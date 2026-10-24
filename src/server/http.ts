import { timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { Config, loadConfig, MITZI_HOME, PERMISSION_MODES, PermissionMode } from '../config.js';
import { PROVIDER_PRESETS, providerView, resolveProviders, RoutingClient, usable } from '../providers.js';
import type { ProviderConfig, ProviderKind, SearchKind } from '../shared/types.js';
import type { ApprovalAnswer } from '../permissions.js';
import { APPROVAL_LEVELS, Attachment, AUTO_MODEL, BankProfile, BankSummary, Bot, BotTools, Chat, DEFAULT_BOT_ID, MemoryType, Project, PublicSettings, SettingsUpdate, StreamEvent } from '../shared/types.js';
import { toToolSpecs } from '../tools/index.js';
import { compactChat, contextBreakdown, ModelCatalog, systemPrompt } from './context.js';
import { MemoryService } from './memory/index.js';
import { listCommands } from './extensions/commands.js';
import { Plugins, syncPlugins } from './extensions/plugins.js';
import { Skills, SkillRoot } from './extensions/skills.js';
import { McpManager } from './mcp/manager.js';
import { OAuthFlows } from './mcp/oauth.js';
import { oauthCallback, registerExtensionRoutes } from './routes-ext.js';
import { ChatRunner, summarizeChat } from './runner.js';
import { CompareInsightsStore } from './compare.js';
import { MediaService } from './media.js';
import { StarterService } from './starters.js';
import { migrateDocs } from './workspace.js';
import { registerFolderRoutes } from './folders.js';
import { registerUpdateRoutes } from './routes-update.js';
import { registerImportRoutes } from './importer.js';
import { mediaUpdate, registerFeatureRoutes } from './routes-features.js';
import { newId, now, Store } from './store.js';
import { INLINE_LIMIT, KnowledgeIndex } from './knowledge.js';
import { PythonSandbox } from './python.js';
import { WorkflowTriggers } from './workflow-triggers.js';
import { registerShareRoutes, serveShare } from './shares.js';
import { Channels } from './channels/index.js';
import { budgetMessage, BudgetExceeded, budgetStatus, UsageLog } from './usage.js';
import { SearchIndex } from './search.js';
import { ComputerService, systemBackend } from './computer.js';
import { BrowserService } from './browser.js';
import { registerWorkRoutes } from './routes-work.js';
import { detectVerifyCommand } from './verify.js';
import { backfillOutcomes, OutcomeLearner, OutcomeLog } from './outcomes.js';
import { registerLearningRoutes } from './routes-learning.js';
import { EditMiner } from './edits.js';
import { LessonHygiene } from './lesson-hygiene.js';
import { ProjectKnowledge } from './project-knowledge.js';
import { Playbooks } from './playbooks.js';
import { ModelAdaptation } from './adaptation.js';
import { EvalService } from './evals.js';
import { registerWorkflowRoutes } from './routes-workflows.js';
import { WorkflowEngine, workflowTool } from './workflows.js';
import { clamp, fail, Handler, HttpError, Req, STREAMED, str } from './util.js';

export { HttpError } from './util.js';



const MAX_BODY = 25 * 1024 * 1024;
const VERSION = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
const MAX_FILE = 2 * 1024 * 1024;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

export interface AppOptions {
  dataDir: string;
  webDir: string;
  token: string;
  /** Host header values allowed (guards against DNS rebinding). */
  allowedHosts: string[];
  /** The app's own origin, e.g. http://localhost:4545 (for OAuth redirects). */
  origin: () => string;
  /** Addresses other devices on the network can open (with the token), when started with --lan. */
  lanUrls?: () => string[];
}

export function createApp(opts: AppOptions) {
  const store = new Store(opts.dataDir);
  const usage = new UsageLog(join(opts.dataDir, 'usage'), () => catalog.peek());
  const config = (): Config => loadConfig(process.cwd());
  // One router per provider configuration; rebuilt (and the model list refreshed) when it changes.
  let routing: { key: string; client: RoutingClient } | undefined;
  const router = () => {
    const providers = resolveProviders(config());
    const key = JSON.stringify(providers);
    if (routing?.key !== key) {
      routing = { key, client: new RoutingClient(providers) };
      routing.client.onUsage = (model, u) => usage.record(model, u);
      routing.client.beforeChat = () => {
        const b = budgetStatus(usage, store.settings.budget);
        if (b.state === 'over' && b.hardStop) throw new BudgetExceeded(budgetMessage(b));
      };
      catalog?.invalidate();
    }
    return routing.client;
  };
  const hasChatProvider = () => router().providers.some((p) => usable(p) && PROVIDER_PRESETS[p.kind]?.chat !== false);
  const client = () => {
    if (!hasChatProvider()) throw new HttpError(400, 'Add an API key for OpenRouter or another provider in Settings → Providers to start chatting.');
    return router();
  };
  // eslint-disable-next-line prefer-const
  let catalog: ModelCatalog = new ModelCatalog(client);
  const memory = new MemoryService(
    join(opts.dataDir, 'banks'),
    () => {
      const c = config();
      return { client: client(), model: c.model, fastModel: c.smallModel ?? c.model, embeddingModel: store.settings.embeddingModel || undefined };
    },
    () => store.settings,
    () => config().hindsightApiKey,
  );
  const mcp = new McpManager(store);
  const plugins = new Plugins(store, MITZI_HOME);
  const claudeHome = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  const skills = new Skills(
    (): SkillRoot[] => [
      { dir: join(MITZI_HOME, 'skills'), source: 'user' },
      ...(store.settings.useClaudeSkills ? [{ dir: join(claudeHome, 'skills'), source: 'claude' as const }] : []),
      ...plugins.skillRoots(),
    ],
    () => new Set(store.settings.disabledSkills),
    join(MITZI_HOME, 'skills'),
  );
  const commands = () => listCommands([{ dir: join(MITZI_HOME, 'commands'), source: 'user' }, ...plugins.commandRoots()]);
  const oauth = new OAuthFlows();
  const extensions = {
    store,
    mcp,
    oauth,
    skills,
    plugins,
    commands,
    sync: () => syncPlugins(store, plugins, mcp),
    redirectUri: () => `${opts.origin()}/api/oauth/callback`,
  };
  const media = new MediaService(opts.dataDir, router, () => store.settings.media);
  const browser = new BrowserService(join(MITZI_HOME, 'browser-profile'), media, () => !!store.settings.browserHeaded);
  const compareInsights = new CompareInsightsStore(opts.dataDir);
  const knowledge = new KnowledgeIndex();
  const python = new PythonSandbox(opts.dataDir);
  const computer = new ComputerService(systemBackend(), (bytes, mime) => media.save(bytes, mime));
  const outcomes = new OutcomeLog(join(opts.dataDir, 'outcomes'));
  const runner = new ChatRunner({ store, config, client, catalog, memory, mcp, skills, commands, media, usage, browser, compareInsights, knowledge, python, computer, outcomes });
  const hygiene = new LessonHygiene({ store, log: outcomes, client, config });
  const learner = new OutcomeLearner({ store, log: outcomes, client, config, afterLearn: (botId) => hygiene.tidy(botId) });
  const edits = new EditMiner({ store, client, config, botFor: (chat) => runner.botFor(chat), outcomes, delayMs: Number(process.env.MITZI_EDIT_LEARN_DELAY_MS) || undefined });
  runner.edits = edits;
  const projectKnowledge = new ProjectKnowledge({ store, client, config, outcomes });
  runner.projectKnowledge = projectKnowledge;
  const playbooks = new Playbooks({ store, client, config, outcomes });
  runner.playbooks = playbooks;
  const adaptation = new ModelAdaptation(() => outcomes.all());
  runner.adaptation = adaptation;
  const evals = new EvalService({ store, runner, outcomes, client, config });
  const starters = new StarterService({ store, memory, client, config, memoryOn: (bot) => runner.memoryOn(bot) });
  seedBots(store, opts.dataDir);
  ensureDefaultBot(store);
  migrateLegacyMemories(store, memory);
  migrateDocs(store);
  backfillOutcomes(outcomes, store);
  void extensions.sync().then(() => mcp.warmup());

  const routes: { method: string; re: RegExp; keys: string[]; handler: Handler }[] = [];
  const route = (method: string, path: string, handler: Handler) => {
    const keys: string[] = [];
    const re = new RegExp(`^${path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)'))}$`);
    routes.push({ method, re, keys, handler });
  };

  const getChat = (id: string) => store.chats.get(id) ?? fail(404, 'Chat not found');
  const getProject = (id: string) => store.projects.get(id) ?? fail(404, 'Project not found');
  const getBot = (id: string) => store.bots.get(id) ?? fail(404, 'Bot not found');

  // ---- Settings & models ----------------------------------------------------

  const publicSettings = (): PublicSettings => {
    const c = config();
    const { telegram: _telegram, channels: _channels, ...ui } = store.settings;
    return {
      ...ui,
      hasApiKey: hasChatProvider(),
      hasHindsightKey: !!c.hindsightApiKey,
      apiKeySource: process.env.OPENROUTER_API_KEY ? 'env' : c.apiKey ? 'config' : null,
      defaultModel: c.model,
      smallModel: c.smallModel,
      version: VERSION,
      home: MITZI_HOME,
    };
  };

  route('GET', '/api/settings', () => publicSettings());
  route('PUT', '/api/settings', ({ body }) => {
    const update = body as SettingsUpdate;
    const userConfig: Record<string, unknown> = {};
    if (typeof update.apiKey === 'string') userConfig.apiKey = update.apiKey.trim() || undefined;
    if (typeof update.defaultModel === 'string' && update.defaultModel.trim()) userConfig.model = update.defaultModel.trim();
    if (typeof update.smallModel === 'string') userConfig.smallModel = update.smallModel.trim() || undefined;
    if (typeof update.hindsightApiKey === 'string') userConfig.hindsightApiKey = update.hindsightApiKey.trim() || undefined;
    if (Object.keys(userConfig).length) writeUserConfig(userConfig);
    const ui: Partial<typeof store.settings> = {};
    if (typeof update.memoryEnabled === 'boolean') ui.memoryEnabled = update.memoryEnabled;
    if (typeof update.useClaudeSkills === 'boolean') ui.useClaudeSkills = update.useClaudeSkills;
    if (typeof update.autoCompactPercent === 'number') ui.autoCompactPercent = clamp(update.autoCompactPercent, 0, 95);
    if (typeof update.keepRecentTurns === 'number') ui.keepRecentTurns = clamp(Math.round(update.keepRecentTurns), 0, 20);
    if (update.memoryBackend === 'builtin' || update.memoryBackend === 'hindsight') ui.memoryBackend = update.memoryBackend;
    if (typeof update.hindsightUrl === 'string') {
      const url = update.hindsightUrl.trim();
      if (url && !/^https?:\/\/[^\s]+$/.test(url)) throw new HttpError(400, 'The Hindsight URL must start with http:// or https://');
      ui.hindsightUrl = url;
    }
    if (typeof update.embeddingModel === 'string') ui.embeddingModel = update.embeddingModel.trim();
    if (typeof update.autoCheckUpdates === 'boolean') ui.autoCheckUpdates = update.autoCheckUpdates;
    if (typeof update.browserHeaded === 'boolean') ui.browserHeaded = update.browserHeaded;
    if (typeof update.computerUse === 'boolean') ui.computerUse = update.computerUse;
    if (typeof update.toolTraceHints === 'boolean') ui.toolTraceHints = update.toolTraceHints;
    if (typeof update.recallTokens === 'number') ui.recallTokens = clamp(Math.round(update.recallTokens), 200, 8000);
    if (update.media) ui.media = mediaUpdate(update.media, store.settings.media);
    if (update.budget && typeof update.budget === 'object') {
      const money = (v: unknown) => (typeof v === 'number' && v > 0 ? Math.round(v * 10_000) / 10_000 : undefined);
      ui.budget = {
        daily: money(update.budget.daily),
        monthly: money(update.budget.monthly),
        alertPercent: clamp(Math.round(Number(update.budget.alertPercent) || 80), 10, 100),
        hardStop: update.budget.hardStop === true,
      };
    }
    if (update.routing && typeof update.routing === 'object') {
      const model = (v: unknown) => (typeof v === 'string' && v.trim() !== AUTO_MODEL ? v.trim() : '');
      ui.routing = { fast: model(update.routing.fast), strong: model(update.routing.strong), newChats: update.routing.newChats === true, ...(update.routing.learned === true ? { learned: true } : {}) };
    }
    if (APPROVAL_LEVELS.includes(update.approval as never)) ui.approval = update.approval;
    store.updateSettings(ui);
    return publicSettings();
  });
  route('GET', '/api/models', async () => {
    try {
      return await catalog.list();
    } catch (err: any) {
      throw err instanceof HttpError ? err : new HttpError(502, `Could not load models from OpenRouter: ${err.message}`);
    }
  });

  // ---- Providers ---------------------------------------------------------------

  const providersInConfig = (): ProviderConfig[] => (readUserConfig().providers as ProviderConfig[] | undefined) ?? [];
  const saveProviders = (list: ProviderConfig[]) => {
    writeUserConfig({ providers: list });
    catalog.invalidate();
  };
  const providerList = () => {
    const r = router();
    return r.providers.map((p) => providerView(p, { error: r.errors.get(p.id), modelCount: r.counts.get(p.id) }));
  };

  route('GET', '/api/providers', () => ({
    providers: providerList(),
    presets: (Object.keys(PROVIDER_PRESETS) as ProviderKind[]).map((kind) => {
      const { name, baseUrl, keyUrl, keyless, chat } = PROVIDER_PRESETS[kind];
      return { kind, name, baseUrl, keyUrl, keyless: !!keyless, chat };
    }),
  }));
  route('POST', '/api/providers', ({ body }) => {
    const kind = str(body?.kind) as ProviderKind;
    if (!PROVIDER_PRESETS[kind]) throw new HttpError(400, 'Unknown provider');
    const apiKey = str(body?.apiKey).trim() || undefined;
    if (kind === 'openrouter') {
      writeUserConfig({ apiKey });
      catalog.invalidate();
      return providerList();
    }
    const list = providersInConfig();
    // A configured provider replaces an environment-only one with the same id.
    const taken = new Set(list.map((p) => p.id));
    const base = (str(body?.id).trim() || kind).toLowerCase().replace(/[^a-z0-9-]+/g, '-');
    let id = base;
    for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
    const entry: ProviderConfig = {
      id,
      kind,
      name: str(body?.name).trim() || PROVIDER_PRESETS[kind].name,
      apiKey,
      baseUrl: str(body?.baseUrl).trim() || undefined,
      enabled: true,
    };
    if (kind === 'custom' && !entry.baseUrl) throw new HttpError(400, 'Enter the base URL of the OpenAI-compatible API');
    saveProviders([...list.filter((p) => p.id !== id), entry]);
    return providerList();
  });
  route('PATCH', '/api/providers/:id', ({ params, body }) => {
    if (params.id === 'openrouter') {
      if (typeof body?.apiKey === 'string') writeUserConfig({ apiKey: body.apiKey.trim() || undefined });
      catalog.invalidate();
      return providerList();
    }
    const list = providersInConfig();
    let entry = list.find((p) => p.id === params.id);
    if (!entry) {
      // A provider found only in the environment: start a config entry to hold the change.
      const env = router().providers.find((p) => p.id === params.id) ?? fail(404, 'Provider not found');
      entry = { id: env.id, kind: env.kind, name: env.name, enabled: true };
    }
    if (typeof body?.apiKey === 'string') entry.apiKey = body.apiKey.trim() || undefined;
    if (typeof body?.baseUrl === 'string') entry.baseUrl = body.baseUrl.trim() || undefined;
    if (typeof body?.name === 'string' && body.name.trim()) entry.name = body.name.trim();
    if (typeof body?.enabled === 'boolean') entry.enabled = body.enabled;
    saveProviders([...list.filter((p) => p.id !== params.id), entry]);
    return providerList();
  });
  route('DELETE', '/api/providers/:id', ({ params }) => {
    if (params.id === 'openrouter') {
      writeUserConfig({ apiKey: undefined });
    } else {
      const list = providersInConfig();
      if (!list.some((p) => p.id === params.id)) throw new HttpError(400, 'This provider comes from an environment variable; unset it to remove the provider.');
      saveProviders(list.filter((p) => p.id !== params.id));
    }
    catalog.invalidate();
    return providerList();
  });
  route('POST', '/api/providers/:id/test', async ({ params }) => {
    const r = router();
    const p = r.providers.find((x) => x.id === params.id) ?? fail(404, 'Provider not found');
    if (!usable(p)) throw new HttpError(400, `Add an API key for ${p.name} first`);
    if (PROVIDER_PRESETS[p.kind]?.chat === false) return { ok: true, count: 0 };
    try {
      const single = new RoutingClient([p, ...r.providers.filter((x) => x.kind === 'openrouter' && x.id !== p.id).map((x) => ({ ...x, enabled: false }))]);
      const models = await single.listModels();
      catalog.invalidate();
      return { ok: true, count: models.length };
    } catch (err: any) {
      throw new HttpError(502, err.message);
    }
  });

  // ---- Chats -----------------------------------------------------------------

  route('GET', '/api/chats', ({ query }) => {
    const projectId = query.get('projectId');
    return store.chats
      .all()
      .filter((c) => !projectId || c.projectId === projectId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((c) => ({ ...summarizeChat(c), running: runner.isRunning(c.id), waiting: runner.isWaiting(c.id) }));
  });
  /** A new, unsaved chat; `fields` override the defaults. */
  const newChat = (fields: Partial<Chat> = {}): Chat => {
    const bot = store.bots.get(fields.botId ?? DEFAULT_BOT_ID) ?? getBot(DEFAULT_BOT_ID);
    return {
      id: newId(),
      title: 'New chat',
      webSearch: false,
      pinned: false,
      messages: [],
      contextStart: 0,
      allowedRules: [],
      usage: { promptTokens: 0, completionTokens: 0, cost: 0, requests: 0 },
      lastPromptTokens: 0,
      createdAt: now(),
      updatedAt: now(),
      ...fields,
      botId: bot.id,
      model: fields.model || bot.model || (store.settings.routing?.newChats ? AUTO_MODEL : config().model),
    };
  };
  route('POST', '/api/chats', ({ body }) => {
    const project = body?.projectId ? getProject(body.projectId) : undefined;
    const bot = getBot(str(body?.botId) || DEFAULT_BOT_ID);
    return store.chats.put(
      newChat({
        projectId: project?.id,
        botId: bot.id,
        model: str(body?.model) || undefined,
        ...(body?.mode === 'work' ? { mode: 'work' as const } : {}),
        ...(APPROVAL_LEVELS.includes(body?.approval) ? { approval: body.approval } : {}),
      }),
    );
  });
  route('GET', '/api/chats/:id', ({ params }) => ({ ...getChat(params.id), running: runner.isRunning(params.id) }));
  route('PATCH', '/api/chats/:id', ({ params, body }) => {
    const chat = getChat(params.id);
    if (typeof body.title === 'string' && body.title.trim()) chat.title = body.title.trim().slice(0, 120);
    if (typeof body.model === 'string' && body.model.trim()) chat.model = body.model.trim();
    if (typeof body.pinned === 'boolean') chat.pinned = body.pinned;
    if (body.archived === true) chat.archivedAt = now();
    if (body.archived === false) delete chat.archivedAt;
    if (typeof body.webSearch === 'boolean') chat.webSearch = body.webSearch;
    if (body.mode === 'chat' || body.mode === 'work') chat.mode = body.mode;
    if (APPROVAL_LEVELS.includes(body.approval)) chat.approval = body.approval;
    if (body.projectId === null) chat.projectId = undefined;
    else if (typeof body.projectId === 'string') chat.projectId = getProject(body.projectId).id;
    chat.updatedAt = now();
    return summarizeChat(store.chats.put(chat));
  });
  route('DELETE', '/api/chats/:id', ({ params }) => {
    runner.stop(params.id);
    deleteChat(params.id);
    return { ok: true };
  });

  const stream = (chatId: string, input: Parameters<ChatRunner['run']>[1]) => async ({ req, res }: Req) => {
    getChat(chatId);
    if (runner.isRunning(chatId)) throw new HttpError(409, 'This chat is already responding');
    client(); // fail fast (as JSON) when no API key is set
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    // The run goes on if the browser leaves: it works in the background, and coming back follows it again.
    let open = true;
    res.on('close', () => (open = false));
    const emit = (e: StreamEvent) => {
      if (open && !res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`);
    };
    req.socket.setTimeout(0);
    try {
      await runner.run(chatId, input, emit, new AbortController().signal);
    } catch (err: any) {
      emit({ type: 'error', message: err.message });
      emit({ type: 'done' });
    }
    res.end();
    return STREAMED;
  };

  route('POST', '/api/chats/:id/messages', (r) => {
    const content = str(r.body?.content);
    const attachments: Attachment[] = Array.isArray(r.body?.attachments)
      ? r.body.attachments
          .filter((a: any) => typeof a?.name === 'string' && typeof a?.content === 'string')
          .map((a: any) => ({ name: a.name, content: a.content, kind: a.kind === 'image' ? 'image' : 'text' }))
      : [];
    if (!content.trim() && !attachments.length) throw new HttpError(400, 'Message is empty');
    const editIndex = typeof r.body?.editIndex === 'number' ? r.body.editIndex : undefined;
    const auto = ['redo', 'plan', 'goal'].includes(str(r.body?.auto)) ? (str(r.body.auto) as 'redo' | 'plan' | 'goal') : undefined;
    const feedbackLoopId = str(r.body?.feedbackLoopId) || undefined;
    // Writing in an archived chat means it's in use again.
    const chat = getChat(r.params.id);
    if (chat.archivedAt) {
      delete chat.archivedAt;
      store.chats.put(chat);
    }
    return stream(r.params.id, { kind: 'message', content, attachments, editIndex, focus: str(r.body?.focus) || undefined, auto, feedbackLoopId })(r);
  });
  /** Starts a realtime voice conversation in the chat: a short-lived key and the call address for the browser. */
  route('POST', '/api/chats/:id/realtime', async ({ params, body }) => {
    const chat = getChat(params.id);
    if (runner.isRunning(chat.id)) throw new HttpError(409, 'Wait for the response to finish first');
    // The bot's instructions and memories, and the conversation so far, so the voice picks up where the chat is.
    const history = chat.messages
      .filter((m) => (m.role === 'user' && !m.auto) || (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()))
      .slice(-20)
      .map((m) => `${m.role === 'user' ? 'User' : 'You'}: ${(typeof m.content === 'string' ? m.content : (m.content ?? []).map((p) => (p.type === 'text' ? p.text : '')).join(' ')).replace(/<attachment[\s\S]*?<\/attachment>/g, '[file]').slice(0, 1500)}`)
      .join('\n');
    const instructions =
      `${systemPrompt({ ...runner.setup(chat), toolNames: [], team: [] })}\n\n# Voice conversation\nYou are talking with the user out loud. Keep answers short and natural to listen to: no Markdown, lists or code. ` +
      `Speak the language the user speaks. You can't use tools in this conversation; if something needs them, say so and suggest continuing in the chat.` +
      (history ? `\n\n# The conversation so far\n${history}` : '');
    return media.realtimeSession(instructions.slice(0, 60_000), str(body?.voice) || undefined);
  });
  /** Saves a spoken turn of a realtime conversation to the chat. */
  route('POST', '/api/chats/:id/spoken', ({ params, body }) => {
    const chat = getChat(params.id);
    const content = str(body?.content).trim();
    if (!content || (body?.role !== 'user' && body?.role !== 'assistant')) throw new HttpError(400, 'A spoken turn needs a role and its text');
    chat.messages.push({ role: body.role, content, ts: Date.now(), spoken: true, ...(body.role === 'assistant' ? { model: store.settings.media.realtimeModel || undefined } : {}) });
    if (chat.title === 'New chat' && body.role === 'user') chat.title = content.slice(0, 60);
    chat.updatedAt = now();
    store.chats.put(chat);
    return { ok: true, count: chat.messages.length };
  });
  route('POST', '/api/chats/:id/regenerate', (r) => stream(r.params.id, { kind: 'regenerate' })(r));
  /** Queues a message while the chat is responding; `now` interrupts the response to send it right away. */
  route('POST', '/api/chats/:id/queue', ({ params, body }) => {
    getChat(params.id);
    const content = str(body?.content);
    const attachments: Attachment[] = Array.isArray(body?.attachments)
      ? body.attachments
          .filter((a: any) => typeof a?.name === 'string' && typeof a?.content === 'string')
          .map((a: any) => ({ name: a.name, content: a.content, kind: a.kind === 'image' ? 'image' : 'text' }))
      : [];
    if (!content.trim() && !attachments.length) throw new HttpError(400, 'Message is empty');
    return { queue: runner.enqueue(params.id, { content, ...(attachments.length ? { attachments } : {}) }, body?.now === true) };
  });
  route('PUT', '/api/chats/:id/queue', ({ params, body }) => {
    getChat(params.id);
    if (!Array.isArray(body?.order) || !body.order.every((id: unknown) => typeof id === 'string')) throw new HttpError(400, 'order must be a list of queued message ids');
    return { queue: runner.reorderQueue(params.id, body.order) };
  });
  route('DELETE', '/api/chats/:id/queue/:qid', ({ params }) => ({ queue: runner.dequeue(params.id, params.qid) }));
  route('POST', '/api/chats/:id/queue/:qid/now', ({ params }) => ({ queue: runner.dequeue(params.id, params.qid, true) }));
  /** Follows a running chat: what it streamed so far, then live events until it's done. */
  route('GET', '/api/chats/:id/stream', ({ params, req, res }) => {
    getChat(params.id);
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    req.socket.setTimeout(0);
    const write = (e: StreamEvent) => {
      if (res.writableEnded) return;
      res.write(`data: ${JSON.stringify(e)}\n\n`);
      if (e.type === 'done') res.end();
    };
    const detach = runner.attach(params.id, write);
    if (!detach) write({ type: 'done' });
    else res.on('close', detach);
    return STREAMED;
  });
  route('POST', '/api/chats/:id/stop', ({ params }) => ({ stopped: runner.stop(params.id) }));
  route('POST', '/api/chats/:id/compare/pick', ({ params, body }) => {
    const choice = str(body?.choice);
    if (choice !== 'A' && choice !== 'B' && choice !== 'skip') throw new HttpError(400, 'choice must be A, B or skip');
    if (!runner.resolveComparePick(params.id, choice)) throw new HttpError(404, 'No compare is waiting for a pick');
    return { ok: true };
  });
  route('GET', '/api/insights/compare', () => compareInsights.insights);
  route('POST', '/api/chats/:id/permission', ({ params, body }) => {
    const a = body?.answer;
    const answer: ApprovalAnswer =
      a === 'yes' || a === 'always' || a === 'no' ? { kind: a } : { kind: 'feedback', text: str(body?.feedback) || 'Declined' };
    if (!runner.resolvePermission(params.id, str(body?.requestId), answer)) throw new HttpError(404, 'No pending permission request');
    return { ok: true };
  });
  route('POST', '/api/chats/:id/answer', ({ params, body }) => {
    // One list of strings per question; null (or nothing) skips.
    const raw = body?.answers;
    const answers =
      raw == null
        ? null
        : Array.isArray(raw) && raw.every((a: unknown) => Array.isArray(a) && a.every((x) => typeof x === 'string'))
          ? (raw as string[][]).map((a) => a.map((x) => x.trim().slice(0, 4000)).filter(Boolean))
          : undefined;
    if (answers === undefined) throw new HttpError(400, 'answers must be a list of string lists, or null to skip');
    if (!runner.resolveQuestion(params.id, str(body?.requestId), answers)) throw new HttpError(404, 'No question is waiting for an answer');
    return { ok: true };
  });
  route('GET', '/api/chats/:id/context', async ({ params }) => {
    const chat = getChat(params.id);
    const setup = runner.setup(chat);
    const specs = toToolSpecs(runner.tools(chat, () => {}));
    return contextBreakdown(setup, specs, await catalog.contextLength(runner.modelOf(chat)));
  });
  route('POST', '/api/chats/:id/compact', async ({ params, body }) => {
    const chat = getChat(params.id);
    if (runner.isRunning(chat.id)) throw new HttpError(409, 'Wait for the response to finish first');
    const keep = typeof body?.keepRecentTurns === 'number' ? body.keepRecentTurns : store.settings.keepRecentTurns;
    const compacted = await compactChat(chat, client(), config().smallModel ?? runner.modelOf(chat), keep);
    if (compacted) store.chats.put(chat);
    return { compacted, chat: summarizeChat(chat) };
  });
  route('POST', '/api/chats/:id/uncompact', ({ params }) => {
    const chat = getChat(params.id);
    chat.contextStart = 0;
    chat.summary = undefined;
    store.chats.put(chat);
    return summarizeChat(chat);
  });

  // ---- Projects --------------------------------------------------------------

  const projectView = (p: Project) => {
    const size = knowledge.size(p);
    return {
      ...p,
      chatCount: store.chats.all().filter((c) => c.projectId === p.id).length,
      knowledge: { ...size, searched: size.chars > INLINE_LIMIT },
      verifyDetected: p.folder ? detectVerifyCommand(p.folder) : undefined,
    };
  };

  route('GET', '/api/projects', () =>
    store.projects
      .all()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(projectView),
  );
  route('POST', '/api/projects', ({ body }) => {
    const name = str(body?.name).trim();
    if (!name) throw new HttpError(400, 'Name is required');
    const project: Project = {
      id: newId(),
      name,
      description: str(body?.description),
      instructions: '',
      files: [],
      permissionMode: 'default',
      createdAt: now(),
      updatedAt: now(),
    };
    return projectView(store.projects.put(project));
  });
  route('GET', '/api/projects/:id', ({ params }) => projectView(getProject(params.id)));
  route('PATCH', '/api/projects/:id', ({ params, body }) => {
    const p = getProject(params.id);
    if (typeof body.name === 'string' && body.name.trim()) p.name = body.name.trim();
    if (typeof body.description === 'string') p.description = body.description;
    if (typeof body.instructions === 'string') p.instructions = body.instructions;
    if (body.archived === true) p.archivedAt = now();
    if (body.archived === false) delete p.archivedAt;
    if (typeof body.permissionMode === 'string') {
      if (!PERMISSION_MODES.includes(body.permissionMode)) throw new HttpError(400, 'Unknown permission mode');
      p.permissionMode = body.permissionMode as PermissionMode;
    }
    if (body.folder === null || body.folder === '') p.folder = undefined;
    else if (typeof body.folder === 'string') p.folder = validateFolder(body.folder);
    if (body.verify && typeof body.verify === 'object') {
      p.verify = {
        enabled: body.verify.enabled !== false,
        command: typeof body.verify.command === 'string' && body.verify.command.trim() ? body.verify.command.trim().slice(0, 500) : undefined,
      };
    }
    if (Array.isArray(body.knowledgeFolders)) p.knowledgeFolders = [...new Set(body.knowledgeFolders.filter((f: unknown) => typeof f === 'string').map((f: string) => validateFolder(f)))].slice(0, 10) as string[];
    p.updatedAt = now();
    return projectView(store.projects.put(p));
  });
  // Chats move out of the project unless ?chats=delete. Files in a linked folder are never touched.
  route('DELETE', '/api/projects/:id', ({ params, query }) => {
    getProject(params.id);
    const removeChats = query.get('chats') === 'delete';
    for (const c of store.chats.all()) {
      if (c.projectId !== params.id) continue;
      if (removeChats) deleteChat(c.id);
      else store.chats.put({ ...c, projectId: undefined });
    }
    for (const a of store.artifacts.all()) if (a.projectId === params.id && store.artifacts.get(a.id)) store.artifacts.put({ ...a, projectId: undefined });
    for (const t of store.tasks.all()) if (t.projectId === params.id) store.tasks.put({ ...t, projectId: undefined });
    store.projects.delete(params.id);
    store.projectMemory.delete(params.id);
    for (const p of playbooks.list(params.id)) playbooks.remove(p.id);
    rmSync(join(opts.dataDir, 'repo-tokens', `${params.id}.json`), { force: true });
    return { ok: true };
  });
  route('POST', '/api/projects/:id/files', ({ params, body }) => {
    const p = getProject(params.id);
    const name = str(body?.name).trim();
    const content = str(body?.content);
    if (!name) throw new HttpError(400, 'File name is required');
    if (Buffer.byteLength(content) > MAX_FILE) throw new HttpError(413, 'Knowledge files are limited to 2 MB of text');
    p.files.push({ id: newId(), name, content, size: Buffer.byteLength(content), addedAt: now() });
    p.updatedAt = now();
    return projectView(store.projects.put(p));
  });
  route('DELETE', '/api/projects/:id/files/:fileId', ({ params }) => {
    const p = getProject(params.id);
    p.files = p.files.filter((f) => f.id !== params.fileId);
    p.updatedAt = now();
    return projectView(store.projects.put(p));
  });

  // ---- Bots ------------------------------------------------------------------

  route('GET', '/api/bots', () => store.bots.all().sort((a, b) => Number(!!b.builtIn) - Number(!!a.builtIn) || a.name.localeCompare(b.name)));
  route('POST', '/api/bots', ({ body }) => store.bots.put(applyBot({ id: newId(), createdAt: now() } as Bot, body, true)));
  route('GET', '/api/bots/:id', ({ params }) => getBot(params.id));
  route('GET', '/api/bots/:id/starters', ({ params, query }) => starters.get(getBot(params.id), query.get('refresh') === '1', query.get('lang') === 'he' ? 'Hebrew' : ''));
  route('PATCH', '/api/bots/:id', ({ params, body }) => store.bots.put(applyBot(getBot(params.id), body, false)));
  route('DELETE', '/api/bots/:id', async ({ params }) => {
    const bot = getBot(params.id);
    if (bot.builtIn) throw new HttpError(400, 'The default bot can’t be deleted.');
    // Its memory bank goes with it (an external Hindsight server keeps its copy).
    await memory.builtin.clear(memory.bankFor(bot)).catch(() => {});
    store.bots.delete(params.id);
    return { ok: true };
  });

  // ---- Artifacts -------------------------------------------------------------

  route('GET', '/api/artifacts', ({ query }) => {
    const chatId = query.get('chatId');
    const projectId = query.get('projectId');
    return store.artifacts
      .all()
      .filter((a) => (!chatId || a.chatId === chatId) && (!projectId || a.projectId === projectId))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((a) => ({ ...a, chatTitle: store.chats.get(a.chatId)?.title }));
  });
  route('GET', '/api/artifacts/:id', ({ params }) => {
    const a = store.artifacts.get(params.id) ?? fail(404, 'Artifact not found');
    return { ...a, chatTitle: store.chats.get(a.chatId)?.title, running: runner.isRunning(a.chatId) };
  });
  route('DELETE', '/api/artifacts/:id', ({ params }) => {
    // Its share links go with it.
    for (const s of store.shares.all()) if (s.targetId === params.id) store.shares.delete(s.id);
    return { ok: store.artifacts.delete(params.id) };
  });

  // ---- Memory banks ----------------------------------------------------------

  const bankOf = (botId: string) => memory.bankFor(getBot(botId));
  const MEMORY_TYPES: MemoryType[] = ['world', 'experience', 'observation'];

  route('GET', '/api/banks', async () => {
    const bots = store.bots.all().sort((a, b) => Number(!!b.builtIn) - Number(!!a.builtIn) || a.name.localeCompare(b.name));
    const backend = memory.backend();
    return Promise.all(
      bots.map(async (bot): Promise<BankSummary> => {
        const summary: BankSummary = { bot: { id: bot.id, name: bot.name, emoji: bot.emoji, builtIn: bot.builtIn }, enabled: bot.tools.memory };
        try {
          summary.stats = await backend.stats(memory.bankFor(bot));
        } catch (err: any) {
          summary.error = err.message;
        }
        return summary;
      }),
    );
  });
  route('GET', '/api/banks/:botId/memories', async ({ params, query }) => {
    const type = query.get('type') as MemoryType | null;
    return memory.backend().list(bankOf(params.botId), {
      type: type && MEMORY_TYPES.includes(type) ? type : undefined,
      q: query.get('q') ?? undefined,
      limit: clamp(Number(query.get('limit')) || 50, 1, 200),
      offset: Math.max(0, Number(query.get('offset')) || 0),
    });
  });
  route('POST', '/api/banks/:botId/memories', async ({ params, body }) => {
    const content = str(body?.content).trim();
    if (!content) throw new HttpError(400, 'Memory is empty');
    await memory.backend().remember(bankOf(params.botId), content, 'user');
    return { ok: true };
  });
  route('PATCH', '/api/banks/:botId/memories/:id', async ({ params, body }) => {
    const text = str(body?.text).trim();
    if (!text) throw new HttpError(400, 'Memory is empty');
    await memory.backend().update(bankOf(params.botId), params.id, text);
    return { ok: true };
  });
  route('DELETE', '/api/banks/:botId/memories/:id', async ({ params }) => {
    await memory.backend().forget(bankOf(params.botId), params.id);
    return { ok: true };
  });
  route('POST', '/api/banks/:botId/recall', async ({ params, body }) => {
    const q = str(body?.query).trim();
    if (!q) throw new HttpError(400, 'Query is empty');
    return memory.backend().recall(bankOf(params.botId), q, { maxTokens: 4000, limit: 25, includeCore: false });
  });
  route('POST', '/api/banks/:botId/reflect', async ({ params, body }) => {
    const q = str(body?.query).trim();
    if (!q) throw new HttpError(400, 'Question is empty');
    return memory.backend().reflect(bankOf(params.botId), q);
  });
  route('DELETE', '/api/banks/:botId', async ({ params }) => {
    await memory.backend().clear(bankOf(params.botId));
    return { ok: true };
  });
  route('POST', '/api/memory/test', async ({ body }) => {
    const url = str(body?.url).trim() || store.settings.hindsightUrl;
    if (!url) throw new HttpError(400, 'Enter the Hindsight server URL first');
    try {
      await memory.hindsight(url, str(body?.apiKey).trim() || config().hindsightApiKey).check();
    } catch (err: any) {
      throw new HttpError(502, err.cause?.code === 'ECONNREFUSED' ? `Nothing is listening at ${url}` : err.message);
    }
    return { ok: true };
  });

  registerExtensionRoutes(route, extensions);
  registerFolderRoutes(route, store, projectView);
  const updates = registerUpdateRoutes(route, store);
  registerImportRoutes(route, { store, memory, client, config, newChat, memoryOn: (bot) => runner.memoryOn(bot) });
  const workflows = new WorkflowEngine({ store, runner, media, memory, newChat, python });
  runner.extraTools = () => {
    const tool = workflowTool(store, workflows);
    return tool ? [tool] : [];
  };
  registerShareRoutes(route, store);
  const triggers = new WorkflowTriggers(store, workflows);
  triggers.start();
  registerWorkflowRoutes(route, { store, engine: workflows, client, config, triggers, validateFolder });
  const { scheduler } = registerFeatureRoutes(route, { store, runner, client, config, memory, media, newChat, workflows, edits });

  // ---- Messaging (Telegram, Discord, Slack, WhatsApp, email) --------------------------------
  const channels = new Channels({ store, runner, media, workflows, newChat }, { apiBase: { telegram: process.env.MITZI_TELEGRAM_API, discord: process.env.MITZI_DISCORD_API, slack: process.env.MITZI_SLACK_API, whatsapp: process.env.MITZI_WHATSAPP_API } });
  channels.start();
  scheduler.finishedListeners.add((task) => {
    const run = task.runs.at(-1);
    if (run) channels.notify(`${run.status === 'error' ? '⚠️' : '✅'} “${task.name}” ${run.status === 'error' ? `failed: ${run.error}` : `is done.${run.preview ? `\n\n${run.preview}` : ''}`}`);
  });
  route('GET', '/api/channels', () => [...channels.hubs.values()].map((h) => h.view()));
  route('PUT', '/api/channels/:kind', async ({ params, body }) => {
    const hub = channels.get(params.kind) ?? fail(404, 'Unknown messaging service');
    try {
      await hub.update(body ?? {});
    } catch (err) {
      throw new HttpError((err as { status?: number }).status ?? 500, (err as Error).message);
    }
    return hub.view();
  });
  registerWorkRoutes(route, { store, runner, client, config, memory, usage });
  registerLearningRoutes(route, { store, outcomes, learner, projectKnowledge, hygiene, playbooks, adaptation, evals });

  // Search across chats, artifacts and memories.
  const search = new SearchIndex(join(opts.dataDir, 'search'), store, memory, () => {
    const model = store.settings.embeddingModel;
    if (!model || !hasChatProvider()) return undefined;
    return { client: router(), model };
  });
  route('GET', '/api/phone', () => ({ lan: !!opts.lanUrls?.().length, urls: opts.lanUrls?.() ?? [] }));
  route('GET', '/api/budget', () => budgetStatus(usage, store.settings.budget));
  route('GET', '/api/search', async ({ query }) => {
    const q = (query.get('q') ?? '').trim();
    if (!q) return { hits: [], semantic: false };
    const kinds = (query.get('kinds') ?? '').split(',').filter((k): k is SearchKind => k === 'message' || k === 'artifact' || k === 'memory');
    return search.search(q.slice(0, 500), { kinds, projectId: query.get('projectId') || undefined, botId: query.get('botId') || undefined, limit: 60 });
  });
  scheduler.start();
  learner.start();

  // ---- Helpers ---------------------------------------------------------------

  function deleteChat(id: string) {
    // Share links of the chat and its artifacts stop working.
    const gone = new Set([id, ...store.artifacts.all().filter((a) => a.chatId === id).map((a) => a.id)]);
    for (const s of store.shares.all()) if (gone.has(s.targetId)) store.shares.delete(s.id);
    for (const a of store.artifacts.all()) if (a.chatId === id) store.artifacts.delete(a.id);
    store.chats.delete(id);
  }

  // ---- Request handling ------------------------------------------------------

  const tokenBuf = Buffer.from(opts.token);
  const validToken = (t: string | undefined) => {
    const b = Buffer.from(t ?? '');
    return b.length === tokenBuf.length && timingSafeEqual(b, tokenBuf);
  };

  const handle = async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // Webhooks come from other services (through a tunnel or proxy, so any host); the secret in the address authenticates them.
    if (url.pathname.startsWith('/hooks/channels/')) return channels.webhook(url.pathname.slice(16), req, res);
    if (url.pathname.startsWith('/hooks/')) return triggers.webhook(decodeURIComponent(url.pathname.slice(7)), req, res);
    // Share links are for other people (on your network or through a tunnel); the secret in the address is the key.
    if (url.pathname.startsWith('/s/') && req.method === 'GET') return serveShare(store, url.pathname.slice(3), res);
    if (!opts.allowedHosts.includes((req.headers.host ?? '').toLowerCase())) {
      return sendJson(res, 403, { error: 'Forbidden host' });
    }

    // Generated media have unguessable names, so <img> and <video> tags can load them without the token.
    if (url.pathname.startsWith('/media/')) return serveMedia(media, url.pathname.slice(7), req, res);
    // The app manifest, with a start address that signs in (only for whoever already has the token).
    if (url.pathname === '/manifest.webmanifest' && validToken(url.searchParams.get('token') ?? undefined)) {
      try {
        const manifest = JSON.parse(readFileSync(join(opts.webDir, 'manifest.webmanifest'), 'utf8'));
        res.writeHead(200, { 'content-type': 'application/manifest+json', 'cache-control': 'no-store' });
        return void res.end(JSON.stringify({ ...manifest, start_url: `/?token=${opts.token}` }));
      } catch {
        // Not built; fall through to the static file.
      }
    }
    if (url.pathname === '/sw.js') res.setHeader('service-worker-allowed', '/');
    if (!url.pathname.startsWith('/api/')) return serveStatic(opts.webDir, url.pathname, res);
    // OAuth providers redirect the browser here; the one-time state value authenticates it.
    if (url.pathname === '/api/oauth/callback' && req.method === 'GET') return oauthCallback(extensions, url, res);

    // A custom header can't be sent cross-origin without a CORS preflight, which we never grant.
    if (!validToken(req.headers['x-mitzi-token'] as string | undefined)) {
      return sendJson(res, 401, { error: 'Missing or invalid access token. Open Mitzi using the link printed in your terminal.' });
    }

    const match = routes
      .filter((r) => r.method === req.method)
      .map((r) => ({ r, m: r.re.exec(url.pathname) }))
      .find((x) => x.m);
    if (!match) return sendJson(res, 404, { error: 'Not found' });

    try {
      const params = Object.fromEntries(match.r.keys.map((k, i) => [k, decodeURIComponent(match.m![i + 1])]));
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
      const result = await match.r.handler({ params, query: url.searchParams, body, req, res });
      if (result !== STREAMED) sendJson(res, 200, result);
    } catch (err: any) {
      if (res.headersSent) return void res.end();
      const status = err instanceof HttpError ? err.status : err?.status && Number.isInteger(err.status) ? 502 : 500;
      sendJson(res, status, { error: err?.message ?? 'Internal error' });
    }
  };
  return Object.assign(handle, {
    dispose: () => {
      scheduler.stop();
      learner.stop();
      edits.stop();
      triggers.stop();
      channels.stop();
      void browser.close();
      python.close();
      updates.dispose();
      return mcp.dispose();
    },
  });
}




function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data ?? null);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(webDir: string, pathname: string, res: ServerResponse): void {
  const root = resolve(webDir);
  let file = normalize(join(root, decodeURIComponent(pathname)));
  if (!file.startsWith(root + sep) && file !== root) return sendJson(res, 403, { error: 'Forbidden' });
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html'); // SPA fallback
  if (!existsSync(file)) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    return void res.end('The web UI has not been built. Run `npm run build`.');
  }
  const immutable = file.includes(`${sep}assets${sep}`);
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(readFileSync(file));
}

