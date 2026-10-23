import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from './helpers.js';

// An "installed" copy (a clone) of a "published" repository.
const root = tempDir();
const upstream = join(root, 'upstream');
const app = join(root, 'app');
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const sh = (args: string[], cwd: string) => execFileSync('git', args, { cwd, env, stdio: 'pipe' }).toString();
const pkg = (version: string, build: string) => JSON.stringify({ name: 'fake-mitzi', version, private: true, scripts: { build } }, null, 2);
const BUILD_OK = 'node -e "require(\'fs\').writeFileSync(\'built.txt\', require(\'./package.json\').version)"';

execFileSync('mkdir', ['-p', upstream]);
sh(['init', '-q', '-b', 'main'], upstream);
writeFileSync(join(upstream, 'package.json'), pkg('1.0.0', BUILD_OK));
writeFileSync(join(upstream, '.gitignore'), 'built.txt\nnode_modules\npackage-lock.json\n');
sh(['add', '.'], upstream);
sh(['commit', '-qm', 'First release'], upstream);
sh(['clone', '-q', upstream, app], root);
process.env.MITZI_APP_DIR = app;

const { applyUpdate, checkForUpdates } = await import('../updater.js');

const publish = (version: string, build: string, message: string) => {
  writeFileSync(join(upstream, 'package.json'), pkg(version, build));
  sh(['commit', '-qam', message], upstream);
};

test('reports up to date, then lists new versions with their changes', async () => {
  let info = await checkForUpdates();
  assert.equal(info.supported, true);
  assert.equal(info.behind, 0);
  assert.equal(info.current.version, '1.0.0');

  publish('1.1.0', BUILD_OK, 'Add a cat');
  info = await checkForUpdates();
  assert.equal(info.behind, 1);
  assert.equal(info.latest?.version, '1.1.0');
  assert.deepEqual(info.commits.map((c) => c.subject), ['Add a cat']);
});

test('updates: pulls, installs when dependencies changed, builds', async () => {
  const events: any[] = [];
  assert.equal(await applyUpdate((e) => events.push(e)), true);
  assert.deepEqual(
    events.filter((e) => e.type === 'step').map((e) => `${e.step}:${e.status}`),
    ['download:running', 'download:done', 'install:running', 'install:done', 'build:running', 'build:done'],
  );
  assert.deepEqual(events.at(-1), { type: 'done', version: '1.1.0' });
  assert.equal(readFileSync(join(app, 'built.txt'), 'utf8'), '1.1.0');
  assert.equal((await checkForUpdates()).behind, 0);
});

test('a failed build rolls back to the version that was running', async () => {
  const before = sh(['rev-parse', 'HEAD'], app).trim();
  publish('1.2.0', 'node -e "process.exit(3)"', 'Broken release');
  const events: any[] = [];
  assert.equal(await applyUpdate((e) => events.push(e)), false);
  const error = events.find((e) => e.type === 'error');
  assert.match(error.message, /went back to the version you had/);
  assert.equal(sh(['rev-parse', 'HEAD'], app).trim(), before);
  assert.equal(readFileSync(join(app, 'built.txt'), 'utf8'), '1.1.0');
});

test('hand-edited files block updates instead of being overwritten', async () => {
  publish('1.3.0', BUILD_OK, 'Fix the broken release');
  writeFileSync(join(app, 'package.json'), pkg('1.1.0-mine', BUILD_OK));
  const info = await checkForUpdates();
  assert.equal(info.supported, false);
  assert.match(info.reason!, /changed by hand/);
  sh(['checkout', '.'], app);
  assert.equal((await checkForUpdates()).supported, true);
  assert.ok(existsSync(join(app, '.git')));
});
