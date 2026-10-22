import { homedir } from 'node:os';
import { Agent } from '../agent.js';
import type { Config } from '../config.js';
import type { ContentPart, Message, OpenRouterClient } from '../openrouter.js';
import { ApprovalAnswer, Approver, Permissions } from '../permissions.js';
import { Artifact, Attachment, Bot, Chat, ChatMessage, ChatSummary, DEFAULT_BOT_ID, RecalledMemory, StreamEvent } from '../shared/types.js';
import { ALL_TOOLS, Tool, toToolSpecs } from '../tools/index.js';
import { webFetchTool } from '../tools/web.js';
import type { Todo } from '../tools/types.js';
import type { UI } from '../ui.js';
import { ChatSetup, compactChat, contextMessages, generateTitle, ModelCatalog, systemPrompt } from './context.js';
import { newId, now, Store } from './store.js';
import { memoryTool, MemoryService } from './memory/index.js';
import type { McpManager } from './mcp/manager.js';
import { CommandDef, expandCommand, parseSlash } from './extensions/commands.js';
import { Skills, skillTool } from './extensions/skills.js';
import { artifactTool } from './tools.js';

const MAX_EVENT_OUTPUT = 20_000;

export function summarizeChat(chat: Chat): ChatSummary {
  const { messages, summary: _summary, ...rest } = chat;
  return { ...rest, messageCount: messages.length };
}

export interface RunnerDeps {
  store: Store;
  config: () => Config;
  client: () => OpenRouterClient;
  catalog: ModelCatalog;
  memory: MemoryService;
  mcp: McpManager;
  skills: Skills;
  commands: () => CommandDef[];
}

export type RunInput =
  | { kind: 'message'; content: string; attachments: Attachment[]; editIndex?: number }
  | { kind: 'regenerate' };

interface ActiveRun {
  controller: AbortController;
  pending: Map<string, (answer: ApprovalAnswer) => void>;
}

/** Streams agent activity to the browser as StreamEvents. */
class WebUI implements UI {
  partialText = '';

  constructor(private readonly emit: (e: StreamEvent) => void) {}

  startThinking(): void {}
  stopThinking(): void {}
  text(chunk: string): void {
    this.partialText += chunk;
    this.emit({ type: 'text', text: chunk });
  }
  reasoning(chunk: string): void {
    this.emit({ type: 'reasoning', text: chunk });
  }
  toolCall(name: string, summary: string, id?: string, args?: unknown): void {
    this.partialText = '';
    this.emit({ type: 'tool_call', id: id ?? newId(), name, summary, args: args ?? {} });
  }
  toolResult(output: string, isError: boolean, id?: string): void {
    const clipped = output.length > MAX_EVENT_OUTPUT ? `${output.slice(0, MAX_EVENT_OUTPUT)}\n… [truncated]` : output;
    this.emit({ type: 'tool_result', id: id ?? '', output: clipped, isError });
  }
  todos(todos: Todo[]): void {
    this.emit({ type: 'todos', todos });
  }
  info(msg: string): void {
    this.emit({ type: 'status', message: msg });
  }
  warn(msg: string): void {
    this.emit({ type: 'warn', message: msg });
  }
  error(msg: string): void {
    this.emit({ type: 'error', message: msg });
  }
  endTurn(): void {
    this.partialText = '';
  }
}

export function buildUserContent(text: string, attachments: Attachment[]): string | ContentPart[] {
  const files = attachments
    .filter((a) => a.kind === 'text')
    .map((a) => `<attachment name="${a.name.replace(/"/g, "'")}">\n${a.content}\n</attachment>`);
  const body = [...files, text].filter(Boolean).join('\n\n');
  const images = attachments.filter((a) => a.kind === 'image' && a.content.startsWith('data:image/'));
  if (!images.length) return body;
  return [{ type: 'text', text: body || 'See the attached image.' }, ...images.map((a) => ({ type: 'image_url' as const, image_url: { url: a.content } }))];
}

export class ChatRunner {
  private readonly active = new Map<string, ActiveRun>();

  constructor(private readonly deps: RunnerDeps) {}

