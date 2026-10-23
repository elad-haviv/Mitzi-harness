import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ruleMatches } from '../permissions.js';
import { bashTool } from '../tools/bash.js';
import { editTool, readTool, simpleDiff, writeTool } from '../tools/fs.js';
import { globToRegExp, globTool, grepTool } from '../tools/search.js';
import { htmlToText } from '../tools/web.js';
import { makeCtx, tempDir } from './helpers.js';

test('Read numbers lines and supports offset/limit', async () => {
  const cwd = tempDir();
  writeFileSync(join(cwd, 'a.txt'), 'one\ntwo\nthree\nfour\n');
  const ctx = makeCtx(cwd);
  assert.equal(await readTool.run({ file_path: 'a.txt' }, ctx), '1\tone\n2\ttwo\n3\tthree\n4\tfour');
  const part = await readTool.run({ file_path: 'a.txt', offset: 2, limit: 2 }, ctx);
  assert.match(part, /^2\ttwo\n3\tthree\n… 1 more lines/);
});

test('Edit requires a prior Read and a unique match', async () => {
  const cwd = tempDir();
  const file = join(cwd, 'b.ts');
  writeFileSync(file, 'const x = 1;\nconst y = 1;\n');
  const ctx = makeCtx(cwd);

  await assert.rejects(editTool.run({ file_path: file, old_string: 'x', new_string: 'z' }, ctx), /has not been read/);
  await readTool.run({ file_path: file }, ctx);
  await assert.rejects(editTool.run({ file_path: file, old_string: '= 1', new_string: '= 2' }, ctx), /appears 2 times/);
  await assert.rejects(editTool.run({ file_path: file, old_string: 'nope', new_string: 'x' }, ctx), /not found/);

  await editTool.run({ file_path: file, old_string: 'const x = 1;', new_string: 'const x = 42;' }, ctx);
  assert.equal(readFileSync(file, 'utf8'), 'const x = 42;\nconst y = 1;\n');

  await editTool.run({ file_path: file, old_string: 'const', new_string: 'let', replace_all: true }, ctx);
  assert.equal(readFileSync(file, 'utf8'), 'let x = 42;\nlet y = 1;\n');
});

test('Edit treats $ in new_string literally', async () => {
  const cwd = tempDir();
  const file = join(cwd, 'c.js');
  writeFileSync(file, 'price = X\n');
  const ctx = makeCtx(cwd);
  await readTool.run({ file_path: file }, ctx);
  await editTool.run({ file_path: file, old_string: 'X', new_string: "'$&$1'" }, ctx);
  assert.equal(readFileSync(file, 'utf8'), "price = '$&$1'\n");
});

test('Write refuses to clobber a file changed since it was read', async () => {
  const cwd = tempDir();
  const file = join(cwd, 'd.txt');
  writeFileSync(file, 'v1');
  const ctx = makeCtx(cwd);
  await readTool.run({ file_path: file }, ctx);
  const future = new Date(Date.now() + 10_000);
  utimesSync(file, future, future);
  await assert.rejects(writeTool.run({ file_path: file, content: 'v2' }, ctx), /modified since/);

  const created = await writeTool.run({ file_path: 'nested/dir/new.txt', content: 'x' }, ctx);
  assert.match(created, /Created nested\/dir\/new.txt/);
});

test('Bash reports exit codes and persists cd', async () => {
  const cwd = realpathSync(tempDir());
  mkdirSync(join(cwd, 'sub'));
  const ctx = makeCtx(cwd);
  assert.match(await bashTool.run({ command: 'echo hi; exit 3' }, ctx), /hi\n\[Exit code 3\]/);
  await bashTool.run({ command: 'cd sub' }, ctx);
  assert.equal(ctx.cwd, join(cwd, 'sub'));
  // Git bash prints MSYS-style paths (/c/...); compare endsWith on the dir name instead.
  assert.match((await bashTool.run({ command: 'pwd' }, ctx)).trim(), /[\\/]sub$/);
  assert.match(await bashTool.run({ command: 'sleep 5', timeout: 1000 }, ctx), /timed out/);
});

test('Glob and Grep find files and content', async () => {
  const cwd = tempDir();
  mkdirSync(join(cwd, 'src'));
  writeFileSync(join(cwd, 'src', 'main.ts'), 'export function hello() {}\n');
  writeFileSync(join(cwd, 'src', 'util.js'), 'function hello() {}\n');
  writeFileSync(join(cwd, 'README.md'), 'hello docs\n');
  const ctx = makeCtx(cwd);

  assert.equal(await globTool.run({ pattern: '**/*.ts' }, ctx), 'src/main.ts');
  const files = (await grepTool.run({ pattern: 'function hello' }, ctx)).split('\n').sort();
  assert.deepEqual(files, ['src/main.ts', 'src/util.js']);
  assert.equal(await grepTool.run({ pattern: 'hello', glob: '*.md', output_mode: 'content' }, ctx), 'README.md:1:hello docs');
  assert.equal(await grepTool.run({ pattern: 'zzz' }, ctx), 'No matches found');
});

test('globToRegExp handles common patterns', () => {
  assert.ok(globToRegExp('**/*.ts').test('a/b/c.ts'));
  assert.ok(globToRegExp('**/*.ts').test('c.ts'));
  assert.ok(!globToRegExp('*.ts').test('a/c.ts'));
  assert.ok(globToRegExp('src/*.{js,ts}').test('src/x.js'));
  assert.ok(!globToRegExp('src/*.{js,ts}').test('src/x.py'));
  assert.ok(globToRegExp('file?.[ch]').test('file1.c'));
});

test('permission rules match tool names and safe Bash prefixes', () => {
  const bash = { name: 'Bash' } as any;
  assert.ok(ruleMatches('Bash', bash, { command: 'anything' }));
  assert.ok(ruleMatches('Bash(npm test)', bash, { command: 'npm test -- --watch' }));
  assert.ok(!ruleMatches('Bash(npm test)', bash, { command: 'npm testing' }));
  assert.ok(!ruleMatches('Bash(npm test)', bash, { command: 'npm test && rm -rf /' }));
  assert.ok(!ruleMatches('Bash(git)', bash, { command: 'git log $(rm x)' }));
  assert.ok(ruleMatches('Edit', { name: 'Edit' } as any, {}));
  assert.ok(!ruleMatches('Edit', { name: 'Write' } as any, {}));
});

test('helpers: diff and html conversion', () => {
  assert.equal(simpleDiff('a\nb\nc', 'a\nB\nc'), '@@ line 1 @@\n  a\n- b\n+ B\n  c');
  assert.equal(htmlToText('<html><head><title>x</title></head><body><p>Hi &amp; bye</p><script>evil()</script></body></html>'), 'Hi & bye');
});
