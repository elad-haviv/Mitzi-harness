import { homedir } from 'node:os';
import { Agent } from '../agent.js';
import type { Config } from '../config.js';
import type { ContentPart, OpenRouterClient } from '../openrouter.js';
import { ApprovalAnswer, Approver, Permissions } from '../permissions.js';
import type { Artifact, Attachment, Chat, ChatSummary, StreamEvent } from '../shared/types.js';
import { ALL_TOOLS, Tool, toToolSpecs } from '../tools/index.js';
import { webFetchTool } from '../tools/web.js';
import type { Todo } from '../tools/types.js';
import type { UI } from '../ui.js';
import { ChatSetup, compactChat, contextMessages, generateTitle, ModelCatalog, systemPrompt } from './context.js';
import { newId, now, Store } from './store.js';
import { artifactTool, memoryTool } from './tools.js';

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

  /** The chat's project, bot, memories and artifacts, as used to build its prompt. */
  setup(chat: Chat): ChatSetup {
    const { store } = this.deps;
    const project = chat.projectId ? store.projects.get(chat.projectId) : undefined;
    const bot = chat.botId ? store.bots.get(chat.botId) : undefined;
    const tools = this.tools(chat, () => {}).map((t) => t.name);
    return {
      chat,
      project,
      bot,
      settings: store.settings,
      toolNames: tools,
      memories: store.memories.all().filter((m) => !m.projectId || m.projectId === chat.projectId),
      artifacts: store.artifacts.all().filter((a) => a.chatId === chat.id),
    };
  }

  tools(chat: Chat, onArtifact: (a: Artifact) => void): Tool[] {
    const { store } = this.deps;
    const project = chat.projectId ? store.projects.get(chat.projectId) : undefined;
    const bot = chat.botId ? store.bots.get(chat.botId) : undefined;
    const tools: Tool[] = project?.folder ? [...ALL_TOOLS] : bot?.tools.web === false ? [] : [webFetchTool];
    if (bot?.tools.artifacts !== false) tools.push(artifactTool(store, chat.id, chat.projectId, onArtifact));
    if (store.settings.memoryEnabled && bot?.tools.memory !== false) tools.push(memoryTool(store, chat.projectId));
    return tools;
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
    const bot = chat.botId ? store.bots.get(chat.botId) : undefined;

    // Work out the user message for this turn, trimming history for edits and regenerations.
    let content: string | ContentPart[];
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
      content = buildUserContent(input.content, input.attachments);
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

    const tools = this.tools(chat, (artifact) => emit({ type: 'artifact', artifact }));
    const supportsTools = (await catalog.list().catch(() => [])).find((m) => m.id === chat.model)?.tools ?? true;
    const permissions = new Permissions(project?.permissionMode ?? 'default', chat.allowedRules, approver);
    const ui = new WebUI(emit);
    const config: Config = {
      ...this.deps.config(),
      model: chat.webSearch ? `${chat.model}:online` : chat.model,
      temperature: bot?.temperature,
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
    // Save the user's message right away so a reload mid-turn still shows it.
    chat.messages.push({ role: 'user', content, ts: Date.now() });
    chat.updatedAt = now();
    store.chats.put(chat);
    agent.messages = contextMessages(chat);
    const before = agent.messages.length;

    const firstText = typeof content === 'string' ? content : content.map((p) => (p.type === 'text' ? p.text : '')).join(' ');
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
    }

    if (title) {
      await title;
      store.chats.put(chat);
    }
  }
}
