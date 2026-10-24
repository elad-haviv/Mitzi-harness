// End-to-end tests for how Mitzi checks its work and learns from what happened: a real server against a mock model.
import assert from 'node:assert/strict';
import { createServer, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { tempDir, textChunks, toolCallChunks } from './helpers.js';

process.env.MITZI_HOME = tempDir();
process.env.OPENROUTER_API_KEY = 'test-key';
process.env.CLAUDE_CONFIG_DIR = tempDir();
process.env.MITZI_EDIT_LEARN_DELAY_MS = '20';

const TOKEN = 'b'.repeat(48);
let base = '';
let mock: Server;
let close: () => Promise<void>;
/** Decides the mock model's reply to each main request. */
let reply: (body: any) => object[] = () => textChunks('Hello!');
/** Replies to background jobs (titles, memory, learning), recognized by `background`. */
let jobReply: (body: any) => object[] | undefined = () => undefined;
const requests: any[] = [];
const imageRequests: any[] = [];
/** A 1×1 PNG. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const isMemoryJob = (body: any) => /Extract memories worth keeping|You maintain \\?"observations|reflective memory of/.test(JSON.stringify(body.messages?.[0] ?? ''));

before(async () => {
  mock = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      if (req.url?.split('?')[0].endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: req.url.includes('output_modalities') ? [] : [{ id: 'test/model', name: 'Test: Model', context_length: 100000, supported_parameters: ['tools'] }] }));
        return;
      }
      const body = JSON.parse(raw);
      requests.push(body);
      // Image generation and editing (OpenRouter's image output) answer with JSON, not a stream.
      if (body.modalities?.includes('image')) {
        imageRequests.push(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '', images: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } }] } }] }));
        return;
      }
      let chunks: object[];
      try {
        chunks =
        body.max_tokens === 60
          ? textChunks('Generated Title')
          : isMemoryJob(body)
            ? textChunks(JSON.stringify(body).includes('Extract memories') ? '{"facts": []}' : '{"update": [], "create": []}')
            : (jobReply(body) ?? reply(body));
      } catch (err) {
        // A failed assertion inside a reply shows up as a model error instead of hanging the test.
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `mock: ${(err as Error).message}` } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
  process.env.MITZI_MODEL = 'test/model';
  const { startServer } = await import('../server/index.js');
  const server = await startServer({ port: 0, token: TOKEN, dataDir: join(tempDir(), 'data'), webDir: tempDir() });
  base = `http://127.0.0.1:${server.port}`;
  close = server.close;
});

after(async () => {
  await close?.();
  mock?.close();
});

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, { method, headers: { 'x-mitzi-token': TOKEN, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: (await res.json()) as any };
}

/** Sends a message, approving every permission prompt, and collects the streamed events. */
async function stream(chatId: string, body: unknown): Promise<any[]> {
  const res = await fetch(`${base}/api/chats/${chatId}/messages`, { method: 'POST', headers: { 'x-mitzi-token': TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(res.status, 200);
  const events: any[] = [];
  let buf = '';
  for await (const chunk of res.body!.pipeThrough(new TextDecoderStream()) as unknown as AsyncIterable<string>) {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (!frame.startsWith('data: ')) continue;
      const e = JSON.parse(frame.slice(6));
      events.push(e);
      if (e.type === 'permission') void call('POST', `/api/chats/${chatId}/permission`, { requestId: e.requestId, answer: 'always' });
    }
  }
  return events;
}

/** A coding project whose checks pass only when ok.txt says "fixed". */
async function codingProject(name: string) {
  const folder = tempDir();
  writeFileSync(join(folder, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node check.js' } }));
  writeFileSync(join(folder, 'check.js'), "const fs = require('fs'); const ok = fs.existsSync('ok.txt') && fs.readFileSync('ok.txt', 'utf8').trim() === 'fixed'; if (!ok) { console.error('expected fixed'); process.exit(1); } console.log('all good');");
  const project = (await call('POST', '/api/projects', { name })).data;
  await call('PATCH', `/api/projects/${project.id}`, { folder });
  return { folder, project: (await call('GET', `/api/projects/${project.id}`)).data };
}

test('work mode checks the project after changes and keeps working until the checks pass', async () => {
  const { folder, project } = await codingProject('Verify');
  assert.equal(project.verifyDetected, 'npm test');
  const chat = (await call('POST', '/api/chats', { projectId: project.id })).data;
  await call('PATCH', `/api/chats/${chat.id}`, { mode: 'work' });
  let turn = 0;
  reply = (body) => {
    turn++;
    if (turn === 1) return toolCallChunks('w1', 'Write', { file_path: 'ok.txt', content: 'broken' });
    if (turn === 2) return textChunks('Done.');
    if (turn === 3) {
      assert.match(JSON.stringify(body.messages.at(-1)), /checks \(`npm test`\)[\s\S]*expected fixed/);
      return toolCallChunks('w2', 'Write', { file_path: 'ok.txt', content: 'fixed' });
    }
    return textChunks('Fixed it.');
  };
  const events = await stream(chat.id, { content: 'Make the tests pass' });
  const checks = events.filter((e) => e.type === 'verify').map((e) => e.result.passed);
  assert.deepEqual(checks, [false, true]);
  assert.equal(readFileSync(join(folder, 'ok.txt'), 'utf8'), 'fixed');
  const saved = (await call('GET', `/api/chats/${chat.id}`)).data;
  assert.deepEqual(saved.messages.map((m: any) => m.auto ?? m.role), ['user', 'assistant', 'tool', 'assistant', 'verify', 'assistant', 'tool', 'assistant']);
  assert.deepEqual(saved.messages.at(-1).verify.map((v: any) => v.passed), [false, true]);

  // Turned off, or nothing changed: no checks.
  reply = () => textChunks('Just talking.');
  assert.ok(!(await stream(chat.id, { content: 'Thanks' })).some((e) => e.type === 'verify'));
  await call('PATCH', `/api/projects/${project.id}`, { verify: { enabled: false } });
  turn = 0;
  reply = () => (turn++ === 0 ? toolCallChunks('w3', 'Write', { file_path: 'ok.txt', content: 'broken again' }) : textChunks('Changed.'));
  assert.ok(!(await stream(chat.id, { content: 'Break it' })).some((e) => e.type === 'verify'));
});

test('outcomes are recorded for tasks, amended by reviews, and distilled into lessons', async () => {
  const { project } = await codingProject('Outcomes');
  await call('PATCH', `/api/projects/${project.id}`, { verify: { enabled: false } });
  const chat = (await call('POST', '/api/chats', { projectId: project.id })).data;
  let turn = 0;
  reply = () => {
    turn++;
    if (turn === 1) return toolCallChunks('e1', 'Edit', { file_path: 'missing.ts', old_string: 'a', new_string: 'b' });
    if (turn === 2) return toolCallChunks('b1', 'Bash', { command: 'nonexistent-tool-xyz --version' });
    return textChunks('I could not do it.');
  };
  await stream(chat.id, { content: 'Rename a to b in missing.ts' });
  let saved = (await call('GET', `/api/chats/${chat.id}`)).data;
  const outcomeId = saved.messages.at(-1).outcomeId;
  assert.ok(outcomeId);
  let [o] = (await call('GET', `/api/outcomes?chatId=${chat.id}`)).data;
  assert.equal(o.id, outcomeId);
  assert.equal(o.task, 'Rename a to b in missing.ts');
  assert.deepEqual(o.errors.map((e: any) => e.kind), ['agent', 'environment']);
  assert.equal(o.redone, false);

  // A redo request marks the outcome; the redo is the second attempt.
  const review = (await call('POST', `/api/chats/${chat.id}/messages/${saved.messages.length - 1}/review`, { rating: 1, directions: 'Create the file first', redo: true })).data;
  [o] = (await call('GET', `/api/outcomes?chatId=${chat.id}`)).data;
  assert.deepEqual([o.redone, o.rating], [true, 1]);
  turn = 10;
  reply = () => (turn++ === 10 ? toolCallChunks('w1', 'Write', { file_path: 'missing.ts', content: 'b' }) : textChunks('Created it.'));
  await stream(chat.id, { content: review.redo, auto: 'redo', feedbackLoopId: review.loop.id });
  const list = (await call('GET', `/api/outcomes?chatId=${chat.id}`)).data;
  assert.equal(list[0].attempts, 2);
  assert.equal(list[0].task, 'Rename a to b in missing.ts');

  // Distilling: environment problems are set apart, and lessons join the bot's.
  jobReply = (body) => {
    const prompt = JSON.stringify(body.messages);
    if (!/distill what it should do/.test(prompt)) return undefined;
    assert.match(prompt, /Edit failed: [^\n]*missing\.ts/);
    assert.match(prompt, /<environment-problems>[\s\S]*nonexistent-tool-xyz[\s\S]*command not found/);
    return textChunks('{"lessons": ["Check that a file exists with Glob before editing it."]}');
  };
  const learned = (await call('POST', '/api/bots/mitzi/learn')).data;
  assert.deepEqual(learned.lessons, ['Check that a file exists with Glob before editing it.']);
  assert.equal(learned.pending, 0);
  const lessons = (await call('GET', '/api/bots/mitzi/lessons')).data;
  assert.equal(lessons.at(-1).source, 'outcome');
  jobReply = () => undefined;
  saved = (await call('GET', `/api/chats/${chat.id}`)).data;
  // Lessons reach the prompt, and the next outcome records which ones were there.
  reply = () => (turn++ === 12 ? toolCallChunks('r1', 'Read', { file_path: 'missing.ts' }) : textChunks('It says b.'));
  await stream(chat.id, { content: 'What does it say?' });
  const latest = (await call('GET', `/api/outcomes?chatId=${chat.id}`)).data[0];
  assert.ok(latest.lessonIds.includes(lessons.at(-1).id));
});

/** Polls until `check` returns something truthy. */
async function eventually<T>(check: () => Promise<T | undefined | false>, what: string): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const v = await check();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

test('the user silently rewriting the bot\'s work becomes a style lesson', async () => {
  const bot = (await call('POST', '/api/bots', { name: 'Editor', emoji: '✏️', systemPrompt: 'Write.' })).data;
  const chat = (await call('POST', '/api/chats', { botId: bot.id })).data;
  let turn = 0;
  reply = () => (turn++ === 0 ? toolCallChunks('a1', 'Artifact', { command: 'create', type: 'markdown', title: 'Memo', content: 'The report was written by the team.\nIt was reviewed by me.' }) : textChunks('Here it is.'));
  const events = await stream(chat.id, { content: 'Write a memo' });
  const artifact = events.find((e) => e.type === 'artifact').artifact;
  jobReply = (body) => {
    const prompt = JSON.stringify(body.messages);
    if (!/edited it themselves/.test(prompt)) return undefined;
    assert.match(prompt, /- The report was written by the team\.[\s\S]*\+ The team wrote the report\./);
    return textChunks('Write in the active voice.');
  };
  // Whitespace alone teaches nothing; a real rewrite does.
  await call('PATCH', `/api/artifacts/${artifact.id}`, { content: 'The team wrote the report.\nI reviewed it.' });
  const lessons = await eventually(async () => {
    const list = (await call('GET', `/api/bots/${bot.id}/lessons`)).data;
    return list.length ? list : undefined;
  }, 'an edit lesson');
  assert.deepEqual(lessons.map((l: any) => [l.text, l.source]), [['Write in the active voice.', 'edit']]);

  // Files the bot wrote in a project folder count too: the change is noticed on the next turn.
  const { folder, project } = await codingProject('Edits');
  await call('PATCH', `/api/projects/${project.id}`, { verify: { enabled: false } });
  const code = (await call('POST', '/api/chats', { projectId: project.id, botId: bot.id })).data;
  turn = 0;
  reply = () => (turn++ === 0 ? toolCallChunks('w1', 'Write', { file_path: 'util.js', content: 'function f(x) {\n  if (x) {\n    return 1;\n  } else {\n    return 2;\n  }\n}\n' }) : textChunks('Wrote it.'));
  await stream(code.id, { content: 'Write f' });
  writeFileSync(join(folder, 'util.js'), 'function f(x) {\n  if (x) return 1;\n  return 2;\n}\n');
  jobReply = (body) => (/edited it themselves/.test(JSON.stringify(body.messages)) ? textChunks('Use early returns instead of else branches.') : undefined);
  reply = () => textChunks('Okay.');
  await stream(code.id, { content: 'Thanks' });
  await eventually(async () => (await call('GET', `/api/bots/${bot.id}/lessons`)).data.find((l: any) => /early returns/.test(l.text)), 'a code edit lesson');
  const [o] = (await call('GET', `/api/outcomes?chatId=${code.id}`)).data;
  assert.equal(o.editsAfter, 1);
  jobReply = () => undefined;
});

test('project knowledge: learned from what works and from corrections, kept in every prompt, offered for MITZI.md', async () => {
  const { folder, project } = await codingProject('Knowledge');
  const chat = (await call('POST', '/api/chats', { projectId: project.id })).data;
  await call('PATCH', `/api/chats/${chat.id}`, { mode: 'work' });
  // Two tasks: the same command works both times, and the second passes the checks.
  let turn = 0;
  reply = () => (turn++ % 2 === 0 ? toolCallChunks(`b${turn}`, 'Bash', { command: 'node -e "1"' }) : textChunks('Ran it.'));
  await stream(chat.id, { content: 'Run node' });
  turn = 0;
  reply = () => [toolCallChunks('w', 'Write', { file_path: 'ok.txt', content: 'fixed' }), toolCallChunks('b', 'Bash', { command: 'node -e "1"' }), textChunks('Done.')][turn++] ?? textChunks('Done.');
  await stream(chat.id, { content: 'Fix it' });
  let facts = (await call('GET', `/api/projects/${project.id}/learned`)).data;
  assert.deepEqual(facts.map((f: any) => f.text).sort(), ['Verify changes with `npm test`.', '`node -e "1"` works here.']);

  // A correction becomes a fact from the user; the bot can note facts itself.
  jobReply = (body) => (/corrects how things are done/.test(JSON.stringify(body.messages)) ? textChunks('{"facts": [{"text": "Use pnpm, not npm.", "kind": "command"}]}') : undefined);
  turn = 0;
  reply = (body) => {
    if (turn++ === 0) return toolCallChunks('n1', 'ProjectNote', { text: 'Sources live in src/, tests in test/.', kind: 'layout' });
    assert.match(JSON.stringify(body.messages[0]), /# What you know about this repository[\s\S]*Verify changes with `npm test`/);
    return textChunks('Noted.');
  };
  await stream(chat.id, { content: 'No, we use pnpm here' });
  facts = await eventually(async () => {
    const list = (await call('GET', `/api/projects/${project.id}/learned`)).data;
    return list.some((f: any) => f.source === 'correction') ? list : undefined;
  }, 'a correction fact');
  const correction = facts.find((f: any) => f.source === 'correction');
  assert.deepEqual([correction.text, correction.priority], ['Use pnpm, not npm.', 3]);
  assert.ok(facts.some((f: any) => f.source === 'agent' && f.kind === 'layout'));
  jobReply = () => undefined;
  reply = (body) => {
    assert.match(JSON.stringify(body.messages[0]), /\(from the user\) Use pnpm, not npm\./);
    return textChunks('Sure.');
  };
  await stream(chat.id, { content: 'Thanks' });

  // The facts as an addition to MITZI.md, written only when accepted.
  writeFileSync(join(folder, 'MITZI.md'), '# Notes\n- Use pnpm, not npm.\n');
  const proposal = (await call('GET', `/api/projects/${project.id}/learned/instructions`)).data;
  assert.ok(!proposal.added.some((f: any) => /pnpm/.test(f.text)));
  assert.ok(proposal.added.some((f: any) => /npm test/.test(f.text)));
  assert.equal(readFileSync(join(folder, 'MITZI.md'), 'utf8'), '# Notes\n- Use pnpm, not npm.\n');
  const applied = (await call('POST', `/api/projects/${project.id}/learned/instructions`)).data;
  assert.equal(applied.added, proposal.added.length);
  assert.match(readFileSync(join(folder, 'MITZI.md'), 'utf8'), /## Learned by Mitzi[\s\S]*Verify changes with `npm test`/);

  // Consolidation merges facts.
  jobReply = (body) => (/Merge duplicates/.test(JSON.stringify(body.messages)) ? textChunks('{"facts": [{"text": "Use pnpm, not npm; verify with `pnpm test`.", "kind": "command", "from": [1, 2, 3]}]}') : undefined);
  facts = (await call('POST', `/api/projects/${project.id}/learned/consolidate`)).data;
  assert.equal(facts[0].text, 'Use pnpm, not npm; verify with `pnpm test`.');
  assert.equal(facts[0].source, 'consolidated');
  jobReply = () => undefined;
});

test('teammates debrief: their outcomes join the ledger, and what they learn serves the whole team', async () => {
  const mate = (await call('POST', '/api/bots', { name: 'Fixer', emoji: '🔧', description: 'Fixes files', systemPrompt: 'You fix files.' })).data;
  let mateTurn = 0;
  let leadTurn = 0;
  reply = (body) => {
    const system = JSON.stringify(body.messages[0]);
    if (/You fix files/.test(system)) return mateTurn++ === 0 ? toolCallChunks('m1', 'WebFetch', {}) : textChunks('Could not fetch.');
    return leadTurn++ === 0 ? toolCallChunks('d1', 'Delegate', { assignments: [{ bot: 'fixer', task: 'Fetch the page' }] }) : textChunks('My teammate tried.');
  };
  const chat = (await call('POST', '/api/chats', {})).data;
  await stream(chat.id, { content: 'Get the page' });
  const outcomes = (await call('GET', `/api/outcomes?chatId=${chat.id}`)).data;
  const debrief = outcomes.find((o: any) => o.source === 'teammate');
  assert.deepEqual([debrief.botId, debrief.leadBotId, debrief.task, debrief.toolErrors], [mate.id, 'mitzi', 'Fetch the page', 1]);
  assert.ok(outcomes.some((o: any) => o.source === 'run' && o.botId === 'mitzi'));

  jobReply = (body) => (/distill what it should do/.test(JSON.stringify(body.messages)) ? textChunks('{"lessons": ["Pass a url when fetching a page."]}') : undefined);
  assert.deepEqual((await call('POST', `/api/bots/${mate.id}/learn`)).data.lessons, ['Pass a url when fetching a page.']);
  jobReply = () => undefined;
  const [lesson] = (await call('GET', `/api/bots/${mate.id}/lessons`)).data;
  assert.equal(lesson.source, 'teammate');
  reply = (body) => {
    assert.match(JSON.stringify(body.messages[0]), /# Team lessons[\s\S]*\(Fixer\) Pass a url when fetching a page\./);
    return textChunks('Noted.');
  };
  await stream(chat.id, { content: 'Thanks' });
  await call('DELETE', `/api/bots/${mate.id}`);
});

test('self-review: a bot that reviews its own changes goes back to fix what the review found', async () => {
  const { project } = await codingProject('Review');
  await call('PATCH', `/api/projects/${project.id}`, { verify: { enabled: false } });
  const bot = (await call('POST', '/api/bots', { name: 'Careful', emoji: '🧐', systemPrompt: 'Be careful.', selfReview: true })).data;
  assert.equal(bot.selfReview, true);
  const chat = (await call('POST', '/api/chats', { projectId: project.id, botId: bot.id })).data;
  await call('PATCH', `/api/chats/${chat.id}`, { mode: 'work' });
  let turn = 0;
  let reviews = 0;
  jobReply = (body) => {
    const prompt = JSON.stringify(body.messages);
    if (!/review an AI coding assistant's changes/.test(prompt)) return undefined;
    reviews++;
    assert.match(prompt, /### Wrote add\.js/);
    return textChunks(reviews === 1 ? '{"ok": false, "issues": ["add.js subtracts instead of adding"]}' : '{"ok": true, "issues": []}');
  };
  reply = (body) => {
    turn++;
    if (turn === 1) return toolCallChunks('w1', 'Write', { file_path: 'add.js', content: 'const add = (a, b) => a - b;' });
    if (turn === 2) return textChunks('Done.');
    if (turn === 3) {
      assert.match(JSON.stringify(body.messages.at(-1)), /add\.js subtracts instead of adding/);
      return toolCallChunks('w2', 'Write', { file_path: 'add.js', content: 'const add = (a, b) => a + b;' });
    }
    return textChunks('Fixed the sign.');
  };
  await stream(chat.id, { content: 'Write add' });
  jobReply = () => undefined;
  const saved = (await call('GET', `/api/chats/${chat.id}`)).data;
  assert.deepEqual(saved.messages.map((m: any) => m.auto ?? m.role), ['user', 'assistant', 'tool', 'assistant', 'critique', 'assistant', 'tool', 'assistant']);
  // One review round only: the fix isn't reviewed again.
  assert.equal(reviews, 1);
});

test('playbooks: a clean task becomes a playbook that similar tasks get; a redo takes it back', async () => {
  const { project } = await codingProject('Playbooks');
  const chat = (await call('POST', '/api/chats', { projectId: project.id })).data;
  await call('PATCH', `/api/chats/${chat.id}`, { mode: 'work' });
  jobReply = (body) => {
    const prompt = JSON.stringify(body.messages);
    if (!/reusable playbook/.test(prompt)) return undefined;
    assert.match(prompt, /Read check\.js[\s\S]*Write ok\.txt[\s\S]*verified with `npm test`/);
    return textChunks('{"title": "Make the checks pass", "when": "When the project checks fail and need fixing", "steps": ["Read check.js", "Write ok.txt"], "verification": "npm test"}');
  };
  let turn = 0;
  reply = () => [toolCallChunks('r', 'Read', { file_path: 'check.js' }), toolCallChunks('l', 'LS', {}), toolCallChunks('w', 'Write', { file_path: 'ok.txt', content: 'fixed' })][turn++] ?? textChunks('Done.');
  await stream(chat.id, { content: 'Make the project checks pass' });
  const list = await eventually(async () => {
    const l = (await call('GET', `/api/projects/${project.id}/playbooks`)).data;
    return l.length ? l : undefined;
  }, 'a playbook');
  assert.equal(list[0].title, 'Make the checks pass');
  jobReply = () => undefined;

  // A similar task gets it; tool calls only with the hints setting on.
  reply = (body) => {
    const system = JSON.stringify(body.messages[0]);
    assert.match(system, /# Playbooks from earlier work here[\s\S]*## Make the checks pass[\s\S]*1\. Read check\.js/);
    assert.doesNotMatch(system, /Tool calls that worked last time/);
    return textChunks('They pass already.');
  };
  await stream(chat.id, { content: 'The checks fail again, please fix them' });
  await call('PUT', '/api/settings', { toolTraceHints: true });
  reply = (body) => {
    assert.match(JSON.stringify(body.messages[0]), /Tool calls that worked last time:[\s\S]*- Write ok\.txt/);
    return textChunks('Still passing.');
  };
  await stream(chat.id, { content: 'Fix the failing checks' });
  await call('PUT', '/api/settings', { toolTraceHints: false });
  assert.equal((await call('GET', `/api/projects/${project.id}/playbooks`)).data[0].uses, 2);

  // The task it came from was redone after all: not a good way to do it.
  const saved = (await call('GET', `/api/chats/${chat.id}`)).data;
  const first = saved.messages.findIndex((m: any) => m.outcomeId === list[0].outcomeId);
  await call('POST', `/api/chats/${chat.id}/messages/${first}/review`, { rating: 2, redo: true });
  assert.deepEqual((await call('GET', `/api/projects/${project.id}/playbooks`)).data, []);
});

test('plan critique: a proposed plan is checked against the lessons before approval', async () => {
  const chat = (await call('POST', '/api/chats', {})).data;
  jobReply = (body) => {
    const prompt = JSON.stringify(body.messages);
    if (!/Check it ONLY against the lessons/.test(prompt)) return undefined;
    assert.match(prompt, /Check that a file exists with Glob before editing it/);
    return textChunks('{"ok": false, "issues": ["Step 1 edits config.ts without checking it exists (lesson 1)."]}');
  };
  let turn = 0;
  reply = () => (turn++ === 0 ? toolCallChunks('p1', 'SubmitPlan', { plan: '1. Edit config.ts\n2. Done', steps: ['Edit config.ts', 'Done'] }) : textChunks('Plan ready.'));
  const events = await stream(chat.id, { content: '/plan change the config' });
  jobReply = () => undefined;
  assert.deepEqual(events.filter((e) => e.type === 'plan').at(-1).plan.notes, ['Step 1 edits config.ts without checking it exists (lesson 1).']);
  assert.deepEqual((await call('GET', `/api/chats/${chat.id}`)).data.plan.notes, ['Step 1 edits config.ts without checking it exists (lesson 1).']);
});

test('evals: a past task is replayed with another model in a throwaway worktree, checked and scored', { timeout: 60_000 }, async () => {
  const { folder, project } = await codingProject('Evals');
  const sh = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: folder, stdio: 'pipe' });
  sh('init', '-q');
  sh('add', '.');
  sh('commit', '-qm', 'start');
  const chat = (await call('POST', '/api/chats', { projectId: project.id })).data;
  await call('PATCH', `/api/chats/${chat.id}`, { mode: 'work' });
  let turn = 0;
  reply = () => (turn++ === 0 ? toolCallChunks('w', 'Write', { file_path: 'ok.txt', content: 'fixed' }) : textChunks('Fixed: ok.txt now says fixed.'));
  await stream(chat.id, { content: 'Make the checks pass by fixing ok.txt' });
  const [candidate] = (await call('GET', `/api/evals/candidates?projectId=${project.id}`)).data;
  assert.equal(candidate.task, 'Make the checks pass by fixing ok.txt');
  assert.ok(candidate.gitHead);

  // The replay: the model writes into the worktree, never the project's folder.
  turn = 0;
  reply = (body) => {
    const system = JSON.stringify(body.messages[0]);
    assert.match(system, /mitzi-eval-/);
    return turn++ === 0 ? toolCallChunks('e', 'Write', { file_path: 'eval.txt', content: 'replayed' }) : turn === 2 ? toolCallChunks('f', 'Write', { file_path: 'ok.txt', content: 'fixed' }) : textChunks('Done in the copy.');
  };
  jobReply = (body) => {
    const prompt = JSON.stringify(body.messages);
    if (!/Score how well an AI coding assistant/.test(prompt)) return undefined;
    assert.match(prompt, /Fixed: ok\.txt now says fixed\.[\s\S]*Done in the copy\.[\s\S]*eval\.txt[\s\S]*checks \(`npm test`\) passed/);
    return textChunks('{"score": 4, "notes": "Fixed it, plus a stray file."}');
  };
  const started = (await call('POST', '/api/evals', { projectId: project.id, outcomeIds: [candidate.id], models: ['test/model'] })).data;
  const run = await eventually(async () => {
    const r = (await call('GET', `/api/evals/${started.id}`)).data;
    return r.status === 'running' ? undefined : r;
  }, 'the eval to finish');
  jobReply = () => undefined;
  assert.equal(run.status, 'done');
  const [item] = run.items;
  assert.deepEqual([item.status, item.testsPassed, item.score, item.toolCalls, item.checkCommand], ['done', true, 4, 2, 'npm test']);
  assert.deepEqual(run.summary.map((m: any) => [m.model, m.done, m.passRate, m.avgScore]), [['test/model', 1, 1, 4]]);
  assert.equal(existsSync(join(folder, 'eval.txt')), false);
  assert.doesNotMatch(execFileSync('git', ['worktree', 'list'], { cwd: folder }).toString(), /mitzi-eval-/);
  assert.equal((await call('GET', '/api/evals')).data[0].id, run.id);
});

test('workspace: "create" while an artifact of that type is open fills it in, and comment fixes stay in it', async () => {
  const page = (await call('POST', '/api/artifacts', { type: 'html', title: 'Untitled web page' })).data;
  let turn = 0;
  reply = (body) => {
    if (turn++ === 0) {
      assert.match(JSON.stringify(body.messages[0]), /rewrite\\" with id /);
      return toolCallChunks('c1', 'Artifact', { command: 'create', type: 'html', title: 'Bakery', content: '<h1>Bakery</h1>' });
    }
    return textChunks('Made it.');
  };
  await stream(page.chatId, { content: 'Create a web page for a bakery', focus: page.id });
  let list = (await call('GET', '/api/artifacts')).data.filter((a: any) => a.chatId === page.chatId);
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'Bakery');
  assert.equal(list[0].versions.at(-1).content, '<h1>Bakery</h1>');

  // Another type, or an explicit request for a separate one, still makes a new artifact.
  turn = 0;
  reply = () => (turn++ === 0 ? toolCallChunks('c2', 'Artifact', { command: 'create', type: 'html', title: 'Bakery v2', content: '<h1>Two</h1>', separate: true }) : textChunks('Here is a second one.'));
  await stream(page.chatId, { content: 'Make me a separate second version', focus: page.id });
  list = (await call('GET', '/api/artifacts')).data.filter((a: any) => a.chatId === page.chatId);
  assert.equal(list.length, 2);
});

test('images: the open image is edited in place, guided by the user\'s markup', async () => {
  await call('PUT', '/api/settings', { media: { imageModel: 'test/image' } });
  const chat = (await call('POST', '/api/chats', {})).data;
  let turn = 0;
  reply = () => (turn++ === 0 ? toolCallChunks('g1', 'GenerateImage', { prompt: 'a street with a red sign' }) : textChunks('Here it is.'));
  const events = await stream(chat.id, { content: 'Draw a street with a sign' });
  const image = events.find((e) => e.type === 'artifact').artifact;
  assert.equal(image.type, 'image');

  // The user marks it up and asks for a change from the image's workspace.
  const marked = (await call('POST', `/api/artifacts/${image.id}/image`, { dataUrl: `data:image/png;base64,${PNG}`, as: 'markup' })).data;
  assert.match(marked.markup.url, /^\/media\/[a-f0-9]{32}\.png$/);
  assert.equal(marked.versions.length, 1);
  turn = 0;
  reply = (body) => {
    if (turn++ === 0) {
      assert.match(JSON.stringify(body.messages[0]), /use EditImage with artifact_id [\s\S]*use_markup true/);
      return toolCallChunks('e1', 'EditImage', { artifact_id: image.id, prompt: 'Make the marked sign blue', use_markup: true });
    }
    return textChunks('The sign is blue now.');
  };
  imageRequests.length = 0;
  await stream(chat.id, { content: 'Make this sign blue\n\n(I marked up the image to show where.)', focus: image.id });
  const edit = imageRequests[0].messages[0].content;
  assert.deepEqual(edit.map((p: any) => p.type), ['image_url', 'image_url', 'text']);
  assert.match(edit[2].text, /Make the marked sign blue[\s\S]*second image is the first one with the user's markings/);
  const after = (await call('GET', '/api/artifacts')).data.filter((a: any) => a.chatId === chat.id);
  assert.equal(after.length, 1);
  assert.deepEqual(after[0].versions.map((v: any) => [v.author, v.note]), [['assistant', 'a street with a red sign'], ['assistant', 'Make the marked sign blue']]);

  // Saving the markup as a version keeps it as the user's.
  const saved = (await call('POST', `/api/artifacts/${image.id}/image`, { dataUrl: `data:image/png;base64,${PNG}`, as: 'version' })).data;
  assert.equal(saved.versions.at(-1).author, 'user');
  assert.equal((await call('POST', `/api/artifacts/${image.id}/image`, { dataUrl: 'data:text/html;base64,PGI+', as: 'version' })).status, 400);
});

test('archiving: chats and projects can be put away and restored; writing in an archived chat brings it back', async () => {
  const project = (await call('POST', '/api/projects', { name: 'Old stuff' })).data;
  assert.ok((await call('PATCH', `/api/projects/${project.id}`, { archived: true })).data.archivedAt);
  assert.equal((await call('PATCH', `/api/projects/${project.id}`, { archived: false })).data.archivedAt, undefined);
  const chat = (await call('POST', '/api/chats', {})).data;
  const archived = (await call('PATCH', `/api/chats/${chat.id}`, { archived: true })).data;
  assert.ok(archived.archivedAt);
  assert.ok((await call('GET', '/api/chats')).data.find((c: any) => c.id === chat.id).archivedAt);
  reply = () => textChunks('Back again.');
  await stream(chat.id, { content: 'Hello again' });
  assert.equal((await call('GET', `/api/chats/${chat.id}`)).data.archivedAt, undefined);
});
