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
/** Milliseconds between the mock model's chunks (0: all at once). */
let chunkDelay = 0;
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
      if (req.url?.split('?')[0].endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: req.url.includes('output_modalities') ? [] : [{ id: 'test/model', name: 'Test: Model', context_length: 1000, supported_parameters: ['tools'] }] }));
        return;
      }
      const body = JSON.parse(raw);
      requests.push(body);
      // Title requests are recognizable by their small token budget.
      const chunks = body.max_tokens === 60 ? textChunks('Generated Title') : isMemoryJob(body) ? memoryReply(body) : reply(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      void (async () => {
        for (const c of chunks) {
          res.write(`data: ${JSON.stringify(c)}\n\n`);
          if (chunkDelay) await new Promise((r) => setTimeout(r, chunkDelay));
        }
        res.end('data: [DONE]\n\n');
      })();
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

test('bots shape new chats; deleting a project keeps or deletes its chats', async () => {
  const bot = (await call('POST', '/api/bots', { name: 'Pirate', emoji: '🏴‍☠️', systemPrompt: 'Talk like a pirate.', model: 'test/model', tools: { web: false } })).data;
  assert.deepEqual(bot.tools, { artifacts: true, web: false, memory: true, skills: true, connectors: true, media: true, team: true, subagents: true, code: true, browser: true });
  reply = () => textChunks('Arr');
  const chat = (await call('POST', '/api/chats', { botId: bot.id })).data;
  await stream(`/api/chats/${chat.id}/messages`, { content: 'Ahoy' });
  const last = lastMain();
  assert.match(JSON.stringify(last.messages[0]), /Talk like a pirate/);
  assert.ok(!last.tools.some((t: any) => t.function.name === 'WebFetch'));

  // By default the chats move out of the project.
  const kept = (await call('POST', '/api/projects', { name: 'Temp' })).data;
  const keptChat = (await call('POST', '/api/chats', { projectId: kept.id })).data;
  assert.equal((await call('DELETE', `/api/projects/${kept.id}`)).status, 200);
  assert.equal((await call('GET', `/api/projects/${kept.id}`)).status, 404);
  const moved = (await call('GET', `/api/chats/${keptChat.id}`)).data;
  assert.equal(moved.projectId, undefined);

  // Or they're deleted with it.
  const project = (await call('POST', '/api/projects', { name: 'Temp 2' })).data;
  const inProject = (await call('POST', '/api/chats', { projectId: project.id })).data;
  await call('DELETE', `/api/projects/${project.id}?chats=delete`);
  assert.equal((await call('GET', `/api/chats/${inProject.id}`)).status, 404);
});

test('a bot hands tasks to teammates and uses their answers', async () => {
  const mate = (await call('POST', '/api/bots', { name: 'Researcher', emoji: '🔬', description: 'Finds facts', systemPrompt: 'You research carefully.', tools: { web: false } })).data;
  let lead = 0;
  reply = (body) => {
    const system = JSON.stringify(body.messages[0]);
    // The teammate: its own instructions, plus the note about who it works for.
    if (/You research carefully/.test(system)) {
      assert.match(system, /Working with Mitzi/);
      assert.ok(!body.tools?.some((t: any) => t.function.name === 'Delegate'), 'teammates can’t delegate further');
      assert.equal(body.messages.at(-1).content, 'Find three facts about cats');
      return textChunks('Cats sleep 13 hours a day.');
    }
    assert.match(system, /# Your team[\s\S]*Researcher: Finds facts/);
    return lead++ === 0
      ? toolCallChunks('call_team', 'Delegate', { assignments: [{ bot: 'researcher', task: 'Find three facts about cats' }] })
      : textChunks('Here is what my researcher found: cats sleep a lot.');
  };
  const chat = (await call('POST', '/api/chats', {})).data;
  const events = await stream(`/api/chats/${chat.id}/messages`, { content: 'Tell me about cats' });
  const progress = events.filter((e) => e.type === 'delegate');
  assert.ok(progress.every((e) => e.callId === 'call_team' && e.botId === mate.id));
  assert.deepEqual([...new Set(progress.map((e) => e.event))], ['start', 'text', 'done']);
  assert.equal(progress.filter((e) => e.event === 'text').map((e) => e.text).join(''), 'Cats sleep 13 hours a day.');
  const result = events.find((e) => e.type === 'tool_result' && e.id === 'call_team');
  assert.equal(result.output, '## 🔬 Researcher\nCats sleep 13 hours a day.');
  const saved = (await call('GET', `/api/chats/${chat.id}`)).data;
  assert.equal(saved.messages.at(-1).content, 'Here is what my researcher found: cats sleep a lot.');
  // The teammate's requests count toward the chat's usage.
  assert.equal(saved.usage.requests, 3);

  // Without the Team capability, there's no Delegate tool.
  await call('PATCH', '/api/bots/mitzi', { tools: { team: false } });
  reply = () => textChunks('Solo.');
  await stream(`/api/chats/${chat.id}/messages`, { content: 'Again' });
  assert.ok(!lastMain().tools?.some((t: any) => t.function.name === 'Delegate'));
  assert.doesNotMatch(JSON.stringify(lastMain().messages[0]), /# Your team/);
  await call('PATCH', '/api/bots/mitzi', { tools: { team: true } });
  await call('DELETE', `/api/bots/${mate.id}`);
});

test('each response records its time, tokens and cost; usage adds up per chat and project', async () => {
  const project = (await call('POST', '/api/projects', { name: 'Costs' })).data;
  reply = () => textChunks('Counted.');
  const chat = (await call('POST', '/api/chats', { projectId: project.id })).data;
  const events = await stream(`/api/chats/${chat.id}/messages`, { content: 'Count me' });
  const stats = events.find((e) => e.type === 'stats').stats;
  assert.equal(stats.promptTokens, 10);
  assert.equal(stats.completionTokens, 5);
  assert.equal(stats.requests, 1);
  assert.ok(stats.durationMs >= 0);
  const saved = (await call('GET', `/api/chats/${chat.id}`)).data;
  assert.deepEqual(saved.messages.at(-1).stats, stats);
  const usage = (await call('GET', `/api/usage?days=7&projectId=${project.id}`)).data;
  // The project's usage includes everything done for it: the answer, its title and memory.
  const answers = usage.byKind.find((k: any) => k.key === 'chat').totals;
  assert.equal(answers.requests, 1);
  assert.equal(answers.prompt, 10);
  assert.equal(usage.totals.requests, usage.byKind.reduce((n: number, k: any) => n + k.totals.requests, 0));
  assert.equal(usage.byProject[0].name, 'Costs');
  assert.equal(usage.daily.length, 7);
  assert.equal(usage.daily.at(-1).requests, usage.totals.requests);
  // Titles are counted separately from the response.
  assert.ok((await call('GET', '/api/usage')).data.byKind.some((k: any) => k.key === 'title'));
});

test('/plan proposes a plan with read-only tools; approving it switches to work mode with a task list', async () => {
  let turn = 0;
  reply = (body) => {
    const names = (body.tools ?? []).map((t: any) => t.function.name);
    if (turn++ === 0) {
      assert.ok(names.includes('SubmitPlan'));
      assert.ok(!names.includes('Artifact') && !names.includes('Delegate'));
      assert.match(JSON.stringify(body.messages[0]), /# Plan mode/);
      return toolCallChunks('call_plan', 'SubmitPlan', { plan: '1. Outline the post\n2. Write it', steps: ['Outline the post', 'Write it'] });
    }
    return textChunks('Plan ready.');
  };
  const chat = (await call('POST', '/api/chats', {})).data;
  const events = await stream(`/api/chats/${chat.id}/messages`, { content: '/plan a blog post about tea' });
  assert.deepEqual(events.find((e) => e.type === 'plan').plan.steps, ['Outline the post', 'Write it']);
  const approved = (await call('POST', `/api/chats/${chat.id}/plan`, { action: 'approve' })).data;
  assert.equal(approved.mode, 'work');
  assert.deepEqual(approved.todos.map((t: any) => t.content), ['Outline the post', 'Write it']);
  reply = (body) => {
    const system = JSON.stringify(body.messages[0]);
    assert.match(system, /# Work mode[\s\S]*# Approved plan[\s\S]*# Task list/);
    assert.ok(body.tools.some((t: any) => t.function.name === 'TodoWrite'));
    return turn++ === 2 ? toolCallChunks('call_todo', 'TodoWrite', { todos: [{ content: 'Outline the post', status: 'completed' }, { content: 'Write it', status: 'in_progress' }] }) : textChunks('Done.');
  };
  await stream(`/api/chats/${chat.id}/messages`, { content: 'Go ahead with the plan.', auto: 'plan' });
  const saved = (await call('GET', `/api/chats/${chat.id}`)).data;
  assert.equal(saved.todos[0].status, 'completed');
  assert.equal(saved.messages.findLast((m: any) => m.role === 'user').auto, 'plan');
});

test('/goal keeps working until a check says the goal is met; /subgoal adds milestones', async () => {
  let checks = 0;
  let work = 0;
  reply = (body) => {
    const prompt = JSON.stringify(body.messages);
    if (/fully achieved a goal/.test(prompt)) {
      return textChunks(++checks === 1 ? '{"met": false, "done_milestones": ["1"], "reason": "Only the outline exists."}' : '{"met": true, "done_milestones": ["2"], "reason": "The poem is written."}');
    }
    assert.ok(body.tools.some((t: any) => t.function.name === 'Goal'));
    return textChunks(++work === 1 ? 'Outline done.' : 'Poem written.');
  };
  const chat = (await call('POST', '/api/chats', {})).data;
  // Milestones can be set up before the goal starts.
  const sub = (await call('POST', `/api/chats/${chat.id}/command`, { text: '/subgoal Outline' })).data;
  assert.equal(sub.goal.status, 'paused');
  await call('POST', `/api/chats/${chat.id}/command`, { text: '/subgoal Write the poem' });
  await call('POST', `/api/chats/${chat.id}/command`, { text: '/goal clear' });
  const events = await stream(`/api/chats/${chat.id}/messages`, { content: '/goal write a poem about rain' });
  const goals = events.filter((e) => e.type === 'goal').map((e) => e.goal);
  assert.equal(goals.at(-1).status, 'complete');
  assert.equal(goals.at(-1).turns, 2);
  const saved = (await call('GET', `/api/chats/${chat.id}`)).data;
  assert.deepEqual(
    saved.messages.map((m: any) => m.auto ?? m.role),
    ['user', 'assistant', 'goal', 'assistant'],
  );
  assert.equal(saved.messages[0].command, '/goal write a poem about rain');
  assert.equal(saved.goal.lastCheck, 'The poem is written.');
  // Controls.
  assert.match((await call('POST', `/api/chats/${chat.id}/command`, { text: '/goal' })).data.message, /complete/);
  assert.equal((await call('POST', `/api/chats/${chat.id}/command`, { text: '/goal resume' })).status, 400);
  await call('POST', `/api/chats/${chat.id}/command`, { text: '/goal clear' });
  assert.equal((await call('GET', `/api/chats/${chat.id}`)).data.goal, undefined);
});

test('/btw answers a side question without saving it', async () => {
  reply = () => textChunks('Hello again!');
  const chat = (await call('POST', '/api/chats', {})).data;
  await stream(`/api/chats/${chat.id}/messages`, { content: 'Hi' });
  reply = (body) => {
    assert.ok(!body.tools);
    assert.match(JSON.stringify(body.messages.at(-1)), /what did I say/);
    return textChunks('You said hi.');
  };
  const res = await fetch(`${base}/api/chats/${chat.id}/btw`, { method: 'POST', headers: { 'x-mitzi-token': TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ question: 'what did I say?' }) });
  const body = await res.text();
  const answer = body.split('\n\n').filter(Boolean).map((f) => JSON.parse(f.slice(6))).filter((e) => e.type === 'text').map((e) => e.text).join('');
  assert.equal(answer, 'You said hi.');
  assert.equal((await call('GET', `/api/chats/${chat.id}`)).data.messages.length, 2);
});

test('feedback loop: rate, redo with directions until happy, and learn from it', async () => {
  reply = () => textChunks('A formal letter.');
  const chat = (await call('POST', '/api/chats', {})).data;
  await stream(`/api/chats/${chat.id}/messages`, { content: 'Write a note to my neighbor' });
  const review = (await call('POST', `/api/chats/${chat.id}/messages/1/review`, { rating: 2, meant: 'A friendly short note', did: 'A stiff formal letter', directions: 'Keep it casual and under 50 words', redo: true })).data;
  assert.equal(review.loop.iterations.length, 1);
  assert.match(review.redo, /rated it 2\/5[\s\S]*What I meant: A friendly short note[\s\S]*Directions for the redo: Keep it casual/);
  reply = () => textChunks('Hey! Thanks for the cookies 🙂');
  await stream(`/api/chats/${chat.id}/messages`, { content: review.redo, auto: 'redo', feedbackLoopId: review.loop.id });
  let saved = (await call('GET', `/api/chats/${chat.id}`)).data;
  assert.equal(saved.messages[3].feedbackLoopId, review.loop.id);
  reply = (body) => {
    assert.match(JSON.stringify(body.messages), /several attempts[\s\S]*Attempt 1 \(rated 2\/5\)[\s\S]*Attempt 2 \(rated 5\/5\)/);
    return textChunks('When asked for a note to a neighbor, write it casually and briefly.');
  };
  const accepted = (await call('POST', `/api/chats/${chat.id}/messages/3/review`, { rating: 5, wait: true })).data;
  assert.equal(accepted.loop.status, 'accepted');
  const loop = (await call('GET', '/api/feedback')).data.find((l: any) => l.id === review.loop.id);
  assert.equal(loop.lesson, 'When asked for a note to a neighbor, write it casually and briefly.');
  assert.equal(loop.task, 'Write a note to my neighbor');
  const bot = (await call('GET', '/api/bots')).data.find((b: any) => b.id === 'mitzi');
  assert.ok(bot.lessons.some((l: any) => l.text === loop.lesson));
  const curve = (await call('GET', '/api/insights/learning')).data;
  assert.equal(curve.points.at(-1).attempts, 2);
  assert.equal(curve.points.at(-1).firstRating, 2);
  assert.equal(curve.summary.accepted >= 1, true);
  saved = (await call('GET', `/api/chats/${chat.id}`)).data;
  // The redo directions aren't the task.
  assert.equal(saved.messages[2].auto, 'redo');
});

test('workflows: run step by step, branch, run from chats and on a schedule', async () => {
  const pages = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body><h1>Tea news</h1><script>x()</script><p>Green tea is up 5%.</p></body></html>');
  });
  await new Promise<void>((r) => pages.listen(0, '127.0.0.1', r));
  const pageUrl = `http://127.0.0.1:${(pages.address() as AddressInfo).port}/news`;
  try {
    const wf = (await call('POST', '/api/workflows', { template: 'digest' })).data;
    assert.deepEqual(wf.nodes.map((n: any) => n.type), ['trigger', 'browse', 'ai', 'artifact', 'output']);
    reply = (body) => {
      const prompt = JSON.stringify(body.messages);
      assert.match(prompt, /Summarize this page[\s\S]*Green tea is up 5%/);
      assert.doesNotMatch(prompt, /x\(\)/);
      assert.match(prompt, /step \\"Summarize\\" of the workflow/);
      return textChunks('- Green tea prices rose 5%.');
    };
    const res = await fetch(`${base}/api/workflows/${wf.id}/run`, { method: 'POST', headers: { 'x-mitzi-token': TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ input: pageUrl }) });
    const events = (await res.text()).split('\n\n').filter(Boolean).map((f) => JSON.parse(f.slice(6)));
    const finished = events.filter((e) => e.type === 'step' && e.step.status === 'done').map((e) => e.step.nodeId);
    assert.deepEqual(finished, ['start', 'read', 'sum', 'save', 'out']);
    const run = events.at(-1).run;
    assert.equal(run.status, 'done');
    assert.equal(run.output, '- Green tea prices rose 5%.');
    const saved = (await call('GET', '/api/artifacts')).data.find((a: any) => a.title === `Digest: ${pageUrl}`);
    assert.ok(saved, 'the artifact step saved a document');
    assert.equal((await call('GET', `/api/chats/${saved.chatId}`)).status, 200);
    assert.equal((await call('GET', `/api/workflows/${wf.id}`)).data.runs[0].id, run.id);
    assert.ok((await call('GET', '/api/usage')).data.byKind.some((k: any) => k.key === 'workflow'));

    // Conditions pick a branch.
    const triage = (await call('POST', '/api/workflows', { template: 'triage' })).data;
    reply = (body) => textChunks(/URGENT or ROUTINE/.test(JSON.stringify(body.messages)) ? 'ROUTINE' : 'Thanks for your note!');
    const runTriage = async () => {
      const r = await fetch(`${base}/api/workflows/${triage.id}/run`, { method: 'POST', headers: { 'x-mitzi-token': TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ input: 'Lunch next week?' }) });
      return (await r.text()).split('\n\n').filter(Boolean).map((f) => JSON.parse(f.slice(6))).at(-1).run;
    };
    const t = await runTriage();
    assert.deepEqual(t.steps.map((s: any) => s.nodeId), ['start', 'classify', 'if', 'routine', 'out']);
    assert.equal(t.output, 'Thanks for your note!');

    // Loops are refused.
    const loop = await call('PATCH', `/api/workflows/${triage.id}`, { nodes: triage.nodes, edges: [...triage.edges, { from: 'out', to: 'start' }] });
    assert.equal(loop.status, 400);

    // Exposed workflows become a tool bots can call.
    await call('PATCH', `/api/workflows/${triage.id}`, { exposeToChat: true });
    let turn = 0;
    reply = (body) => {
      if (/URGENT or ROUTINE/.test(JSON.stringify(body.messages))) return textChunks('ROUTINE');
      if (/Draft a friendly reply/.test(JSON.stringify(body.messages))) return textChunks('Sure, Tuesday works!');
      const tool = body.tools?.find((x: any) => x.function.name === 'Workflow');
      if (turn++ === 0) {
        assert.ok(tool);
        assert.deepEqual(tool.function.parameters.properties.workflow.enum, ['Message triage']);
        return toolCallChunks('call_wf', 'Workflow', { workflow: 'Message triage', input: 'Lunch next week?' });
      }
      return textChunks('Done.');
    };
    const chat = (await call('POST', '/api/chats', {})).data;
    const chatEvents = await stream(`/api/chats/${chat.id}/messages`, { content: 'Triage this: Lunch next week?' }, (e) => {
      if (e.type === 'permission') void call('POST', `/api/chats/${chat.id}/permission`, { requestId: e.requestId, answer: 'yes' });
    });
    assert.equal(chatEvents.find((e) => e.type === 'tool_result' && e.id === 'call_wf').output, 'Sure, Tuesday works!');

    // A scheduled task can run a workflow.
    const task = (await call('POST', '/api/tasks', { name: 'Daily triage', prompt: 'Lunch next week?', workflowId: triage.id, schedule: { kind: 'daily', time: '09:00' } })).data;
    await call('POST', `/api/tasks/${task.id}/run`);
    let runs: any[] = [];
    for (let i = 0; i < 100 && !runs.some((r) => r.status !== 'running'); i++) {
      await new Promise((r) => setTimeout(r, 30));
      runs = (await call('GET', '/api/tasks')).data.find((x: any) => x.id === task.id).runs;
    }
    assert.equal(runs[0].status, 'ok');
    assert.equal(runs[0].preview, 'Sure, Tuesday works!');
    assert.ok(runs[0].workflowRunId);
    await call('DELETE', `/api/tasks/${task.id}`);
    await call('DELETE', `/api/workflows/${triage.id}`);
    await call('DELETE', `/api/workflows/${wf.id}`);
  } finally {
    pages.close();
  }
});

