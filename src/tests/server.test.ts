import assert from 'node:assert/strict';
import { createServer, request, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { tempDir, textChunks, toolCallChunks, writeStdioMcpServer } from './helpers.js';
import { pathToFileURL } from 'node:url';

// Configure before the server modules read the environment.
process.env.MITZI_HOME = tempDir();
process.env.OPENROUTER_API_KEY = 'test-key';
// Keep the developer's own ~/.claude skills out of the tests.
process.env.CLAUDE_CONFIG_DIR = tempDir();

const TOKEN = 'a'.repeat(48);
let base = '';
let mock: Server;
let close: () => Promise<void>;
/** Decides the mock model's reply to each request. */
let reply: (body: any) => object[] = () => textChunks('Hello!');
const requests: any[] = [];
/** The latest chat request, ignoring concurrent title-generation requests. */
const isMemoryJob = (body: any) => /Extract memories worth keeping|You maintain \\?"observations|reflective memory of/.test(JSON.stringify(body.messages?.[0] ?? ''));
const lastMain = (): any => requests.filter((r) => r.max_tokens !== 60 && !isMemoryJob(r)).at(-1);
/** Replies to the memory engine's own LLM calls (extraction, consolidation, reflection). */
let memoryReply: (body: any) => object[] = (body) =>
  textChunks(JSON.stringify(body).includes('Extract memories') ? '{"facts": []}' : '{"update": [], "create": []}');

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
      const chunks = body.max_tokens === 60 ? textChunks('Generated Title') : isMemoryJob(body) ? memoryReply(body) : reply(body);
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
  assert.ok(bots.data.length >= 4);
  assert.equal(bots.data[0].id, 'mitzi');
  assert.equal(bots.data[0].builtIn, true);
  assert.ok(bots.data.every((b: any) => b.memory?.disposition?.skepticism >= 1));
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

/** Waits until a bot's bank has finished processing retains. */
async function settle(botId: string, until: (stats: any) => boolean = () => true) {
  for (let i = 0; i < 100; i++) {
    const bank = (await call('GET', '/api/banks')).data.find((b: any) => b.bot.id === botId);
    if (bank.stats && bank.stats.pending === 0 && until(bank.stats)) return bank.stats;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`Bank ${botId} did not settle`);
}

test('new chats use the default bot, which cannot be deleted', async () => {
  const chat = (await call('POST', '/api/chats', {})).data;
  assert.equal(chat.botId, 'mitzi');
  assert.equal((await call('DELETE', '/api/bots/mitzi')).status, 400);
  const patched = await call('PATCH', '/api/bots/mitzi', { systemPrompt: 'Be extra kind.', memory: { disposition: { skepticism: 9 } } });
  assert.equal(patched.data.memory.disposition.skepticism, 5);
  reply = () => textChunks('Hi!');
  await stream(`/api/chats/${chat.id}/messages`, { content: 'Hello' });
  assert.match(JSON.stringify(lastMain().messages[0]), /You are Mitzi[\s\S]*Be extra kind\./);
});

test('conversations are retained per bot and recalled in later chats', async () => {
  memoryReply = (body) => {
    const prompt = JSON.stringify(body.messages[0].content);
    if (prompt.includes('Extract memories')) {
      return textChunks(
        JSON.stringify({
          facts: [
            { text: 'The user has a cat named Luna.', type: 'world', entities: ['Luna'], occurred: null },
            { text: 'The user lives in Haifa.', type: 'world', entities: ['Haifa'], occurred: '2026-01-01' },
          ],
        }),
      );
    }
    // Consolidate whichever new facts were offered into one observation.
    const ids = [...(prompt.split('Related earlier facts')[0].matchAll(/\[([\w-]+)\]/g) ?? [])].map((m) => m[1]);
    return textChunks(JSON.stringify({ update: [], create: [{ text: 'The user is a cat owner living in Haifa.', evidence: ids, entities: ['Luna', 'Haifa'] }] }));
  };
  try {
    reply = () => textChunks('What a lovely cat!');
    const first = (await call('POST', '/api/chats', {})).data;
    await stream(`/api/chats/${first.id}/messages`, { content: 'My cat Luna keeps me company here in Haifa' });
    const stats = await settle('mitzi', (s) => s.observation >= 1);
    assert.ok(stats.world >= 2);

    // A later chat recalls the relevant memories (Luna is linked through the entity graph).
    reply = () => textChunks('Luna is doing great, I hope!');
    const second = (await call('POST', '/api/chats', {})).data;
    const events = await stream(`/api/chats/${second.id}/messages`, { content: 'Any ideas for how to keep Luna entertained?' });
    const recalled = events.find((e) => e.type === 'recall').memories;
    const luna = recalled.find((m: any) => m.text === 'The user has a cat named Luna.');
    assert.ok(luna.strategies.includes('graph') && luna.strategies.includes('keyword'));
    assert.ok(recalled.some((m: any) => m.type === 'observation'));
    assert.match(JSON.stringify(lastMain().messages[0]), /cat named Luna/);
    const saved = (await call('GET', `/api/chats/${second.id}`)).data;
    assert.ok(saved.messages[0].memories.length >= 2);
    // The per-message memories never reach the API as message fields.
    assert.ok(lastMain().messages.every((m: any) => m.memories === undefined));

    // Banks are per bot: another bot knows nothing about Luna.
    const tutor = (await call('GET', '/api/bots')).data.find((b: any) => b.name === 'Socratic Tutor');
    const other = (await call('POST', `/api/banks/${tutor.id}/recall`, { query: 'Luna' })).data;
    assert.deepEqual(other, []);
  } finally {
    memoryReply = (body) => textChunks(JSON.stringify(body).includes('Extract memories') ? '{"facts": []}' : '{"update": [], "create": []}');
  }
});

test('the Memory tool and bank endpoints manage memories', async () => {
  const bot = (await call('POST', '/api/bots', { name: 'Gardener', tools: { web: false } })).data;
  let turn = 0;
  reply = () => (turn++ === 0 ? toolCallChunks('call_mem', 'Memory', { action: 'remember', content: 'The user grows tomatoes on a balcony.' }) : textChunks('Noted.'));
  const chat = (await call('POST', '/api/chats', { botId: bot.id })).data;
  await stream(`/api/chats/${chat.id}/messages`, { content: 'Remember that I grow tomatoes on my balcony' });
  await settle(bot.id);

  const list = (await call('GET', `/api/banks/${bot.id}/memories?type=world`)).data;
  const tomato = list.items.find((m: any) => m.text === 'The user grows tomatoes on a balcony.');
  assert.equal(tomato.source, 'assistant');

  await call('POST', `/api/banks/${bot.id}/memories`, { content: 'The user prefers organic fertilizer.' });
  const found = (await call('POST', `/api/banks/${bot.id}/recall`, { query: 'what fertilizer for tomatoes?' })).data;
  assert.equal(found.length, 2);

  memoryReply = () => textChunks('The user grows tomatoes organically on a balcony [x].');
  const reflection = (await call('POST', `/api/banks/${bot.id}/reflect`, { query: 'How does the user garden?' })).data;
  assert.match(reflection.text, /organically/);
  assert.equal(reflection.basedOn.length, 2);
  assert.match(JSON.stringify(requests.at(-1)), /Skepticism 3\/5/);

  assert.equal((await call('DELETE', `/api/banks/${bot.id}/memories/${tomato.id}`)).status, 200);
  assert.equal((await call('GET', `/api/banks/${bot.id}/memories`)).data.total, 1);
  await call('DELETE', `/api/banks/${bot.id}`);
  assert.equal((await call('GET', `/api/banks/${bot.id}/memories`)).data.total, 0);
});

test('memory can live on an external Hindsight server', async () => {
  const calls: { method: string; url: string; body: any }[] = [];
  const hs = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      calls.push({ method: req.method!, url: req.url!, body: raw ? JSON.parse(raw) : undefined });
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url!.endsWith('/memories/recall')) res.end(JSON.stringify({ results: [{ id: 'h1', text: 'The user speaks Hebrew.', type: 'world' }] }));
      else if (req.url!.includes('/memories/list')) res.end(JSON.stringify({ items: [{ id: 'h1', text: 'The user speaks Hebrew.', fact_type: 'world' }], total: 1, limit: 50, offset: 0 }));
      else res.end('{}');
    });
  });
  await new Promise<void>((r) => hs.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(hs.address() as AddressInfo).port}`;
  try {
    assert.equal((await call('POST', '/api/memory/test', { url })).status, 200);
    await call('PUT', '/api/settings', { memoryBackend: 'hindsight', hindsightUrl: url });

    reply = () => textChunks('שלום!');
    const chat = (await call('POST', '/api/chats', {})).data;
    const events = await stream(`/api/chats/${chat.id}/messages`, { content: 'Say hi in my language' });
    assert.equal(events.find((e) => e.type === 'recall').memories[0].text, 'The user speaks Hebrew.');
    assert.match(JSON.stringify(lastMain().messages[0]), /speaks Hebrew/);

    for (let i = 0; i < 50 && !calls.some((c) => c.method === 'POST' && c.url.endsWith('/memories')); i++) await new Promise((r) => setTimeout(r, 20));
    const bank = calls.find((c) => c.method === 'PUT');
    assert.equal(bank!.url, '/v1/default/banks/mitzi-mitzi');
    assert.deepEqual(Object.keys(bank!.body.disposition).sort(), ['empathy', 'literalism', 'skepticism']);
    const retain = calls.find((c) => c.method === 'POST' && c.url.endsWith('/memories'));
    assert.match(retain!.body.items[0].content, /Say hi in my language/);
    const listed = (await call('GET', '/api/banks/mitzi/memories')).data;
    assert.equal(listed.items[0].text, 'The user speaks Hebrew.');
  } finally {
    await call('PUT', '/api/settings', { memoryBackend: 'builtin' });
    hs.close();
  }
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
  assert.deepEqual(bot.tools, { artifacts: true, web: false, memory: true, skills: true, connectors: true, media: true });
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

/** Polls until a server reaches a status. */
async function waitFor(id: string, status: string) {
  for (let i = 0; i < 200; i++) {
    const server = (await call('GET', '/api/mcp')).data.find((s: any) => s.id === id);
    if (server?.status === status) return server;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Server ${id} never became ${status}`);
}

