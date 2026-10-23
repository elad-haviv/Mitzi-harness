import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseRoute, route, routeModels } from '../server/routing.js';

const tier = (content: string, extra: Partial<Parameters<typeof chooseRoute>[0]> = {}) => chooseRoute({ content, working: false, planning: false, ...extra }).tier;

test('quick questions and small talk go to the fast model', () => {
  for (const text of ['hi', 'thanks!', 'What is the capital of France?', 'Translate "good morning" to Spanish', 'שלום, מה שלומך?']) assert.equal(tier(text), 'fast', text);
});

test('code, analysis, long messages and multi-step work go to the strong model', () => {
  for (const text of [
    'Why does this fail?\n```js\nconst x = await f();\n```',
    'Analyze the trade-offs between Postgres and MongoDB for this',
    'Write me a Python script that renames my photos by date',
    'Debug my function please',
    'נתח את הדוח הזה ותגיד לי מה חשוב',
    'x'.repeat(800),
    'What is A? What is B? And what is C?',
  ])
    assert.equal(tier(text), 'strong', text.slice(0, 40));
  assert.equal(tier('hi', { working: true }), 'strong');
  assert.equal(tier('hi', { planning: true }), 'strong');
  assert.equal(tier('continue', { previous: 'strong' }), 'strong');
  assert.equal(tier('continue', { previous: 'fast' }), 'fast');
});

test('long attachments go to the strong model; short ones follow the message', () => {
  const doc = (n: number) => `Summarize this\n\n<attachment name="a.txt">\n${'word '.repeat(n)}\n</attachment>`;
  assert.equal(tier(doc(50)), 'fast');
  assert.equal(tier(doc(2000)), 'strong');
});

test('images go to a model that can see them', () => {
  const content = [
    { type: 'text' as const, text: 'What is this?' },
    { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,AA' } },
  ];
  const models = { fast: 'a/fast', strong: 'b/strong' };
  const info = (id: string, vision: boolean) => ({ id, name: id, tools: true, vision });
  assert.equal(route({ content, working: false, planning: false }, models, [info('a/fast', true), info('b/strong', true)]).model, 'a/fast');
  const r = route({ content, working: false, planning: false }, models, [info('a/fast', false), info('b/strong', true)]);
  assert.deepEqual([r.model, r.reason], ['b/strong', 'Has images']);
});

test('Auto falls back to the fast-tasks and default models', () => {
  assert.deepEqual(routeModels(undefined, { model: 'm/big', smallModel: 'm/small' }), { fast: 'm/small', strong: 'm/big' });
  assert.deepEqual(routeModels(undefined, { model: 'm/big' }), { fast: 'm/big', strong: 'm/big' });
  assert.deepEqual(routeModels({ fast: 'x/f', strong: '', newChats: false }, { model: 'm/big' }), { fast: 'x/f', strong: 'm/big' });
});