test('search finds messages, artifacts and memories, and points at the message', async () => {
  reply = () => textChunks('Basil and cherry tomatoes grow well in pots.');
  const chat = (await call('POST', '/api/chats', {})).data;
  await stream(`/api/chats/${chat.id}/messages`, { content: 'What can I grow on my sunny balcony?' });
  reply = () => textChunks('שלום! עגבניות שרי גדלות היטב בעציצים.');
  await stream(`/api/chats/${chat.id}/messages`, { content: 'ואיך מגדלים עגבניות?' });
  await call('POST', '/api/banks/mitzi/memories', { content: 'The user keeps a herb garden on the balcony.' });
  reply = () => toolCallChunks('call_doc', 'Artifact', { command: 'create', type: 'markdown', title: 'Balcony planting calendar', content: '# March\nSow basil indoors.' });
  const other = (await call('POST', '/api/chats', {})).data;
  await stream(`/api/chats/${other.id}/messages`, { content: 'Make a planting calendar' });

  const res = (await call('GET', `/api/search?q=${encodeURIComponent('balcony basil')}`)).data;
  const kinds = res.hits.map((h: any) => h.kind);
  assert.ok(kinds.includes('message') && kinds.includes('artifact') && kinds.includes('memory'), JSON.stringify(kinds));
  const msg = res.hits.find((h: any) => h.kind === 'message' && h.chatId === chat.id);
  assert.ok([0, 1].includes(msg.index));
  const marked = msg.marks.map(([a, b]: [number, number]) => msg.snippet.slice(a, b).toLowerCase());
  assert.ok(marked.some((m: string) => m.startsWith('balcony') || m.startsWith('basil')), JSON.stringify(marked));
  // Messages from one chat are grouped: the best one, plus how many more matched.
  assert.equal(res.hits.filter((h: any) => h.chatId === chat.id && h.kind === 'message').length, 1);
  // Other scripts work too.
  const he = (await call('GET', `/api/search?q=${encodeURIComponent('עגבניות')}`)).data;
  assert.equal(he.hits[0].chatId, chat.id);
  assert.equal(he.hits[0].more, 1);
  // Filters.
  const onlyMemories = (await call('GET', '/api/search?q=balcony&kinds=memory')).data;
  assert.ok(onlyMemories.hits.length && onlyMemories.hits.every((h: any) => h.kind === 'memory'));
  assert.deepEqual((await call('GET', '/api/search?q=')).data.hits, []);
});