test('MCP servers: tools join chats, with trust-based permissions', async () => {
  const script = writeStdioMcpServer(tempDir());
  const created = await call('POST', '/api/mcp', {
    name: 'Test Tools',
    transport: 'stdio',
    command: process.execPath,
    args: [script],
    env: { API_KEY: 's3cret' },
    trust: 'readonly',
  });
  assert.equal(created.status, 200);
  assert.equal(created.data.env.API_KEY, '••••••••');
  const server = await waitFor(created.data.id, 'connected');
  assert.deepEqual(
    server.tools.map((t: any) => [t.name, t.readOnly]),
    [
      ['echo', true],
      ['shout', false],
      ['fail', false],
    ],
  );
  await call('PATCH', `/api/mcp/${server.id}`, { disabledTools: ['fail'] });

  let turn = 0;
  reply = () =>
    [
      () => toolCallChunks('c1', 'mcp__test_tools__echo', { text: 'hi' }),
      () => toolCallChunks('c2', 'mcp__test_tools__shout', { text: 'hey' }),
      () => textChunks('Done.'),
    ][turn++]();
  const chat = (await call('POST', '/api/chats', {})).data;
  const permissions: string[] = [];
  const events = await stream(`/api/chats/${chat.id}/messages`, { content: 'Use the tools' }, (e) => {
    if (e.type === 'permission') {
      permissions.push(e.tool);
      void call('POST', `/api/chats/${chat.id}/permission`, { requestId: e.requestId, answer: 'yes' });
    }
  });
  // The read-only tool ran without asking; the other one asked first.
  assert.deepEqual(permissions, ['mcp__test_tools__shout']);
  const results = events.filter((e) => e.type === 'tool_result').map((e) => e.output);
  assert.deepEqual(results, ['echo: hi', 'HEY']);
  const offered = lastMain().tools.map((t: any) => t.function.name);
  assert.ok(offered.includes('mcp__test_tools__echo') && !offered.includes('mcp__test_tools__fail'));

  assert.equal((await call('DELETE', `/api/mcp/${server.id}`)).status, 200);
});

