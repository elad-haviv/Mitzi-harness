import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { OpenRouterClient } from '../openrouter.js';
import { CompareInsightsStore, looksLikeModelId, parseCompareArgs, runCompareRace, tallyFor } from '../server/compare.js';
import type { StreamEvent } from '../shared/types.js';
import { mockByModel, tempDir, textChunks } from './helpers.js';

const servers: { close(): void }[] = [];
after(() => servers.forEach((s) => s.close()));

test('looksLikeModelId accepts vendor/model and provider:id, rejects prompts', () => {
  assert.ok(looksLikeModelId('openai/gpt-5'));
  assert.ok(looksLikeModelId('openai:gpt-5'));
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

test('runCompareRace streams both sides in parallel and applies the pick', async () => {
  const script = new Map<string, object[][]>([
    ['model/a', [textChunks('Answer A one')]],
    ['model/b', [textChunks('Answer B one')]],
  ]);
  const mock = await mockByModel(script);
  servers.push(mock.server);
  const client = new OpenRouterClient({ apiKey: 'k', baseUrl: mock.url, maxRetries: 0 });
  const events: StreamEvent[] = [];
  const outcome = await runCompareRace({
    client,
    modelA: 'model/a',
    modelB: 'model/b',
    prompt: 'hello',
    emit: (e) => events.push(e),
    waitForPick: async () => 'B',
  });
  assert.equal(outcome.winner, 'B');
  assert.equal(outcome.textB, 'Answer B one');
  assert.ok(outcome.errorA === undefined && outcome.errorB === undefined);
  assert.equal(events[0].type, 'compare_start');
  assert.ok(events.some((e) => e.type === 'compare_text' && e.side === 'A'));
  assert.ok(events.some((e) => e.type === 'compare_text' && e.side === 'B'));
  assert.ok(events.some((e) => e.type === 'compare_end' && e.side === 'B' && !e.error));
});

test('runCompareRace: one side failing still lets the user pick the other', async () => {
  const script = new Map<string, object[][]>([
    ['model/bad', []], // script exhausted → server 500
    ['model/good', [textChunks('The good answer')]],
  ]);
  const mock = await mockByModel(script);
  servers.push(mock.server);
  const client = new OpenRouterClient({ apiKey: 'k', baseUrl: mock.url, maxRetries: 0 });
  const outcome = await runCompareRace({
    client,
    modelA: 'model/bad',
    modelB: 'model/good',
    prompt: 'hello',
    emit: () => {},
    waitForPick: async () => 'B',
  });
  assert.match(outcome.errorA ?? '', /Failed|exhausted|HTTP/i);
  assert.equal(outcome.winner, 'B');
});

test('runCompareRace: skip records no winner', async () => {
  const mock = await mockByModel(
    new Map([
      ['model/a', [textChunks('A')]],
      ['model/b', [textChunks('B')]],
    ]),
  );
  servers.push(mock.server);
  const client = new OpenRouterClient({ apiKey: 'k', baseUrl: mock.url, maxRetries: 0 });
  const outcome = await runCompareRace({
    client,
    modelA: 'model/a',
    modelB: 'model/b',
    prompt: 'hello',
    emit: () => {},
    waitForPick: async () => 'skip',
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

test('CompareInsightsStore: record/persist/reload round-trip', () => {
  const dir = tempDir();
  const store = new CompareInsightsStore(dir);
  store.record('openai/gpt-5', 'anthropic/claude');
  store.record('openai/gpt-5', 'anthropic/claude');
  store.record('anthropic/claude', 'openai/gpt-5');
  store.record(undefined, undefined);

  // Persisted as JSON on disk.
  const onDisk = JSON.parse(readFileSync(join(dir, 'compare-insights.json'), 'utf8'));
  assert.equal(onDisk.comparisons, 4);

  const reloaded = new CompareInsightsStore(dir).insights;
  assert.equal(reloaded.comparisons, 4);
  assert.equal(reloaded.skipped, 1);
  assert.equal(reloaded.wins['openai/gpt-5'], 2);
  assert.equal(reloaded.losses['anthropic/claude'], 2);
  assert.equal(reloaded.wins['anthropic/claude'], 1);
});

test('CompareInsightsStore: corrupt file falls back to empty', () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'compare-insights.json'), '{not json');
  const data = new CompareInsightsStore(dir).insights;
  assert.deepEqual(data, { wins: {}, losses: {}, comparisons: 0, skipped: 0 });
});