test('budgets warn, and the hard stop refuses requests once a limit is reached', async () => {
  reply = () => textChunks('Fine.');
  const chat = (await call('POST', '/api/chats', {})).data;
  await stream(`/api/chats/${chat.id}/messages`, { content: 'Spend a little' });
  // Memory jobs after the answer cost a little too; let them finish.
  await new Promise((r) => setTimeout(r, 500));
  const spent = (await call('GET', '/api/budget')).data.spentMonth;
  assert.ok(spent > 0);

  // 85% of the limit spent: past the 80% alert.
  await call('PUT', '/api/settings', { budget: { monthly: spent / 0.85, alertPercent: 80, hardStop: true } });
  let b = (await call('GET', '/api/budget')).data;
  assert.equal(b.state, 'warn');
  assert.equal(b.limit, 'monthly');

  await call('PUT', '/api/settings', { budget: { monthly: 0.001, daily: 1000, alertPercent: 80, hardStop: false } });
  b = (await call('GET', '/api/budget')).data;
  assert.equal(b.state, 'over');
  // Without the hard stop, an exceeded budget only warns.
  let events = await stream(`/api/chats/${chat.id}/messages`, { content: 'Still allowed' });
  assert.ok(!events.some((e) => e.type === 'error'));

  await call('PUT', '/api/settings', { budget: { monthly: 0.001, alertPercent: 80, hardStop: true } });
  events = await stream(`/api/chats/${chat.id}/messages`, { content: 'Refused' });
  assert.match(events.find((e) => e.type === 'error').message, /monthly budget of \$0\.00[\s\S]*Settings → Usage & budget/);
  await call('PUT', '/api/settings', { budget: { alertPercent: 80, hardStop: false } });
  assert.equal((await call('GET', '/api/budget')).data.state, 'ok');
});

