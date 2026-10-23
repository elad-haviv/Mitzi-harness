import { BUILTIN_COMMANDS } from './agentic.js';
import type { ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import type { McpServerConfig, McpTransport, McpTrust } from '../shared/types.js';
import { CONNECTORS } from './extensions/connectors.js';
import { CommandDef } from './extensions/commands.js';
import { MarketplaceRepoError, Plugins } from './extensions/plugins.js';
import type { Skills } from './extensions/skills.js';
import { McpManager, mergeSecrets } from './mcp/manager.js';
import type { OAuthFlows } from './mcp/oauth.js';
import { newId, now, Store } from './store.js';
import { fail, HttpError, Route, str } from './util.js';

export interface ExtensionContext {
  store: Store;
  mcp: McpManager;
  oauth: OAuthFlows;
  skills: Skills;
  plugins: Plugins;
  commands: () => CommandDef[];
  /** Re-applies plugin contributions (bots, connectors) after plugin changes. */
  sync: () => Promise<void>;
  redirectUri: () => string;
}

const TRUSTS: McpTrust[] = ['ask', 'readonly', 'allow'];
const TRANSPORTS: McpTransport[] = ['stdio', 'http', 'sse'];

const tilde = (p: string) => p.replace(/^~(?=$|[/\\])/, homedir());

function stringMap(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object') return {};
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>)
      .filter(([k]) => k.trim())
      .map(([k, val]) => [k.trim(), String(val ?? '')]),
  );
}

