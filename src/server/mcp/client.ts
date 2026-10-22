// A Model Context Protocol client: JSON-RPC 2.0 over stdio, Streamable HTTP or the
// older HTTP+SSE transport. Covers what an agent needs: initialize, tools, and calls.
import { ChildProcess, spawn } from 'node:child_process';

export const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'mitzi', version: '0.1.0' };

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
}

export interface CallToolResult {
  content?: any[];
  structuredContent?: unknown;
  isError?: boolean;
}

export class McpError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = 'McpError';
  }
}

/** The server wants (new) credentials; `header` is its WWW-Authenticate value. */
export class AuthRequiredError extends Error {
  constructor(readonly header: string) {
    super('Authorization required');
    this.name = 'AuthRequiredError';
  }
}

export interface Transport {
  start(onMessage: (msg: any) => void, onClose: (err?: Error) => void): Promise<void>;
  send(msg: any): Promise<void>;
  /** Called once initialize negotiates a protocol version. */
  setProtocolVersion?(version: string): void;
  close(): Promise<void>;
}

/** Bearer token for HTTP transports, refreshed as needed. */
export type TokenProvider = () => Promise<string | undefined>;

// ---------- Server-sent events ----------

export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const decoder = new TextDecoder();
  let buf = '';
  let event = 'message';
  let data: string[] = [];
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line === '') {
        if (data.length) yield { event, data: data.join('\n') };
        event = 'message';
        data = [];
      } else if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (data.length) yield { event, data: data.join('\n') };
}

// ---------- stdio ----------

export class StdioTransport implements Transport {
  private child?: ChildProcess;
  private stderr = '';

  constructor(private readonly opts: { command: string; args: string[]; env?: Record<string, string>; cwd?: string }) {}

  start(onMessage: (msg: any) => void, onClose: (err?: Error) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.opts.command, this.opts.args, {
        cwd: this.opts.cwd,
        env: { ...process.env, ...this.opts.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        // npx and friends are .cmd shims on Windows.
        shell: process.platform === 'win32',
      });
      this.child = child;
      let buf = '';
      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            onMessage(JSON.parse(line));
          } catch {
            // Servers sometimes print logs to stdout; ignore non-JSON lines.
          }
        }
      });
      child.stderr!.setEncoding('utf8');
      child.stderr!.on('data', (d: string) => (this.stderr = (this.stderr + d).slice(-4000)));
      child.once('spawn', () => resolve());
      child.once('error', (err) => {
        const e = new McpError((err as NodeJS.ErrnoException).code === 'ENOENT' ? `Command not found: ${this.opts.command}` : err.message);
        reject(e);
        onClose(e);
      });
      child.once('exit', (code, signal) => {
        const tail = this.stderr.trim().split('\n').slice(-6).join('\n');
        onClose(new McpError(`Server exited (${signal ?? `code ${code}`})${tail ? `: ${tail}` : ''}`));
      });
    });
  }

  async send(msg: any): Promise<void> {
    if (!this.child?.stdin?.writable) throw new McpError('Server is not running');
    this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    child.stdin?.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 2000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }
}

// ---------- Streamable HTTP ----------

export class HttpTransport implements Transport {
  private sessionId?: string;
  private protocolVersion?: string;
  private onMessage: (msg: any) => void = () => {};
  private readonly streams = new Set<AbortController>();

  constructor(private readonly opts: { url: string; headers?: Record<string, string>; token?: TokenProvider }) {}

  async start(onMessage: (msg: any) => void): Promise<void> {
    this.onMessage = onMessage;
  }

  setProtocolVersion(version: string): void {
    this.protocolVersion = version;
  }

  private async headers(): Promise<Record<string, string>> {
    const token = await this.opts.token?.();
    return {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...this.opts.headers,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
      ...(this.protocolVersion ? { 'mcp-protocol-version': this.protocolVersion } : {}),
    };
  }