  isRunning(chatId: string): boolean {
    return this.active.has(chatId);
  }

  stop(chatId: string): boolean {
    const run = this.active.get(chatId);
    run?.controller.abort();
    return !!run;
  }

  resolvePermission(chatId: string, requestId: string, answer: ApprovalAnswer): boolean {
    const resolve = this.active.get(chatId)?.pending.get(requestId);
    resolve?.(answer);
    return !!resolve;
  }

  /** The chat's bot; chats without one (or whose bot was deleted) use the default bot. */
  botFor(chat: Chat): Bot {
    const { store } = this.deps;
    return store.bots.get(chat.botId ?? DEFAULT_BOT_ID) ?? store.bots.get(DEFAULT_BOT_ID)!;
  }

  memoryOn(bot: Bot): boolean {
    return this.deps.store.settings.memoryEnabled && bot.tools.memory;
  }

  /** The chat's project, bot, recalled memories and artifacts, as used to build its prompt. */
  setup(chat: Chat): ChatSetup {
    const { store } = this.deps;
    const project = chat.projectId ? store.projects.get(chat.projectId) : undefined;
    const tools = this.tools(chat, () => {}).map((t) => t.name);
    return {
      chat,
      project,
      bot: this.botFor(chat),
      settings: store.settings,
      toolNames: tools,
      // Memories recalled for the latest user message.
      recalled: chat.messages.findLast((m) => m.role === 'user')?.memories ?? [],
      skills: this.deps.skills.enabled(),
      artifacts: store.artifacts.all().filter((a) => a.chatId === chat.id),
    };
  }

  tools(chat: Chat, onArtifact: (a: Artifact) => void): Tool[] {
    const { store, memory } = this.deps;
    const project = chat.projectId ? store.projects.get(chat.projectId) : undefined;
    const bot = this.botFor(chat);
    const tools: Tool[] = project?.folder ? [...ALL_TOOLS] : bot.tools.web ? [webFetchTool] : [];
    if (bot.tools.artifacts) tools.push(artifactTool(store, chat.id, chat.projectId, onArtifact));
    if (this.memoryOn(bot)) tools.push(memoryTool(memory, memory.bankFor(bot)));
    if (bot.tools.skills && this.deps.skills.enabled().length) tools.push(skillTool(this.deps.skills));
    return tools;
  }

  /** All tools for a turn, including connector (MCP) tools, which may need a moment to start. */
  async allTools(chat: Chat, onArtifact: (a: Artifact) => void, waitMs = 20_000): Promise<{ tools: Tool[]; warnings: string[] }> {
    const tools = this.tools(chat, onArtifact);
    if (!this.botFor(chat).tools.connectors) return { tools, warnings: [] };
    const mcp = await this.deps.mcp.tools(waitMs);
    return { tools: [...tools, ...mcp.tools], warnings: mcp.warnings };
  }

  /** Recalls memories relevant to a message; failures only cost the memories, never the reply. */
  private async recall(bot: Bot, query: string, emit: (e: StreamEvent) => void): Promise<RecalledMemory[]> {
    const { memory, store } = this.deps;
    try {
      return await memory.backend().recall(memory.bankFor(bot), query, { maxTokens: store.settings.recallTokens });
    } catch (err: any) {
      emit({ type: 'warn', message: `Couldn't recall memories: ${err.message}` });
      return [];
    }
  }

  /** Learns from a finished exchange in the background. */
  private retain(bot: Bot, chat: Chat, userText: string, added: Message[]): void {
    const { memory } = this.deps;
    const assistant = added
      .filter((m) => m.role === 'assistant')
      .map((m) => {
        const text = typeof m.content === 'string' ? m.content : '';
        const tools = (m.tool_calls ?? []).map((c) => `[used ${c.function.name}: ${c.function.arguments.slice(0, 200)}]`).join('\n');
        return [text, tools].filter(Boolean).join('\n');
      })
      .filter(Boolean)
      .join('\n\n');
    if (!userText.trim() || !assistant.trim()) return;
    const project = chat.projectId ? this.deps.store.projects.get(chat.projectId) : undefined;
    memory
      .backend()
      .retain(memory.bankFor(bot), {
        content: `User: ${userText.slice(0, 8000)}\n\nAssistant: ${assistant.slice(0, 8000)}`,
        context: `Conversation "${chat.title}"${project ? ` in project "${project.name}"` : ''}`,
        timestamp: new Date().toISOString(),
        chatId: chat.id,
      })
      .catch((err) => console.warn(`Memory: retain failed for bank ${bot.id}: ${err.message}`));
  }

