// Unit tests for how Mitzi checks its work and learns from experience.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Message } from '../openrouter.js';
import { detectVerifyCommand, touchedFiles, verifyCommandFor, verifyOutcome } from '../server/verify.js';
import { tempDir } from './helpers.js';

test('verification: the check command comes from the project manifests', () => {
  const node = tempDir();
  writeFileSync(join(node, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1', typecheck: 'tsc' } }));
  assert.equal(detectVerifyCommand(node), 'npm run typecheck');
  writeFileSync(join(node, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
  writeFileSync(join(node, 'pnpm-lock.yaml'), '');
  assert.equal(detectVerifyCommand(node), 'pnpm test');
  const go = tempDir();
  writeFileSync(join(go, 'go.mod'), 'module x');
  assert.equal(detectVerifyCommand(go), 'go test ./...');
  const make = tempDir();
  writeFileSync(join(make, 'Makefile'), 'build:\n\tcc x.c\ntest:\n\t./run\n');
  assert.equal(detectVerifyCommand(make), 'make test');
  assert.equal(detectVerifyCommand(tempDir()), undefined);
  const project = { folder: go, verify: { command: 'go vet ./...' } } as any;
  assert.equal(verifyCommandFor(project), 'go vet ./...');
  assert.equal(verifyCommandFor({ ...project, verify: { enabled: false } }), undefined);
  assert.equal(verifyCommandFor(undefined), undefined);
});

test('verification: changed files and pass/fail are read from the transcript', () => {
  const call = (id: string, name: string, args: object) => ({ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } });
  const messages: Message[] = [
    { role: 'assistant', content: null, tool_calls: [call('a', 'Write', { file_path: 'x.ts', content: '' }), call('b', 'Edit', { file_path: 'y.ts' }), call('c', 'Read', { file_path: 'z.ts' })] },
    { role: 'tool', tool_call_id: 'a', content: 'Wrote x.ts' },
    { role: 'tool', tool_call_id: 'b', content: 'Error: old_string not found' },
    { role: 'tool', tool_call_id: 'c', content: '1 hello' },
  ];
  assert.deepEqual(touchedFiles(messages), ['x.ts']);
  assert.equal(verifyOutcome('npm test', 'ok\n# pass 3').passed, true);
  assert.equal(verifyOutcome('npm test', 'boom\n[Exit code 1]').passed, false);
  assert.equal(verifyOutcome('npm test', 'slow\n[Command timed out after 600s]').passed, false);
});
