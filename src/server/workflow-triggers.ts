// Workflow triggers besides schedules: a secret webhook URL, and a watched folder whose new or changed
// files each start a run.
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, relative } from 'node:path';
import type { Workflow } from '../shared/types.js';
import type { Store } from './store.js';
import type { WorkflowEngine } from './workflows.js';

const POLL_MS = 3_000;
const MAX_FILE = 1024 * 1024;
const MAX_HOOK_BODY = 1024 * 1024;

export const newHookToken = () => randomBytes(18).toString('base64url');

/** "*.md, *.txt" → a test for file names; empty or "*" matches everything. */
export function patternTest(pattern: string): (name: string) => boolean {
  const parts = pattern
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length || parts.includes('*')) return () => true;
  const res = parts.map((p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i'));
  return (name) => res.some((re) => re.test(name));
}

/** Files directly in a folder (and one level down), with their modification times. */
function listFiles(dir: string, match: (name: string) => boolean): Map<string, number> {
  const out = new Map<string, number>();
  const scan = (d: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = join(d, e.name);
      if (e.isDirectory() && depth < 1) scan(p, depth + 1);
      else if (e.isFile() && match(e.name)) {
        try {
          out.set(p, statSync(p).mtimeMs);
        } catch {
          // Gone already.
        }
      }
    }
  };
  scan(dir, 0);
  return out;
}

interface Watch {
  path: string;
  pattern: string;
  seen: Map<string, number>;
}

export class WorkflowTriggers {
  private readonly watches = new Map<string, Watch>();
  /** Files waiting for their workflow to finish its current run. */
  private readonly pending = new Map<string, string[]>();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly store: Store,
    private readonly engine: WorkflowEngine,
  ) {}

  start(): void {
    this.refresh();
    this.timer = setInterval(() => this.poll(), POLL_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** Picks up changed folder triggers. Files already in a folder when it's first watched don't count. */
  refresh(): void {
    const wanted = new Map(
      this.store.workflows
        .all()
        .filter((w) => w.triggers?.folder?.enabled && w.triggers.folder.path)
        .map((w) => [w.id, w.triggers!.folder!] as const),
    );
    for (const id of this.watches.keys()) if (!wanted.has(id)) this.watches.delete(id);
    for (const [id, f] of wanted) {
      const cur = this.watches.get(id);
      if (cur && cur.path === f.path && cur.pattern === f.pattern) continue;
      this.watches.set(id, { path: f.path, pattern: f.pattern, seen: listFiles(f.path, patternTest(f.pattern)) });
    }
  }

  /** Looks for new and changed files, and starts runs for them. */
  poll(): void {
    for (const [id, w] of this.watches) {
      const files = listFiles(w.path, patternTest(w.pattern));
      for (const [path, mtime] of files) {
        if (w.seen.get(path) === mtime) continue;
        w.seen.set(path, mtime);
        const queue = this.pending.get(id) ?? [];
        if (!queue.includes(path)) queue.push(path);
        this.pending.set(id, queue);
      }
      for (const path of [...w.seen.keys()]) if (!files.has(path)) w.seen.delete(path);
      this.next(id);
    }
  }

  /** Runs the workflow on the next waiting file, unless it's busy. */
  private next(id: string): void {
    const queue = this.pending.get(id);
    const workflow = this.store.workflows.get(id);
    const watch = this.watches.get(id);
    if (!queue?.length || !workflow || !watch || this.engine.isRunning(id)) return;
    const path = queue.shift()!;
    let text: string;
    try {
      if (statSync(path).size > MAX_FILE) return this.next(id);
      text = readFileSync(path, 'utf8');
    } catch {
      return this.next(id);
    }
    // Binary files aren't text a workflow can use.
    if (text.includes('\u0000')) return this.next(id);
    void this.engine
      .run(workflow, text, 'folder', () => {}, undefined, relative(watch.path, path).replace(/\\/g, '/'))
      .catch(() => {})
      .finally(() => this.next(id));
  }

  /** POST /hooks/<token>: runs the workflow with the body as its input. `?wait=1` answers with the result. */
  async webhook(token: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (req.method !== 'POST') return send(405, { error: 'Use POST' });
    const workflow = this.store.workflows.all().find((w) => w.triggers?.webhook?.enabled && w.triggers.webhook.token === token);
    if (!workflow || !token) return send(404, { error: 'No workflow at this address' });
    let body: string;
    try {
      body = await readRaw(req);
    } catch (err) {
      return send(413, { error: (err as Error).message });
    }
    if (this.engine.isRunning(workflow.id)) return send(409, { error: 'The workflow is already running; try again shortly' });
    // A JSON body with an "input" string uses that; anything else is the input as it is.
    let input = body;
    try {
      const json = JSON.parse(body);
      if (json && typeof json.input === 'string') input = json.input;
    } catch {
      // Not JSON: use the text.
    }
    const running = this.engine.run(workflow, input, 'webhook', () => {}, undefined, 'webhook');
    if (new URL(req.url ?? '/', 'http://x').searchParams.get('wait') === '1') {
      const run = await running;
      return send(run.status === 'done' ? 200 : 500, { run: run.id, status: run.status, output: run.output, error: run.error });
    }
    running.catch(() => {});
    send(202, { ok: true, workflow: workflow.name });
  }
}

export function readRaw(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_HOOK_BODY) {
        reject(new Error('The request is larger than 1 MB'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Normalizes a triggers update from the editor; `previous` keeps the webhook's token. */
export function cleanTriggers(raw: any, previous: Workflow['triggers'], validateFolder: (p: string) => string): Workflow['triggers'] {
  const out: NonNullable<Workflow['triggers']> = { ...previous };
  if (raw?.webhook) {
    const token = raw.webhook.regenerate || !previous?.webhook?.token ? newHookToken() : previous.webhook.token;
    out.webhook = { token, enabled: raw.webhook.enabled === true };
  }
  if (raw?.folder) {
    const path = typeof raw.folder.path === 'string' && raw.folder.path.trim() ? validateFolder(raw.folder.path.trim()) : '';
    out.folder = { path, pattern: String(raw.folder.pattern ?? '*').slice(0, 200), enabled: raw.folder.enabled === true && !!path };
  }
  return out;
}
