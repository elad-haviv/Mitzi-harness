import { timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { Config, loadConfig, MITZI_HOME, PERMISSION_MODES, PermissionMode } from '../config.js';
import { OpenRouterClient } from '../openrouter.js';
import type { ApprovalAnswer } from '../permissions.js';
import type { Attachment, Bot, BotTools, Chat, Memory, Project, PublicSettings, SettingsUpdate, StreamEvent } from '../shared/types.js';
import { toToolSpecs } from '../tools/index.js';
import { compactChat, contextBreakdown, ModelCatalog } from './context.js';
import { ChatRunner, summarizeChat } from './runner.js';
import { newId, now, Store } from './store.js';

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

interface Req {
  params: Record<string, string>;
  query: URLSearchParams;
  body: any;
  req: IncomingMessage;
  res: ServerResponse;
}

type Handler = (r: Req) => unknown | Promise<unknown>;

/** Returned by handlers that write the response themselves (SSE). */
const STREAMED = Symbol('streamed');

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
  const runner = new ChatRunner({ store, config, client, catalog });
  seedBots(store, opts.dataDir);

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
    if (Object.keys(userConfig).length) writeUserConfig(userConfig);
    const ui: Partial<typeof store.settings> = {};
    if (typeof update.memoryEnabled === 'boolean') ui.memoryEnabled = update.memoryEnabled;
    if (typeof update.autoCompactPercent === 'number') ui.autoCompactPercent = clamp(update.autoCompactPercent, 0, 95);
    if (typeof update.keepRecentTurns === 'number') ui.keepRecentTurns = clamp(Math.round(update.keepRecentTurns), 0, 20);
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
    const bot = body?.botId ? getBot(body.botId) : undefined;
    const chat: Chat = {
      id: newId(),
      title: 'New chat',
      projectId: project?.id,
      botId: bot?.id,
      model: str(body?.model) || bot?.model || config().model,
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
    for (const m of store.memories.all()) if (m.projectId === params.id) store.memories.delete(m.id);
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

  route('GET', '/api/bots', () => store.bots.all().sort((a, b) => a.name.localeCompare(b.name)));
  route('POST', '/api/bots', ({ body }) => store.bots.put(applyBot({ id: newId(), createdAt: now() } as Bot, body, true)));
  route('GET', '/api/bots/:id', ({ params }) => getBot(params.id));
  route('PATCH', '/api/bots/:id', ({ params, body }) => store.bots.put(applyBot(getBot(params.id), body, false)));
  route('DELETE', '/api/bots/:id', ({ params }) => {
    getBot(params.id);
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

  // ---- Memory ----------------------------------------------------------------

  route('GET', '/api/memories', () => store.memories.all().sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  route('POST', '/api/memories', ({ body }) => {
    const content = str(body?.content).trim();
    if (!content) throw new HttpError(400, 'Memory is empty');
    const memory: Memory = {
      id: newId(),
      content,
      projectId: body?.projectId ? getProject(body.projectId).id : undefined,
      source: 'user',
      createdAt: now(),
    };
    return store.memories.put(memory);
  });
  route('PATCH', '/api/memories/:id', ({ params, body }) => {
    const m = store.memories.get(params.id) ?? fail(404, 'Memory not found');
    if (typeof body?.content === 'string' && body.content.trim()) m.content = body.content.trim();
    return store.memories.put(m);
  });
  route('DELETE', '/api/memories/:id', ({ params }) => ({ ok: store.memories.delete(params.id) }));

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

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!opts.allowedHosts.includes((req.headers.host ?? '').toLowerCase())) {
      return sendJson(res, 403, { error: 'Forbidden host' });
    }

    if (!url.pathname.startsWith('/api/')) return serveStatic(opts.webDir, url.pathname, res);

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
}

function fail(status: number, message: string): never {
  throw new HttpError(status, message);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
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
  };
  if (creating || Array.isArray(body?.starters)) {
    bot.starters = (Array.isArray(body?.starters) ? body.starters : []).filter((s: unknown) => typeof s === 'string' && s.trim()).slice(0, 6);
  }
  bot.updatedAt = now();
  return bot;
}

function seedBots(store: Store, dataDir: string): void {
  const marker = join(dataDir, '.seeded');
  if (existsSync(marker)) return;
  writeFileSync(marker, now());
  if (store.bots.all().length) return;
  const seeds: Omit<Bot, 'id' | 'createdAt' | 'updatedAt'>[] = [
    {
      name: 'Code Reviewer',
      emoji: '🧐',
      description: 'Reviews code for bugs, security issues and clarity.',
      systemPrompt:
        'You are a meticulous senior engineer reviewing code. Look first for correctness bugs, security issues and edge cases, then for clarity and maintainability. ' +
        'Be specific: quote the line, explain the problem, and show the fix. Rank findings by severity and skip nitpicks unless asked.',
      tools: { artifacts: true, web: false, memory: false },
      starters: ['Review this function for bugs:', 'Is this SQL query safe from injection?', 'How can I make this code easier to test?'],
    },
    {
      name: 'Writing Coach',
      emoji: '✍️',
      description: 'Tightens prose and gives candid feedback on drafts.',
      systemPrompt:
        'You are an experienced editor. Help the user write clearly and concisely. When given a draft, first give two or three high-level observations, ' +
        'then a revised version. Preserve the author\'s voice; cut filler, hedging and jargon. Explain the reasoning behind significant edits.',
      tools: { artifacts: true, web: false, memory: true },
      starters: ['Tighten this paragraph:', 'Give me feedback on my cover letter', 'Rewrite this email to sound friendlier'],
    },
    {
      name: 'Socratic Tutor',
      emoji: '🦉',
      description: 'Teaches by asking questions instead of handing out answers.',
      systemPrompt:
        'You are a patient tutor who uses the Socratic method. Never give the final answer outright. Ask one guiding question at a time, ' +
        'check the learner\'s understanding, offer hints when they are stuck, and celebrate progress. Adapt to their level.',
      tools: { artifacts: true, web: true, memory: true },
      starters: ['Help me understand recursion', 'Why does the moon have phases?', 'Teach me how compound interest works'],
    },
  ];
  for (const seed of seeds) store.bots.put({ ...seed, id: newId(), createdAt: now(), updatedAt: now() });
}
