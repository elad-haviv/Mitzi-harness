import assert from 'node:assert/strict';
import { createServer, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { toAnthropic } from '../anthropic.js';
import { resolveProviders, RoutingClient } from '../providers.js';
import { nextRun, parseCron, validateSchedule } from '../server/scheduler.js';
import { tempDir, textChunks, toolCallChunks } from './helpers.js';

process.env.MITZI_HOME = tempDir();
process.env.OPENROUTER_API_KEY = 'test-key';
process.env.CLAUDE_CONFIG_DIR = tempDir();
for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ELEVENLABS_API_KEY']) delete process.env[k];

const TOKEN = 'b'.repeat(48);
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
let base = '';
let mockUrl = '';
let mock: Server;
let close: () => Promise<void>;
let reply: (body: any) => object[] = () => textChunks('Hello!');
const requests: any[] = [];
const isBackground = (body: any) =>
  body.max_tokens === 60 || /Extract memories worth keeping|You maintain \\?"observations|reflective memory of|rated an AI assistant/.test(JSON.stringify(body.messages?.[0] ?? ''));
const lastMain = (): any => requests.filter((r) => !isBackground(r)).at(-1);

before(async () => {
  mock = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', name: 'Test: Model', context_length: 100000, supported_parameters: ['tools'] }, { id: 'gpt-test' }] }));
        return;
      }
      if (req.url?.endsWith('/images/generations')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }));
        return;
      }
      if (req.url?.endsWith('/audio/speech')) {
        res.writeHead(200, { 'content-type': 'audio/mpeg' });
        res.end(Buffer.from('ID3fakeaudio'));
        return;
      }
      const body = JSON.parse(raw);
      requests.push(body);
      const text = JSON.stringify(body.messages?.[0] ?? '');
      const chunks =
        body.max_tokens === 60
          ? textChunks('Generated Title')
          : /rated an AI assistant/.test(text)
            ? textChunks(/disliked/.test(text) ? 'Prefer short answers with a concrete example.' : 'NONE')
            : /Extract memories/.test(text)
              ? textChunks('{"facts": []}')
              : /observations|reflective memory/.test(text)
                ? textChunks('{"update": [], "create": []}')
                : reply(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  mockUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
  process.env.OPENROUTER_BASE_URL = mockUrl;
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
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'x-mitzi-token': TOKEN, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as any };
}

