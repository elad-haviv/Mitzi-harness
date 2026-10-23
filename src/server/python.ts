// The Python tool: runs code with Pyodide (Python compiled to WebAssembly) in a worker thread. Each chat keeps
// its own interpreter for a while, so variables carry over between calls; /work is a folder on disk.
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { Tool, ToolError, truncateMiddle } from '../tools/types.js';

const IDLE_MS = 10 * 60_000;
const DEFAULT_TIMEOUT = 60_000;
const MAX_TIMEOUT = 300_000;
const MAX_OUTPUT = 20_000;

export interface PythonResult {
  output: string;
  result?: string;
  error?: string;
  images: { name: string; dataUrl: string }[];
  timedOut?: boolean;
}

interface Session {
  worker: Worker;
  ready: Promise<void>;
  busy: boolean;
  idle?: NodeJS.Timeout;
  workDir: string;
}

export class PythonSandbox {
  private readonly sessions = new Map<string, Session>();
  private next = 1;

  constructor(private readonly dataDir: string) {}

  /** Whether Pyodide is installed (it is an optional dependency). */
  available(): boolean {
    try {
      createRequire(import.meta.url).resolve('pyodide');
      return true;
    } catch {
      return false;
    }
  }

  /** The folder a chat without a project folder works in. */
  sandboxDir(chatId: string): string {
    const dir = join(this.dataDir, 'sandbox', chatId.replace(/[^\w-]/g, '_'));
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private session(key: string, workDir: string): Session {
    const existing = this.sessions.get(key);
    if (existing && existing.workDir === workDir) return existing;
    if (existing) this.end(key);
    const worker = new Worker(new URL('./python-worker.js', import.meta.url), { workerData: { workDir, cacheDir: join(this.dataDir, 'pyodide-packages') } });
    mkdirSync(join(this.dataDir, 'pyodide-packages'), { recursive: true });
    const ready = new Promise<void>((resolve, reject) => {
      const onMessage = (m: any) => m.type === 'ready' && (worker.off('message', onMessage), resolve());
      worker.on('message', onMessage);
      worker.once('error', reject);
      worker.once('exit', (code) => reject(new Error(`Python stopped (exit code ${code})`)));
    });
    ready.catch(() => this.sessions.delete(key));
    const session: Session = { worker, ready, busy: false, workDir };
    worker.unref();
    this.sessions.set(key, session);
    return session;
  }

  /** Stops a chat's interpreter (its variables are lost). */
  end(key: string): void {
    const s = this.sessions.get(key);
    if (!s) return;
    clearTimeout(s.idle);
    void s.worker.terminate();
    this.sessions.delete(key);
  }

  /** Runs code in the chat's interpreter. A timeout or abort ends the interpreter. */
  async run(key: string, workDir: string, code: string, opts: { timeoutMs?: number; signal?: AbortSignal; onOutput?(text: string): void } = {}): Promise<PythonResult> {
    const s = this.session(key, workDir);
    if (s.busy) throw new ToolError('Python is still running the previous code in this chat');
    s.busy = true;
    clearTimeout(s.idle);
    // Running code keeps the process alive; an idle interpreter doesn't.
    s.worker.ref();
    try {
      await s.ready;
      const id = this.next++;
      const timeout = Math.min(Math.max(1000, opts.timeoutMs ?? DEFAULT_TIMEOUT), MAX_TIMEOUT);
      return await new Promise<PythonResult>((resolve, reject) => {
        let output = '';
        const finish = (r: PythonResult | Error) => {
          clearTimeout(timer);
          s.worker.off('message', onMessage);
          s.worker.off('exit', onExit);
          opts.signal?.removeEventListener('abort', onAbort);
          if (r instanceof Error) reject(r);
          else resolve(r);
        };
        const onMessage = (m: any) => {
          if (m.type === 'output') {
            output += m.text;
            opts.onOutput?.(m.text);
          } else if (m.type === 'done' && m.id === id) finish({ output: m.output, result: m.result, error: m.error, images: m.images });
        };
        const onExit = () => finish(new ToolError('Python stopped unexpectedly'));
        const stop = (why: string) => {
          this.end(key);
          finish({ output, error: why, images: [], timedOut: true });
        };
        const onAbort = () => stop('Stopped');
        const timer = setTimeout(() => stop(`Timed out after ${timeout / 1000}s, so Python was restarted (variables were lost)`), timeout);
        s.worker.on('message', onMessage);
        s.worker.once('exit', onExit);
        opts.signal?.addEventListener('abort', onAbort, { once: true });
        s.worker.postMessage({ id, code });
      });
    } finally {
      s.busy = false;
      s.worker.unref();
      if (this.sessions.get(key) === s) s.idle = setTimeout(() => this.end(key), IDLE_MS);
    }
  }

  /** Ends every interpreter (on shutdown). */
  close(): void {
    for (const key of [...this.sessions.keys()]) this.end(key);
  }
}

/** The Python tool for one chat. `onImage` keeps charts and saved images (as artifacts). */
export function pythonTool(
  sandbox: PythonSandbox,
  key: string,
  workDir: string,
  inProjectFolder: boolean,
  onImage: (image: { name: string; dataUrl: string }, callId?: string) => string,
): Tool<{ code: string; timeout?: number }> {
  return {
    name: 'Python',
    // In a project's folder the code can change the user's files; in the chat's sandbox it can't touch anything else.
    kind: inProjectFolder ? 'edit' : 'read',
    description:
      'Run Python 3 (Pyodide: Python in WebAssembly, no network) and get its printed output and the value of the last expression. ' +
      'Use it for calculations, data analysis and charts. numpy, pandas, matplotlib, scipy, scikit-learn and many other packages ' +
      'load automatically when imported. Variables and imports carry over between calls in this chat. ' +
      `The working folder /work is ${inProjectFolder ? "the project's folder (files you write there change the user's files)" : "this chat's own folder: read and write files there"}. ` +
      'Charts drawn with matplotlib, and images saved to /work, are shown to the user automatically; don’t call plt.show(). ' +
      `Default timeout ${DEFAULT_TIMEOUT / 1000}s (max ${MAX_TIMEOUT / 1000}s).`,
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'The Python code to run' },
        timeout: { type: 'integer', description: `Timeout in milliseconds (max ${MAX_TIMEOUT})` },
      },
      required: ['code'],
    },
    summarize: (a) => String(a.code ?? '').trim().split('\n').find((l) => l.trim() && !l.trim().startsWith('#'))?.slice(0, 80) ?? 'Python',
    sensitive: () => (inProjectFolder ? "runs code in the project's folder" : undefined),
    async run(a, ctx) {
      if (!String(a.code ?? '').trim()) throw new ToolError('code is required');
      const r = await sandbox.run(key, workDir, a.code, { timeoutMs: a.timeout, signal: ctx.signal });
      const parts: string[] = [];
      if (r.output.trim()) parts.push(truncateMiddle(r.output.trimEnd(), MAX_OUTPUT));
      if (r.result !== undefined) parts.push(`Result: ${truncateMiddle(r.result, 4000)}`);
      for (const image of r.images) parts.push(`[Shown to the user: ${onImage(image, ctx.callId)}]`);
      if (r.error) parts.push(`Error:\n${truncateMiddle(r.error, 6000)}`);
      const text = parts.join('\n\n') || '(no output)';
      if (r.error && !r.output.trim() && !r.images.length) throw new ToolError(text);
      return text;
    },
  };
}