/** Splits a command line into words, honoring quotes. */
export function splitArgs(line: string): string[] {
  return (line.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((a) => a.replace(/^(["'])(.*)\1$/, '$2'));
}

function uniqueName(store: Store, name: string): string {
  const taken = new Set(store.mcpServers.all().map((s) => s.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) if (!taken.has(`${name} ${i}`.toLowerCase())) return `${name} ${i}`;
}

function validateServer(s: McpServerConfig): void {
  if (!s.name.trim()) throw new HttpError(400, 'Give the server a name');
  if (!TRANSPORTS.includes(s.transport)) throw new HttpError(400, 'Transport must be stdio, http or sse');
  if (s.transport === 'stdio' && !s.command?.trim()) throw new HttpError(400, 'Enter the command that starts the server');
  if (s.transport !== 'stdio') {
    if (!s.url || !/^https?:\/\/\S+$/.test(s.url)) throw new HttpError(400, 'Enter the server URL (http:// or https://)');
  }
}

export function registerExtensionRoutes(route: Route, ctx: ExtensionContext): void {
  const { store, mcp, skills, plugins } = ctx;
  const getServer = (id: string) => store.mcpServers.get(id) ?? fail(404, 'Server not found');
  const view = (s: McpServerConfig) => mcp.view(s);

  // ---- MCP servers ----------------------------------------------------------

  route('GET', '/api/mcp', () =>
    store.mcpServers
      .all()
      .sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name))
      .map(view),
  );

  route('POST', '/api/mcp', ({ body }) => {
    const transport = (TRANSPORTS.includes(body?.transport) ? body.transport : 'stdio') as McpTransport;
    const args = Array.isArray(body?.args) ? body.args.map(String) : splitArgs(str(body?.args));
    const server: McpServerConfig = {
      id: newId(),
      name: uniqueName(store, str(body?.name).trim()),
      transport,
      command: transport === 'stdio' ? str(body?.command).trim() : undefined,
      args: transport === 'stdio' ? args : undefined,
      env: transport === 'stdio' ? stringMap(body?.env) : undefined,
      url: transport !== 'stdio' ? str(body?.url).trim() : undefined,
      headers: transport !== 'stdio' ? stringMap(body?.headers) : undefined,
      enabled: true,
      trust: TRUSTS.includes(body?.trust) ? body.trust : 'ask',
      disabledTools: [],
      source: 'user',
      createdAt: now(),
      updatedAt: now(),
    };
    validateServer(server);
    store.mcpServers.put(server);
    void mcp.ensure(server.id);
    return view(server);
  });

  route('PATCH', '/api/mcp/:id', async ({ params, body }) => {
    const server = getServer(params.id);
    const before = JSON.stringify([server.transport, server.command, server.args, server.env, server.url, server.headers, server.enabled]);
    if (typeof body?.enabled === 'boolean') server.enabled = body.enabled;
    if (TRUSTS.includes(body?.trust)) server.trust = body.trust;
    if (Array.isArray(body?.disabledTools)) server.disabledTools = body.disabledTools.map(String);
    // A plugin owns its servers' launch settings.
    if (server.source !== 'plugin') {
      if (typeof body?.name === 'string' && body.name.trim()) server.name = body.name.trim();
      if (typeof body?.command === 'string') server.command = body.command.trim();
      if (body?.args !== undefined) server.args = Array.isArray(body.args) ? body.args.map(String) : splitArgs(str(body.args));
      if (body?.env !== undefined) server.env = mergeSecrets(stringMap(body.env), server.env);
      if (typeof body?.url === 'string') server.url = body.url.trim();
      if (body?.headers !== undefined) server.headers = mergeSecrets(stringMap(body.headers), server.headers);
    }
    validateServer(server);
    server.updatedAt = now();
    store.mcpServers.put(server);
    const after = JSON.stringify([server.transport, server.command, server.args, server.env, server.url, server.headers, server.enabled]);
    if (before !== after) {
      await mcp.disconnect(server.id);
      if (server.enabled) void mcp.ensure(server.id);
    }
    return view(server);
  });

  route('DELETE', '/api/mcp/:id', async ({ params }) => {
    const server = getServer(params.id);
    if (server.source === 'plugin') throw new HttpError(400, 'This server comes from a plugin; disable it or remove the plugin instead.');
    await mcp.disconnect(server.id);
    store.mcpServers.delete(server.id);
    return { ok: true };
  });

  route('POST', '/api/mcp/:id/reconnect', async ({ params }) => {
    const server = getServer(params.id);
    await mcp.restart(server.id);
    return view(server);
  });

  route('POST', '/api/mcp/:id/auth', async ({ params }) => {
    const server = getServer(params.id);
    if (server.transport === 'stdio' || !server.url) throw new HttpError(400, 'Only remote servers sign in with OAuth');
    try {
      const url = await ctx.oauth.start({
        serverId: server.id,
        serverUrl: server.url,
        redirectUri: ctx.redirectUri(),
        wwwAuthenticate: mcp.authHeader(server.id),
        existing: server.oauth?.clientId ? { clientId: server.oauth.clientId, clientSecret: server.oauth.clientSecret } : undefined,
      });
      return { url };
    } catch (err: any) {
      throw new HttpError(502, err.message);
    }
  });

  route('POST', '/api/mcp/:id/signout', async ({ params }) => {
    const server = getServer(params.id);
    server.oauth = undefined;
    store.mcpServers.put(server);
    await mcp.restart(server.id);
    return view(server);
  });

  // ---- Connector directory -------------------------------------------------

  route('GET', '/api/connectors', () =>
    CONNECTORS.map((c) => ({ ...c, installed: store.mcpServers.all().filter((s) => s.connectorId === c.id).length })),
  );

  route('POST', '/api/connectors/:id', ({ params, body }) => {
    const preset = CONNECTORS.find((c) => c.id === params.id) ?? fail(404, 'Unknown connector');
    const values = stringMap(body?.values);
    const env: Record<string, string> = {};
    const headers: Record<string, string> = {};
    const args = [...(preset.args ?? [])];
    for (const f of preset.fields) {
      const v = (values[f.key] ?? '').trim();
      if (!v) {
        if (f.required) throw new HttpError(400, `${f.label} is required`);
        continue;
      }
      if (f.kind === 'env') env[f.key] = v;
      else if (f.kind === 'header') headers[f.key] = v;
      else if (f.kind === 'bearer') headers.Authorization = `Bearer ${v}`;
      else if (f.key.startsWith('-')) args.push(f.key, tilde(v));
      else args.push(...v.split(/\n+/).map((x) => tilde(x.trim())).filter(Boolean));
    }
    const server: McpServerConfig = {
      id: newId(),
      name: uniqueName(store, preset.name),
      transport: preset.transport,
      command: preset.command,
      args: preset.transport === 'stdio' ? args : undefined,
      env: preset.transport === 'stdio' ? env : undefined,
      url: preset.url,
      headers: preset.transport !== 'stdio' ? headers : undefined,
      enabled: true,
      trust: preset.trust ?? 'ask',
      disabledTools: [],
      source: 'connector',
      connectorId: preset.id,
      createdAt: now(),
      updatedAt: now(),
    };
    store.mcpServers.put(server);
    void mcp.ensure(server.id);
    return view(server);
  });

  // ---- Skills ----------------------------------------------------------------

  route('GET', '/api/skills', () => skills.list());
  route('GET', '/api/skills/:id', ({ params }) => skills.get(params.id) ?? fail(404, 'Skill not found'));
  const saveSkill = (body: any, id?: string) => {
    try {
      return skills.save({ name: str(body?.name), description: str(body?.description), body: str(body?.body) }, id);
    } catch (err: any) {
      throw new HttpError(400, err.message);
    }
  };
  route('POST', '/api/skills', ({ body }) => saveSkill(body));
  route('PUT', '/api/skills/:id', ({ params, body }) => saveSkill(body, params.id));
  route('PATCH', '/api/skills/:id', ({ params, body }) => {
    if (typeof body?.enabled !== 'boolean') throw new HttpError(400, 'enabled is required');
    const disabled = new Set(store.settings.disabledSkills);
    if (body.enabled) disabled.delete(params.id);
    else disabled.add(params.id);
    store.updateSettings({ disabledSkills: [...disabled] });
    return skills.list().find((s) => s.id === params.id) ?? fail(404, 'Skill not found');
  });
  route('DELETE', '/api/skills/:id', ({ params }) => {
    try {
      skills.remove(params.id);
    } catch (err: any) {
      throw new HttpError(400, err.message);
    }
    return { ok: true };
  });
  route('POST', '/api/skills/import', ({ body }) => {
    const files = Array.isArray(body?.files) ? body.files.filter((f: any) => typeof f?.path === 'string' && typeof f?.content === 'string') : [];
    try {
      return skills.import(files);
    } catch (err: any) {
      throw new HttpError(400, err.message);
    }
  });

  // ---- Plugins & marketplaces ------------------------------------------------

  const pluginList = () =>
    store.plugins
      .all()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({ ...p, components: plugins.components(p.id, p.skillPaths) }));

  route('GET', '/api/plugins', () => pluginList());
  route('POST', '/api/plugins', async ({ body }) => {
    const source = str(body?.source).trim();
    if (!source) throw new HttpError(400, 'Enter a git URL, owner/repo, or a folder path');
    try {
      const plugin = await plugins.installFromSource(source, str(body?.ref) || undefined);
      await ctx.sync();
      return { plugin };
    } catch (err: any) {
      if (err instanceof MarketplaceRepoError) {
        // A marketplace repo: add it so the user can pick plugins from it.
        const marketplace = await plugins.addMarketplace(source);
        return { marketplace: plugins.marketplaceView(marketplace) };
      }
      throw new HttpError(400, err.message);
    }
  });
  route('PATCH', '/api/plugins/:id', async ({ params, body }) => {
    const plugin = store.plugins.get(params.id) ?? fail(404, 'Plugin not found');
    if (typeof body?.enabled === 'boolean') plugin.enabled = body.enabled;
    plugin.updatedAt = now();
    store.plugins.put(plugin);
    await ctx.sync();
    return plugin;
  });
  route('POST', '/api/plugins/:id/update', async ({ params }) => {
    try {
      const plugin = await plugins.update(params.id);
      await ctx.sync();
      return plugin;
    } catch (err: any) {
      throw new HttpError(400, err.message);
    }
  });
  route('DELETE', '/api/plugins/:id', async ({ params }) => {
    store.plugins.get(params.id) ?? fail(404, 'Plugin not found');
    plugins.uninstall(params.id);
    await ctx.sync();
    return { ok: true };
  });

  route('GET', '/api/marketplaces', () => store.marketplaces.all().map((m) => plugins.marketplaceView(m)));
  route('POST', '/api/marketplaces', async ({ body }) => {
    const source = str(body?.source).trim();
    if (!source) throw new HttpError(400, 'Enter a git URL, owner/repo, or a folder path');
    try {
      return plugins.marketplaceView(await plugins.addMarketplace(source));
    } catch (err: any) {
      throw new HttpError(400, err.message);
    }
  });
  route('POST', '/api/marketplaces/:id/refresh', async ({ params }) => {
    try {
      return plugins.marketplaceView(await plugins.refreshMarketplace(params.id));
    } catch (err: any) {
      throw new HttpError(400, err.message);
    }
  });
  route('DELETE', '/api/marketplaces/:id', ({ params }) => {
    plugins.removeMarketplace(params.id);
    return { ok: true };
  });
  route('POST', '/api/marketplaces/:id/install', async ({ params, body }) => {
    try {
      const plugin = await plugins.installFromMarketplace(params.id, str(body?.name));
      await ctx.sync();
      return plugin;
    } catch (err: any) {
      throw new HttpError(400, err.message);
    }
  });

  route('GET', '/api/commands', () => [...BUILTIN_COMMANDS.map((c) => ({ ...c, source: 'mitzi' })), ...ctx.commands().map(({ file: _file, ...c }) => c)]);
}

function page(res: ServerResponse, status: number, title: string, message: string): void {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;background:#faf9f6;color:#1d1b18}
div{max-width:420px;text-align:center;padding:24px}h1{font-size:20px}</style>
<div><h1>${esc(title)}</h1><p>${esc(message)}</p></div>
<script>try{window.opener&&window.opener.postMessage({type:'mitzi-oauth',ok:${status === 200}},location.origin)}catch(e){}${status === 200 ? 'setTimeout(()=>window.close(),1200)' : ''}</script>`);
}

/** The OAuth redirect target. It can't carry Mitzi's token, so the OAuth `state` authenticates it. */
export async function oauthCallback(ctx: ExtensionContext, url: URL, res: ServerResponse): Promise<void> {
  const error = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (error || !code || !state) {
    return page(res, 400, 'Sign-in was not completed', url.searchParams.get('error_description') ?? error ?? 'The provider did not return an authorization code.');
  }
  try {
    const { serverId, oauth } = await ctx.oauth.finish(state, code);
    const server = ctx.store.mcpServers.get(serverId);
    if (!server) throw new Error('That connector no longer exists.');
    server.oauth = oauth;
    server.updatedAt = now();
    ctx.store.mcpServers.put(server);
    await ctx.mcp.restart(serverId);
    page(res, 200, `Connected to ${server.name}`, 'You can close this tab and return to Mitzi.');
  } catch (err: any) {
    page(res, 400, 'Sign-in failed', err.message);
  }
}
