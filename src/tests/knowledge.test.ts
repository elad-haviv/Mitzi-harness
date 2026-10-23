import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { chunk, KnowledgeIndex, scanFolder } from '../server/knowledge.js';
import { runJavaScript, splitItems } from '../server/workflows.js';
import type { Project } from '../shared/types.js';
import { tempDir } from './helpers.js';

const project = (files: { name: string; content: string }[], knowledgeFolders?: string[]): Project => ({
  id: `p${Math.random()}`,
  name: 'P',
  description: '',
  instructions: '',
  files: files.map((f, i) => ({ id: String(i), name: f.name, content: f.content, size: f.content.length, addedAt: '' })),
  knowledgeFolders,
  permissionMode: 'default',
  createdAt: '',
  updatedAt: String(Math.random()),
});

test('documents are chunked at headings, each chunk labeled with its section', () => {
  const doc = `# Intro\n\nHello there.\n\n# Pricing\n\n${'Plans cost money. '.repeat(30)}\n\n${'More details here. '.repeat(100)}`;
  const chunks = chunk('guide.md', doc);
  assert.equal(chunks[0].where, 'Intro');
  assert.ok(chunks.slice(1).every((c) => c.where === 'Pricing'));
  assert.ok(chunks.every((c) => c.text.length <= 1_400 * 2));
  // PDF pages extracted in the browser label their chunks too.
  assert.equal(chunk('a.pdf', '--- Page 3 ---\nSome text')[0].where, 'Page 3');
});

test('search finds the passages that answer a question, and keeps to the budget', () => {
  const filler = (topic: string) => Array.from({ length: 40 }, (_, i) => `## ${topic} note ${i}\n\nRoutine details about ${topic} number ${i}, nothing special.`).join('\n\n');
  const p = project([
    { name: 'ops.md', content: `${filler('shipping')}\n\n## Refunds\n\nCustomers get a full refund within 30 days if the parcel arrives damaged.` },
    { name: 'hr.md', content: filler('vacation') },
  ]);
  const index = new KnowledgeIndex();
  const hits = index.search(p, 'How do refunds work for a damaged parcel?', 3_000);
  assert.equal(hits[0].name, 'ops.md');
  assert.equal(hits[0].where, 'Refunds');
  assert.ok(hits.reduce((n, h) => n + h.text.length, 0) <= 3_000 + 1_400);
  // Restricted to one document.
  assert.ok(index.search(p, 'vacation', 2_000, 'hr.md').every((h) => h.name === 'hr.md'));
  // Hebrew works too.
  const he = project([{ name: 'he.md', content: `${filler('x')}\n\n## החזרים\n\nהחזר כספי מלא תוך 30 יום` }]);
  assert.equal(index.search(he, 'מה עם החזר כספי?')[0].where, 'החזרים');
});

test('linked folders: text files count, dependencies and binaries don’t', () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'notes.md'), '# Notes\n\nThe launch is on Tuesday.');
  mkdirSync(join(dir, 'docs'));
  writeFileSync(join(dir, 'docs', 'faq.txt'), 'Q: When? A: Soon.');
  mkdirSync(join(dir, 'node_modules'));
  writeFileSync(join(dir, 'node_modules', 'x.md'), 'ignore me');
  writeFileSync(join(dir, 'photo.png'), Buffer.from([0, 1, 2]));
  assert.deepEqual(scanFolder(dir).map((d) => d.name).sort(), ['docs/faq.txt', 'notes.md']);
  const index = new KnowledgeIndex();
  const p = project([], [dir]);
  assert.equal(index.size(p).docs, 2);
  assert.match(index.search(p, 'when is the launch')[0].text, /Tuesday/);
});

test('workflow helpers: splitting items for a loop, and JavaScript code steps', () => {
  assert.deepEqual(splitItems('- one\n2. two\n\n* three', 'lines'), ['one', 'two', 'three']);
  assert.deepEqual(splitItems('Here you go:\n```json\n["a", {"b": 1}]\n```', 'json'), ['a', '{"b":1}']);
  assert.deepEqual(splitItems('a; b ;c', 'separator', ';'), ['a', 'b', 'c']);
  assert.throws(() => splitItems('not a list', 'json'), /JSON list/);
  assert.equal(runJavaScript('return input.length + steps.first.length;', { input: 'abc', trigger: '', steps: { first: 'xy' } }), '5');
  assert.equal(runJavaScript('console.log("hi", 1)', { input: '', trigger: '', steps: {} }), 'hi 1');
  assert.equal(runJavaScript('return { n: 1 };', { input: '', trigger: '', steps: {} }), '{\n  "n": 1\n}');
  assert.throws(() => runJavaScript('while (true) {}', { input: '', trigger: '', steps: {} }, 200), /timed out/i);
  // No Node APIs inside.
  assert.throws(() => runJavaScript('return require("fs")', { input: '', trigger: '', steps: {} }), /require is not defined/);
});
