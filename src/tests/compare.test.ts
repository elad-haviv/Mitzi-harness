import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { looksLikeModelId, parseCompareArgs, runCompare, tallyFor } from '../compare.js';
import { loadInsights, recordPick, renderInsights, saveInsights } from '../insights.js';
import { OpenRouterClient } from '../openrouter.js';
import { CompareUI } from '../ui.js';
import { mockByModel, tempDir, textChunks } from './helpers.js';

const servers: { close(): void }[] = [];
after(() => servers.forEach((s) => s.close()));

test('looksLikeModelId accepts vendor/model and rejects prompts', () => {
  assert.ok(looksLikeModelId('openai/gpt-5'));
  assert.ok(looksLikeModelId('anthropic/claude-sonnet-4.5'));
  assert.ok(!looksLikeModelId('npm/test scripts'));
  assert.ok(!looksLikeModelId('plainword'));
  assert.ok(!looksLikeModelId('a/b/c'));
});

test('parseCompareArgs: zero, one and two model ids', () => {
  const withChallenger = parseCompareArgs('write fizzbuzz', 'anthropic/a', 'openai/b');
  assert.deepEqual(withChallenger, { modelA: 'anthropic/a', modelB: 'openai/b', prompt: 'write fizzbuzz' });

  const one = parseCompareArgs('openai/b write fizzbuzz', 'anthropic/a', undefined);
  assert.deepEqual(one, { modelA: 'anthropic/a', modelB: 'openai/b', prompt: 'write fizzbuzz' });

  const two = parseCompareArgs('openai/b google/c write fizzbuzz', 'anthropic/a', 'openai/b');
  assert.deepEqual(two, { modelA: 'openai/b', modelB: 'google/c', prompt: 'write fizzbuzz' });

  const noChallenger = parseCompareArgs('write fizzbuzz', 'anthropic/a', undefined);
  assert.ok('error' in noChallenger && /compareModel/.test(noChallenger.error));

  const noPrompt = parseCompareArgs('openai/b', 'anthropic/a', undefined);
  assert.ok('error' in noPrompt && /Usage/.test(noPrompt.error));
});

test('parseCompareArgs: knownIds rescue vendor/slash-shaped prompt text', () => {
  const known = new Set(['openai/gpt-5']);
  const r = parseCompareArgs('npm/test scripts fail', 'anthropic/a', 'openai/gpt-5', known);
  assert.deepEqual(r, { modelA: 'anthropic/a', modelB: 'openai/gpt-5', prompt: 'npm/test scripts fail' });
  const r2 = parseCompareArgs('openai/gpt-5 vs tests', 'anthropic/a', undefined, known);
  assert.deepEqual(r2, { modelA: 'anthropic/a', modelB: 'openai/gpt-5', prompt: 'vs tests' });
});

test('runCompare streams both sides in parallel and applies the pick', async () => {
  const script = new Map<string, object[][]>([
    ['model/a', [textChunks('Answer A one'), textChunks('Answer A two')]],
    ['model/b', [textChunks('Answer B one')]],
  ]);
  const mock = await mockByModel(script);
  servers.push(mock.server);
  const client = new OpenRouterClient({ apiKey: 'k', baseUrl: mock.url, maxRetries: 0 });
  const ui = new CompareUI('model/a', 'model/b');
  let usageCount = 0;
  const outcome = await runCompare({
    client,
    ui,
    modelA: 'model/a',
    modelB: 'model/b',
    prompt: 'hello',
    pick: async () => 'B',
    onUsage: () => usageCount++,
  });
  assert.equal(outcome.winner, 'B');
  assert.equal(outcome.textB, 'Answer B one');
  assert.equal(usageCount, 2); // both sides reported usage
  assert.ok(outcome.errorA === undefined && outcome.errorB === undefined);
});

