import { homedir } from 'node:os';
import { Agent } from '../agent.js';
import type { Config, PermissionMode } from '../config.js';
import type { ContentPart, LlmClient, Message } from '../openrouter.js';
import type { RoutingClient } from '../providers.js';
import { ApprovalAnswer, Approver, Permissions } from '../permissions.js';
import { ApprovalLevel, Artifact, Attachment, AUTO_MODEL, Project, QueuedMessage, Bot, Chat, ChatMessage, ChatSummary, DEFAULT_BOT_ID, RecalledMemory, RouteChoice, StreamEvent } from '../shared/types.js';
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
import { commentTool } from './workspace.js';
import { MediaService, mediaTools } from './media.js';
import { delegateTool } from './team.js';
import { KnowledgeIndex } from './knowledge.js';
import { subagentId, subagentsTool } from './subagents.js';
import { checkGoal, goalTool, newGoal, parseBuiltin, submitPlanTool } from './agentic.js';
import { CompareInsightsStore, parseCompareArgs, runCompareRace, tallyFor, CompareOutcome } from './compare.js';
import { todoTool } from '../tools/todo.js';
import { currentUsageTag, UsageLog, withUsage } from './usage.js';
import { concreteModel, route, RouteInput, RouteModels, routeModels } from './routing.js';
import { BrowserService, browserTool } from './browser.js';

const MAX_EVENT_OUTPUT = 20_000;

/** Keeps a run's events for replay, joining streamed text so the log stays small. */
function record(events: StreamEvent[], e: StreamEvent): void {
  const last = events.at(-1);
  if ((e.type === 'text' || e.type === 'reasoning') && last?.type === e.type) events[events.length - 1] = { type: e.type, text: last.text + e.text };
  else if (events.length < 20_000) events.push(e);
}

export function summarizeChat(chat: Chat): ChatSummary {
  const { messages, summary: _summary, ...rest } = chat;
  return { ...rest, messageCount: messages.length };
}

export interface RunnerDeps {
  store: Store;
  config: () => Config;
  client: () => RoutingClient;
  catalog: ModelCatalog;
  memory: MemoryService;
  mcp: McpManager;
  skills: Skills;
  commands: () => CommandDef[];
  media: MediaService;
  usage: UsageLog;
  browser: BrowserService;
  compareInsights: CompareInsightsStore;
  knowledge: KnowledgeIndex;
}

export type RunInput =
  /** `focus`: the artifact open in the workspace beside the chat. */
  | {
      kind: 'message';
      content: string;
      attachments: Attachment[];
      editIndex?: number;
      focus?: string;
      /** Sent by Mitzi for the user (redo directions, plan approval). */
      auto?: ChatMessage['auto'];
      /** The answer belongs to this feedback loop. */
      feedbackLoopId?: string;
    }
  | { kind: 'regenerate' };

export interface RunOptions {
  /** Nobody is watching (scheduled tasks): tools that would ask are allowed or declined automatically. */
  headless?: { autoApprove: boolean };
  /** The scheduled task this run belongs to, for usage accounting. */
  taskId?: string;
}

/** Goal controls typed as "/goal pause" etc.; anything else after /goal is a new goal. */
export const GOAL_CONTROLS = new Set(['', 'pause', 'resume', 'clear', 'status', 'stop']);

interface RunTotals {
  prompt: number;
  completion: number;
  cost: number;
  requests: number;
}

interface ActiveRun {
  controller: AbortController;
  pending: Map<string, (answer: ApprovalAnswer) => void>;
  startedAt: number;
  /** Everything the run has streamed so far, so a browser that comes back can catch up. */
  events: StreamEvent[];
  /** Browsers following the run besides the one that started it. */
  listeners: Set<(e: StreamEvent) => void>;
  /** Streams an event to everyone following the run. */
  emit?: (e: StreamEvent) => void;
  /** Resolves the /compare A/B/skip pick for this run, when one is waiting. */
  comparePick?: (choice: 'A' | 'B' | 'skip') => void;
}

/** Streams agent activity to the browser as StreamEvents. */
class WebUI implements UI {
  partialText = '';
  partialReasoning = '';

  constructor(private readonly emit: (e: StreamEvent) => void) {}

  startThinking(): void {}
  stopThinking(): void {}
  text(chunk: string): void {
    this.partialText += chunk;
    this.emit({ type: 'text', text: chunk });
  }
  reasoning(chunk: string): void {
    this.partialReasoning += chunk;
    this.emit({ type: 'reasoning', text: chunk });
  }
  toolCall(name: string, summary: string, id?: string, args?: unknown): void {
    this.partialText = '';
    this.partialReasoning = '';
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
    this.partialReasoning = '';
  }
}

