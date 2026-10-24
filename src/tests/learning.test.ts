// Unit tests for how Mitzi checks its work and learns from experience.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Message } from '../openrouter.js';
import { detectVerifyCommand, touchedFiles, verifyCommandFor, verifyOutcome } from '../server/verify.js';
import { backfillOutcomes, classifyError, describeOutcomes, hasSignal, OutcomeLog, parseLessons, summarizeRun } from '../server/outcomes.js';
import { Store } from '../server/store.js';
import type { TaskOutcome } from '../shared/types.js';
import { lineDiff, meaningfulEdit } from '../server/edits.js';
import { factsFromOutcome, looksLikeCorrection, MD_START, proposeInstructions } from '../server/project-knowledge.js';
import { tempDir } from './helpers.js';

const call = (id: string, name: string, args: object) => ({ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } });

export function outcome(fields: Partial<TaskOutcome> = {}): TaskOutcome {
  return {
    id: Math.random().toString(36).slice(2),
    ts: Date.now(),
    chatId: 'c1',
    botId: 'mitzi',
    model: 'test/model',
    task: 'Fix the bug',
    mode: 'work',
    source: 'run',
    attempts: 1,
    toolCalls: 3,
    toolErrors: 0,
    errors: [],
    errorKinds: [],
    filesTouched: [],
    commands: [],
    redone: false,
    lessonIds: [],
    ...fields,
  };
}

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

test('outcomes: failures are told apart: the agent\'s mistakes, the environment, the user saying no', () => {
  assert.equal(classifyError('Error: old_string not found in src/a.ts'), 'agent');
  assert.equal(classifyError("src/a.ts(3,1): error TS2304: Cannot find name 'x'.\n[Exit code 2]"), 'agent');
  assert.equal(classifyError('Error: No working bash found. Install Git for Windows or enable WSL'), 'environment');
  assert.equal(classifyError('listen EADDRINUSE: address already in use :::3000\n[Exit code 1]'), 'environment');
  assert.equal(classifyError('pnpm: command not found\n[Exit code 127]'), 'environment');
  assert.equal(classifyError('The user declined this tool call. Stop and wait for their instructions.'), 'declined');
  assert.equal(classifyError('Something odd happened'), 'unknown');
});

test('outcomes: a run is summarized from its messages', () => {
  const run = summarizeRun([
    { role: 'assistant', content: null, tool_calls: [call('a', 'Edit', { file_path: 'a.ts' }), call('b', 'Bash', { command: 'npm test' }), call('c', 'Bash', { command: 'grep -r foo .' })] },
    { role: 'tool', tool_call_id: 'a', content: 'Error: old_string not found' },
    { role: 'tool', tool_call_id: 'b', content: '1 failing\n[Exit code 1]' },
    { role: 'tool', tool_call_id: 'c', content: '(no output)\n[Exit code 1]' },
    { role: 'assistant', content: null, tool_calls: [call('d', 'Bash', { command: 'pnpm install' }), call('e', 'Write', { file_path: 'b.ts', content: '' }), call('f', 'Bash', { command: 'npm test' })] },
    { role: 'tool', tool_call_id: 'd', content: 'pnpm: command not found\n[Exit code 127]' },
    { role: 'tool', tool_call_id: 'e', content: 'Wrote b.ts' },
    { role: 'tool', tool_call_id: 'f', content: '# pass 4' },
  ]);
  assert.equal(run.toolCalls, 6);
  // The edit mistake and the missing pnpm; a failing test run or an empty grep is just work.
  assert.deepEqual(run.errors.map((e) => e.kind), ['agent', 'environment']);
  assert.equal(run.toolErrors, 2);
  assert.deepEqual(run.filesTouched, ['b.ts']);
  assert.equal(run.testsPassed, true);
  assert.deepEqual(run.commands.map((c) => c.ok), [false, false, false, true]);
});

