import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { expandCommand, listCommands, parseSlash } from '../server/extensions/commands.js';
import { parseFrontmatter } from '../server/extensions/frontmatter.js';
import { expandVars, normalizeRepo } from '../server/extensions/plugins.js';
import { Skills, skillTool } from '../server/extensions/skills.js';
import { makeCtx, tempDir } from './helpers.js';

test('frontmatter: plain, quoted, folded, literal and lists', () => {
  const { data, body } = parseFrontmatter(`---
name: pdf
description: >
  Use this for PDFs:
  forms, merging.

  Second paragraph.
quoted: "Say \\"hi\\""
literal: |-
  line one
  line two
tools: [Read, Grep]
allowed:
  - Bash(git add:*)
  - Read
flag: true
---
# Body
`);
  assert.equal(data.name, 'pdf');
  assert.equal(data.description, 'Use this for PDFs: forms, merging.\nSecond paragraph.');
  assert.equal(data.quoted, 'Say "hi"');
  assert.equal(data.literal, 'line one\nline two');
  assert.deepEqual(data.tools, ['Read', 'Grep']);
  assert.deepEqual(data.allowed, ['Bash(git add:*)', 'Read']);
  assert.equal(data.flag, true);
  assert.equal(body, '# Body\n');
  assert.deepEqual(parseFrontmatter('no frontmatter').data, {});
});

test('skills: discovery, enable state, Skill tool and file loading', async () => {
  const root = tempDir();
  const user = join(root, 'user');
  mkdirSync(join(root, 'plugin', 'skills', 'charts', 'reference'), { recursive: true });
  writeFileSync(join(root, 'plugin', 'skills', 'charts', 'SKILL.md'), '---\nname: charts\ndescription: Make charts\n---\nUse reference/colors.md.');
  writeFileSync(join(root, 'plugin', 'skills', 'charts', 'reference', 'colors.md'), 'Use blue.');
  const disabled = new Set<string>();
  const skills = new Skills(() => [{ dir: user, source: 'user' }, { dir: join(root, 'plugin', 'skills'), source: 'plugin', pluginId: 'viz' }], () => disabled, user);

  const created = skills.save({ name: 'Release Notes', description: 'Write release notes', body: 'Group by feature.' });
  assert.equal(created.id, 'user:release-notes');
  assert.deepEqual(
    skills.list().map((s) => s.id),
    ['viz:charts', 'user:release-notes'],
  );

  const tool = skillTool(skills);
  const loaded = await tool.run({ name: 'charts' }, makeCtx(root));
  assert.match(loaded, /Use reference\/colors\.md/);
  assert.match(loaded, /- reference\/colors\.md/);
  assert.equal(await tool.run({ name: 'charts', file: 'reference/colors.md' }, makeCtx(root)), 'Use blue.');
  await assert.rejects(tool.run({ name: 'charts', file: '../../user/release-notes/SKILL.md' }, makeCtx(root)), /outside/);

  disabled.add('viz:charts');
  await assert.rejects(tool.run({ name: 'charts' }, makeCtx(root)), /No skill named/);
  assert.throws(() => skills.remove('viz:charts'), /Only your own/);

  const imported = skills.import([
    { path: 'my-skill/SKILL.md', content: '---\nname: Tables\ndescription: Format tables\n---\nAlign columns.' },
    { path: 'my-skill/examples/a.md', content: 'example' },
    { path: 'my-skill/../escape.md', content: 'nope' },
  ]);
  assert.deepEqual(imported.files, ['SKILL.md', 'examples/a.md']);
});

test('commands: listing, arguments and shell snippets', async () => {
  const root = tempDir();
  mkdirSync(join(root, 'cmds'));
  writeFileSync(join(root, 'cmds', 'review.md'), '---\ndescription: Review a file\nargument-hint: <file>\n---\nReview $1 carefully. All: $ARGUMENTS. Branch: !`echo main`');
  writeFileSync(join(root, 'cmds', 'plain.md'), 'Just do it.');
  const cmds = listCommands([{ dir: join(root, 'cmds'), source: 'user' }]);
  assert.deepEqual(
    cmds.map((c) => [c.name, c.description, c.argumentHint]),
    [
      ['plain', undefined, undefined],
      ['review', 'Review a file', '<file>'],
    ],
  );
  const review = cmds.find((c) => c.name === 'review')!;
  assert.equal(await expandCommand(review, 'a.ts fast', root), 'Review a.ts carefully. All: a.ts fast. Branch: main');
  // Without a project folder, snippets are not run.
  assert.match(await expandCommand(review, 'x', undefined), /not run/);
  // Arguments can't smuggle in shell snippets.
  assert.match(await expandCommand(review, '!`touch pwned`', root), /All: !`touch pwned`/);
  assert.equal(await expandCommand(cmds[0], 'extra words', root), 'Just do it.\n\nARGUMENTS: extra words');
  assert.deepEqual(parseSlash('/plugin:Review a.ts'), { name: 'review', args: 'a.ts' });
  assert.equal(parseSlash('not a command'), undefined);
});

test('plugins: variable expansion and repo shorthand', () => {
  process.env.MITZI_TEST_VAR = 'value';
  assert.equal(expandVars('${CLAUDE_PLUGIN_ROOT}/bin --x ${MITZI_TEST_VAR} ${MISSING:-dflt}', '/p'), '/p/bin --x value dflt');
  assert.deepEqual(normalizeRepo('anthropics/skills'), { url: 'https://github.com/anthropics/skills.git' });
  assert.deepEqual(normalizeRepo('https://example.com/x.git'), { url: 'https://example.com/x.git' });
  assert.ok(normalizeRepo('./local/plugin').path?.endsWith('local/plugin'));
});