/** Reports a teammate's progress inside the Delegate call that started it. */
class TeammateUI implements UI {
  constructor(private readonly send: (event: 'text' | 'tool' | 'error', text: string) => void) {}

  startThinking(): void {}
  stopThinking(): void {}
  text(chunk: string): void {
    this.send('text', chunk);
  }
  reasoning(): void {}
  toolCall(name: string, summary: string): void {
    this.send('tool', summary ? `${name}: ${summary}` : name);
  }
  toolResult(): void {}
  todos(): void {}
  info(): void {}
  warn(): void {}
  error(msg: string): void {
    this.send('error', msg);
  }
  endTurn(): void {}
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
  /** Tools added from outside (the Workflow tool, set once workflows exist). */
  extraTools: () => Tool[] = () => [];

  constructor(private readonly deps: RunnerDeps) {}

  isRunning(chatId: string): boolean {
    return this.active.has(chatId);
  }

  /** Whether a running chat is waiting for the user to approve something. */
  isWaiting(chatId: string): boolean {
    return (this.active.get(chatId)?.pending.size ?? 0) > 0;
  }

  /**
   * Follows a running chat: replays what it streamed so far, then streams the rest. Returns a function that
   * stops following, or undefined when the chat isn't running.
   */
  attach(chatId: string, listener: (e: StreamEvent) => void): (() => void) | undefined {
    const run = this.active.get(chatId);
    if (!run) return undefined;
    listener({ type: 'run', startedAt: run.startedAt });
    for (const e of run.events) listener(e);
    run.listeners.add(listener);
    return () => run.listeners.delete(listener);
  }

  stop(chatId: string): boolean {
    const run = this.active.get(chatId);
    run?.controller.abort();
    return !!run;
  }