test('outcomes: the ledger keeps outcomes and later amendments across restarts; feedback loops are backfilled once', () => {
  const dir = tempDir();
  const log = new OutcomeLog(dir);
  const o = log.record(outcome({ id: 'o1' }));
  assert.equal(hasSignal(o), false);
  log.amend('o1', { redone: true, rating: 2 });
  const again = new OutcomeLog(dir);
  assert.deepEqual([again.get('o1')?.redone, again.get('o1')?.rating], [true, 2]);
  assert.equal(hasSignal(again.get('o1')!), true);

  const store = new Store(tempDir());
  store.feedback.put({ id: 'l1', chatId: 'c', botId: 'mitzi', task: 'Write a note', status: 'accepted', iterations: [{ messageIndex: 1, rating: 2, at: '' }, { messageIndex: 3, rating: 5, at: '' }], createdAt: new Date().toISOString(), updatedAt: '' });
  assert.equal(backfillOutcomes(again, store), 1);
  assert.equal(backfillOutcomes(again, store), 0);
  const filled = again.get('fb-l1')!;
  assert.deepEqual([filled.attempts, filled.redone, filled.rating, filled.source, filled.distilled], [2, true, 5, 'backfill', true]);
});

test('outcomes: the distillation prompt keeps environment problems apart; lessons are parsed from JSON', () => {
  const text = describeOutcomes([
    outcome({ errors: [{ tool: 'Edit', kind: 'agent', text: 'old_string not found' }, { tool: 'Bash', kind: 'environment', text: 'No working bash found' }], firstCheckPassed: false }),
  ]);
  assert.match(text.outcomes, /Edit failed: old_string not found/);
  assert.match(text.outcomes, /harness had to send it back/);
  assert.doesNotMatch(text.outcomes, /No working bash/);
  assert.match(text.environment, /No working bash found/);
  assert.deepEqual(parseLessons('Sure: {"lessons": ["Read files before editing them.", ""]}'), ['Read files before editing them.']);
  assert.deepEqual(parseLessons('nothing'), []);
});

test('edits: a readable line diff, and whitespace-only edits are ignored', () => {
  assert.equal(lineDiff('a\nb\nc\nd', 'a\nB\nc\nd'), '  a\n- b\n+ B\n  c');
  assert.equal(lineDiff('x\ny', 'x\ny\nz'), '  y\n+ z');
  assert.equal(meaningfulEdit('a  b\n', 'a b'), false);
  assert.equal(meaningfulEdit('a b', 'a c'), true);
});

test('project knowledge: facts come from checks that pass, commands that keep working, and machine gotchas', () => {
  const earlier = outcome({ commands: [{ command: 'cd /x && npm run build', ok: true }, { command: 'ls', ok: true }] });
  const now = outcome({
    checkCommand: 'npm test',
    testsPassed: true,
    commands: [{ command: 'npm run build', ok: true }, { command: 'ls', ok: true }, { command: 'npm run lint', ok: true }, { command: 'pnpm i', ok: false }],
    errors: [{ tool: 'Bash', kind: 'environment', text: 'pnpm: command not found\n[Exit code 127]', command: 'pnpm i' }],
  });
  assert.deepEqual(
    factsFromOutcome(now, [earlier]).map((f) => f.text),
    ['Verify changes with `npm test`.', '`npm run build` works here.', 'On this machine, `pnpm i` fails: pnpm: command not found'],
  );
  assert.equal(looksLikeCorrection('No, we use pnpm here'), true);
  assert.equal(looksLikeCorrection('Use vitest instead of jest'), true);
  assert.equal(looksLikeCorrection('Add a dark mode toggle'), false);
});

test('project knowledge: proposed instructions add only what the file lacks, in a section that can be updated', () => {
  const fact = (text: string, kind: any) => ({ id: text, text, kind, source: 'observed' as const, priority: 2, evidence: 2, createdAt: '', updatedAt: '' });
  const existing = '# Notes\n- Build with `npm run build`.\n';
  const first = proposeInstructions(existing, [fact('Build with `npm run build`.', 'command'), fact('Relative imports end in `.js`.', 'convention')]);
  assert.deepEqual(first.added.map((f) => f.text), ['Relative imports end in `.js`.']);
  assert.match(first.content, /# Notes[\s\S]*## Learned by Mitzi\n\n### Conventions\n- Relative imports end in `\.js`\./);
  const second = proposeInstructions(first.content, [fact('Relative imports end in `.js`.', 'convention'), fact('Tests need `tsc` first.', 'gotcha')]);
  assert.equal(second.content.split(MD_START).length, 2);
  assert.match(second.content, /### Gotchas on this machine\n- Tests need `tsc` first\./);
});