async function send(chatId: string, content: string): Promise<any[]> {
  const res = await fetch(`${base}/api/chats/${chatId}/messages`, {
    method: 'POST',
    headers: { 'x-mitzi-token': TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  assert.equal(res.status, 200);
  return (await res.text())
    .split('\n\n')
    .filter((f) => f.startsWith('data: '))
    .map((f) => JSON.parse(f.slice(6)));
}

async function until<T>(fn: () => Promise<T | undefined>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ---- Pure units --------------------------------------------------------------------

test('cron and schedules compute the next run in local time', () => {
  const from = new Date(2026, 0, 5, 10, 7); // Monday 10:07
  assert.deepEqual(nextRun({ kind: 'cron', cron: '*/15 * * * *' }, from), new Date(2026, 0, 5, 10, 15));
  assert.deepEqual(nextRun({ kind: 'cron', cron: '30 9 * * 1-5' }, from), new Date(2026, 0, 6, 9, 30));
  assert.deepEqual(nextRun({ kind: 'cron', cron: '0 0 1 * *' }, from), new Date(2026, 1, 1, 0, 0));
  assert.deepEqual(nextRun({ kind: 'daily', time: '08:00' }, from), new Date(2026, 0, 6, 8, 0));
  assert.deepEqual(nextRun({ kind: 'daily', time: '23:00' }, from), new Date(2026, 0, 5, 23, 0));
  assert.deepEqual(nextRun({ kind: 'weekly', time: '09:00', days: [0, 6] }, from), new Date(2026, 0, 10, 9, 0));
  assert.deepEqual(nextRun({ kind: 'interval', everyMinutes: 60 }, from, new Date(2026, 0, 5, 9, 30)), new Date(2026, 0, 5, 10, 30));
  assert.equal(nextRun({ kind: 'once', at: from.toISOString() }, from, from), undefined);
  assert.equal(parseCron('0 9 * * 7').dow.has(0), true);
  assert.throws(() => parseCron('61 * * * *'), /out of range/);
  assert.throws(() => validateSchedule({ kind: 'interval', everyMinutes: 1 }), /at least 5/);
});

test('model ids route to providers by prefix', () => {
  const r = new RoutingClient(
    resolveProviders({
      apiKey: 'or',
      providers: [
        { id: 'openai', kind: 'openai', name: 'OpenAI', apiKey: 'sk', enabled: true },
        { id: 'openai-eu', kind: 'custom', name: 'EU', apiKey: 'x', baseUrl: 'http://x', enabled: true },
        { id: 'anthropic', kind: 'anthropic', name: 'Anthropic', enabled: true },
      ],
    } as any),
  );
  assert.deepEqual([r.route('openai:gpt-5').provider.id, r.route('openai:gpt-5').model], ['openai', 'gpt-5']);
  assert.equal(r.route('openai-eu:m').provider.id, 'openai-eu');
  assert.equal(r.route('anthropic/claude-sonnet-4.5').provider.id, 'openrouter');
  assert.ok(r.isOpenRouter('google/gemini-2.5-pro'));
  assert.throws(() => r.route('anthropic:claude-sonnet-4-5'), /Add your Anthropic API key/);
});

test('messages convert to Anthropic format', () => {
  const { system, messages } = toAnthropic([
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'Hi' },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
    { role: 'assistant', content: 'Let me look.', tool_calls: [{ id: 't1', type: 'function', function: { name: 'Read', arguments: '{"path":"a"}' } }] },
    { role: 'tool', tool_call_id: 't1', content: 'file body' },
  ]);
  assert.equal(system[0].text, 'Be brief.');
  assert.deepEqual(
    messages.map((m) => [m.role, m.content.map((b) => b.type)]),
    [
      ['user', ['text', 'image']],
      ['assistant', ['text', 'tool_use']],
      ['user', ['tool_result']],
    ],
  );
  assert.deepEqual(messages[1].content[1].input, { path: 'a' });
  assert.equal(messages[0].content[1].source.media_type, 'image/png');
  assert.ok(messages[2].content[0].cache_control);
});

// ---- Server features -----------------------------------------------------------------

test('providers can be added, listed and removed', async () => {
  const added = await call('POST', '/api/providers', { kind: 'openai', apiKey: 'sk-test', baseUrl: mockUrl });
  assert.equal(added.status, 200);
  const openai = added.data.find((p: any) => p.id === 'openai');
  assert.equal(openai.hasKey, true);
  assert.equal(openai.apiKey, undefined);
  const models = (await call('GET', '/api/models')).data;
  assert.ok(models.some((m: any) => m.id === 'openai:gpt-test' && m.provider === 'OpenAI'));
  assert.ok(models.some((m: any) => m.id === 'test/model'));
  const tested = await call('POST', '/api/providers/openai/test');
  assert.equal(tested.data.ok, true);
});

test('branching copies history up to an answer, with its artifacts', async () => {
  let turn = 0;
  reply = () =>
    turn++ === 0 ? toolCallChunks('call_b1', 'Artifact', { command: 'create', type: 'markdown', title: 'Plan', content: '# Plan' }) : textChunks(`Answer ${turn}`);
  const chat = (await call('POST', '/api/chats', {})).data;
  await send(chat.id, 'Make a plan');
  reply = () => textChunks('Second answer');
  await send(chat.id, 'And then?');
  const full = (await call('GET', `/api/chats/${chat.id}`)).data;
  assert.equal(full.messages.length, 6);

  // Branch from the tool-call message of the first turn: the whole first turn comes along.
  const branch = (await call('POST', `/api/chats/${chat.id}/branch`, { index: 1 })).data;
  assert.equal(branch.branchedFrom.chatId, chat.id);
  assert.match(branch.title, /\(branch\)/);
  const copy = (await call('GET', `/api/chats/${branch.id}`)).data;
  assert.deepEqual(
    copy.messages.map((m: any) => m.role),
    ['user', 'assistant', 'tool', 'assistant'],
  );
  const arts = (await call('GET', `/api/artifacts?chatId=${branch.id}`)).data;
  assert.equal(arts.length, 1);
  assert.equal(arts[0].title, 'Plan');
  const original = (await call('GET', `/api/artifacts?chatId=${chat.id}`)).data;
  assert.notEqual(arts[0].id, original[0].id);
  assert.ok(copy.messages[2].content.includes(arts[0].id));

  // Continuing the branch leaves the original alone.
  reply = () => textChunks('Branch answer');
  await send(branch.id, 'Try differently');
  assert.equal((await call('GET', `/api/chats/${chat.id}`)).data.messages.length, 6);
});

test('ratings teach the bot lessons that shape later prompts', async () => {
  reply = () => textChunks('A very long rambling answer.');
  const chat = (await call('POST', '/api/chats', {})).data;
  await send(chat.id, 'Explain monads');
  const r = await call('POST', `/api/chats/${chat.id}/messages/1/rating`, { value: -1, comment: 'Too long, show an example', wait: true });
  assert.equal(r.data.rating.value, -1);
  const saved = (await call('GET', `/api/chats/${chat.id}`)).data;
  assert.equal(saved.messages[1].rating.lesson, 'Prefer short answers with a concrete example.');
  const lessons = (await call('GET', '/api/bots/mitzi/lessons')).data;
  assert.equal(lessons.length, 1);

  await send(chat.id, 'Explain functors');
  assert.match(JSON.stringify(lastMain().messages[0]), /Lessons from feedback[\s\S]*Prefer short answers with a concrete example/);
  // The rating itself never reaches the model.
  assert.ok(!JSON.stringify(lastMain().messages).includes('"rating"'));

  // A like with nothing to learn adds no lesson; clearing a rating removes its lesson.
  await call('POST', `/api/chats/${chat.id}/messages/3/rating`, { value: 1, wait: true });
  assert.equal((await call('GET', '/api/bots/mitzi/lessons')).data.length, 1);
  await call('POST', `/api/chats/${chat.id}/messages/1/rating`, { value: 0 });
  assert.equal((await call('GET', '/api/bots/mitzi/lessons')).data.length, 0);
  assert.equal((await call('POST', `/api/chats/${chat.id}/messages/0/rating`, { value: 1 })).status, 400);
});

test('documents: the bot edits, comments and versions a shared document', async () => {
  const doc = (await call('POST', '/api/docs', { title: 'Trip notes', content: '# Trip\n\nWe go to Rome in May.' })).data;
  assert.ok(doc.chatId);
  // The companion chat stays out of the chat list.
  assert.ok(!(await call('GET', '/api/chats')).data.some((c: any) => c.id === doc.chatId));

  const withComment = (await call('POST', `/api/docs/${doc.id}/comments`, { quote: 'Rome', text: 'Should we add Florence?' })).data;
  const commentId = withComment.comments[0].id;

  let turn = 0;
  reply = () => {
    turn++;
    if (turn === 1) return toolCallChunks('d1', 'DocEdit', { old_str: 'Rome in May.', new_str: 'Rome and Florence in May.' });
    if (turn === 2) return toolCallChunks('d2', 'DocComment', { action: 'resolve', id: commentId, text: 'Added Florence.' });
    return textChunks('Added Florence to the plan.');
  };
  const events = await send(doc.chatId, 'Please address my comment');
  const docEvents = events.filter((e) => e.type === 'doc');
  assert.equal(docEvents.length, 2);
  assert.match(JSON.stringify(requests.filter((r) => !isBackground(r)).at(-3).messages[0]), /Document workspace[\s\S]*We go to Rome in May[\s\S]*Should we add Florence/);

  const after = (await call('GET', `/api/docs/${doc.id}`)).data;
  assert.equal(after.content, '# Trip\n\nWe go to Rome and Florence in May.');
  assert.equal(after.comments[0].resolved, true);
  assert.equal(after.comments[0].replies[0].text, 'Added Florence.');
  assert.deepEqual(
    after.versions.map((v: any) => v.author),
    ['user', 'assistant'],
  );

  // User edits are saved, and old versions can be restored.
  await call('PATCH', `/api/docs/${doc.id}`, { content: 'Rewritten by hand' });
  const restored = (await call('POST', `/api/docs/${doc.id}/versions/${after.versions[0].id}/restore`)).data;
  assert.equal(restored.content, '# Trip\n\nWe go to Rome in May.');
  const list = (await call('GET', '/api/docs')).data;
  assert.equal(list[0].id, doc.id);
  assert.equal(list[0].openComments, 0);

  // A failed edit is reported to the model, not applied.
  reply = () => (turn++ === 3 ? toolCallChunks('d3', 'DocEdit', { old_str: 'Paris', new_str: 'Lyon' }) : textChunks('Sorry.'));
  const failed = await send(doc.chatId, 'Change Paris');
  assert.ok(failed.some((e) => e.type === 'tool_result' && e.isError && /not found/.test(e.output)));

  // Documents can start from a markdown artifact; deleting a doc removes its chat.
  const art = (await call('GET', '/api/artifacts')).data.find((a: any) => a.type === 'markdown');
  const fromArt = (await call('POST', '/api/docs', { artifactId: art.id })).data;
  assert.equal(fromArt.content, '# Plan');
  await call('DELETE', `/api/docs/${fromArt.id}`);
  assert.equal((await call('GET', `/api/chats/${fromArt.chatId}`)).status, 404);
});

test('scheduled tasks validate, run headless and record runs', async () => {
  assert.equal((await call('POST', '/api/tasks', { name: 'Bad', prompt: 'x', schedule: { kind: 'cron', cron: 'nope' } })).status, 400);
  const task = (await call('POST', '/api/tasks', { name: 'Morning brief', prompt: 'Summarize my day', schedule: { kind: 'daily', time: '07:30' } })).data;
  assert.ok(task.nextRunAt);
  assert.equal(new Date(task.nextRunAt).getHours(), 7);
  assert.equal(task.description, 'Every day at 07:30');

  reply = () => textChunks('Here is your brief.');
  await call('POST', `/api/tasks/${task.id}/run`);
  const done = await until(async () => {
    const t = (await call('GET', '/api/tasks')).data.find((x: any) => x.id === task.id);
    return t.runs[0]?.status === 'ok' ? t : undefined;
  });
  assert.equal(done.runs[0].preview, 'Here is your brief.');
  assert.equal(done.runs[0].seen, false);
  const chat = (await call('GET', `/api/chats/${done.runs[0].chatId}`)).data;
  assert.equal(chat.taskId, task.id);
  assert.match(lastMain().messages.at(-1).content, /scheduled task "Morning brief"/);

  await call('POST', '/api/tasks/seen');
  assert.equal((await call('GET', '/api/tasks')).data.find((x: any) => x.id === task.id).runs[0].seen, true);

  // Without auto-approve, tools that ask are declined instead of waiting forever.
  const folder = tempDir();
  const project = (await call('POST', '/api/projects', { name: 'Code' })).data;
  await call('PATCH', `/api/projects/${project.id}`, { folder });
  const coding = (await call('POST', '/api/tasks', { name: 'Cleanup', prompt: 'Delete temp files', projectId: project.id, schedule: { kind: 'interval', everyMinutes: 60 } })).data;
  let turn = 0;
  reply = () => (turn++ === 0 ? toolCallChunks('b1', 'Bash', { command: 'echo hi' }) : textChunks('Could not run it.'));
  await call('POST', `/api/tasks/${coding.id}/run`);
  const ran = await until(async () => {
    const t = (await call('GET', '/api/tasks')).data.find((x: any) => x.id === coding.id);
    return t.runs[0]?.status === 'ok' ? t : undefined;
  });
  const transcript = (await call('GET', `/api/chats/${ran.runs[0].chatId}`)).data;
  assert.match(transcript.messages.find((m: any) => m.role === 'tool').content, /unattended scheduled run/);

  await call('PATCH', `/api/tasks/${coding.id}`, { enabled: false });
  assert.equal((await call('GET', '/api/tasks')).data.find((x: any) => x.id === coding.id).nextRunAt, undefined);
  await call('DELETE', `/api/tasks/${coding.id}`);
});

test('media: image generation tool, read-aloud and media files', async () => {
  await call('POST', '/api/providers', { kind: 'custom', id: 'studio', apiKey: 'k', baseUrl: mockUrl });
  const settings = (await call('PUT', '/api/settings', { media: { imageModel: 'studio:img-1', speechModel: 'studio:tts-1', bogus: 'x' } })).data;
  assert.equal(settings.media.imageModel, 'studio:img-1');
  assert.equal(settings.media.bogus, undefined);
  const opts = (await call('GET', '/api/media/options')).data;
  assert.equal(opts.available.image, true);
  assert.equal(opts.available.video, false);

  let turn = 0;
  reply = () => (turn++ === 0 ? toolCallChunks('img1', 'GenerateImage', { prompt: 'a cat' }) : textChunks('Here is your cat.'));
  const chat = (await call('POST', '/api/chats', {})).data;
  const events = await send(chat.id, 'Draw a cat');
  const result = events.find((e) => e.type === 'tool_result');
  const m = /MEDIA: (\/media\/[a-f0-9]{32}\.png) image\/png/.exec(result.output);
  assert.ok(m, result.output);
  // Media load without the token (img tags can't send headers), and support ranges.
  const file = await fetch(`${base}${m[1]}`);
  assert.equal(file.status, 200);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG);
  const part = await fetch(`${base}${m[1]}`, { headers: { range: 'bytes=0-3' } });
  assert.equal(part.status, 206);
  assert.equal((await part.arrayBuffer()).byteLength, 4);
  assert.equal((await fetch(`${base}/media/..%2Fsettings.json`)).status, 404);

  const tts = await fetch(`${base}/api/tts`, { method: 'POST', headers: { 'x-mitzi-token': TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Hello' }) });
  assert.equal(tts.headers.get('content-type'), 'audio/mpeg');
  assert.equal(Buffer.from(await tts.arrayBuffer()).toString(), 'ID3fakeaudio');
});