  /** The user picked a /compare winner (or skipped). */
  resolveComparePick(chatId: string, choice: 'A' | 'B' | 'skip'): boolean {
    const resolve = this.active.get(chatId)?.comparePick;
    if (!resolve) return false;
    this.active.get(chatId)!.comparePick = undefined;
    resolve(choice);
    return true;
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

  /** The bots this bot can hand tasks to. */
  teamFor(bot: Bot): Bot[] {
    return bot.tools.team === false ? [] : this.deps.store.bots.all().filter((b) => b.id !== bot.id);
  }

  /** The chat's approval level: its own, else the project's permissions, else the default from Settings. */
  approvalOf(chat: Chat): ApprovalLevel {
    if (chat.approval) return chat.approval;
    const project = chat.projectId ? this.deps.store.projects.get(chat.projectId) : undefined;
    if (project?.permissionMode === 'yolo') return 'alleycat';
    if (project?.permissionMode === 'sensitive') return 'housecat';
    return this.deps.store.settings.approval ?? 'kitten';
  }

  /** The permission mode a turn runs in. A project in plan mode stays read-only whatever the level. */
  permissionMode(chat: Chat): PermissionMode {
    const project = chat.projectId ? this.deps.store.projects.get(chat.projectId) : undefined;
    if (project?.permissionMode === 'plan') return 'plan';
    const level = this.approvalOf(chat);
    if (level === 'alleycat') return 'yolo';
    if (level === 'housecat') return 'sensitive';
    return project?.permissionMode === 'acceptEdits' ? 'acceptEdits' : 'default';
  }

  /** The fast and strong models the Auto model picks from. */
  routeModels(): RouteModels {
    return routeModels(this.deps.store.settings.routing, this.deps.config());
  }

  /** The model a chat uses outside a turn; Auto counts as its strong model. */
  modelOf(chat: Chat): string {
    return concreteModel(chat.model, this.routeModels());
  }

  /** The model to answer with: `model` itself, or Auto's pick for this input. */
  private async pick(model: string, input: RouteInput): Promise<{ model: string; route?: RouteChoice }> {
    if (model !== AUTO_MODEL) return { model };
    const choice = route(input, this.routeModels(), await this.deps.catalog.list().catch(() => []));
    return { model: choice.model, route: choice };
  }

  /** The chat's project, bot, recalled memories and artifacts, as used to build its prompt. */
  setup(chat: Chat): ChatSetup {
    const { store } = this.deps;
    const project = chat.projectId ? store.projects.get(chat.projectId) : undefined;
    const tools = this.tools(chat, () => {}).map((t) => t.name);
    const bot = this.botFor(chat);
    return {
      chat,
      project,
      bot,
      team: this.teamFor(bot),
      settings: store.settings,
      toolNames: tools,
      // Memories recalled for the latest user message.
      recalled: chat.messages.findLast((m) => m.role === 'user')?.memories ?? [],
      skills: this.deps.skills.enabled(),
      knowledge: project ? this.knowledgeFor(project, chat) : undefined,
      artifacts: store.artifacts.all().filter((a) => a.chatId === chat.id),
      focus: this.focusOf(chat),
    };
  }

  /** The project's knowledge for the chat: all of it when small, else the excerpts that match the latest messages. */
  private knowledgeFor(project: Project, chat: Chat): ChatSetup['knowledge'] {
    const { knowledge } = this.deps;
    const docs = knowledge.docs(project);
    if (!docs.length) return undefined;
    if (!knowledge.isLarge(project)) return { mode: 'inline', docs };
    // The last two things the user said: a follow-up ("and the second one?") leans on the message before.
    const asked = chat.messages.filter((m) => m.role === 'user').slice(-2);
    const query = asked.map((m) => (typeof m.content === 'string' ? m.content : (m.content ?? []).map((p) => (p.type === 'text' ? p.text : '')).join(' ')).replace(/<attachment[\s\S]*?<\/attachment>/g, ' ')).join('\n');
    return { mode: 'search', names: docs.map((d) => d.name), excerpts: knowledge.search(project, query) };
  }

  /** The chat's artifact open in the workspace, if any. */
  focusOf(chat: Chat): Artifact | undefined {
    const a = chat.focusArtifactId ? this.deps.store.artifacts.get(chat.focusArtifactId) : undefined;
    return a?.chatId === chat.id ? a : undefined;
  }

  tools(chat: Chat, onArtifact: (a: Artifact) => void, onBrowser: (v: { url: string; title: string; screenshot?: string }) => void = () => {}): Tool[] {
    const { store, memory } = this.deps;
    const project = chat.projectId ? store.projects.get(chat.projectId) : undefined;
    const bot = this.botFor(chat);
    const tools: Tool[] = project?.folder ? [...ALL_TOOLS] : bot.tools.web ? [webFetchTool] : [];
    // Working on an artifact in its workspace needs the artifact tools whatever the bot's settings.
    const focus = this.focusOf(chat);
    if (bot.tools.artifacts || focus) tools.push(artifactTool(store, chat.id, chat.projectId, onArtifact));
    if (focus || store.artifacts.all().some((a) => a.chatId === chat.id && a.comments?.length)) tools.push(commentTool(store, chat.id, onArtifact));
    if (this.memoryOn(bot)) tools.push(memoryTool(memory, memory.bankFor(bot)));
    if (project && this.deps.knowledge.isLarge(project)) tools.push(this.deps.knowledge.tool(project));
    if (bot.tools.skills && this.deps.skills.enabled().length) tools.push(skillTool(this.deps.skills));
    tools.push(...this.extraTools());
    if (bot.tools.browser !== false && !this.deps.browser.unavailable()) tools.push(browserTool(this.deps.browser, onBrowser));
    if (bot.tools.media !== false) {
      // Generated media are kept as artifacts of the chat, so they show up in the gallery.
      tools.push(
        ...mediaTools(this.deps.media, ({ kind, url, prompt, callId }) => {
          const artifact: Artifact = {
            id: newId(),
            chatId: chat.id,
            projectId: chat.projectId,
            title: prompt.length > 60 ? `${prompt.slice(0, 57).trim()}…` : prompt,
            type: kind,
            versions: [{ content: url, author: 'assistant', note: prompt, createdAt: now(), callId }],
            createdAt: now(),
            updatedAt: now(),
          };
          store.artifacts.put(artifact);
          onArtifact(artifact);
        }),
      );
    }
    return tools;
  }

  /**
   * Runs a bot on one prompt outside any chat (a workflow step). Tools that would ask for permission are declined
   * unless `autoApprove`. Resolves to the final answer.
   */
  async runOnce(opts: { botId?: string; model?: string; prompt: string; projectId?: string; tools: boolean; autoApprove: boolean; note?: string; signal?: AbortSignal }): Promise<string> {
    const { store, catalog } = this.deps;
    const bot = store.bots.get(opts.botId ?? DEFAULT_BOT_ID) ?? store.bots.get(DEFAULT_BOT_ID)!;
    const { model } = await this.pick(opts.model || bot.model || this.deps.config().model, { content: opts.prompt, working: opts.tools, planning: false });
    const project = opts.projectId ? store.projects.get(opts.projectId) : undefined;
    const chat: Chat = {
      id: `once-${newId()}`,
      title: 'Workflow step',
      botId: bot.id,
      projectId: project?.id,
      model,
      webSearch: false,
      pinned: false,
      messages: [],
      contextStart: 0,
      allowedRules: [],
      usage: { promptTokens: 0, completionTokens: 0, cost: 0, requests: 0 },
      lastPromptTokens: 0,
      createdAt: now(),
      updatedAt: now(),
    };
    const tools = opts.tools ? (await this.allTools(chat, () => {})).tools.filter((t) => !/^(Artifact|ArtifactComment|Workflow|Delegate)$/.test(t.name)) : [];
    const supportsTools = (await catalog.list().catch(() => [])).find((m) => m.id === model)?.tools ?? true;
    const permissions = new Permissions(project?.permissionMode ?? 'default', [], async () =>
      opts.autoApprove ? { kind: 'yes' } : { kind: 'feedback', text: 'This step runs unattended, so tools that need approval are unavailable. Do what you can without them.' },
    );
    const agent = new Agent({
      client: this.deps.client(),
      config: { ...this.deps.config(), model, temperature: bot.temperature, autoCompactTokens: 0, maxTurns: 25 },
      tools: supportsTools ? tools : [],
      permissions,
      ui: new TeammateUI(() => {}),
      cwd: project?.folder ?? homedir(),
      systemPrompt: () => `${systemPrompt({ ...this.setup(chat), toolNames: tools.map((t) => t.name), team: [] })}${opts.note ? `\n\n${opts.note}` : ''}`,
    });
    agent.messages = [{ role: 'user', content: opts.prompt }];
    await agent.run(null, opts.signal);
    const last = agent.messages.findLast((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim());
    return typeof last?.content === 'string' ? last.content : '';
  }

  /** All tools for a turn, including connector (MCP) tools, which may need a moment to start. */
  async allTools(
    chat: Chat,
    onArtifact: (a: Artifact) => void,
    waitMs = 20_000,
    onBrowser?: (v: { url: string; title: string; screenshot?: string }) => void,
  ): Promise<{ tools: Tool[]; warnings: string[] }> {
    const tools = this.tools(chat, onArtifact, onBrowser);
    if (!this.botFor(chat).tools.connectors) return { tools, warnings: [] };
    const mcp = await this.deps.mcp.tools(waitMs);
    return { tools: [...tools, ...mcp.tools], warnings: mcp.warnings };
  }

  /** Recalls memories relevant to a message; failures only cost the memories, never the reply. */
  private async recall(bot: Bot, query: string, emit: (e: StreamEvent) => void): Promise<RecalledMemory[]> {
    const { memory, store } = this.deps;
    try {
      return await withUsage({ kind: 'memory', sink: undefined, route: undefined }, () => memory.backend().recall(memory.bankFor(bot), query, { maxTokens: store.settings.recallTokens }));
    } catch (err: any) {
      emit({ type: 'warn', message: `Couldn't recall memories: ${err.message}` });
      return [];
    }
  }

  /**
   * Runs a teammate on a task another bot handed it: a fresh conversation in the same chat and project, with
   * the teammate's own instructions, model, tools and memory. Resolves to its final answer.
   */
  private async runTeammate(
    chat: Chat,
    lead: Bot,
    mate: Bot,
    task: string,
    run: { callId: string; permissions: Permissions; emit: (e: StreamEvent) => void; signal?: AbortSignal; model: string; subagent?: string },
  ): Promise<string> {
    const { store, catalog } = this.deps;
    const project = chat.projectId ? store.projects.get(chat.projectId) : undefined;
    const { model } = await this.pick(mate.model ?? run.model, { content: task, working: true, planning: false });
    const virtual: Chat = { ...chat, botId: mate.id, model, webSearch: false, messages: [], contextStart: 0, summary: undefined, focusArtifactId: undefined };
    // A subagent's progress is told apart from its lead (the same bot) by its own id.
    const send = (event: 'start' | 'text' | 'tool' | 'done' | 'error', text: string) => run.emit({ type: 'delegate', callId: run.callId, botId: run.subagent ?? mate.id, event, text });
    send('start', task);
    const recalled = this.memoryOn(mate) ? await this.recall(mate, task, () => {}) : [];
    const { tools } = await this.allTools(virtual, (artifact) => run.emit({ type: 'artifact', artifact }));
    const supportsTools = (await catalog.list().catch(() => [])).find((m) => m.id === model)?.tools ?? true;
    const agent = new Agent({
      client: this.deps.client(),
      config: { ...this.deps.config(), model, temperature: mate.temperature, autoCompactTokens: 0, maxTurns: 25 },
      tools: supportsTools ? tools : [],
      permissions: run.permissions,
      ui: new TeammateUI(send),
      cwd: project?.folder ?? homedir(),
      systemPrompt: () =>
        `${systemPrompt({ ...this.setup(virtual), recalled, team: [] })}\n\n` +
        (run.subagent
          ? `# Working as a subagent\nYou are a subagent: the main ${lead.name} split this focused task off a larger request from the user and works on other parts meanwhile. ` +
            `The user won't see your reply directly: the main ${lead.name} will use it. Stay on this task, do it thoroughly, and reply with the finished result, without small talk.`
          : `# Working with ${lead.name}\n${lead.name} handed you this task as part of a larger request from the user. ` +
            `The user won't see your reply directly: ${lead.name} will use it. Do the task and reply with the finished result, without small talk.`),
    });
    agent.messages = [{ role: 'user', content: task }];
    try {
      await agent.run(null, run.signal);
    } catch (err: any) {
      send('error', err?.message ?? String(err));
      throw err;
    }
    const last = agent.messages.findLast((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim());
    const answer = typeof last?.content === 'string' ? last.content : '';
    send('done', '');
    return answer;
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
    withUsage({ kind: 'memory', sink: undefined, route: undefined }, () => memory.backend().retain(memory.bankFor(bot), {
        content: `User: ${userText.slice(0, 8000)}\n\nAssistant: ${assistant.slice(0, 8000)}`,
        context: `Conversation "${chat.title}"${project ? ` in project "${project.name}"` : ''}`,
        timestamp: new Date().toISOString(),
        chatId: chat.id,
      })
    ).catch((err) => console.warn(`Memory: retain failed for bank ${bot.id}: ${err.message}`));
  }

  async run(chatId: string, input: RunInput, emit: (e: StreamEvent) => void, disconnect: AbortSignal, options: RunOptions = {}): Promise<void> {
    const { store } = this.deps;
    const chat = store.chats.get(chatId);
    if (!chat) throw new Error('Chat not found');
    if (this.active.has(chatId)) throw new Error('This chat is already running');

    const run: ActiveRun = { controller: new AbortController(), pending: new Map(), startedAt: Date.now(), events: [], listeners: new Set() };
    const signal = AbortSignal.any([run.controller.signal, disconnect]);
    this.active.set(chatId, run);
    const caller = emit;
    emit = (e) => {
      record(run.events, e);
      caller(e);
      for (const l of run.listeners) l(e);
    };
    run.emit = emit;
    const totals: RunTotals = { prompt: 0, completion: 0, cost: 0, requests: 0 };
    try {
      await withUsage(
        {
          kind: options.headless ? 'task' : 'chat',
          chatId,
          projectId: chat.projectId,
          botId: this.botFor(chat).id,
          taskId: options.taskId,
          sink: (e) => {
            totals.prompt += e.prompt;
            totals.completion += e.completion;
            totals.cost += e.cost;
            totals.requests++;
          },
        },
        () => this.execute(chat, run, input, emit, signal, options, totals),
      );
    } finally {
      this.active.delete(chatId);
      // Messages sent while it worked go next, one per run, whether or not anyone is watching.
      setImmediate(() => this.sendQueued(chatId));
    }
    emit({ type: 'chat', chat: summarizeChat(chat) });
    emit({ type: 'done' });
    run.listeners.clear();
  }

  /** Queues a message for when the current response is done; `now` stops the response and sends it next. */
  enqueue(chatId: string, message: Omit<QueuedMessage, 'id' | 'createdAt'>, now = false): QueuedMessage[] {
    const chat = this.deps.store.chats.get(chatId);
    if (!chat) throw new Error('Chat not found');
    const item: QueuedMessage = { id: newId(), ...message, createdAt: new Date().toISOString() };
    chat.queue = now ? [item, ...(chat.queue ?? [])] : [...(chat.queue ?? []), item];
    this.deps.store.chats.put(chat);
    this.active.get(chatId)?.emit?.({ type: 'queue', queue: chat.queue });
    if (now) this.stop(chatId);
    if (!this.active.has(chatId)) this.sendQueued(chatId);
    return chat.queue;
  }

  /** Takes a message off the queue, or moves it to the front and sends it now. */
  dequeue(chatId: string, id: string, sendNow = false): QueuedMessage[] {
    const chat = this.deps.store.chats.get(chatId);
    if (!chat) throw new Error('Chat not found');
    const item = chat.queue?.find((q) => q.id === id);
    chat.queue = (chat.queue ?? []).filter((q) => q.id !== id);
    if (sendNow && item) chat.queue.unshift(item);
    this.deps.store.chats.put(chat);
    this.active.get(chatId)?.emit?.({ type: 'queue', queue: chat.queue });
    if (sendNow) this.stop(chatId);
    return chat.queue;
  }

  /** Starts the next queued message, if the chat is free. */
  private sendQueued(chatId: string): void {
    const chat = this.deps.store.chats.get(chatId);
    const next = chat?.queue?.[0];
    if (!chat || !next || this.active.has(chatId)) return;
    chat.queue = chat.queue!.slice(1);
    this.deps.store.chats.put(chat);
    this.run(chatId, { kind: 'message', content: next.content, attachments: next.attachments ?? [] }, () => {}, new AbortController().signal).catch((err) =>
      console.warn(`Couldn't send a queued message in ${chatId}: ${err.message}`),
    );
  }

  private async execute(
    chat: Chat,
    run: ActiveRun,
    input: RunInput,
    emit: (e: StreamEvent) => void,
    signal: AbortSignal,
    options: RunOptions,
    totals: RunTotals,
  ): Promise<void> {
    const { store, catalog } = this.deps;
    const started = Date.now();
    let planRequest: string | undefined;
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
      const builtin = parseBuiltin(input.content);
      const slash = input.content.startsWith('/') && !builtin ? parseSlash(input.content) : undefined;
      const def = slash && this.deps.commands().find((c) => c.name === slash.name);
      if (builtin?.name === 'plan') {
        if (!builtin.args) throw new Error('Say what to plan: /plan <what you want done>');
        command = input.content.trim();
        planRequest = builtin.args;
        content = buildUserContent(`Make a plan for this (don't carry it out yet):\n\n${builtin.args}`, input.attachments);
      } else if (builtin?.name === 'goal' && !GOAL_CONTROLS.has(builtin.args.toLowerCase())) {
        command = input.content.trim();
        chat.goal = newGoal(builtin.args);
        chat.mode = 'work';
        emit({ type: 'goal', goal: chat.goal });
        content = buildUserContent(`Work on this goal until it's met:\n\n${builtin.args}`, input.attachments);
      } else if (builtin?.name === 'compare') {
        // /compare races two models outside the normal agent turn.
        command = input.content.trim();
        await this.runCompare(chat, run, builtin.args, input.content.trim(), emit, signal);
        return;
      } else if (builtin) {
        throw new Error(`/${builtin.name}${builtin.args ? ` ${builtin.args}` : ''} isn't a message; send it with the command endpoint`);
      } else if (def) {
        command = input.content.trim();
        emit({ type: 'status', message: `Running /${def.name}…` });
        content = buildUserContent(await expandCommand(def, slash!.args, project?.folder), input.attachments);
      } else {
        content = buildUserContent(input.content, input.attachments);
      }
      // Messages sent from an artifact's workspace are about that artifact.
      chat.focusArtifactId = input.focus;
    }
    if (chat.contextStart > chat.messages.length) {
      chat.contextStart = chat.messages.length;
      if (!chat.contextStart) chat.summary = undefined;
    }
    const isFirstTurn = chat.messages.length === 0;
    const working = chat.mode === 'work' || chat.goal?.status === 'active';

    // On Auto, pick the model for this message.
    const previous = chat.messages.findLast((m) => m.role === 'assistant' && m.route)?.route?.tier;
    const { model, route: routed } = await this.pick(chat.model, { content, working, planning: !!planRequest, previous });
    if (routed) {
      emit({ type: 'route', route: routed });
      const tag = currentUsageTag();
      if (tag) tag.route = routed.tier;
    }

    // Compact before sending if the last request came close to the context limit.
    const contextLength = (await catalog.contextLength(model)) ?? 128_000;
    const { autoCompactPercent, keepRecentTurns } = store.settings;
    if (autoCompactPercent > 0 && chat.lastPromptTokens > (contextLength * autoCompactPercent) / 100) {
      emit({ type: 'status', message: 'Compacting earlier messages to free up context…' });
      try {
        // The message being sent counts as one of the recent turns to keep.
        const keep = Math.max(0, keepRecentTurns - 1);
        if (await compactChat(chat, client, this.deps.config().smallModel ?? model, keep, signal)) {
          store.chats.put(chat);
          emit({ type: 'compacted', contextStart: chat.contextStart });
        }
      } catch (err: any) {
        emit({ type: 'warn', message: `Automatic compaction failed: ${err.message}` });
      }
    }

    const headless = options.headless;
    const approver: Approver = (req, abort) =>
      headless
        ? Promise.resolve<ApprovalAnswer>(
            headless.autoApprove
              ? { kind: 'yes' }
              : { kind: 'feedback', text: 'This is an unattended scheduled run, so tools that need approval are unavailable. Do what you can without it.' },
          )
        : new Promise((resolve, reject) => {
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
          ...(req.why ? { why: req.why } : {}),
        });
      });

    const toolset = await this.allTools(chat, (artifact) => emit({ type: 'artifact', artifact }), undefined, (v) => emit({ type: 'browser', ...v }));
    for (const w of toolset.warnings) emit({ type: 'warn', message: w });
    let tools = toolset.tools;
    const team = this.teamFor(bot);
    const permissions = new Permissions(this.permissionMode(chat), chat.allowedRules, approver);
    if (team.length && !planRequest) {
      tools.push(delegateTool(team, (mate, task, callId, toolSignal) => this.runTeammate(chat, bot, mate, task, { callId, permissions, emit, signal: toolSignal ?? signal, model })));
    }
    if (bot.tools.subagents !== false && !planRequest) {
      tools.push(
        subagentsTool((t, i, callId, toolSignal) =>
          this.runTeammate(chat, bot, bot, t.task, { callId, permissions, emit, signal: toolSignal ?? signal, model, subagent: subagentId(i) }),
        ),
      );
    }
    if (working && !tools.some((t) => t.name === 'TodoWrite')) tools.push(todoTool);
    if (chat.goal?.status === 'active') {
      const goal = chat.goal;
      tools.push(goalTool(goal, () => emit({ type: 'goal', goal: { ...goal, subgoals: goal.subgoals.map((x) => ({ ...x })) } })));
    }
    if (planRequest) {
      // Planning looks around but changes nothing.
      tools = [...tools.filter((t) => t.kind === 'read' && !/^(TodoWrite|Artifact|ArtifactComment|Generate\w+)$/.test(t.name)), submitPlanTool(chat, planRequest, (plan) => emit({ type: 'plan', plan }))];
    }
    const supportsTools = (await catalog.list().catch(() => [])).find((m) => m.id === model)?.tools ?? true;
    // The task list is kept with the chat, so it survives reloads and shows in the side panel.
    const ui = new WebUI((e) => {
      if (e.type === 'todos') chat.todos = e.todos;
      emit(e);
    });
    const config: Config = {
      ...this.deps.config(),
      // Web search is OpenRouter's :online feature.
      model: chat.webSearch && client.isOpenRouter(model) ? `${model}:online` : model,
      temperature: bot.temperature,
      autoCompactTokens: 0, // the runner compacts per chat instead
      maxTurns: working ? 100 : 50,
    };
    const agent = new Agent({
      client,
      config,
      tools: supportsTools ? tools : [],
      permissions,
      ui,
      cwd: project?.folder ?? homedir(),
      systemPrompt: () => systemPrompt({ ...this.setup(chat), model, planning: !!planRequest }),
    });
    const firstText = typeof content === 'string' ? content : content.map((p) => (p.type === 'text' ? p.text : '')).join(' ');
    // Save the user's message right away so a reload mid-turn still shows it.
    const userMessage: ChatMessage = {
      role: 'user',
      content,
      ts: Date.now(),
      ...(command ? { command } : {}),
      ...(input.kind === 'message' && input.auto ? { auto: input.auto } : {}),
    };
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

    const titleModel = this.deps.config().smallModel ?? model;
    // Name the chat in parallel with the answer, and show the title as soon as it's ready.
    const title =
      isFirstTurn && chat.title === 'New chat'
        ? withUsage({ kind: 'title', sink: undefined, route: undefined }, () => generateTitle(client, titleModel, firstText)).then((generated) => {
            chat.title = generated || firstText.slice(0, 60).replace(/\s+/g, ' ').trim() || 'New chat';
            emit({ type: 'chat', chat: summarizeChat(chat) });
          })
        : undefined;

    try {
      await agent.run(null, signal);
      // A goal keeps the bot working: check after each turn, and continue until it's met or out of turns.
      while (!signal.aborted && chat.goal?.status === 'active' && agent.messages.at(-1)?.role === 'assistant') {
        const goal = chat.goal;
        goal.turns++;
        emit({ type: 'status', message: 'Checking the goal…' });
        const lastUser = agent.messages.findLastIndex((m) => m.role === 'user');
        const work = agent.messages
          .slice(lastUser + 1)
          .map((m) => (m.role === 'assistant' ? (typeof m.content === 'string' ? m.content : '') : m.role === 'tool' ? `[tool result] ${String(m.content).slice(0, 600)}` : ''))
          .filter(Boolean)
          .join('\n\n');
        const verdict = await withUsage({ kind: 'goal' }, () => checkGoal(client, this.deps.config().smallModel ?? model, goal, work, signal));
        for (const id of verdict.done) {
          const sub = goal.subgoals.find((x) => x.id === id);
          if (sub) sub.done = true;
        }
        goal.lastCheck = verdict.reason;
        if (verdict.met) {
          goal.status = 'complete';
          goal.completedAt = now();
        } else if (goal.turns >= goal.maxTurns) goal.status = 'budget';
        emit({ type: 'goal', goal: { ...goal, subgoals: goal.subgoals.map((x) => ({ ...x })) } });
        if (goal.status !== 'active') break;
        const open = goal.subgoals.filter((x) => !x.done).map((x) => `${x.id}. ${x.text}`);
        const follow: ChatMessage = {
          role: 'user',
          content: `Keep working toward the goal.${open.length ? `\n\nMilestones still open:\n${open.join('\n')}` : ''}\n\nLast check: ${verdict.reason}`,
          auto: 'goal',
        };
        agent.messages.push(follow as Message);
        await agent.run(null, signal);
      }
      if (signal.aborted && chat.goal?.status === 'active') {
        chat.goal.status = 'paused';
        emit({ type: 'goal', goal: chat.goal });
      }
    } catch (err: any) {
      if (!signal.aborted) emit({ type: 'error', message: err?.message ?? String(err) });
    } finally {
      const added = agent.messages.slice(before);
      // Keep whatever the model had streamed before the user pressed stop.
      if (signal.aborted && (ui.partialText.trim() || ui.partialReasoning.trim()) && added.at(-1)?.role !== 'assistant') {
        added.push({ role: 'assistant', content: ui.partialText, ...(ui.partialReasoning.trim() ? { reasoning: ui.partialReasoning } : {}) });
      }
      const ts = Date.now();
      const saved: ChatMessage[] = added.map((m) => ({ ...m, ts, ...(m.role === 'assistant' ? { model } : {}) }));
      // The whole response's time, tokens and cost (teammates and goal checks included) go on its last answer.
      const stats = { durationMs: ts - started, promptTokens: totals.prompt, completionTokens: totals.completion, cost: totals.cost, requests: totals.requests };
      const last = saved.findLast((m) => m.role === 'assistant');
      if (last) {
        last.stats = stats;
        if (routed) last.route = routed;
        if (input.kind === 'message' && input.feedbackLoopId) last.feedbackLoopId = input.feedbackLoopId;
      }
      emit({ type: 'stats', stats });
      chat.messages.push(...saved);
      chat.usage.promptTokens += totals.prompt;
      chat.usage.completionTokens += totals.completion;
      chat.usage.cost += totals.cost;
      chat.usage.requests += totals.requests;
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

  /**
   * /compare: races one prompt against two models, streams both sides as compare events,
   * waits for the user to pick the winner, and saves the winning answer as the turn.
   */
  private async runCompare(
    chat: Chat,
    run: ActiveRun,
    args: string,
    rawCommand: string,
    emit: (e: StreamEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const { store, catalog } = this.deps;
    const started = Date.now();
    if (!args) throw new Error('Usage: /compare [modelA] [modelB] <prompt>');
    const knownIds = new Set((await catalog.list().catch(() => [])).map((m) => m.id));
    const parsed = parseCompareArgs(args, this.modelOf(chat), this.deps.config().compareModel, knownIds.size ? knownIds : undefined);
    if ('error' in parsed) throw new Error(parsed.error);

    // Save the user message right away, as a normal turn would.
    const userMessage: ChatMessage = { role: 'user', content: parsed.prompt, ts: Date.now(), command: rawCommand };
    chat.messages.push(userMessage);
    chat.updatedAt = now();
    store.chats.put(chat);

    const waitForPick = (outcome: CompareOutcome) =>
      new Promise<'A' | 'B' | 'skip'>((resolve) => {
        run.comparePick = (choice) => {
          run.comparePick = undefined;
          resolve(choice);
        };
        signal.addEventListener('abort', () => {
          run.comparePick = undefined;
          resolve('skip');
        }, { once: true });
        emit({ type: 'compare_pick', modelA: outcome.modelA, modelB: outcome.modelB });
      });

    const outcome = await runCompareRace({
      client: this.deps.client(),
      modelA: parsed.modelA,
      modelB: parsed.modelB,
      prompt: parsed.prompt,
      signal,
      emit,
      waitForPick,
    });

    const { winner, loser } = tallyFor(outcome);
    this.deps.compareInsights.record(winner, loser);
    const stats = { durationMs: Date.now() - started, promptTokens: 0, completionTokens: 0, cost: 0, requests: 2 };
    emit({ type: 'stats', stats });

    if (outcome.winner) {
      const winningModel = outcome.winner === 'A' ? outcome.modelA : outcome.modelB;
      const text = (outcome.winner === 'A' ? outcome.textA : outcome.textB) || '(the model returned no content)';
      chat.messages.push({ role: 'assistant', content: text, ts: Date.now(), model: winningModel, stats });
      emit({ type: 'status', message: `Winner (${winningModel}) kept as this turn's answer. The chat's model is unchanged.` });
    } else if (signal.aborted) {
      emit({ type: 'status', message: 'Race interrupted — nothing added, nothing tallied.' });
    } else {
      emit({ type: 'status', message: 'Skipped — nothing added to the conversation.' });
    }
    chat.updatedAt = now();
    store.chats.put(chat);
  }
}
