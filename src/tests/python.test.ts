import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { PythonSandbox, pythonTool } from '../server/python.js';
import { makeCtx, tempDir } from './helpers.js';

const sandbox = new PythonSandbox(tempDir());
after(() => sandbox.close());

test('python runs code, keeps variables between calls, and works in /work', { timeout: 120_000 }, async (t) => {
  if (!sandbox.available()) return t.skip('pyodide is not installed');
  const dir = sandbox.sandboxDir('chat-1');
  let r = await sandbox.run('chat-1', dir, 'x = 6 * 7\nprint("hello")\nx');
  assert.equal(r.output, 'hello\n');
  assert.equal(r.result, '42');
  r = await sandbox.run('chat-1', dir, "open('out.txt', 'w').write(str(x + 1))\nimport os\nos.getcwd()");
  assert.equal(r.result, '/work');
  assert.equal(readFileSync(join(dir, 'out.txt'), 'utf8'), '43');
  // Errors come back as Python tracebacks.
  r = await sandbox.run('chat-1', dir, '1 / 0');
  assert.match(r.error ?? '', /ZeroDivisionError/);
});

test('python: images saved to /work come back; a timeout restarts the interpreter', { timeout: 120_000 }, async (t) => {
  if (!sandbox.available()) return t.skip('pyodide is not installed');
  const dir = sandbox.sandboxDir('chat-2');
  const shown: string[] = [];
  const tool = pythonTool(sandbox, 'chat-2', dir, false, (img) => (shown.push(img.dataUrl), img.name));
  // A 1×1 PNG, written by the code.
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const out = await tool.run({ code: `import base64\nopen('dot.png','wb').write(base64.b64decode('${png}'))\nprint('saved')` }, makeCtx(dir));
  assert.match(out, /saved[\s\S]*\[Shown to the user: dot.png\]/);
  assert.equal(shown[0], `data:image/png;base64,${png}`);

  const r = await sandbox.run('chat-2', dir, 'y = 1\nwhile True: pass', { timeoutMs: 1500 });
  assert.equal(r.timedOut, true);
  assert.match(r.error ?? '', /Timed out/);
  // A fresh interpreter: y is gone.
  assert.match((await sandbox.run('chat-2', dir, 'y')).error ?? '', /NameError/);
});