test('Auto routes quick messages to the fast model and in-depth ones to the strong model', async () => {
  reply = () => textChunks('Sure.');
  await call('PUT', '/api/settings', { routing: { fast: 'test/fast', strong: 'test/strong', newChats: true } });
  // New chats start on Auto.
  const chat = (await call('POST', '/api/chats', {})).data;
  assert.equal(chat.model, 'auto');

  let events = await stream(`/api/chats/${chat.id}/messages`, { content: 'hi there' });
  assert.equal(lastMain().model, 'test/fast');
  assert.deepEqual(events.find((e) => e.type === 'route').route, { tier: 'fast', reason: 'Small talk', model: 'test/fast' });
  // The system prompt names the model that's answering, not "auto".
  assert.match(lastMain().messages[0].content, /running as the model test\/fast/);

  events = await stream(`/api/chats/${chat.id}/messages`, { content: 'Analyze the trade-offs between these two database designs' });
  assert.equal(lastMain().model, 'test/strong');
  assert.equal(events.find((e) => e.type === 'route').route.tier, 'strong');
  // A short follow-up to in-depth work stays on the strong model.
  await stream(`/api/chats/${chat.id}/messages`, { content: 'continue' });
  assert.equal(lastMain().model, 'test/strong');
  // Display fields never reach the API.
  assert.ok(!JSON.stringify(lastMain().messages).includes('"route"'));

  const saved = (await call('GET', `/api/chats/${chat.id}`)).data;
  assert.equal(saved.model, 'auto');
  const answers = saved.messages.filter((m: any) => m.role === 'assistant');
  assert.deepEqual(answers.map((m: any) => [m.model, m.route.tier]), [['test/fast', 'fast'], ['test/strong', 'strong'], ['test/strong', 'strong']]);

  const auto = (await call('GET', `/api/usage?chatId=${chat.id}`)).data.auto;
  assert.equal(auto.fast.requests, 1);
  assert.equal(auto.strong.requests, 2);

  // "auto" can't be one of Auto's own models.
  const settings = (await call('PUT', '/api/settings', { routing: { fast: 'auto', strong: '', newChats: false } })).data;
  assert.deepEqual(settings.routing, { fast: '', strong: '', newChats: false });
  assert.equal((await call('POST', '/api/chats', {})).data.model, 'test/model');
});

