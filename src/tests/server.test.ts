import assert from 'node:assert/strict';
import { createServer, request, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { tempDir, textChunks, toolCallChunks } from './helpers.js';

// Configure before the server modules read the environment.
process.env.MITZI_HOME = tempDir();
process.env.OPENROUTER_API_KEY = 'test-key';

const TOKEN = 'a'.repeat(48);
let base = '';
let mock: Server;
let close: () => Promise<void>;
/** Decides the mock model's reply to each request. */
let reply: (body: any) => object[] = () => textChunks('Hello!');
const requests: any[] = [];
/** The latest chat request, ignoring concurrent title-generation requests. */
const lastMain = (): any => requests.filter((r) => r.max_tokens !== 60).at(-1);

before(async () => {
  mock = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', name: 'Test: Model', context_length: 1000, supported_parameters: ['tools'] }] }));
        return;
      }
      const body = JSON.parse(raw);
      requests.push(body);
      // Title requests are recognizable by their small token budget.
      const chunks = body.max_tokens === 60 ? textChunks('Generated Title') : reply(body);
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

async function call(method: string, path: string, body?: unknown, token = TOKEN) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'x-mitzi-token': token, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as any };
}

/** Sends a message and collects the streamed events; `onEvent` may react (e.g. to permission prompts). */
async function stream(path: string, body: unknown, onEvent?: (e: any) => void): Promise<any[]> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'x-mitzi-token': TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200);
  const events: any[] = [];
  const text = res.body!.pipeThrough(new TextDecoderStream());
  let buf = '';
  for await (const chunk of text as unknown as AsyncIterable<string>) {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (frame.startsWith('data: ')) {
        const e = JSON.parse(frame.slice(6));
        events.push(e);
        onEvent?.(e);
      }
    }
  }
  return events;
}

