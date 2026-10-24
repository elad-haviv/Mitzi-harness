// End-to-end tests for how Mitzi checks its work and learns from what happened: a real server against a mock model.
import assert from 'node:assert/strict';
import { createServer, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { tempDir, textChunks, toolCallChunks } from './helpers.js';

process.env.MITZI_HOME = tempDir();
process.env.OPENROUTER_API_KEY = 'test-key';
process.env.CLAUDE_CONFIG_DIR = tempDir();

const TOKEN = 'b'.repeat(48);
let base = '';
let mock: Server;
let close: () => Promise<void>;
/** Decides the mock model's reply to each main request. */
let reply: (body: any) => object[] = () => textChunks('Hello!');
/** Replies to background jobs (titles, memory, learning), recognized by `background`. */
let jobReply: (body: any) => object[] | undefined = () => undefined;
const requests: any[] = [];
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
      const chunks =
        body.max_tokens === 60
          ? textChunks('Generated Title')
          : isMemoryJob(body)
            ? textChunks(JSON.stringify(body).includes('Extract memories') ? '{"facts": []}' : '{"update": [], "create": []}')
            : (jobReply(body) ?? reply(body));
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
