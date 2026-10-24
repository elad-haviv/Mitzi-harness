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
import { learningMetrics, lessonsAt, weekOf } from '../server/metrics.js';
import { cleanRun, similarity } from '../server/playbooks.js';
import { modelHints } from '../server/adaptation.js';
import { evalCandidates, parseScore, summarizeEval } from '../server/evals.js';
import { learnedPick, routeStats } from '../server/learned-routing.js';
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

test('learning metrics: rates over outcomes, week by week, with the lessons in effect', () => {
  const day = 86_400_000;
  const monday = new Date(2026, 9, 19, 10).getTime();
  const list = [
    outcome({ ts: monday, redone: true, firstCheckPassed: false, testsPassed: true, errors: [{ tool: 'Edit', kind: 'agent', text: '' }], model: 'a' }),
    outcome({ ts: monday + day, firstCheckPassed: true, testsPassed: true, model: 'a' }),
    outcome({ ts: monday + 7 * day, model: 'b', rating: 5 }),
    outcome({ ts: monday + 8 * day, model: 'b', attempts: 2 }),
  ];
  const lessons = [{ id: 'l1', text: '', value: -1 as const, chatId: '', createdAt: new Date(monday + 2 * day).toISOString(), source: 'outcome' as const }];
  const retired = [{ ...lessons[0], id: 'l0', createdAt: new Date(monday - day).toISOString(), retiredAt: new Date(monday + 3 * day).toISOString(), reason: '' }];
  const m = learningMetrics(list, lessons, retired);
  assert.equal(m.overall.tasks, 4);
  assert.equal(m.overall.firstTryAccepted, 2 / 3);
  assert.equal(m.overall.firstCheckPassed, 0.5);
  assert.equal(m.overall.agentErrors, 0.25);
  assert.deepEqual(m.weekly.map((w) => [w.week, w.tasks, w.lessons]), [[weekOf(monday), 2, 1], [weekOf(monday + 7 * day), 2, 1]]);
  assert.deepEqual(m.byModel.map((x) => [x.model, x.tasks]), [['a', 2], ['b', 2]]);
  assert.equal(lessonsAt(monday, lessons, retired), 1);
  assert.equal(lessonsAt(monday + 2.5 * day, lessons, retired), 2);
  assert.deepEqual(m.lessonsBySource, { outcome: 1 });
});

test('playbooks: learned only from clean work, and offered to similar tasks', () => {
  const clean = outcome({ projectId: 'p', toolCalls: 6, filesTouched: ['a.ts'], testsPassed: true });
  assert.equal(cleanRun(clean), true);
  assert.equal(cleanRun({ ...clean, redone: true }), false);
  assert.equal(cleanRun({ ...clean, errors: [{ tool: 'Edit', kind: 'agent', text: '' }] }), false);
  // The machine getting in the way doesn't spoil a clean run.
  assert.equal(cleanRun({ ...clean, errors: [{ tool: 'Bash', kind: 'environment', text: '' }] }), true);
  assert.equal(cleanRun({ ...clean, source: 'teammate' }), false);
  const pb = { title: 'Add an API route', when: 'Adding a new HTTP endpoint to the server routes' };
  assert.ok(similarity('Add a route to the server for exporting users', pb) >= 0.2);
  assert.ok(similarity('Translate the README into Hebrew', pb) < 0.2);
});

test('per-model adaptation: notes appear only with enough evidence, and say what the numbers show', () => {
  const sloppy = (i: number) =>
    outcome({ model: 'weak', firstCheckPassed: i % 3 === 0, errors: [{ tool: 'Edit', kind: 'agent', text: 'old_string not found' }], filesTouched: ['a', 'b', 'c', 'd'] });
  const tidy = () => outcome({ model: 'strong', firstCheckPassed: true, filesTouched: ['a'] });
  const all = [...Array.from({ length: 9 }, (_, i) => sloppy(i)), ...Array.from({ length: 10 }, tidy)];
  const hints = modelHints('weak', all);
  assert.deepEqual(hints.map((h) => h.hint.split(' ').slice(0, 3).join(' ')), ["Before you say", 'Read a file', 'Keep changes focused']);
  assert.match(hints[0].why, /Only 33% of its checked work passed/);
  assert.deepEqual(modelHints('strong', all), []);
  assert.deepEqual(modelHints('weak', all.slice(0, 5)), []);
});

