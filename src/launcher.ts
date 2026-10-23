// `mitzi ui` and `mitzi web`: run the server in a child process and show it in a desktop window or
// the browser. The child exits with RESTART_CODE after an in-app update, and is started again so the
// new version loads; the window or browser tab reconnects by itself.
import { ChildProcess, fork, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromiumBinary } from './browsers.js';
import { MITZI_HOME } from './config.js';
import { openBrowser } from './server/index.js';
import { color } from './ui.js';

/** Exit code the server uses to ask for a restart. */
export const RESTART_CODE = 75;

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ENTRY = fileURLToPath(new URL('./index.js', import.meta.url));

interface Ready {
  type: 'ready';
  url: string;
  port: number;
  version: string;
}

/** Is a Mitzi server already answering on this port with our token? */
async function running(port: number): Promise<string | undefined> {
  try {
    const token = readFileSync(join(MITZI_HOME, 'ui-token'), 'utf8').trim();
    const res = await fetch(`http://127.0.0.1:${port}/api/settings`, { headers: { 'x-mitzi-token': token }, signal: AbortSignal.timeout(1500) });
    // Something else could be answering on the port; only Mitzi reports its version and home.
    const body = res.ok ? ((await res.json().catch(() => undefined)) as { version?: string; home?: string } | undefined) : undefined;
    return body?.version && body.home ? `http://localhost:${port}/?token=${token}` : undefined;
  } catch {
    return undefined;
  }
}

function startServer(port: number): Promise<{ child: ChildProcess; ready: Ready }> {
  return new Promise((resolve, reject) => {
    const child = fork(ENTRY, ['__serve', '--port', String(port)], {
      env: { ...process.env, MITZI_SUPERVISED: '1' },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    const onExit = (code: number | null) => reject(new Error(code === 98 ? `Port ${port} is in use. Try: mitzi ui --port ${port + 1}` : `The server stopped (exit code ${code})`));
    child.once('exit', onExit);
    child.on('message', (m: Ready) => {
      if (m?.type !== 'ready') return;
      child.off('exit', onExit);
      resolve({ child, ready: m });
    });
  });
}

// ---------- Windows ----------

/** The Electron binary, when the optional dependency is installed. */
function electronBinary(): string | undefined {
  try {
    const path = createRequire(import.meta.url)('electron') as unknown;
    return typeof path === 'string' && existsSync(path) ? path : undefined;
  } catch {
    return undefined;
  }
}

/** Opens the app window; resolves when the user closes it. Undefined when no window could be opened. */
function openWindow(url: string): Promise<void> | undefined {
  const electron = electronBinary();
  if (electron) {
    const launch = (args: string[]) =>
      new Promise<{ code: number | null; sandboxError: boolean }>((resolve) => {
        const p = spawn(electron, [...args, join(ROOT, 'desktop', 'main.cjs'), url], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, MITZI_HOME } });
        let stderr = '';
        p.stderr?.on('data', (d) => (stderr += d));
        p.on('error', () => resolve({ code: -1, sandboxError: false }));
        p.on('exit', (code) => resolve({ code, sandboxError: /Running as root without --no-sandbox|SUID sandbox|setuid sandbox|namespace/i.test(stderr) }));
      });
    return (async () => {
      let r = await launch([]);
      // Some Linux systems block Chromium's sandbox for apps installed outside the package manager,
      // and it can't run as root at all.
      if (r.sandboxError && process.platform === 'linux') {
        process.stdout.write(color.dim('The window sandbox isn’t available on this system; opening without it.\n'));
        r = await launch(['--no-sandbox']);
      }
    })();
  }
  const chromium = chromiumBinary();
  if (chromium) {
    const profile = join(MITZI_HOME, 'window-profile');
    mkdirSync(profile, { recursive: true });
    const p = spawn(chromium, [`--app=${url}`, `--user-data-dir=${profile}`, '--window-size=1280,860', '--no-first-run', '--no-default-browser-check'], { stdio: 'ignore' });
    return new Promise((resolve) => {
      p.on('error', () => resolve());
      p.on('exit', () => resolve());
    });
  }
  return undefined;
}

// ---------- The command ----------

export async function runApp(mode: 'ui' | 'web', opts: { port?: number; open: boolean; version: string }): Promise<number> {
  const port = opts.port ?? 4545;
  const banner = (url: string, version: string) =>
    `${color.bold(color.orange('🐱 Mitzi'))} ${color.dim(`v${version}`)} is running at\n\n  ${color.cyan(url)}\n\n`;

  // Already running (e.g. `mitzi ui` while `mitzi web` is open): just show it.
  const existing = await running(port);
  if (existing) {
    process.stdout.write(`${color.bold(color.orange('🐱 Mitzi'))} is already running at ${color.cyan(existing)}\n`);
    const win = mode === 'ui' && opts.open ? openWindow(existing) : undefined;
    if (win) await win;
    else if (opts.open) openBrowser(existing);
    return 0;
  }

  let server: { child: ChildProcess; ready: Ready };
  try {
    server = await startServer(port);
  } catch (err) {
    process.stderr.write(color.red(`${(err as Error).message}\n`));
    return 1;
  }
  let stopping = false;
  let done: (code: number) => void = () => {};
  const finished = new Promise<number>((r) => (done = r));

  const stop = (code = 0) => {
    if (stopping) return;
    stopping = true;
    server.child.kill('SIGTERM');
    setTimeout(() => done(code), 300).unref();
    server.child.once('exit', () => done(code));
  };

  // Restart the server after an update; the page reconnects on its own.
  const supervise = (s: { child: ChildProcess; ready: Ready }) => {
    s.child.once('exit', async (code) => {
      if (stopping) return;
      if (code === RESTART_CODE) {
        process.stdout.write(color.dim('Restarting Mitzi…\n'));
        try {
          const previous = server.ready.version;
          server = await startServer(port);
          process.stdout.write(`${color.green('✓')} ${server.ready.version !== previous ? `Updated to v${server.ready.version}` : 'Restarted'}\n`);
          supervise(server);
          return;
        } catch (err) {
          process.stderr.write(color.red(`Mitzi couldn't restart: ${(err as Error).message}\n`));
        }
      }
      stopping = true;
      done(code ?? 1);
    });
  };
  supervise(server);
  process.once('SIGINT', () => stop(0));
  process.once('SIGTERM', () => stop(0));

  const { url, version } = server.ready;
  process.stdout.write(banner(url, version));
  if (mode === 'ui' && opts.open) {
    const win = openWindow(url);
    if (win) {
      process.stdout.write(color.dim('Close the window or press Ctrl+C to quit.\n'));
      void win.then(() => stop(0));
    } else {
      process.stdout.write(color.yellow('Couldn’t open a desktop window (Electron isn’t installed and no Chrome or Edge was found), so Mitzi opened in your browser.\n'));
      openBrowser(url);
    }
  } else {
    process.stdout.write(color.dim('The link includes your private access token. Press Ctrl+C to stop.\n'));
    if (opts.open) openBrowser(url);
  }
  return finished;
}
