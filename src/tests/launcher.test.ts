import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers.js';

const CLI = fileURLToPath(new URL('../index.js', import.meta.url));
const home = tempDir();
const port = 46000 + Math.floor(Math.random() * 1000);
const env = { ...process.env, MITZI_HOME: home, OPENROUTER_API_KEY: 'test', CLAUDE_CONFIG_DIR: tempDir() };
const procs: ChildProcess[] = [];

function run(args: string[]): { proc: ChildProcess; output: () => string; exited: Promise<number | null> } {
  const proc = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(proc);
  let out = '';
  proc.stdout!.on('data', (d) => (out += d));
  proc.stderr!.on('data', (d) => (out += d));
  return { proc, output: () => out, exited: new Promise((r) => proc.on('exit', r)) };
}

async function until(fn: () => boolean | Promise<boolean>, ms = 15_000) {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

const token = () => readFileSync(join(home, 'ui-token'), 'utf8').trim();
const settings = () =>
  fetch(`http://127.0.0.1:${port}/api/settings`, { headers: { 'x-mitzi-token': token(), connection: 'close' }, signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);

after(() => procs.forEach((p) => p.kill('SIGTERM')));

test('mitzi web serves the app, restarts on request, and a second launch reuses it', async () => {
  const web = run(['web', '--no-open', '--port', String(port)]);
  await until(() => web.output().includes('is running at'));
  assert.match(web.output(), new RegExp(`http://localhost:${port}/\\?token=`));
  assert.ok(await settings());

  // Restarting (as after an update) brings the server back on the same port and token.
  const res = await fetch(`http://127.0.0.1:${port}/api/restart`, { method: 'POST', headers: { 'x-mitzi-token': token() } });
  assert.equal(res.status, 200);
  await until(() => web.output().includes('Restarting Mitzi'));
  await until(settings);

  // Another `mitzi ui` while it runs doesn't start a second server.
  const second = run(['ui', '--no-open', '--port', String(port)]);
  assert.equal(await second.exited, 0);
  assert.match(second.output(), /already running/);

  web.proc.kill('SIGINT');
  assert.equal(await web.exited, 0);
  await until(async () => !(await settings()));
});

test('a port used by something else is reported', async () => {
  const { createServer } = await import('node:http');
  const other = createServer((_q, r) => r.end('not mitzi'));
  const busy = port + 1;
  await new Promise<void>((r) => other.listen(busy, '127.0.0.1', r));
  try {
    const web = run(['web', '--no-open', '--port', String(busy)]);
    assert.equal(await web.exited, 1);
    assert.match(web.output(), /Port \d+ is in use/);
  } finally {
    other.closeAllConnections();
    other.close();
  }
});