  async run(chatId: string, input: RunInput, emit: (e: StreamEvent) => void, disconnect: AbortSignal): Promise<void> {
    const { store } = this.deps;
    const chat = store.chats.get(chatId);
    if (!chat) throw new Error('Chat not found');
    if (this.active.has(chatId)) throw new Error('This chat is already running');

    const run: ActiveRun = { controller: new AbortController(), pending: new Map() };
    const signal = AbortSignal.any([run.controller.signal, disconnect]);
    this.active.set(chatId, run);
    try {
      await this.execute(chat, run, input, emit, signal);
    } finally {
      this.active.delete(chatId);
    }
    emit({ type: 'chat', chat: summarizeChat(chat) });
    emit({ type: 'done' });
  }

  private async execute(chat: Chat, run: ActiveRun, input: RunInput, emit: (e: StreamEvent) => void, signal: AbortSignal): Promise<void> {
    const { store, catalog } = this.deps;
    const client = this.deps.client();
    const project = chat.projectId ? store.projects.get(chat.projectId) : undefined;
    const bot = this.botFor(chat);

    // Work out the user message for this turn, trimming history for edits and regenerations.
    let content: string | ContentPart[];
    let command: string | undefined;
    if (input.kind === 'regenerate') {
      const last = chat.messages.findLastIndex((m) => m.role === 'user');
      if (last < 0) throw new Error('Nothing to regenerate');
      content = chat.messages[last].content ?? '';
      chat.messages = chat.messages.slice(0, last);
    } else {
      if (input.editIndex !== undefined) {
        if (chat.messages[input.editIndex]?.role !== 'user') throw new Error('Only user messages can be edited');
        chat.messages = chat.messages.slice(0, input.editIndex);
      }
      // "/name args" runs a slash command: its template becomes the message.
      const slash = input.content.startsWith('/') ? parseSlash(input.content) : undefined;
      const def = slash && this.deps.commands().find((c) => c.name === slash.name);
      if (def) {
        command = input.content.trim();
        emit({ type: 'status', message: `Running /${def.name}…` });
        content = buildUserContent(await expandCommand(def, slash!.args, project?.folder), input.attachments);
      } else {
        content = buildUserContent(input.content, input.attachments);
      }
    }
    if (chat.contextStart > chat.messages.length) {
      chat.contextStart = chat.messages.length;
      if (!chat.contextStart) chat.summary = undefined;
    }
    const isFirstTurn = chat.messages.length === 0;

    // Compact before sending if the last request came close to the context limit.
    const contextLength = (await catalog.contextLength(chat.model)) ?? 128_000;
    const { autoCompactPercent, keepRecentTurns } = store.settings;
    if (autoCompactPercent > 0 && chat.lastPromptTokens > (contextLength * autoCompactPercent) / 100) {
      emit({ type: 'status', message: 'Compacting earlier messages to free up context…' });
      try {
        // The message being sent counts as one of the recent turns to keep.
        const keep = Math.max(0, keepRecentTurns - 1);
        if (await compactChat(chat, client, this.deps.config().smallModel ?? chat.model, keep, signal)) {
          store.chats.put(chat);
          emit({ type: 'compacted', contextStart: chat.contextStart });
        }
      } catch (err: any) {
        emit({ type: 'warn', message: `Automatic compaction failed: ${err.message}` });
      }
    }

    const approver: Approver = (req, abort) =>
      new Promise((resolve, reject) => {
        const requestId = newId();
        run.pending.set(requestId, (answer) => {
          run.pending.delete(requestId);
          emit({ type: 'permission_resolved', requestId });
          resolve(answer);
        });
        abort?.addEventListener(
          'abort',
          () => {
            run.pending.delete(requestId);
            reject(new Error('aborted'));
          },
          { once: true },
        );
        emit({
          type: 'permission',
          requestId,
          callId: req.callId,
          tool: req.tool.name,
          summary: req.summary,
          preview: req.preview,
          alwaysRule: req.alwaysRule,
        });
      });

    const toolset = await this.allTools(chat, (artifact) => emit({ type: 'artifact', artifact }));
    for (const w of toolset.warnings) emit({ type: 'warn', message: w });
    const tools = toolset.tools;
    const supportsTools = (await catalog.list().catch(() => [])).find((m) => m.id === chat.model)?.tools ?? true;
    const permissions = new Permissions(project?.permissionMode ?? 'default', chat.allowedRules, approver);
    const ui = new WebUI(emit);
    const config: Config = {
      ...this.deps.config(),
      model: chat.webSearch ? `${chat.model}:online` : chat.model,
      temperature: bot.temperature,
      autoCompactTokens: 0, // the runner compacts per chat instead
      maxTurns: 50,
    };
    const agent = new Agent({
      client,
      config,
      tools: supportsTools ? tools : [],
      permissions,
      ui,
      cwd: project?.folder ?? homedir(),
      systemPrompt: () => systemPrompt(this.setup(chat)),
    });
    const firstText = typeof content === 'string' ? content : content.map((p) => (p.type === 'text' ? p.text : '')).join(' ');
    // Save the user's message right away so a reload mid-turn still shows it.
    const userMessage: ChatMessage = { role: 'user', content, ts: Date.now(), ...(command ? { command } : {}) };
    chat.messages.push(userMessage);
    chat.updatedAt = now();
    store.chats.put(chat);

    if (this.memoryOn(bot)) {
      const recalled = await this.recall(bot, firstText.replace(/<attachment[\s\S]*?<\/attachment>/g, ' '), emit);
      if (recalled.length) {
        userMessage.memories = recalled;
        store.chats.put(chat);
      }
      emit({ type: 'recall', memories: recalled });
    }

    agent.messages = contextMessages(chat);
    const before = agent.messages.length;

    const titleModel = this.deps.config().smallModel ?? chat.model;
    // Name the chat in parallel with the answer, and show the title as soon as it's ready.
    const title =
      isFirstTurn && chat.title === 'New chat'
        ? generateTitle(client, titleModel, firstText).then((generated) => {
            chat.title = generated || firstText.slice(0, 60).replace(/\s+/g, ' ').trim() || 'New chat';
            emit({ type: 'chat', chat: summarizeChat(chat) });
          })
        : undefined;

    try {
      await agent.run(null, signal);
    } catch (err: any) {
      if (!signal.aborted) emit({ type: 'error', message: err?.message ?? String(err) });
    } finally {
      const added = agent.messages.slice(before);
      // Keep whatever the model had streamed before the user pressed stop.
      if (signal.aborted && ui.partialText.trim() && added.at(-1)?.role !== 'assistant') {
        added.push({ role: 'assistant', content: ui.partialText });
      }
      const ts = Date.now();
      chat.messages.push(...added.map((m) => ({ ...m, ts, ...(m.role === 'assistant' ? { model: chat.model } : {}) })));
      chat.usage.promptTokens += agent.usage.promptTokens;
      chat.usage.completionTokens += agent.usage.completionTokens;
      chat.usage.cost += agent.usage.cost;
      chat.usage.requests += agent.usage.requests;
      if (agent.lastPromptTokens) chat.lastPromptTokens = agent.lastPromptTokens;
      chat.allowedRules = [...new Set([...chat.allowedRules, ...permissions.sessionRules])];
      chat.updatedAt = now();
      store.chats.put(chat);
      if (!signal.aborted && this.memoryOn(bot) && bot.memory.autoRetain) this.retain(bot, chat, firstText, added);
    }

    if (title) {
      await title;
      store.chats.put(chat);
    }
  }
}
