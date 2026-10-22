import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import type { McpServerConfig, McpServerView, McpStatus, McpToolInfo } from '../../shared/types.js';
import { Tool, ToolError, truncateMiddle } from '../../tools/types.js';
import type { Store } from '../store.js';
import { now } from '../store.js';
import { AuthRequiredError, HttpTransport, McpClient, McpTool, resultText, SseTransport, StdioTransport, Transport } from './client.js';
import { refreshTokens } from './oauth.js';

interface Connection {
  status: McpStatus;
  error?: string;
  client?: McpClient;
  tools: McpTool[];
  serverName?: string;
  /** WWW-Authenticate from the last 401, used to start OAuth. */
  authHeader?: string;
  connecting?: Promise<void>;
  lastAttempt?: number;
}

/** Most providers reject more tools than this in one request. */
const MAX_TOOLS = 100;
const SECRET_KEY = /key|token|secret|password|auth|cookie|credential/i;
export const MASK = '••••••••';

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'server';
}

/** Tool names must match ^[a-zA-Z0-9_-]{1,64}$ for most providers. */
export function mcpToolName(server: string, tool: string): string {
  const name = `mcp__${slug(server).slice(0, 24)}__${tool.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  if (name.length <= 64) return name;
  const hash = createHash('sha1').update(name).digest('hex').slice(0, 8);
  return `${name.slice(0, 55)}_${hash}`;
}

export function maskSecrets(map: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(map ?? {}).map(([k, v]) => [k, SECRET_KEY.test(k) && v ? MASK : v]));
}

/** Applies an edited map from the browser, keeping secrets it only saw masked. */
export function mergeSecrets(next: Record<string, string>, prev: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(next).map(([k, v]) => [k, v === MASK ? prev?.[k] ?? '' : v]));
}

/** Connects to configured MCP servers and exposes their tools to the agent. */
export class McpManager {
  private readonly conns = new Map<string, Connection>();

  constructor(private readonly store: Store) {}

  private conn(id: string): Connection {
    let c = this.conns.get(id);
    if (!c) this.conns.set(id, (c = { status: 'connecting', tools: [] }));
    return c;
  }

  view(server: McpServerConfig): McpServerView {
    const { oauth, ...rest } = server;
    const c = this.conns.get(server.id);
    const status: McpStatus = !server.enabled ? 'disabled' : c?.status ?? 'connecting';
    return {
      ...rest,
      env: maskSecrets(server.env),
      headers: maskSecrets(server.headers),
      status,
      error: c?.error,
      serverName: c?.serverName,
      oauthConnected: !!oauth?.accessToken,
      tools: (c?.tools ?? []).map(
        (t): McpToolInfo => ({
          name: t.name,
          title: t.title ?? t.annotations?.title,
          description: t.description,
          readOnly: t.annotations?.readOnlyHint === true,
          enabled: !server.disabledTools.includes(t.name),
        }),
      ),
    };
  }

  /** WWW-Authenticate from the server's last 401, if any. */
  authHeader(id: string): string | undefined {
    return this.conns.get(id)?.authHeader;
  }

  /** Returns a valid access token, refreshing it when it's about to expire. */
  private async token(id: string): Promise<string | undefined> {
    const server = this.store.mcpServers.get(id);
    const oauth = server?.oauth;
    if (!server || !oauth?.accessToken) return undefined;
    if (oauth.expiresAt && oauth.expiresAt - 60_000 < Date.now() && oauth.refreshToken) {
      try {
        server.oauth = await refreshTokens(oauth);
        this.store.mcpServers.put(server);
      } catch {
        // Fall through with the old token; the server will answer 401 if it's dead.
      }
    }
    return server.oauth?.accessToken;
  }

  private transport(server: McpServerConfig): Transport {
    if (server.transport === 'stdio') {
      if (!server.command) throw new Error('No command configured');
      return new StdioTransport({ command: server.command, args: server.args ?? [], env: server.env, cwd: homedir() });
    }
    if (!server.url) throw new Error('No URL configured');
    const opts = { url: server.url, headers: server.headers, token: () => this.token(server.id) };
    return server.transport === 'sse' ? new SseTransport(opts) : new HttpTransport(opts);
  }

  /** Connects (once) and resolves when connected or failed. */
  ensure(id: string): Promise<void> {
    const server = this.store.mcpServers.get(id);
    const c = this.conn(id);
    if (!server?.enabled) return Promise.resolve();
    if (c.status === 'connected' || c.status === 'needs-auth') return Promise.resolve();
    if (c.connecting) return c.connecting;
    // Don't hammer a server that just failed.
    if (c.status === 'error' && c.lastAttempt && Date.now() - c.lastAttempt < 30_000) return Promise.resolve();
    c.lastAttempt = Date.now();
    c.status = 'connecting';
    c.error = undefined;
    c.connecting = this.open(server, c, true).finally(() => (c.connecting = undefined));
    return c.connecting;
  }

  private async open(server: McpServerConfig, c: Connection, retryAuth: boolean): Promise<void> {
    let client: McpClient | undefined;
    try {
      client = new McpClient(this.transport(server), {
        onClose: (err) => {
          if (c.client !== client) return;
          c.client = undefined;
          c.status = 'error';
          c.error = err?.message ?? 'Disconnected';
        },
        onToolsChanged: () => {
          client?.listTools().then((tools) => (c.tools = tools), () => {});
        },
      });
      // First runs of `npx` servers download packages, so stdio gets longer.
      await client.connect(server.transport === 'stdio' ? 180_000 : 30_000);
      c.tools = await client.listTools();
      c.client = client;
      c.serverName = client.serverInfo?.name;
      c.status = 'connected';
      c.authHeader = undefined;
    } catch (err) {
      await client?.close();
      if (err instanceof AuthRequiredError) {
        c.authHeader = err.header;
        if (retryAuth && server.oauth?.refreshToken) {
          try {
            server.oauth = await refreshTokens(server.oauth);
            server.updatedAt = now();
            this.store.mcpServers.put(server);
            return this.open(server, c, false);
          } catch {
            // Needs a fresh sign-in.
          }
        }
        c.status = 'needs-auth';
        c.error = server.oauth?.accessToken ? 'Your sign-in expired. Connect again.' : 'Sign in to connect.';
        return;
      }
      c.status = 'error';
      c.error = (err as Error).message;
    }
  }

  async disconnect(id: string): Promise<void> {
    const c = this.conns.get(id);
    this.conns.delete(id);
    await c?.client?.close();
  }

  async restart(id: string): Promise<void> {
    await this.disconnect(id);
    await this.ensure(id);
  }

  /** Starts every enabled server in the background. */
  warmup(): void {
    for (const s of this.store.mcpServers.all()) if (s.enabled) void this.ensure(s.id);
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.conns.keys()].map((id) => this.disconnect(id)));
  }

  /** Tools from all enabled, connected servers, waiting briefly for ones still starting. */
  async tools(waitMs = 20_000): Promise<{ tools: Tool[]; warnings: string[] }> {
    const servers = this.store.mcpServers.all().filter((s) => s.enabled);
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.all(servers.map((s) => this.ensure(s.id))), new Promise((r) => (timer = setTimeout(r, waitMs)))]);
    clearTimeout(timer);
    const tools: Tool[] = [];
    const warnings: string[] = [];
    for (const server of servers) {
      const c = this.conn(server.id);
      if (c.status !== 'connected') {
        if (c.status === 'needs-auth') warnings.push(`${server.name} needs you to sign in (Connectors page).`);
        else if (c.status === 'error') warnings.push(`${server.name} is unavailable: ${c.error}`);
        continue;
      }
      for (const t of c.tools) {
        if (server.disabledTools.includes(t.name)) continue;
        if (tools.length >= MAX_TOOLS) {
          warnings.push(`Only the first ${MAX_TOOLS} connector tools are available; turn some off on the Connectors page.`);
          break;
        }
        tools.push(this.toTool(server, t));
      }
    }
    return { tools, warnings: [...new Set(warnings)] };
  }

  private toTool(server: McpServerConfig, t: McpTool): Tool {
    const readOnly = t.annotations?.readOnlyHint === true;
    const schema = t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : {};
    const label = t.title ?? t.annotations?.title ?? t.name;
    return {
      name: mcpToolName(server.name, t.name),
      description: `[${server.name}] ${t.description ?? label}`.slice(0, 1024),
      parameters: { type: 'object', properties: {}, ...schema },
      kind: server.trust === 'allow' || (server.trust === 'readonly' && readOnly) ? 'read' : 'network',
      summarize: (args) => {
        const first = Object.values(args ?? {}).find((v) => typeof v === 'string') as string | undefined;
        return `${server.name} · ${label}${first ? `: ${first.slice(0, 80)}` : ''}`;
      },
      preview: async (args) => JSON.stringify(args ?? {}, null, 2),
      run: async (args, ctx) => {
        await this.ensure(server.id);
        const client = this.conns.get(server.id)?.client;
        if (!client) throw new ToolError(`${server.name} is not connected.`);
        const result = await client.callTool(t.name, args, ctx.signal);
        const text = truncateMiddle(resultText(result), 50_000);
        if (result.isError) throw new ToolError(text);
        return text;
      },
    };
  }
}
