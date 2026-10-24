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
import { changesFromMessages, parseCritique } from '../server/critique.js';
import { LessonHygiene, scoreLessons } from '../server/lesson-hygiene.js';
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

test('self-review: changes are read from the transcript; an unreadable verdict never blocks', () => {
  const changes = changesFromMessages([
    { role: 'assistant', content: null, tool_calls: [call('a', 'Edit', { file_path: 'a.ts', old_string: 'x + 1', new_string: 'x - 1' }), call('b', 'Write', { file_path: 'b.ts', content: 'oops' })] },
    { role: 'tool', tool_call_id: 'a', content: 'Edited a.ts' },
    { role: 'tool', tool_call_id: 'b', content: 'Error: must Read first' },
  ]);
  assert.match(changes, /### Edited a\.ts\n--- before\nx \+ 1\n\+\+\+ after\nx - 1/);
  assert.doesNotMatch(changes, /b\.ts/);
  assert.deepEqual(parseCritique('{"ok": false, "issues": ["a.ts: subtracts instead of adding"]}'), { ok: false, issues: ['a.ts: subtracts instead of adding'] });
  assert.equal(parseCritique('{"ok": false, "issues": []}').ok, true);
  assert.equal(parseCritique('looks fine').ok, true);
});

/** A model that answers every request with `reply`. */
const fakeClient = (reply: (prompt: string) => string) => ({ chat: async (req: any) => ({ content: reply(JSON.stringify(req.messages)), toolCalls: [] }) }) as any;

test('lesson hygiene: lessons are scored against outcomes; ones that hurt retire, and can be restored', async () => {
  const lesson = (id: string, text: string) => ({ id, text, value: -1 as const, chatId: '', createdAt: '', source: 'outcome' as const });
  const good = (ids: string[]) => outcome({ lessonIds: ids });
  const bad = (ids: string[]) => outcome({ lessonIds: ids, redone: true });
  // With "bad": 2 of 8 went well; without it: 8 of 10.
  const outcomes = [...Array.from({ length: 2 }, () => good(['bad', 'ok'])), ...Array.from({ length: 6 }, () => bad(['bad', 'ok'])), ...Array.from({ length: 8 }, () => good(['ok'])), bad([]), bad([])];
  const scores = scoreLessons([lesson('bad', 'Always rewrite whole files.'), lesson('ok', 'Read before editing.'), lesson('new', 'Fresh.')], outcomes);
  assert.deepEqual(scores.map((s) => [s.lessonId, s.uses, s.verdict]), [['bad', 8, 'hurting'], ['ok', 16, 'helping'], ['new', 0, 'unproven']]);

  const store = new Store(tempDir());
  const log = new OutcomeLog(tempDir());
  for (const o of outcomes) log.record(o);
  store.bots.put({ id: 'mitzi', name: 'Mitzi', emoji: '🐱', description: '', systemPrompt: '', tools: {} as any, memory: {} as any, starters: [], createdAt: '', updatedAt: '', lessons: [lesson('bad', 'Always rewrite whole files.'), lesson('ok', 'Read before editing.')] });
  const hygiene = new LessonHygiene({ store, log, client: () => fakeClient(() => '{"lessons": []}'), config: () => ({ model: 'm' }) as any });
  assert.deepEqual(await hygiene.tidy('mitzi'), { retired: 1, merged: 0 });
  assert.deepEqual(store.bots.get('mitzi')!.lessons!.map((l) => l.id), ['ok']);
  assert.match(store.bots.get('mitzi')!.retiredLessons![0].reason, /25% of the time with it, 80% without/);
  hygiene.restore('mitzi', 'bad');
  assert.deepEqual(store.bots.get('mitzi')!.lessons!.map((l) => l.id), ['ok', 'bad']);
});

test('lesson hygiene: tidying merges duplicates and drops what is vague, keeping the rest', async () => {
  const store = new Store(tempDir());
  const lesson = (id: string, text: string) => ({ id, text, value: -1 as const, chatId: '', createdAt: '', source: 'outcome' as const });
  store.bots.put({ id: 'b', name: 'B', emoji: '', description: '', systemPrompt: '', tools: {} as any, memory: {} as any, starters: [], createdAt: '', updatedAt: '', lessons: [lesson('1', 'Read files before editing.'), lesson('2', 'Always read a file before you edit it.'), lesson('3', 'Be good.'), lesson('4', 'Run tests after changes.')] });
  const hygiene = new LessonHygiene({
    store,
    log: new OutcomeLog(tempDir()),
    client: () => fakeClient(() => '{"lessons": [{"text": "Read a file before editing it.", "from": [1, 2]}, {"text": "Run tests after changes.", "from": [4]}], "dropped": [{"n": 3, "reason": "Too vague"}]}'),
    config: () => ({ model: 'm' }) as any,
  });
  assert.deepEqual(await hygiene.tidy('b', true), { retired: 0, merged: 2 });
  const bot = store.bots.get('b')!;
  assert.deepEqual(bot.lessons!.map((l) => l.text), ['Read a file before editing it.', 'Run tests after changes.']);
  assert.equal(bot.lessons![1].id, '4');
  assert.deepEqual(bot.retiredLessons!.map((l) => l.reason), ['Merged into: Read a file before editing it.', 'Merged into: Read a file before editing it.', 'Too vague']);
});