  async send(msg: any): Promise<void> {
    const controller = new AbortController();
    const res = await fetch(this.opts.url, { method: 'POST', headers: await this.headers(), body: JSON.stringify(msg), signal: controller.signal });
    if (res.status === 401) throw new AuthRequiredError(res.headers.get('www-authenticate') ?? '');
    const session = res.headers.get('mcp-session-id');
    if (session) this.sessionId = session;
    if (res.status === 202 || res.status === 204) return;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new McpError(`HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
    }
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('text/event-stream') && res.body) {
      // Responses (and any server requests) arrive on the stream; read it in the background.
      this.streams.add(controller);
      void (async () => {
        try {
          for await (const ev of sseEvents(res.body!)) {
            if (ev.event !== 'message' || !ev.data.trim()) continue;
            try {
              this.dispatch(JSON.parse(ev.data));
            } catch {
              // Ignore malformed events.
            }
          }
        } catch {
          // Stream closed.
        } finally {
          this.streams.delete(controller);
        }
      })();
      return;
    }
    const text = await res.text();
    if (text.trim()) this.dispatch(JSON.parse(text));
  }

  private dispatch(payload: any): void {
    for (const m of Array.isArray(payload) ? payload : [payload]) this.onMessage(m);
  }

  async close(): Promise<void> {
    for (const c of this.streams) c.abort();
    if (this.sessionId) {
      await fetch(this.opts.url, { method: 'DELETE', headers: await this.headers(), signal: AbortSignal.timeout(3000) }).catch(() => {});
    }
  }
}

// ---------- Legacy HTTP+SSE (protocol 2024-11-05) ----------

export class SseTransport implements Transport {
  private endpoint?: string;
  private readonly controller = new AbortController();

  constructor(private readonly opts: { url: string; headers?: Record<string, string>; token?: TokenProvider }) {}

  private async headers(extra: Record<string, string>): Promise<Record<string, string>> {
    const token = await this.opts.token?.();
    return { ...extra, ...this.opts.headers, ...(token ? { authorization: `Bearer ${token}` } : {}) };
  }

  async start(onMessage: (msg: any) => void, onClose: (err?: Error) => void): Promise<void> {
    const res = await fetch(this.opts.url, { headers: await this.headers({ accept: 'text/event-stream' }), signal: this.controller.signal });
    if (res.status === 401) throw new AuthRequiredError(res.headers.get('www-authenticate') ?? '');
    if (!res.ok || !res.body) throw new McpError(`HTTP ${res.status} opening the event stream`);
    const events = sseEvents(res.body);
    // The first event names the URL to POST messages to.
    for (;;) {
      const next = await events.next();
      if (next.done) throw new McpError('The server closed the event stream before sending its endpoint');
      if (next.value.event === 'endpoint') {
        this.endpoint = new URL(next.value.data.trim(), this.opts.url).toString();
        break;
      }
    }
    void (async () => {
      try {
        for await (const ev of events) {
          if (ev.event !== 'message') continue;
          try {
            onMessage(JSON.parse(ev.data));
          } catch {
            // Ignore malformed events.
          }
        }
        onClose(new McpError('The server closed the event stream'));
      } catch (err) {
        if (!this.controller.signal.aborted) onClose(err as Error);
      }
    })();
  }

  async send(msg: any): Promise<void> {
    if (!this.endpoint) throw new McpError('Not connected');
    const res = await fetch(this.endpoint, { method: 'POST', headers: await this.headers({ 'content-type': 'application/json' }), body: JSON.stringify(msg) });
    if (res.status === 401) throw new AuthRequiredError(res.headers.get('www-authenticate') ?? '');
    if (!res.ok && res.status !== 202) throw new McpError(`HTTP ${res.status}`);
  }

  async close(): Promise<void> {
    this.controller.abort();
  }
}

// ---------- JSON-RPC client ----------

interface Pending {
  resolve(v: any): void;
  reject(e: Error): void;
  timer: NodeJS.Timeout;
}

export class McpClient {
  serverInfo?: { name?: string; version?: string };
  instructions?: string;
  capabilities: Record<string, any> = {};
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;

  constructor(
    private readonly transport: Transport,
    private readonly events: { onClose?(err?: Error): void; onToolsChanged?(): void } = {},
  ) {}

  async connect(timeoutMs = 60_000): Promise<void> {
    await this.transport.start(
      (msg) => this.handle(msg),
      (err) => this.fail(err),
    );
    const result = await this.request(
      'initialize',
      { protocolVersion: PROTOCOL_VERSION, capabilities: { roots: { listChanged: false } }, clientInfo: CLIENT_INFO },
      timeoutMs,
    );
    this.serverInfo = result?.serverInfo;
    this.instructions = result?.instructions;
    this.capabilities = result?.capabilities ?? {};
    this.transport.setProtocolVersion?.(result?.protocolVersion ?? PROTOCOL_VERSION);
    await this.notify('notifications/initialized');
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = await this.request('tools/list', cursor ? { cursor } : {});
      tools.push(...(Array.isArray(res?.tools) ? res.tools : []));
      cursor = res?.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  callTool(name: string, args: unknown, signal?: AbortSignal, timeoutMs = 300_000): Promise<CallToolResult> {
    return this.request('tools/call', { name, arguments: args ?? {} }, timeoutMs, signal);
  }

  request(method: string, params?: unknown, timeoutMs = 60_000, signal?: AbortSignal): Promise<any> {
    if (this.closed) return Promise.reject(new McpError('Connection closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        cleanup();
        void this.notify('notifications/cancelled', { requestId: id, reason: 'Cancelled by the user' }).catch(() => {});
        reject(new McpError('Cancelled'));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new McpError(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          cleanup();
          resolve(v);
        },
        reject: (e) => {
          cleanup();
          reject(e);
        },
        timer,
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.transport.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }).catch((err) => {
        cleanup();
        reject(err);
      });
    });
  }

  notify(method: string, params?: unknown): Promise<void> {
    return this.transport.send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  private handle(msg: any): void {
    if (msg?.id !== undefined && msg.id !== null && ('result' in msg || 'error' in msg)) {
      const p = this.pending.get(Number(msg.id));
      if (!p) return;
      if (msg.error) p.reject(new McpError(msg.error.message ?? 'Server error', msg.error.code));
      else p.resolve(msg.result);
      return;
    }
    if (typeof msg?.method !== 'string') return;
    if (msg.id !== undefined) {
      // A request from the server. We support the harmless ones.
      const reply = (body: object) => void this.transport.send({ jsonrpc: '2.0', id: msg.id, ...body }).catch(() => {});
      if (msg.method === 'ping') reply({ result: {} });
      else if (msg.method === 'roots/list') reply({ result: { roots: [] } });
      else reply({ error: { code: -32601, message: `Mitzi does not support ${msg.method}` } });
      return;
    }
    if (msg.method === 'notifications/tools/list_changed') this.events.onToolsChanged?.();
  }

  private fail(err?: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(err ?? new McpError('Connection closed'));
    this.pending.clear();
    this.events.onClose?.(err);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new McpError('Connection closed'));
    this.pending.clear();
    await this.transport.close().catch(() => {});
  }
}

/** Renders a tool result as text for the model. */
export function resultText(result: CallToolResult): string {
  const parts: string[] = [];
  for (const c of result.content ?? []) {
    if (c?.type === 'text') parts.push(String(c.text ?? ''));
    else if (c?.type === 'image') parts.push(`[image: ${c.mimeType ?? 'image'}, ${Math.round(String(c.data ?? '').length * 0.75 / 1024)} KB]`);
    else if (c?.type === 'audio') parts.push(`[audio: ${c.mimeType ?? 'audio'}]`);
    else if (c?.type === 'resource') parts.push(c.resource?.text ?? `[resource: ${c.resource?.uri ?? 'unknown'}]`);
    else if (c?.type === 'resource_link') parts.push(`[resource: ${c.name ?? ''} ${c.uri ?? ''}]`.trim());
  }
  if (!parts.length && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent, null, 2));
  return parts.join('\n\n') || '(no output)';
}