function serveMedia(media: MediaService, name: string, req: IncomingMessage, res: ServerResponse): void {
  if (!media.exists(name)) return sendJson(res, 404, { error: 'Not found' });
  const file = join(media.dir, name);
  const size = statSync(file).size;
  const headers = {
    'content-type': MEDIA_MIME[extname(name)] ?? 'application/octet-stream',
    'cache-control': 'private, max-age=31536000, immutable',
    'accept-ranges': 'bytes',
    'x-content-type-options': 'nosniff',
  };
  // Video seeking needs range requests.
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      res.writeHead(416, { 'content-range': `bytes */${size}` });
      return void res.end();
    }
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
    return void createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'content-length': size });
  createReadStream(file).pipe(res);
}

const MEDIA_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
};

function validateFolder(input: string): string {
  const path = resolve(input.trim().replace(/^~(?=$|\/)/, homedir()));
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new HttpError(400, `Not a directory: ${path}`);
  return path;
}

function readUserConfig(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(join(MITZI_HOME, 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

function writeUserConfig(patch: Record<string, unknown>): void {
  const path = join(MITZI_HOME, 'config.json');
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // Missing or unreadable: start fresh.
  }
  const next = { ...current, ...patch };
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
  mkdirSync(MITZI_HOME, { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2), { mode: 0o600 });
}

function applyBot(bot: Bot, body: any, creating: boolean): Bot {
  const name = str(body?.name).trim();
  if (creating && !name) throw new HttpError(400, 'Name is required');
  if (name) bot.name = name.slice(0, 60);
  if (creating || typeof body?.emoji === 'string') bot.emoji = str(body?.emoji).trim().slice(0, 8) || '🤖';
  if (creating || typeof body?.description === 'string') bot.description = str(body?.description);
  if (creating || typeof body?.systemPrompt === 'string') bot.systemPrompt = str(body?.systemPrompt);
  if (body?.model !== undefined) bot.model = str(body.model).trim() || undefined;
  if (body?.temperature !== undefined) {
    const t = Number(body.temperature);
    bot.temperature = body.temperature === null || body.temperature === '' || Number.isNaN(t) ? undefined : clamp(t, 0, 2);
  }
  if (typeof body?.selfReview === 'boolean') bot.selfReview = body.selfReview || undefined;
  const tools: Partial<BotTools> = body?.tools ?? {};
  bot.tools = {
    artifacts: tools.artifacts ?? bot.tools?.artifacts ?? true,
    web: tools.web ?? bot.tools?.web ?? true,
    memory: tools.memory ?? bot.tools?.memory ?? true,
    skills: tools.skills ?? bot.tools?.skills ?? true,
    connectors: tools.connectors ?? bot.tools?.connectors ?? true,
    media: tools.media ?? bot.tools?.media ?? true,
    team: tools.team ?? bot.tools?.team ?? true,
    subagents: tools.subagents ?? bot.tools?.subagents ?? true,
    code: tools.code ?? bot.tools?.code ?? true,
    browser: tools.browser ?? bot.tools?.browser ?? true,
    computer: tools.computer ?? bot.tools?.computer ?? true,
  };
  if (creating || Array.isArray(body?.starters)) {
    bot.starters = (Array.isArray(body?.starters) ? body.starters : []).filter((s: unknown) => typeof s === 'string' && s.trim()).slice(0, 6);
  }
  bot.memory = bankProfile(body?.memory, bot.memory);
  bot.updatedAt = now();
  return bot;
}

const trait = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? clamp(Math.round(v), 1, 5) : fallback);

function bankProfile(input: any, current?: BankProfile): BankProfile {
  const base: BankProfile = current ?? { mission: '', disposition: { skepticism: 3, literalism: 3, empathy: 3 }, autoRetain: true };
  return {
    mission: typeof input?.mission === 'string' ? input.mission.slice(0, 2000) : base.mission,
    disposition: {
      skepticism: trait(input?.disposition?.skepticism, base.disposition.skepticism),
      literalism: trait(input?.disposition?.literalism, base.disposition.literalism),
      empathy: trait(input?.disposition?.empathy, base.disposition.empathy),
    },
    autoRetain: typeof input?.autoRetain === 'boolean' ? input.autoRetain : base.autoRetain,
  };
}

const DEFAULT_STARTERS = [
  'Explain how transformers work, with a diagram',
  'Build an interactive pomodoro timer as a React component',
  'Help me write a polite follow-up email',
  'Brainstorm names for a coffee shop with a cat theme',
];

/** Makes sure the built-in default bot exists, and that older bots have a memory profile. */
/** Mitzi's logo, also the default bot's icon. */
const LOGO = '🐱';

function ensureDefaultBot(store: Store): void {
  for (const bot of store.bots.all()) {
    if (!bot.memory || bot.tools.skills === undefined || bot.tools.connectors === undefined) {
      store.bots.put({ ...bot, memory: bot.memory ?? bankProfile(undefined), tools: { ...bot.tools, skills: bot.tools.skills ?? true, connectors: bot.tools.connectors ?? true } });
    }
  }
  const existing = store.bots.get(DEFAULT_BOT_ID);
  // The default bot's icon used to be ✻.
  if (existing?.emoji === '✻') store.bots.put({ ...existing, emoji: LOGO });
  if (existing) return;
  store.bots.put({
    id: DEFAULT_BOT_ID,
    builtIn: true,
    name: 'Mitzi',
    emoji: LOGO,
    description: 'Your everyday assistant. It remembers what matters across conversations.',
    systemPrompt: 'You are helpful, knowledgeable and candid. Think things through, admit uncertainty, and get to the point.',
    tools: { artifacts: true, web: true, memory: true, skills: true, connectors: true },
    starters: DEFAULT_STARTERS,
    memory: {
      mission: "Get to know the user: who they are, what they're working on, their preferences, goals and the people in their life, so future help is personal and needs less explaining.",
      disposition: { skepticism: 3, literalism: 3, empathy: 4 },
      autoRetain: true,
    },
    createdAt: now(),
    updatedAt: now(),
  });
}

/** Moves memories from the old global list into the default bot's bank. */
function migrateLegacyMemories(store: Store, memory: MemoryService): void {
  const legacy = store.legacyMemories.all();
  if (!legacy.length) return;
  const bank = memory.bankFor(store.bots.get(DEFAULT_BOT_ID)!);
  for (const m of legacy) {
    void memory.builtin.remember(bank, m.content, m.source);
    store.legacyMemories.delete(m.id);
  }
}

function seedBots(store: Store, dataDir: string): void {
  const marker = join(dataDir, '.seeded');
  if (existsSync(marker)) return;
  writeFileSync(marker, now());
  if (store.bots.all().some((b) => !b.builtIn)) return;
  const seeds: Omit<Bot, 'id' | 'createdAt' | 'updatedAt'>[] = [
    {
      name: 'Code Reviewer',
      emoji: '🧐',
      description: 'Reviews code for bugs, security issues and clarity.',
      systemPrompt:
        'You are a meticulous senior engineer reviewing code. Look first for correctness bugs, security issues and edge cases, then for clarity and maintainability. ' +
        'Be specific: quote the line, explain the problem, and show the fix. Rank findings by severity and skip nitpicks unless asked.',
      tools: { artifacts: true, web: false, memory: true, skills: true, connectors: false },
      memory: { mission: "Remember the user's codebases, languages, conventions and recurring mistakes.", disposition: { skepticism: 4, literalism: 4, empathy: 2 }, autoRetain: true },
      starters: ['Review this function for bugs:', 'Is this SQL query safe from injection?', 'How can I make this code easier to test?'],
    },
    {
      name: 'Writing Coach',
      emoji: '✍️',
      description: 'Tightens prose and gives candid feedback on drafts.',
      systemPrompt:
        'You are an experienced editor. Help the user write clearly and concisely. When given a draft, first give two or three high-level observations, ' +
        'then a revised version. Preserve the author\'s voice; cut filler, hedging and jargon. Explain the reasoning behind significant edits.',
      tools: { artifacts: true, web: false, memory: true, skills: true, connectors: false },
      memory: { mission: "Remember the user's writing projects, voice, audience and the feedback they found useful.", disposition: { skepticism: 2, literalism: 2, empathy: 4 }, autoRetain: true },
      starters: ['Tighten this paragraph:', 'Give me feedback on my cover letter', 'Rewrite this email to sound friendlier'],
    },
    {
      name: 'Socratic Tutor',
      emoji: '🦉',
      description: 'Teaches by asking questions instead of handing out answers.',
      systemPrompt:
        'You are a patient tutor who uses the Socratic method. Never give the final answer outright. Ask one guiding question at a time, ' +
        'check the learner\'s understanding, offer hints when they are stuck, and celebrate progress. Adapt to their level.',
      tools: { artifacts: true, web: true, memory: true, skills: true, connectors: false },
      memory: { mission: 'Track what the learner understands, where they struggle and how they learn best.', disposition: { skepticism: 3, literalism: 2, empathy: 5 }, autoRetain: true },
      starters: ['Help me understand recursion', 'Why does the moon have phases?', 'Teach me how compound interest works'],
    },
  ];
  for (const seed of seeds) store.bots.put({ ...seed, id: newId(), createdAt: now(), updatedAt: now() });
}
