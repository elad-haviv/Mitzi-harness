import { timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { Config, loadConfig, MITZI_HOME, PERMISSION_MODES, PermissionMode } from '../config.js';
import { OpenRouterClient } from '../openrouter.js';
import type { ApprovalAnswer } from '../permissions.js';
import { Attachment, BankProfile, BankSummary, Bot, BotTools, Chat, DEFAULT_BOT_ID, MemoryType, Project, PublicSettings, SettingsUpdate, StreamEvent } from '../shared/types.js';
import { toToolSpecs } from '../tools/index.js';
import { compactChat, contextBreakdown, ModelCatalog } from './context.js';
import { MemoryService } from './memory/index.js';
import { listCommands } from './extensions/commands.js';
import { Plugins, syncPlugins } from './extensions/plugins.js';
import { Skills, SkillRoot } from './extensions/skills.js';
import { McpManager } from './mcp/manager.js';
import { OAuthFlows } from './mcp/oauth.js';
import { oauthCallback, registerExtensionRoutes } from './routes-ext.js';
import { ChatRunner, summarizeChat } from './runner.js';
import { newId, now, Store } from './store.js';
import { clamp, fail, Handler, HttpError, Req, STREAMED, str } from './util.js';

export { HttpError } from './util.js';



const MAX_BODY = 25 * 1024 * 1024;
const MAX_FILE = 2 * 1024 * 1024;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

export interface AppOptions {
  dataDir: string;
  webDir: string;
  token: string;
  /** Host header values allowed (guards against DNS rebinding). */
  allowedHosts: string[];
  /** The app's own origin, e.g. http://localhost:4545 (for OAuth redirects). */
  origin: () => string;
}

export function createApp(opts: AppOptions) {
  const store = new Store(opts.dataDir);
  const config = (): Config => loadConfig(process.cwd());
  const client = () => {
    const c = config();
    if (!c.apiKey) throw new HttpError(400, 'Add your OpenRouter API key in Settings to start chatting.');
    return new OpenRouterClient({ apiKey: c.apiKey, baseUrl: c.baseUrl });
  };
  const catalog = new ModelCatalog(client);
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
  const runner = new ChatRunner({ store, config, client, catalog, memory, mcp, skills, commands });
  seedBots(store, opts.dataDir);
  ensureDefaultBot(store);
  migrateLegacyMemories(store, memory);
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
    return {
      ...store.settings,
      hasApiKey: !!c.apiKey,
      hasHindsightKey: !!c.hindsightApiKey,
      apiKeySource: process.env.OPENROUTER_API_KEY ? 'env' : c.apiKey ? 'config' : null,
      defaultModel: c.model,
      smallModel: c.smallModel,
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
    if (typeof update.recallTokens === 'number') ui.recallTokens = clamp(Math.round(update.recallTokens), 200, 8000);
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

  // ---- Chats -----------------------------------------------------------------

  route('GET', '/api/chats', ({ query }) => {
    const projectId = query.get('projectId');
    return store.chats
      .all()
      .filter((c) => !projectId || c.projectId === projectId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((c) => ({ ...summarizeChat(c), running: runner.isRunning(c.id) }));
  });
  route('POST', '/api/chats', ({ body }) => {
    const project = body?.projectId ? getProject(body.projectId) : undefined;
    const bot = getBot(str(body?.botId) || DEFAULT_BOT_ID);
    const chat: Chat = {
      id: newId(),
      title: 'New chat',
      projectId: project?.id,
      botId: bot.id,
      model: str(body?.model) || bot.model || config().model,
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
    return store.chats.put(chat);
  });
  route('GET', '/api/chats/:id', ({ params }) => ({ ...getChat(params.id), running: runner.isRunning(params.id) }));
  route('PATCH', '/api/chats/:id', ({ params, body }) => {
    const chat = getChat(params.id);
    if (typeof body.title === 'string' && body.title.trim()) chat.title = body.title.trim().slice(0, 120);
    if (typeof body.model === 'string' && body.model.trim()) chat.model = body.model.trim();
    if (typeof body.pinned === 'boolean') chat.pinned = body.pinned;
    if (typeof body.webSearch === 'boolean') chat.webSearch = body.webSearch;
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
    const disconnect = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) disconnect.abort();
    });
    const emit = (e: StreamEvent) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`);
    };
    req.socket.setTimeout(0);
    try {
      await runner.run(chatId, input, emit, disconnect.signal);
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
    return stream(r.params.id, { kind: 'message', content, attachments, editIndex })(r);
  });
  route('POST', '/api/chats/:id/regenerate', (r) => stream(r.params.id, { kind: 'regenerate' })(r));
  route('POST', '/api/chats/:id/stop', ({ params }) => ({ stopped: runner.stop(params.id) }));
  route('POST', '/api/chats/:id/permission', ({ params, body }) => {
    const a = body?.answer;
    const answer: ApprovalAnswer =
      a === 'yes' || a === 'always' || a === 'no' ? { kind: a } : { kind: 'feedback', text: str(body?.feedback) || 'Declined' };
    if (!runner.resolvePermission(params.id, str(body?.requestId), answer)) throw new HttpError(404, 'No pending permission request');
    return { ok: true };
  });
  route('GET', '/api/chats/:id/context', async ({ params }) => {
    const chat = getChat(params.id);
    const setup = runner.setup(chat);
    const specs = toToolSpecs(runner.tools(chat, () => {}));
    return contextBreakdown(setup, specs, await catalog.contextLength(chat.model));
  });
  route('POST', '/api/chats/:id/compact', async ({ params, body }) => {
    const chat = getChat(params.id);
    if (runner.isRunning(chat.id)) throw new HttpError(409, 'Wait for the response to finish first');
    const keep = typeof body?.keepRecentTurns === 'number' ? body.keepRecentTurns : store.settings.keepRecentTurns;
    const compacted = await compactChat(chat, client(), config().smallModel ?? chat.model, keep);
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

  const projectView = (p: Project) => ({ ...p, chatCount: store.chats.all().filter((c) => c.projectId === p.id).length });

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
    if (typeof body.permissionMode === 'string') {
      if (!PERMISSION_MODES.includes(body.permissionMode)) throw new HttpError(400, 'Unknown permission mode');
      p.permissionMode = body.permissionMode as PermissionMode;
    }
    if (body.folder === null || body.folder === '') p.folder = undefined;
    else if (typeof body.folder === 'string') p.folder = validateFolder(body.folder);
    p.updatedAt = now();
    return projectView(store.projects.put(p));
  });
  route('DELETE', '/api/projects/:id', ({ params }) => {
    getProject(params.id);
    for (const c of store.chats.all()) if (c.projectId === params.id) deleteChat(c.id);
    store.projects.delete(params.id);
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
  route('GET', '/api/artifacts/:id', ({ params }) => store.artifacts.get(params.id) ?? fail(404, 'Artifact not found'));
  route('DELETE', '/api/artifacts/:id', ({ params }) => ({ ok: store.artifacts.delete(params.id) }));

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

  // ---- Helpers ---------------------------------------------------------------

  function deleteChat(id: string) {
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
    if (!opts.allowedHosts.includes((req.headers.host ?? '').toLowerCase())) {
      return sendJson(res, 403, { error: 'Forbidden host' });
    }

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
  return Object.assign(handle, { dispose: () => mcp.dispose() });
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

function validateFolder(input: string): string {
  const path = resolve(input.trim().replace(/^~(?=$|\/)/, homedir()));
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new HttpError(400, `Not a directory: ${path}`);
  return path;
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
  const tools: Partial<BotTools> = body?.tools ?? {};
  bot.tools = {
    artifacts: tools.artifacts ?? bot.tools?.artifacts ?? true,
    web: tools.web ?? bot.tools?.web ?? true,
    memory: tools.memory ?? bot.tools?.memory ?? true,
    skills: tools.skills ?? bot.tools?.skills ?? true,
    connectors: tools.connectors ?? bot.tools?.connectors ?? true,
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
function ensureDefaultBot(store: Store): void {
  for (const bot of store.bots.all()) {
    if (!bot.memory || bot.tools.skills === undefined || bot.tools.connectors === undefined) {
      store.bots.put({ ...bot, memory: bot.memory ?? bankProfile(undefined), tools: { ...bot.tools, skills: bot.tools.skills ?? true, connectors: bot.tools.connectors ?? true } });
    }
  }
  if (store.bots.get(DEFAULT_BOT_ID)) return;
  store.bots.put({
    id: DEFAULT_BOT_ID,
    builtIn: true,
    name: 'Mitzi',
    emoji: '✻',
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
