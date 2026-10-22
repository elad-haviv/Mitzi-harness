import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitBudget, guessEntities } from '../server/memory/engine.js';
import { graphSearch, keywordSearch, parseTimeRange, reciprocalRankFusion, similarity, temporalSearch, tokenize } from '../server/memory/search.js';
import type { MemoryUnit } from '../shared/types.js';

const unit = (id: string, text: string, entities: string[] = [], occurredAt?: string): MemoryUnit => ({
  id,
  type: 'world',
  text,
  entities,
  occurredAt,
  mentionedAt: '2026-10-01T00:00:00.000Z',
  source: 'conversation',
});

const units = [
  unit('a', 'The user has a cat named Luna.', ['Luna']),
  unit('b', 'Luna is afraid of the vacuum cleaner.', ['Luna']),
  unit('c', 'The user works as a nurse at Rambam hospital.', ['Rambam']),
  unit('d', 'The user adopted Luna together with their partner Dana.', ['Luna', 'Dana']),
  unit('e', 'Dana is training for a marathon.', ['Dana'], '2026-10-20T00:00:00.000Z'),
];

test('tokenize drops stopwords and stems', () => {
  assert.deepEqual(tokenize("The user's cats are running"), ['user', 'cat', 'runn']);
});

test('keyword search ranks by BM25 relevance', () => {
  const ids = keywordSearch('vacuum cleaner', units);
  assert.equal(ids[0], 'b');
  assert.equal(ids.length, 1);
});

test('graph search follows entities one hop', () => {
  const ids = graphSearch('How is Dana doing?', units);
  // Direct mentions of Dana first, then memories about Luna (linked to Dana through d).
  assert.deepEqual(ids.slice(0, 2).sort(), ['d', 'e']);
  assert.ok(ids.includes('a') && ids.includes('b'));
  assert.ok(!ids.includes('c'));
});

test('parses time expressions into ranges', () => {
  const now = new Date(2026, 9, 22, 12);
  const yesterday = parseTimeRange('what did I do yesterday?', now)!;
  assert.equal(yesterday.start.getDate(), 21);
  const march = parseTimeRange('what happened in March', now)!;
  assert.equal(march.start.getMonth(), 2);
  assert.equal(march.start.getFullYear(), 2026);
  const december = parseTimeRange('in December', now)!;
  assert.equal(december.start.getFullYear(), 2025);
  assert.ok(parseTimeRange('2 weeks ago', now));
  assert.equal(parseTimeRange('tell me about cats', now), undefined);
  // Wednesday Oct 28 → last week is Mon Oct 19 – Sun Oct 25.
  const lastWeek = parseTimeRange('last week', new Date(2026, 9, 28))!;
  assert.deepEqual(temporalSearch(lastWeek, units), ['e']);
});

test('reciprocal rank fusion rewards agreement between strategies', () => {
  const fused = reciprocalRankFusion([
    { name: 'keyword', ids: ['x', 'y'] },
    { name: 'graph', ids: ['y', 'z'] },
  ]);
  assert.equal(fused[0].id, 'y');
  assert.deepEqual(fused[0].strategies, ['keyword', 'graph']);
});

test('helpers: similarity, budget and entity guesses', () => {
  assert.ok(similarity('The user has a cat named Luna.', 'The user has a cat called Luna') >= 0.5);
  assert.ok(similarity('The user has a cat named Luna.', 'Dana runs marathons') < 0.1);
  assert.equal(fitBudget([{ text: 'x'.repeat(400) }, { text: 'y'.repeat(400) }], 150, 10).length, 1);
  assert.deepEqual(guessEntities('My sister Noa moved to Tel Aviv'), ['Noa', 'Tel Aviv']);
});