test('evals: replayable tasks are accepted ones on a clean commit; results add up per model', () => {
  const ok = outcome({ projectId: 'p', gitHead: 'abc', testsPassed: true, filesTouched: ['a'], task: 'Fix it' });
  const list = evalCandidates([ok, { ...ok, id: 'dup' }, { ...ok, id: 'r', task: 'Other', redone: true }, { ...ok, id: 'g', task: 'No head', gitHead: undefined }, { ...ok, id: 'q', task: 'Questions', filesTouched: [] }]);
  assert.deepEqual(list.map((o) => o.task), ['Fix it']);
  const run = {
    id: 'e',
    projectId: 'p',
    models: ['a', 'b'],
    status: 'done' as const,
    createdAt: '',
    items: [
      { outcomeId: '1', task: '', model: 'a', status: 'done' as const, testsPassed: true, score: 5, toolErrors: 0, cost: 0.1 },
      { outcomeId: '2', task: '', model: 'a', status: 'done' as const, testsPassed: false, score: 3, toolErrors: 2, cost: 0.1 },
      { outcomeId: '1', task: '', model: 'b', status: 'error' as const },
    ],
  };
  assert.deepEqual(summarizeEval(run).map((m) => [m.model, m.done, m.passRate, m.avgScore, m.avgToolErrors]), [['a', 2, 0.5, 4, 1], ['b', 0, undefined, undefined, undefined]]);
  assert.deepEqual(parseScore('{"score": 4.4, "notes": "ok"}'), { score: 4, notes: 'ok' });
  assert.deepEqual(parseScore('{"score": 9}'), { score: undefined, notes: undefined });
});

test('learned routing: switches only with enough data on both models and a clear lead', () => {
  const tasks = (model: string, good: number, bad: number, mode: 'work' | 'chat' = 'work') => [
    ...Array.from({ length: good }, () => outcome({ model, mode })),
    ...Array.from({ length: bad }, () => outcome({ model, mode, redone: true })),
  ];
  const evalRun = { id: 'e', projectId: 'p', models: ['c'], status: 'done' as const, createdAt: '', items: Array.from({ length: 6 }, () => ({ outcomeId: '', task: '', model: 'c', status: 'done' as const, testsPassed: true, score: 5 })) };
  const stats = routeStats([...tasks('strong', 4, 4), ...tasks('better', 7, 1), ...tasks('few', 3, 0), ...tasks('chatty', 9, 0, 'chat')], [evalRun]);
  // c's replays all passed: 100% beats better's 88% and strong's 50%.
  assert.match(learnedPick('work', 'strong', stats)!.reason, /^Learned: does multi-step work best here \(100% went well vs 50%\)/);
  assert.equal(learnedPick('work', 'strong', stats)!.model, 'c');
  assert.equal(learnedPick('work', 'strong', stats, new Set(['strong', 'better']))!.model, 'better');
  // Not enough on the current model, no clear lead, or nothing in the category: Auto's choice stands.
  assert.equal(learnedPick('work', 'few', stats), undefined);
  assert.equal(learnedPick('work', 'better', stats, new Set(['better', 'strong'])), undefined);
  assert.equal(learnedPick('chat', 'chatty', stats), undefined);
});