test('rejects requests without the token or from foreign hosts', async () => {
  assert.equal((await call('GET', '/api/chats', undefined, 'wrong')).status, 401);
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(`${base}/api/chats`, { headers: { 'x-mitzi-token': TOKEN, host: 'evil.example' } }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
});

test('seeds starter bots and reports settings', async () => {
  const bots = await call('GET', '/api/bots');
  assert.ok(bots.data.length >= 3);
  const settings = await call('GET', '/api/settings');
  assert.equal(settings.data.hasApiKey, true);
  assert.equal(settings.data.apiKeySource, 'env');
  assert.equal(settings.data.defaultModel, 'test/model');
});

test('a chat turn streams text, creates an artifact and gets a title', async () => {
  let turn = 0;
  reply = () =>
    turn++ === 0
      ? toolCallChunks('call_art', 'Artifact', { command: 'create', type: 'html', title: 'Hello Page', content: '<h1>Hi</h1>' })
      : textChunks('I made you a page.');
  const chat = (await call('POST', '/api/chats', {})).data;
  const events = await stream(`/api/chats/${chat.id}/messages`, { content: 'Make a page', attachments: [{ name: 'notes.txt', content: 'be bold', kind: 'text' }] });

  const artifactEvent = events.find((e) => e.type === 'artifact');
  assert.equal(artifactEvent.artifact.title, 'Hello Page');
  assert.equal(artifactEvent.artifact.versions[0].callId, 'call_art');
  assert.ok(events.some((e) => e.type === 'text'));
  assert.equal(events.at(-1).type, 'done');

  const saved = (await call('GET', `/api/chats/${chat.id}`)).data;
  assert.deepEqual(
    saved.messages.map((m: any) => m.role),
    ['user', 'assistant', 'tool', 'assistant'],
  );
  assert.match(saved.messages[0].content, /<attachment name="notes.txt">\nbe bold\n<\/attachment>/);
  assert.equal(saved.title, 'Generated Title');
  assert.equal(saved.usage.requests, 2);

  // The system prompt includes the artifact guide; the next request lists the artifact.
  const system = lastMain().messages[0];
  assert.match(JSON.stringify(system), /Artifacts in this chat/);

  const artifacts = (await call('GET', `/api/artifacts?chatId=${chat.id}`)).data;
  assert.equal(artifacts.length, 1);
});

test('regenerate replaces the last answer', async () => {
  reply = () => textChunks('First answer');
  const chat = (await call('POST', '/api/chats', {})).data;
  await stream(`/api/chats/${chat.id}/messages`, { content: 'Question' });
  reply = () => textChunks('Second answer');
  await stream(`/api/chats/${chat.id}/regenerate`, {});
  const saved = (await call('GET', `/api/chats/${chat.id}`)).data;
  assert.equal(saved.messages.length, 2);
  assert.equal(saved.messages[1].content, 'Second answer');
});

test('editing a message truncates history from that point', async () => {
  reply = () => textChunks('Answer');
  const chat = (await call('POST', '/api/chats', {})).data;
  await stream(`/api/chats/${chat.id}/messages`, { content: 'One' });
  await stream(`/api/chats/${chat.id}/messages`, { content: 'Two' });
  await stream(`/api/chats/${chat.id}/messages`, { content: 'Two, edited', editIndex: 2 });
  const saved = (await call('GET', `/api/chats/${chat.id}`)).data;
  assert.deepEqual(
    saved.messages.map((m: any) => m.content),
    ['One', 'Answer', 'Two, edited', 'Answer'],
  );
});

test('coding projects ask for permission over the stream', async () => {
  const folder = tempDir();
  writeFileSync(join(folder, 'a.txt'), 'hello');
  const project = (await call('POST', '/api/projects', { name: 'Code' })).data;
  const patched = await call('PATCH', `/api/projects/${project.id}`, { folder, instructions: 'Be terse.' });
  assert.equal(patched.data.folder, folder);
  const chat = (await call('POST', '/api/chats', { projectId: project.id })).data;

  let turn = 0;
  reply = () => (turn++ === 0 ? toolCallChunks('call_sh', 'Bash', { command: 'echo done > out.txt' }) : textChunks('Ran it.'));
  const events = await stream(`/api/chats/${chat.id}/messages`, { content: 'Run it' }, (e) => {
    if (e.type === 'permission') void call('POST', `/api/chats/${chat.id}/permission`, { requestId: e.requestId, answer: 'always' });
  });
  assert.ok(events.some((e) => e.type === 'permission' && e.tool === 'Bash'));
  assert.ok(events.some((e) => e.type === 'tool_result' && !e.isError));
  assert.equal(readFileSync(join(folder, 'out.txt'), 'utf8').trim(), 'done');

  const saved = (await call('GET', `/api/chats/${chat.id}`)).data;
  assert.deepEqual(saved.allowedRules, ['Bash(echo)']);
  // Project instructions and the coding prompt reach the model.
  const system = JSON.stringify(lastMain().messages[0]);
  assert.match(system, /Be terse\./);
  assert.match(system, /interactive coding agent/);
});

test('the model can save memories, which later chats see', async () => {
  let turn = 0;
  reply = () => (turn++ === 0 ? toolCallChunks('call_mem', 'Memory', { action: 'add', content: 'User loves cats' }) : textChunks('Noted.'));
  const chat = (await call('POST', '/api/chats', {})).data;
  await stream(`/api/chats/${chat.id}/messages`, { content: 'Remember I love cats' });
  const memories = (await call('GET', '/api/memories')).data;
  assert.ok(memories.some((m: any) => m.content === 'User loves cats' && m.source === 'assistant'));

  reply = () => textChunks('Meow');
  const next = (await call('POST', '/api/chats', {})).data;
  await stream(`/api/chats/${next.id}/messages`, { content: 'Hi' });
  assert.match(JSON.stringify(lastMain().messages[0]), /User loves cats/);
});

test('compaction summarizes older turns and the context breakdown reflects it', async () => {
  reply = () => textChunks('Reply');
  const chat = (await call('POST', '/api/chats', {})).data;
  for (const q of ['Q1', 'Q2', 'Q3']) await stream(`/api/chats/${chat.id}/messages`, { content: q });

  reply = () => textChunks('SUMMARY OF Q1');
  const res = await call('POST', `/api/chats/${chat.id}/compact`, { keepRecentTurns: 2 });
  assert.equal(res.data.compacted, true);
  const saved = (await call('GET', `/api/chats/${chat.id}`)).data;
  assert.equal(saved.contextStart, 2);
  assert.equal(saved.summary, 'SUMMARY OF Q1');

  const ctx = (await call('GET', `/api/chats/${chat.id}/context`)).data;
  assert.equal(ctx.contextLength, 1000);
  assert.ok(ctx.sections.some((s: any) => s.kind === 'summary'));
  assert.equal(ctx.compactedMessages, 2);

  // The next request sends the summary instead of the old turns.
  reply = () => textChunks('After');
  await stream(`/api/chats/${chat.id}/messages`, { content: 'Q4' });
  const sent = JSON.stringify(lastMain().messages);
  assert.match(sent, /SUMMARY OF Q1/);
  assert.doesNotMatch(sent, /"Q1"/);
});

test('auto-compaction triggers when the last request was near the limit', async () => {
  // A 1% threshold of the mock's 1000-token window is 10 tokens; the first reply reports 50.
  await call('PUT', '/api/settings', { autoCompactPercent: 1, keepRecentTurns: 1 });
  try {
    reply = () => [...textChunks('Reply').slice(0, 2), { choices: [], usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 } }];
    const chat = (await call('POST', '/api/chats', {})).data;
    await stream(`/api/chats/${chat.id}/messages`, { content: 'First' });
    reply = (body) => textChunks(JSON.stringify(body.messages).includes('Summarize the conversation') ? 'AUTO SUMMARY' : 'Reply');
    const events = await stream(`/api/chats/${chat.id}/messages`, { content: 'Second' });
    assert.ok(events.some((e) => e.type === 'compacted'));
    assert.equal((await call('GET', `/api/chats/${chat.id}`)).data.summary, 'AUTO SUMMARY');
  } finally {
    await call('PUT', '/api/settings', { autoCompactPercent: 80, keepRecentTurns: 2 });
  }
});

test('bots shape new chats and deleting a project removes its chats', async () => {
  const bot = (await call('POST', '/api/bots', { name: 'Pirate', emoji: '🏴‍☠️', systemPrompt: 'Talk like a pirate.', model: 'test/model', tools: { web: false } })).data;
  assert.deepEqual(bot.tools, { artifacts: true, web: false, memory: true });
  reply = () => textChunks('Arr');
  const chat = (await call('POST', '/api/chats', { botId: bot.id })).data;
  await stream(`/api/chats/${chat.id}/messages`, { content: 'Ahoy' });
  const last = lastMain();
  assert.match(JSON.stringify(last.messages[0]), /Talk like a pirate/);
  assert.ok(!last.tools.some((t: any) => t.function.name === 'WebFetch'));

  const project = (await call('POST', '/api/projects', { name: 'Temp' })).data;
  const inProject = (await call('POST', '/api/chats', { projectId: project.id })).data;
  await call('DELETE', `/api/projects/${project.id}`);
  assert.equal((await call('GET', `/api/chats/${inProject.id}`)).status, 404);
});