test('approval levels: a chat keeps its own, and new chats follow Settings', async () => {
  assert.equal((await call('PUT', '/api/settings', { approval: 'housecat' })).data.approval, 'housecat');
  const chat = (await call('POST', '/api/chats', { approval: 'alleycat' })).data;
  assert.equal(chat.approval, 'alleycat');
  assert.equal((await call('PATCH', `/api/chats/${chat.id}`, { approval: 'kitten' })).data.approval, 'kitten');
  // Unknown levels are ignored.
  assert.equal((await call('PATCH', `/api/chats/${chat.id}`, { approval: 'tiger' })).data.approval, 'kitten');
  await call('PUT', '/api/settings', { approval: 'kitten' });
});

test('a running chat keeps going when the browser leaves, and coming back catches up', async () => {
  const words = Array.from({ length: 12 }, (_, i) => `word${i}`);
  // One chunk per word, so the answer takes a while.
  reply = () => [...words.map((w, i) => ({ choices: [{ delta: { content: i ? ` ${w}` : w } }] })), ...textChunks('').slice(1)];
  chunkDelay = 40;
  try {
    const chat = (await call('POST', '/api/chats', {})).data;
    // Start a turn, then drop the connection right away.
    const leaving = new AbortController();
    const started = await fetch(`${base}/api/chats/${chat.id}/messages`, {
      method: 'POST',
      headers: { 'x-mitzi-token': TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'Say twelve words' }),
      signal: leaving.signal,
    });
    assert.equal(started.status, 200);
    await new Promise((r) => setTimeout(r, 150));
    leaving.abort();
    const listed = (await call('GET', '/api/chats')).data.find((c: any) => c.id === chat.id);
    assert.equal(listed.running, true);

    // Coming back: the stream starts with when the run began, replays what was missed, then follows to the end.
    const res = await fetch(`${base}/api/chats/${chat.id}/stream`, { headers: { 'x-mitzi-token': TOKEN } });
    const events = (await res.text())
      .split('\n\n')
      .filter((f) => f.startsWith('data: '))
      .map((f) => JSON.parse(f.slice(6)));
    assert.equal(events[0].type, 'run');
    assert.ok(events[0].startedAt <= Date.now());
    assert.equal(events.filter((e) => e.type === 'text').map((e) => e.text).join(''), words.join(' '));
    assert.equal(events.at(-1).type, 'done');

    const saved = (await call('GET', `/api/chats/${chat.id}`)).data;
    assert.equal(saved.running, false);
    assert.equal(saved.messages.at(-1).content, words.join(' '));
    // Nothing running: the stream just ends.
    const idle = await (await fetch(`${base}/api/chats/${chat.id}/stream`, { headers: { 'x-mitzi-token': TOKEN } })).text();
    assert.match(idle, /"type":"done"/);
  } finally {
    chunkDelay = 0;
  }
});