test('runCompare: one side failing still lets the user pick the other', async () => {
  const script = new Map<string, object[][]>([
    ['model/bad', []], // script exhausted → server 500
    ['model/good', [textChunks('The good answer')]],
  ]);
  const mock = await mockByModel(script);
  servers.push(mock.server);
  const client = new OpenRouterClient({ apiKey: 'k', baseUrl: mock.url, maxRetries: 0 });
  const ui = new CompareUI('model/bad', 'model/good');
  let picked: string | undefined;
  const outcome = await runCompare({
    client,
    ui,
    modelA: 'model/bad',
    modelB: 'model/good',
    prompt: 'hello',
    pick: async (o) => {
      picked = o.winner;
      return 'B';
    },
  });
  assert.match(outcome.errorA ?? '', /Failed|exhausted|HTTP/i);
  assert.equal(outcome.winner, 'B');
  assert.equal(picked, undefined); // pick is asked before winner is set
});

test('runCompare: skip records no winner', async () => {
  const mock = await mockByModel(
    new Map([
      ['model/a', [textChunks('A')]],
      ['model/b', [textChunks('B')]],
    ]),
  );
  servers.push(mock.server);
  const client = new OpenRouterClient({ apiKey: 'k', baseUrl: mock.url, maxRetries: 0 });
  const outcome = await runCompare({
    client,
    ui: new CompareUI('model/a', 'model/b'),
    modelA: 'model/a',
    modelB: 'model/b',
    prompt: 'hello',
    pick: async () => 'skip',
  });
  assert.equal(outcome.winner, undefined);
  assert.deepEqual(tallyFor(outcome), {});
});

test('tallyFor counts a loss only when the loser actually answered', () => {
  const base = { modelA: 'model/a', modelB: 'model/b', textA: 'a', textB: 'b' };
  assert.deepEqual(tallyFor({ ...base, winner: 'A' }), { winner: 'model/a', loser: 'model/b' });
  assert.deepEqual(tallyFor({ ...base, winner: 'B', errorA: 'boom' }), { winner: 'model/b', loser: undefined });
  assert.deepEqual(tallyFor({ ...base, errorA: 'x', errorB: 'y' }), {});
});

test('insights: load/record/save round-trip and leaderboard rendering', async (t) => {
  const home = tempDir();
  const prevHome = process.env.MITZI_HOME;
  t.after(() => {
    if (prevHome === undefined) delete process.env.MITZI_HOME;
    else process.env.MITZI_HOME = prevHome;
  });
  process.env.MITZI_HOME = home;
  assert.deepEqual(loadInsights(), { wins: {}, losses: {}, comparisons: 0, skipped: 0 });

  const data = loadInsights();
  recordPick(data, 'openai/gpt-5', 'anthropic/claude');
  recordPick(data, 'openai/gpt-5', 'anthropic/claude');
  recordPick(data, 'anthropic/claude', 'openai/gpt-5');
  recordPick(data, undefined, undefined);
  saveInsights(data);

  const loaded = loadInsights();
  assert.equal(loaded.comparisons, 4);
  assert.equal(loaded.skipped, 1);
  assert.equal(loaded.wins['openai/gpt-5'], 2);
  assert.equal(loaded.losses['anthropic/claude'], 2);

  const lines = renderInsights(loaded);
  assert.match(lines[0], /2W 1L/);
  assert.match(lines[0], /openai\/gpt-5/);
  assert.match(lines[1], /1W 2L/);
  assert.match(lines[1], /anthropic\/claude/);
});

test('insights: corrupt file falls back to empty', async (t) => {
  const home = tempDir();
  const prevHome = process.env.MITZI_HOME;
  t.after(() => {
    if (prevHome === undefined) delete process.env.MITZI_HOME;
    else process.env.MITZI_HOME = prevHome;
  });
  process.env.MITZI_HOME = home;
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'insights.json'), '{not json');
  const data = loadInsights();
  assert.deepEqual(data, { wins: {}, losses: {}, comparisons: 0, skipped: 0 });
});