test('formatted editor: its HTML turns back into the same Markdown', async () => {
  const { htmlToMarkdown } = await import('../shared/htmlToMarkdown.js');
  type N = { nodeType: number; nodeName: string; textContent: string | null; childNodes: N[]; getAttribute(n: string): string | null };
  const t = (text: string): N => ({ nodeType: 3, nodeName: '#text', textContent: text, childNodes: [], getAttribute: () => null });
  const h = (tag: string, attrs: Record<string, string> | null, ...children: (N | string)[]): N => {
    const childNodes = children.map((c) => (typeof c === 'string' ? t(c) : c));
    return { nodeType: 1, nodeName: tag.toUpperCase(), childNodes, textContent: childNodes.map((c) => c.textContent).join(''), getAttribute: (n) => attrs?.[n] ?? null };
  };
  const doc = h(
    'div',
    null,
    h('h1', null, 'Q3 update'),
    h('p', null, 'We ', h('strong', null, 'shipped '), 'it. See ', h('a', { href: 'https://x.dev' }, 'the post'), ' and ', h('code', null, 'npm test'), '.'),
    h('ul', null, h('li', null, 'Billing'), h('li', null, 'Mobile', h('ol', null, h('li', null, 'iOS'), h('li', null, 'Android')))),
    h('blockquote', null, h('p', null, 'Great ', h('em', null, 'quarter'))),
    h('pre', null, h('code', { class: 'language-js' }, 'let a = 1;\n')),
    h('table', null, h('thead', null, h('tr', null, h('th', null, 'A'), h('th', null, 'B'))), h('tbody', null, h('tr', null, h('td', null, '1'), h('td', null, 'x|y')))),
    h('hr', null),
    h('div', null, 'Typed on a new line', h('br', null), 'and another'),
  );
  assert.equal(
    htmlToMarkdown(doc),
    [
      '# Q3 update',
      'We **shipped** it. See [the post](https://x.dev) and `npm test`.',
      '- Billing\n- Mobile\n  1. iOS\n  2. Android',
      '> Great *quarter*',
      '```js\nlet a = 1;\n```',
      '| A | B |\n| --- | --- |\n| 1 | x\\|y |',
      '---',
      'Typed on a new line  \nand another',
    ].join('\n\n') + '\n',
  );
});

test('budgets: several limits, each starting over when the user chose', async () => {
  const { budgetLimits, budgetStatus, periodOf, UsageLog } = await import('../server/usage.js');
  const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h);
  // Wednesday 2026-10-21.
  const now = at(2026, 10, 21);
  assert.deepEqual(periodOf({ id: 'w', amount: 1, period: 'week', resetDay: 1 }, now).start, at(2026, 10, 19, 0));
  assert.deepEqual(periodOf({ id: 'w', amount: 1, period: 'week', resetDay: 4 }, now).start, at(2026, 10, 15, 0));
  assert.deepEqual(periodOf({ id: 'm', amount: 1, period: 'month', resetDay: 25 }, now).start, at(2026, 9, 25, 0));
  assert.deepEqual(periodOf({ id: 'm', amount: 1, period: 'month', resetDay: 25 }, now).end, at(2026, 10, 25, 0));
  assert.deepEqual(periodOf({ id: 'm', amount: 1, period: 'month', resetDay: 15 }, now).start, at(2026, 10, 15, 0));
  assert.equal(periodOf({ id: 't', amount: 1, period: 'total', since: at(2026, 1, 1).toISOString() }, now).end, undefined);
  // Older settings with a daily and a monthly limit still count.
  assert.deepEqual(budgetLimits({ daily: 2, monthly: 30, alertPercent: 80, hardStop: false }).map((l) => l.period), ['day', 'month']);

  const log = new UsageLog(tempDir());
  log.record('m', { prompt_tokens: 1, completion_tokens: 1, cost: 4 } as any, { kind: 'chat' });
  const status = budgetStatus(log, { limits: [{ id: 'd', amount: 10, period: 'day' }, { id: 'w', amount: 4.5, period: 'week', resetDay: 1 }, { id: 'y', amount: 100, period: 'year' }], alertPercent: 80, hardStop: true });
  assert.deepEqual(status.limits.map((l) => [l.id, l.state]), [['d', 'ok'], ['w', 'warn'], ['y', 'ok']]);
  assert.equal(status.limit?.id, 'w');
  assert.equal(status.freeMode, false);
  const over = budgetStatus(log, { limits: [{ id: 'd', amount: 3, period: 'day' }], alertPercent: 80, hardStop: false, freeModel: 'free/model' });
  assert.deepEqual([over.state, over.freeMode, over.freeModel], ['over', true, 'free/model']);
});