test('MCP OAuth: needs-auth, sign-in through the callback, then connected', async () => {
  const libDir = tempDir();
  writeStdioMcpServer(libDir);
  const lib = (await import(pathToFileURL(join(libDir, 'mcp-lib.mjs')).href)).handle as (m: any) => any;
  let base = '';
  const authServer = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const url = new URL(req.url!, base);
      const json = (status: number, data: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(data));
      };
      if (url.pathname === '/mcp') {
        if (req.headers.authorization !== 'Bearer good-token') {
          return json(401, {}, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` });
        }
        const reply = lib(JSON.parse(raw));
        if (!reply) return void res.writeHead(202).end();
        return json(200, reply);
      }
      if (url.pathname === '/.well-known/oauth-protected-resource') return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        return json(200, { authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register` });
      }
      if (url.pathname === '/register') return json(201, { client_id: 'mitzi-client' });
      if (url.pathname === '/authorize') {
        // Pretend the user approved: redirect back with a code.
        const back = new URL(url.searchParams.get('redirect_uri')!);
        back.searchParams.set('code', 'code-1');
        back.searchParams.set('state', url.searchParams.get('state')!);
        res.writeHead(302, { location: back.toString() });
        return res.end();
      }
      if (url.pathname === '/token') return json(200, { access_token: 'good-token', refresh_token: 'r1', expires_in: 3600 });
      json(404, {});
    });
  });
  await new Promise<void>((r) => authServer.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(authServer.address() as AddressInfo).port}`;
  try {
    const created = (await call('POST', '/api/mcp', { name: 'Secure', transport: 'http', url: `${base}/mcp` })).data;
    await waitFor(created.id, 'needs-auth');
    const { url } = (await call('POST', `/api/mcp/${created.id}/auth`)).data;
    const approve = await fetch(url, { redirect: 'manual' });
    const callback = approve.headers.get('location')!;
    assert.match(callback, /\/api\/oauth\/callback\?code=code-1&state=/);
    // The browser follows the redirect to Mitzi (no app token: the state authenticates it).
    const done = await fetch(callback);
    assert.equal(done.status, 200);
    assert.match(await done.text(), /Connected to Secure/);
    const server = await waitFor(created.id, 'connected');
    assert.equal(server.oauthConnected, true);
    assert.equal(server.tools.length, 3);
    // A forged callback is rejected.
    const forged = await fetch(callback.replace(/state=[^&]+/, 'state=forged'));
    assert.equal(forged.status, 400);
    await call('DELETE', `/api/mcp/${created.id}`);
  } finally {
    authServer.close();
  }
});

function makePlugin(dir: string, name: string) {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  mkdirSync(join(dir, 'skills', 'haiku'), { recursive: true });
  mkdirSync(join(dir, 'commands'));
  mkdirSync(join(dir, 'agents'));
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, description: 'A demo plugin', version: '1.2.0', author: { name: 'Me' } }));
  writeFileSync(join(dir, 'skills', 'haiku', 'SKILL.md'), '---\nname: haiku\ndescription: Write haiku in 5-7-5\n---\nCount syllables carefully.');
  writeFileSync(join(dir, 'commands', 'greet.md'), '---\ndescription: Greet someone\nargument-hint: <name>\n---\nSay hello to $ARGUMENTS warmly.');
  writeFileSync(join(dir, 'agents', 'poet.md'), '---\nname: Poet\ndescription: Writes poems\nmodel: sonnet\n---\nYou are a poet.');
  writeStdioMcpServer(dir);
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { verse: { command: process.execPath, args: ['${CLAUDE_PLUGIN_ROOT}/mcp-server.mjs'] } } }));
}

test('plugins: install a Claude-format plugin; skills, commands, agents and MCP servers follow', async () => {
  const src = tempDir();
  makePlugin(src, 'demo-kit');
  const installed = (await call('POST', '/api/plugins', { source: src })).data.plugin;
  assert.equal(installed.id, 'demo-kit');
  assert.deepEqual(installed.components, { skills: 1, commands: 1, agents: 1, mcpServers: 1, hooks: false });

  const poet = (await call('GET', '/api/bots')).data.find((b: any) => b.name === 'Poet');
  assert.equal(poet.pluginId, 'demo-kit');
  assert.equal(poet.systemPrompt, 'You are a poet.');
  assert.ok((await call('GET', '/api/commands')).data.some((c: any) => c.name === 'greet' && c.source === 'demo-kit'));
  assert.ok((await call('GET', '/api/skills')).data.some((s: any) => s.id === 'demo-kit:haiku'));
  const verse = (await call('GET', '/api/mcp')).data.find((s: any) => s.pluginId === 'demo-kit');
  assert.match(verse.args[0], /plugins\/demo-kit\/mcp-server\.mjs$/);
  await waitFor(verse.id, 'connected');

  // Slash commands expand; skills are offered in the prompt.
  reply = () => textChunks('Hello, Dana!');
  const chat = (await call('POST', '/api/chats', {})).data;
  await stream(`/api/chats/${chat.id}/messages`, { content: '/greet Dana' });
  const saved = (await call('GET', `/api/chats/${chat.id}`)).data;
  assert.equal(saved.messages[0].content, 'Say hello to Dana warmly.');
  assert.equal(saved.messages[0].command, '/greet Dana');
  const system = JSON.stringify(lastMain().messages[0]);
  assert.match(system, /# Skills[\s\S]*haiku: Write haiku in 5-7-5/);
  assert.ok(lastMain().tools.some((t: any) => t.function.name === 'Skill'));

  // Disabling removes everything it contributed.
  await call('PATCH', '/api/plugins/demo-kit', { enabled: false });
  assert.ok(!(await call('GET', '/api/bots')).data.some((b: any) => b.name === 'Poet'));
  assert.ok(!(await call('GET', '/api/mcp')).data.some((s: any) => s.pluginId === 'demo-kit'));
  assert.ok(!(await call('GET', '/api/commands')).data.some((c: any) => c.name === 'greet'));
  assert.equal((await call('DELETE', '/api/plugins/demo-kit')).status, 200);
});

test('marketplaces: list plugins and install, including skill-only entries', async () => {
  const mp = tempDir();
  mkdirSync(join(mp, '.claude-plugin'), { recursive: true });
  makePlugin(join(mp, 'plugins', 'demo'), 'demo-kit');
  mkdirSync(join(mp, 'skills', 'one'), { recursive: true });
  mkdirSync(join(mp, 'skills', 'two'), { recursive: true });
  writeFileSync(join(mp, 'skills', 'one', 'SKILL.md'), '---\nname: one\ndescription: First\n---\nOne.');
  writeFileSync(join(mp, 'skills', 'two', 'SKILL.md'), '---\nname: two\ndescription: Second\n---\nTwo.');
  writeFileSync(
    join(mp, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'local-market',
      owner: { name: 'Me' },
      plugins: [
        { name: 'demo-kit', source: './plugins/demo', description: 'Demo' },
        { name: 'skill-pack', source: './', strict: false, skills: ['./skills/one'], description: 'Just one skill' },
      ],
    }),
  );
  // Installing a marketplace repo as a plugin adds the marketplace instead.
  const viaPlugin = (await call('POST', '/api/plugins', { source: mp })).data;
  assert.equal(viaPlugin.marketplace.name, 'local-market');
  assert.deepEqual(
    viaPlugin.marketplace.plugins.map((p: any) => p.name),
    ['demo-kit', 'skill-pack'],
  );

  const plugin = (await call('POST', '/api/marketplaces/local-market/install', { name: 'skill-pack' })).data;
  assert.equal(plugin.components.skills, 1);
  const ids = (await call('GET', '/api/skills')).data.map((s: any) => s.id);
  assert.ok(ids.includes('skill-pack:one') && !ids.includes('skill-pack:two'));
  const listed = (await call('GET', '/api/marketplaces')).data[0];
  assert.equal(listed.plugins.find((p: any) => p.name === 'skill-pack').installed, true);

  await call('DELETE', '/api/plugins/skill-pack');
  await call('DELETE', '/api/marketplaces/local-market');
  assert.deepEqual((await call('GET', '/api/marketplaces')).data, []);
});

test('connectors directory creates configured servers', async () => {
  const presets = (await call('GET', '/api/connectors')).data;
  assert.ok(presets.some((p: any) => p.id === 'notion' && p.oauth));
  assert.equal((await call('POST', '/api/connectors/brave-search', { values: {} })).status, 400);

  const gh = (await call('POST', '/api/connectors/github', { values: { token: 'ghp_secret' } })).data;
  assert.equal(gh.transport, 'http');
  assert.equal(gh.headers.Authorization, '••••••••');
  const fsServer = (await call('POST', '/api/connectors/filesystem', { values: { paths: '~/docs\n/tmp/x' } })).data;
  assert.deepEqual(fsServer.args.slice(0, 2), ['-y', '@modelcontextprotocol/server-filesystem']);
  assert.ok(fsServer.args[2].endsWith('/docs') && !fsServer.args[2].startsWith('~'));
  assert.equal(fsServer.args[3], '/tmp/x');
  const again = (await call('POST', '/api/connectors/github', { values: { token: 'x' } })).data;
  assert.equal(again.name, 'GitHub 2');
  for (const s of [gh, fsServer, again]) await call('PATCH', `/api/mcp/${s.id}`, { enabled: false });
  for (const s of [gh, fsServer, again]) await call('DELETE', `/api/mcp/${s.id}`);
});