/** Waits until a chat has stopped responding (queued messages included). */
async function idle(chatId: string) {
  for (let i = 0; i < 400; i++) {
    const c = (await call('GET', `/api/chats/${chatId}`)).data;
    if (!c.running && !c.queue?.length) return c;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('Chat never finished');
}

test('messages sent while the bot works are queued and sent in order; "now" interrupts', async () => {
  const words = Array.from({ length: 10 }, (_, i) => `w${i}`);
  reply = (body) => {
    const last = body.messages.findLast((m: any) => m.role === 'user')?.content;
    if (last !== 'First') return textChunks(`Re: ${last}`);
    return [...words.map((w, i) => ({ choices: [{ delta: { content: i ? ` ${w}` : w } }] })), ...textChunks('').slice(1)];
  };
  chunkDelay = 30;
  try {
    const chat = (await call('POST', '/api/chats', {})).data;
    const first = stream(`/api/chats/${chat.id}/messages`, { content: 'First' });
    await new Promise((r) => setTimeout(r, 80));
    await call('POST', `/api/chats/${chat.id}/queue`, { content: 'Second' });
    const queued = (await call('POST', `/api/chats/${chat.id}/queue`, { content: 'Third' })).data.queue;
    assert.deepEqual(queued.map((q: any) => q.content), ['Second', 'Third']);
    const events = await first;
    // Followers hear about the queue.
    assert.ok(events.some((e) => e.type === 'queue' && e.queue.length === 2));
    const done = await idle(chat.id);
    assert.deepEqual(
      done.messages.map((m: any) => m.content),
      ['First', words.join(' '), 'Second', 'Re: Second', 'Third', 'Re: Third'],
    );

    // Interrupt: the long answer stops early and the new message goes right away.
    const again = stream(`/api/chats/${chat.id}/messages`, { content: 'First' });
    await new Promise((r) => setTimeout(r, 100));
    await call('POST', `/api/chats/${chat.id}/queue`, { content: 'Stop, do this', now: true });
    await again;
    const after = await idle(chat.id);
    const tail = after.messages.slice(6).map((m: any) => m.content);
    assert.equal(tail[0], 'First');
    assert.ok(tail[1].length < words.join(' ').length, 'the first answer was cut short');
    assert.deepEqual(tail.slice(2), ['Stop, do this', 'Re: Stop, do this']);

    // Queued messages can be taken back.
    const third = stream(`/api/chats/${chat.id}/messages`, { content: 'First' });
    await new Promise((r) => setTimeout(r, 80));
    const q = (await call('POST', `/api/chats/${chat.id}/queue`, { content: 'Never mind' })).data.queue;
    assert.deepEqual((await call('DELETE', `/api/chats/${chat.id}/queue/${q[0].id}`)).data.queue, []);
    await third;
    assert.ok(!(await idle(chat.id)).messages.some((m: any) => m.content === 'Never mind'));
  } finally {
    chunkDelay = 0;
  }
});

test('a bot splits work off to subagents that run in parallel and report back', async () => {
  let lead = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  reply = (body) => {
    const system = JSON.stringify(body.messages[0]);
    if (/Working as a subagent/.test(system)) {
      assert.ok(!body.tools?.some((t: any) => t.function.name === 'Subagents'), 'subagents can’t spawn more');
      // A clean context: only its task.
      assert.equal(body.messages.length, 2);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      setTimeout(() => inFlight--, 60);
      return textChunks(`Done: ${body.messages[1].content}`);
    }
    assert.ok(body.tools?.some((t: any) => t.function.name === 'Subagents'));
    return lead++ === 0
      ? toolCallChunks('call_sub', 'Subagents', {
          tasks: [
            { title: 'Cat breeds', task: 'List two cat breeds' },
            { title: 'Cat food', task: 'Name a cat food' },
          ],
        })
      : textChunks('Combined the subagents’ work.');
  };
  chunkDelay = 20;
  try {
    const chat = (await call('POST', '/api/chats', {})).data;
    const events = await stream(`/api/chats/${chat.id}/messages`, { content: 'Research cats' });
    const progress = events.filter((e) => e.type === 'delegate');
    assert.deepEqual([...new Set(progress.map((e) => e.botId))].sort(), ['subagent-1', 'subagent-2']);
    assert.ok(progress.every((e) => e.callId === 'call_sub'));
    assert.equal(maxInFlight, 2, 'both subagents worked at the same time');
    const result = events.find((e) => e.type === 'tool_result' && e.id === 'call_sub');
    assert.equal(result.output, '## Cat breeds\nDone: List two cat breeds\n\n## Cat food\nDone: Name a cat food');
    assert.equal((await call('GET', `/api/chats/${chat.id}`)).data.messages.at(-1).content, 'Combined the subagents’ work.');

    // The capability can be turned off per bot.
    await call('PATCH', '/api/bots/mitzi', { tools: { subagents: false } });
    reply = () => textChunks('Solo.');
    await stream(`/api/chats/${chat.id}/messages`, { content: 'Again' });
    assert.ok(!lastMain().tools?.some((t: any) => t.function.name === 'Subagents'));
    await call('PATCH', '/api/bots/mitzi', { tools: { subagents: true } });
  } finally {
    chunkDelay = 0;
  }
});

test('large project knowledge is searched per message; small knowledge goes in whole', async () => {
  reply = () => textChunks('Noted.');
  const small = (await call('POST', '/api/projects', { name: 'Small' })).data;
  await call('POST', `/api/projects/${small.id}/files`, { name: 'tiny.md', content: 'The office cat is called Pixel.' });
  let chat = (await call('POST', '/api/chats', { projectId: small.id })).data;
  await stream(`/api/chats/${chat.id}/messages`, { content: 'Hi' });
  assert.match(lastMain().messages[0].content, /<document name="tiny.md">\nThe office cat is called Pixel./);
  assert.ok(!lastMain().tools?.some((t: any) => t.function.name === 'ProjectKnowledge'));

  const big = (await call('POST', '/api/projects', { name: 'Big' })).data;
  const filler = Array.from({ length: 120 }, (_, i) => `## Section ${i}\n\n${'Ordinary operational text about warehouses and trucks. '.repeat(12)}`).join('\n\n');
  await call('POST', `/api/projects/${big.id}/files`, { name: 'handbook.md', content: `${filler}\n\n## Zebra protocol\n\nDuring a zebra protocol, all forklifts stop and staff gather at door 7.` });
  const view = (await call('GET', '/api/projects')).data.find((p: any) => p.id === big.id);
  assert.equal(view.knowledge.searched, true);
  chat = (await call('POST', '/api/chats', { projectId: big.id })).data;
  await stream(`/api/chats/${chat.id}/messages`, { content: 'What happens during the zebra protocol?' });
  const system = lastMain().messages[0].content;
  assert.match(system, /<excerpt document="handbook.md" section="Zebra protocol">[\s\S]*door 7/);
  assert.ok(system.length < filler.length / 2, 'only excerpts, not the whole handbook');
  assert.ok(lastMain().tools.some((t: any) => t.function.name === 'ProjectKnowledge'));
});

test('workflow steps: code, for each, wait and approval', async () => {
  reply = (body) => textChunks(`Fact about ${body.messages.at(-1).content.replace(/^Fact: /, '')}`);
  const wf = (await call('POST', '/api/workflows', {})).data;
  const n = (id: string, type: string, config: object = {}) => ({ id, type, label: id, x: 0, y: 0, config });
  const nodes = [
    n('start', 'trigger'),
    n('split', 'code', { language: 'javascript', code: 'return input.split(",").map((s) => s.trim()).join("\\n");' }),
    n('each', 'loop', { split: 'lines', mode: 'ai', prompt: 'Fact: {{item}}', parallel: 2, join: 'lines' }),
    n('pause', 'delay', { seconds: 0 }),
    n('check', 'approval', { message: 'Publish these?\n\n{{input}}' }),
    n('yes', 'transform', { template: 'Published:\n{{input}}' }),
    n('no', 'transform', { template: 'Not published' }),
    n('out', 'output'),
  ];
  const e = (from: string, to: string, port?: string) => ({ from, to, ...(port ? { port } : {}) });
  const edges = [e('start', 'split'), e('split', 'each'), e('each', 'pause'), e('pause', 'check'), e('check', 'yes', 'true'), e('check', 'no', 'false'), e('yes', 'out'), e('no', 'out')];
  assert.equal((await call('PATCH', `/api/workflows/${wf.id}`, { nodes, edges })).status, 200);

  const running = fetch(`${base}/api/workflows/${wf.id}/run`, { method: 'POST', headers: { 'x-mitzi-token': TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ input: 'cats, dogs, owls' }) }).then((r) => r.text());
  // The run pauses at the approval step.
  let waiting: any;
  for (let i = 0; i < 200 && !waiting; i++) {
    waiting = (await call('GET', `/api/workflows/${wf.id}`)).data.runs.find((r: any) => r.status === 'waiting');
    if (!waiting) await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(waiting, 'the run waits for approval');
  const step = waiting.steps.find((s: any) => s.nodeId === 'check');
  assert.equal(step.status, 'waiting');
  assert.equal(step.ask, 'Publish these?\n\nFact about cats\nFact about dogs\nFact about owls');
  assert.equal((await call('POST', `/api/workflows/${wf.id}/runs/nope/decide`, { approved: true })).status, 404);
  await call('POST', `/api/workflows/${wf.id}/runs/${waiting.id}/decide`, { approved: true, note: 'Looks good' });
  await running;
  const run = (await call('GET', `/api/workflows/${wf.id}`)).data.runs[0];
  assert.equal(run.status, 'done');
  assert.equal(run.output, 'Published:\nFact about cats\nFact about dogs\nFact about owls\n\nReviewer’s note: Looks good');
  assert.ok(!run.steps.some((s: any) => s.nodeId === 'no'), 'the rejected branch didn’t run');
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
