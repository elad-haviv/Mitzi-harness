import assert from 'node:assert/strict';
import { createServer, IncomingMessage, Server } from 'node:http';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fakeWebSocketServer, FakeSocket, tempDir, textChunks, toolCallChunks } from './helpers.js';

process.env.MITZI_HOME = tempDir();
process.env.OPENROUTER_API_KEY = 'test-key';
process.env.CLAUDE_CONFIG_DIR = tempDir();
process.env.MITZI_EMAIL_PLAIN = '1';
process.env.MITZI_EMAIL_POLL_MS = '100';

const TOKEN = 'c'.repeat(48);
let base = '';
let close: () => Promise<void>;
const servers: Server[] = [];
let reply: (body: any) => object[] = () => textChunks('Hello!');

/** Each fake service records the calls Mitzi makes to it. */
interface Call {
  method: string;
  path: string;
  body: any;
  headers: IncomingMessage['headers'];
}

async function fakeApi(handle: (c: Call) => unknown): Promise<{ url: string; calls: Call[] }> {
  const calls: Call[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', async () => {
      let body: any = raw;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        // Form-encoded or text.
      }
      const call = { method: req.method ?? 'GET', path: req.url ?? '/', body, headers: req.headers };
      calls.push(call);
      const out = await handle(call);
      if (Buffer.isBuffer(out)) return res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(out);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out ?? {}));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls };
}

let discord: { url: string; calls: Call[] };
let slack: { url: string; calls: Call[] };
let slackSocket: FakeSocket | undefined;
let slackTs = 1;
let whatsapp: { url: string; calls: Call[] };
let waIds = 1;
let gateway: FakeSocket | undefined;
let discordIds = 100;

before(async () => {
  const model = await fakeApi(() => undefined);
  // The model answers as `reply` says, streamed.
  servers[0].removeAllListeners('request');
  servers[0].on('request', (req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'test/model', name: 'Test', context_length: 100000, supported_parameters: ['tools'] }] }));
      }
      const body = JSON.parse(raw);
      const chunks = body.max_tokens === 60 || /Extract memories|observations|conversation starters/.test(JSON.stringify(body.messages?.[0] ?? '')) ? textChunks('{"facts": []}') : reply(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  process.env.OPENROUTER_BASE_URL = model.url;
  process.env.MITZI_MODEL = 'test/model';

  // Discord: REST, plus a gateway that says hello and gets ready once the bot identifies.
  const ws = await fakeWebSocketServer((socket) => {
    gateway = socket;
    socket.send({ op: 10, d: { heartbeat_interval: 45000 } });
    socket.onMessage = (m) => {
      if (m.op === 2) socket.send({ op: 0, t: 'READY', s: 1, d: { user: { id: 'bot1', username: 'mitzi' } } });
    };
  });
  servers.push(ws.server);
  discord = await fakeApi((c) => {
    if (c.path === '/users/@me') return { id: 'bot1', username: 'mitzi' };
    if (c.path === '/gateway/bot') return { url: ws.url };
    if (/^\/channels\/\d+$/.test(c.path)) return { name: 'general' };
    if (c.method === 'POST' && /\/messages$/.test(c.path)) return { id: String(discordIds++) };
    return {};
  });
  process.env.MITZI_DISCORD_API = discord.url;

  // Slack: the Web API, plus a Socket Mode connection that says hello.
  const slackWs = await fakeWebSocketServer((socket) => {
    slackSocket = socket;
    socket.send({ type: 'hello' });
  });
  servers.push(slackWs.server);
  slack = await fakeApi((c) => {
    const method = c.path.slice(1);
    if (method === 'auth.test') return c.headers.authorization === 'Bearer xoxb-bot' ? { ok: true, user_id: 'UBOT', user: 'mitzi', team: 'Cats Inc' } : { ok: false, error: 'invalid_auth' };
    if (method === 'apps.connections.open') return c.headers.authorization === 'Bearer xapp-app' ? { ok: true, url: slackWs.url } : { ok: false, error: 'invalid_auth' };
    if (method === 'users.info') return { ok: true, user: { real_name: 'Dana Cohen', profile: { display_name: 'dana' } } };
    if (method === 'conversations.info') return { ok: true, channel: { name: 'general' } };
    if (method === 'chat.postMessage') return { ok: true, ts: `1700.${slackTs++}` };
    return { ok: true };
  });
  process.env.MITZI_SLACK_API = slack.url;

  // WhatsApp: the Graph API (the messages themselves come to Mitzi's webhook).
  whatsapp = await fakeApi((c) => {
    if (c.method === 'GET' && c.path.startsWith('/PHONE1?')) return { display_phone_number: '+1 555 0100', verified_name: 'Mitzi Cat' };
    if (c.method === 'GET' && c.path === '/media9') return { url: `${whatsapp.url}/files/media9` };
    if (c.path === '/files/media9') return Buffer.from('notes from a file');
    if (c.method === 'POST') return { messages: [{ id: `wamid.${waIds++}` }] };
    return {};
  });
  process.env.MITZI_WHATSAPP_API = whatsapp.url;

  const { startServer } = await import('../server/index.js');
  const webDir = tempDir();
  writeFileSync(join(webDir, 'manifest.webmanifest'), '{}');
  const server = await startServer({ port: 0, token: TOKEN, dataDir: join(tempDir(), 'data'), webDir });
  base = `http://127.0.0.1:${server.port}`;
  close = server.close;
});

after(async () => {
  await close?.();
  for (const s of servers) s.close();
});

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, { method, headers: { 'x-mitzi-token': TOKEN, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: (await res.json()) as any };
}

async function until(check: () => unknown, what = 'condition'): Promise<void> {
  for (let i = 0; i < 300 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(check(), `timed out waiting for ${what}`);
}

const channel = async (kind: string) => (await call('GET', '/api/channels')).data.find((c: any) => c.kind === kind);

test('Discord: pairing a DM, streamed answers, buttons for questions, server channels kept quiet', { timeout: 30_000 }, async () => {
  const sent = () => discord.calls.filter((c) => c.method === 'POST' && /\/messages$/.test(c.path));
  const say = (content: string, extra: object = {}) =>
    gateway!.send({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: { id: String(discordIds++), channel_id: '555', author: { id: 'u1', username: 'dana', global_name: 'Dana' }, content, ...extra } });

  assert.equal((await call('PUT', '/api/channels/discord', { enabled: true })).status, 400, 'a token comes first');
  const on = (await call('PUT', '/api/channels/discord', { config: { token: 'discord-secret' }, enabled: true })).data;
  assert.equal(on.running, true);
  assert.equal(on.username, 'mitzi');
  assert.ok(!JSON.stringify(on).includes('discord-secret'));
  await until(() => gateway?.received.some((m) => m.op === 2), 'identify');
  const identify = gateway!.received.find((m) => m.op === 2);
  assert.equal(identify.d.token, 'discord-secret');
  assert.equal(identify.d.intents & (1 << 15), 1 << 15, 'asks for message content');
  assert.equal(discord.calls[0].headers.authorization, 'Bot discord-secret');

  // Strangers in a DM are told it's private; in a server channel nothing is said unless Mitzi is mentioned.
  say('hello?');
  await until(() => sent().some((c) => /private/.test(c.body.content)), 'private notice');
  const before = sent().length;
  say('chatting among ourselves', { channel_id: '777', guild_id: 'g1' });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(sent().length, before);

  say(`pair ${on.pairingCode}`);
  await until(() => sent().some((c) => /Connected/.test(c.body.content)), 'paired');
  reply = () => textChunks('**Hi** Dana!');
  say('hi there');
  await until(() => discord.calls.some((c) => c.method === 'PATCH' && c.body?.content === '**Hi** Dana!'), 'answer');
  const link = (await channel('discord')).links[0];
  assert.deepEqual([link.address, link.name], ['555', 'Dana']);
  assert.equal((await call('GET', `/api/chats/${link.mitziChatId}`)).data.title, 'Discord: Dana');

  // A question: options are buttons; pressing one answers and clears them.
  reply = (body) => (body.messages.at(-1).role === 'tool' ? textChunks(`Got: ${body.messages.at(-1).content}`) : toolCallChunks('ask', 'AskUser', { questions: [{ question: 'Tea or coffee?', options: [{ label: 'Tea' }, { label: 'Coffee' }] }] }));
  say('make me a drink');
  await until(() => sent().some((c) => c.body.content.startsWith('❓ Tea or coffee?')), 'question');
  const q = sent().find((c) => c.body.content.startsWith('❓ Tea or coffee?'))!;
  const buttons = q.body.components[0].components;
  assert.deepEqual(buttons.map((b: any) => b.label), ['Tea', 'Coffee']);
  gateway!.send({ op: 0, t: 'INTERACTION_CREATE', s: 3, d: { id: 'i1', token: 'itok', type: 3, channel_id: '555', data: { custom_id: buttons[1].custom_id }, message: { id: '1', content: q.body.content } } });
  await until(() => discord.calls.some((c) => c.path === '/interactions/i1/itok/callback'), 'interaction answered');
  const cb = discord.calls.find((c) => c.path === '/interactions/i1/itok/callback')!;
  assert.equal(cb.body.type, 7);
  assert.deepEqual(cb.body.data.components, []);
  assert.match(cb.body.data.content, /→ Coffee$/);
  await until(() => discord.calls.some((c) => /Tea or coffee\?\n→ Coffee/.test(c.body?.content ?? '')), 'carried on with the answer');

  // Pressing it again says it's already answered.
  gateway!.send({ op: 0, t: 'INTERACTION_CREATE', s: 4, d: { id: 'i2', token: 'itok2', type: 3, data: { custom_id: buttons[0].custom_id }, message: { id: '1', content: '' } } });
  await until(() => discord.calls.some((c) => c.path === '/interactions/i2/itok2/callback'), 'stale press');
  assert.equal(discord.calls.find((c) => c.path === '/interactions/i2/itok2/callback')!.body.data.flags, 64);

  await call('PUT', '/api/channels/discord', { enabled: false });
  assert.equal((await channel('discord')).running, false);
});

test('Slack: Socket Mode events are acknowledged, pairing, mrkdwn answers, approvals as buttons', { timeout: 30_000 }, async () => {
  const posts = () => slack.calls.filter((c) => c.path === '/chat.postMessage');
  let envelope = 1;
  const event = (e: object) => slackSocket!.send({ type: 'events_api', envelope_id: `env${envelope++}`, payload: { event: { type: 'message', channel: 'D1', channel_type: 'im', user: 'U1', ts: `1600.${envelope}`, ...e } } });

  assert.match((await call('PUT', '/api/channels/slack', { config: { appToken: 'nope', botToken: 'xoxb-bot' }, enabled: true })).data.error, /xapp-/);
  const on = (await call('PUT', '/api/channels/slack', { config: { appToken: 'xapp-app', botToken: 'xoxb-bot' }, enabled: true })).data;
  assert.equal(on.running, true);
  assert.equal(on.username, '@mitzi in Cats Inc');
  assert.deepEqual(on.values, { appToken: true, botToken: true });
  await until(() => slackSocket, 'socket');

  event({ text: `pair ${on.pairingCode}` });
  await until(() => posts().some((c) => /Connected/.test(c.body.text)), 'paired');
  assert.ok(slackSocket!.received.some((m) => m.envelope_id === 'env1'), 'acknowledged');
  assert.match(posts().find((c) => /Connected/.test(c.body.text))!.body.text, /!help lists commands/);
  const link = (await channel('slack')).links[0];
  assert.deepEqual([link.address, link.name], ['D1', 'dana']);

  // The same message as a mention too is handled once; the answer ends up in Slack's mrkdwn.
  reply = () => textChunks('**Bold** and [a link](https://example.com)');
  event({ text: 'hello', ts: '1650.1' });
  event({ type: 'app_mention', text: '<@UBOT> hello', ts: '1650.1' });
  await until(() => slack.calls.some((c) => c.path === '/chat.update' && c.body.text === '*Bold* and <https://example.com|a link>'), 'formatted answer');
  const chat = (await call('GET', `/api/chats/${(await channel('slack')).links[0].mitziChatId}`)).data;
  assert.equal(chat.messages.filter((m: any) => m.role === 'user').length, 1);

  // An approval: buttons, and pressing one updates the message without them.
  await call('PATCH', `/api/chats/${chat.id}`, { approval: 'kitten' });
  reply = (body) => (body.messages.at(-1).role === 'tool' ? textChunks('Fetched it.') : toolCallChunks('w1', 'WebFetch', { url: 'http://127.0.0.1:1/x' }));
  event({ text: 'fetch something', ts: '1660.1' });
  await until(() => posts().some((c) => /May I WebFetch/.test(c.body.text)), 'approval');
  const ask = posts().find((c) => /May I WebFetch/.test(c.body.text))!;
  const [allow] = ask.body.blocks[1].elements;
  assert.equal(allow.text.text, '✅ Allow');
  const ts = `1700.${slackTs - 1}`;
  slackSocket!.send({ type: 'interactive', envelope_id: 'act1', payload: { type: 'block_actions', actions: [{ value: allow.value }], channel: { id: 'D1' }, message: { ts, text: ask.body.text } } });
  await until(() => slack.calls.some((c) => c.path === '/chat.update' && /→ Allowed/.test(c.body.blocks?.[0]?.text?.text ?? '')), 'buttons cleared');
  await until(() => slack.calls.some((c) => c.path === '/chat.update' && c.body.text === 'Fetched it.'), 'carried on');

  await call('PUT', '/api/channels/slack', { enabled: false });
});

test('WhatsApp: verified, signed webhooks; pairing; whole answers; buttons and lists', { timeout: 30_000 }, async () => {
  const sentTo = () => whatsapp.calls.filter((c) => c.method === 'POST' && c.path === '/PHONE1/messages').map((c) => c.body);
  const hook = (body: object, secret = 'app-secret') => {
    const raw = JSON.stringify(body);
    return fetch(`${base}/hooks/channels/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}` }, body: raw });
  };
  let id = 1;
  const message = (m: object) => hook({ entry: [{ changes: [{ value: { contacts: [{ wa_id: '972500000001', profile: { name: 'Dana' } }], messages: [{ from: '972500000001', id: `wamid.in${id++}`, ...m }] } }] }] });

  assert.equal((await fetch(`${base}/hooks/channels/whatsapp`)).status, 404, 'off until turned on');
  const on = (await call('PUT', '/api/channels/whatsapp', { config: { phoneNumberId: 'PHONE1', accessToken: 'wa-token', appSecret: 'app-secret', verifyToken: 'purr' }, enabled: true })).data;
  assert.equal(on.running, true);
  assert.equal(on.username, 'Mitzi Cat · +1 555 0100');
  assert.equal(on.webhookPath, '/hooks/channels/whatsapp');
  assert.equal(on.values.verifyToken, 'purr');
  assert.equal(on.values.accessToken, true);

  // Meta's address check, and only signed posts get in.
  const verify = await fetch(`${base}/hooks/channels/whatsapp?hub.mode=subscribe&hub.verify_token=purr&hub.challenge=12345`);
  assert.equal(await verify.text(), '12345');
  assert.equal((await fetch(`${base}/hooks/channels/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1`)).status, 403);
  assert.equal((await hook({ entry: [] }, 'wrong-secret')).status, 401);

  assert.equal((await message({ type: 'text', text: { body: `pair ${on.pairingCode}` } })).status, 200);
  await until(() => sentTo().some((b) => /Connected/.test(b.text?.body ?? '')), 'paired');
  assert.equal(sentTo()[0].to, '972500000001');
  assert.equal(whatsapp.calls.find((c) => c.method === 'POST')!.headers.authorization, 'Bearer wa-token');

  // The answer comes whole, in WhatsApp's formatting; a retried delivery is handled once.
  reply = () => textChunks('**Purr**fect. Read [this](https://example.com).');
  const retry = { type: 'text', text: { body: 'hi' } };
  await hook({ entry: [{ changes: [{ value: { messages: [{ from: '972500000001', id: 'wamid.same', ...retry }] } }] }] });
  await hook({ entry: [{ changes: [{ value: { messages: [{ from: '972500000001', id: 'wamid.same', ...retry }] } }] }] });
  await until(() => sentTo().some((b) => b.text?.body === '*Purr*fect. Read this (https://example.com).'), 'answer');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(sentTo().filter((b) => /Purr/.test(b.text?.body ?? '')).length, 1);

  // Three short choices are buttons; tapping one answers. A file comes through as an attachment.
  reply = (body) => (body.messages.at(-1).role === 'tool' ? textChunks(`Got: ${body.messages.at(-1).content}`) : toolCallChunks('q', 'AskUser', { questions: [{ question: 'Size?', options: [{ label: 'S' }, { label: 'M' }, { label: 'L' }] }] }));
  await message({ type: 'document', document: { id: 'media9', filename: 'notes.txt', mime_type: 'text/plain' } });
  await until(() => sentTo().some((b) => b.type === 'interactive'), 'question');
  const q = sentTo().find((b) => b.type === 'interactive')!;
  assert.equal(q.interactive.type, 'button');
  assert.deepEqual(q.interactive.action.buttons.map((b: any) => b.reply.title), ['S', 'M', 'L']);
  await message({ type: 'interactive', interactive: { button_reply: { id: q.interactive.action.buttons[2].reply.id, title: 'L' } } });
  await until(() => sentTo().some((b) => /Size\?\n→ L/.test(b.text?.body ?? '')), 'carried on');
  const chat = (await call('GET', `/api/chats/${(await channel('whatsapp')).links[0].mitziChatId}`)).data;
  assert.match(JSON.stringify(chat.messages), /notes from a file/);

  // Many choices go in a list.
  reply = (body) => (body.messages.at(-1).role === 'tool' ? textChunks('ok') : toolCallChunks('q2', 'AskUser', { questions: [{ question: 'Which day?', options: ['Monday', 'Tuesday', 'Wednesday', 'Thursday'].map((label) => ({ label })) }] }));
  await message({ type: 'text', text: { body: 'book something' } });
  await until(() => sentTo().filter((b) => b.type === 'interactive').length === 2, 'list');
  const list = sentTo().filter((b) => b.type === 'interactive')[1];
  assert.equal(list.interactive.type, 'list');
  assert.equal(list.interactive.action.sections[0].rows.length, 4);
  // A typed number answers too.
  await message({ type: 'text', text: { body: '2' } });
  await until(() => chat && sentTo().at(-1)?.text?.body === 'ok', 'answered by number');

  await call('PUT', '/api/channels/whatsapp', { enabled: false });
});

/** A fake mail server: an IMAP inbox and an SMTP outbox. */
async function fakeMail() {
  const inbox: { uid: number; raw: string; seen: boolean }[] = [];
  const outbox: string[] = [];
  let nextUid = 1;
  const imap = createTcpServer((sock) => {
    sock.write('* OK fake IMAP ready\r\n');
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const [tag, ...rest] = line.split(' ');
        const cmd = rest.join(' ');
        if (/^LOGIN/i.test(cmd)) sock.write(cmd === 'LOGIN "mitzi@test.dev" "mail-pass"' ? `${tag} OK logged in\r\n` : `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
        else if (/^SELECT/i.test(cmd)) sock.write(`* ${inbox.length} EXISTS\r\n* OK [UIDNEXT ${nextUid}] next\r\n${tag} OK [READ-WRITE] done\r\n`);
        else if (/^UID SEARCH/i.test(cmd)) {
          const from = Number(/UID (\d+):\*/.exec(cmd)?.[1] ?? 1);
          sock.write(`* SEARCH ${inbox.filter((m) => !m.seen && m.uid >= from).map((m) => m.uid).join(' ')}\r\n${tag} OK done\r\n`);
        } else if (/^UID FETCH/i.test(cmd)) {
          const uid = Number(cmd.split(' ')[2]);
          const m = inbox.find((x) => x.uid === uid)!;
          const headerOnly = /HEADER\.FIELDS/.test(cmd);
          const data = headerOnly ? `${m.raw.split('\r\n\r\n')[0].split('\r\n').filter((l) => /^(From|Subject):/i.test(l)).join('\r\n')}\r\n\r\n` : m.raw;
          const len = Buffer.byteLength(data);
          sock.write(`* ${uid} FETCH (UID ${uid} BODY[${headerOnly ? 'HEADER.FIELDS (FROM SUBJECT)' : ''}] {${len}}\r\n${data})\r\n${tag} OK done\r\n`);
        } else if (/^UID STORE/i.test(cmd)) {
          inbox.find((x) => x.uid === Number(cmd.split(' ')[2]))!.seen = true;
          sock.write(`${tag} OK done\r\n`);
        } else if (/^LOGOUT/i.test(cmd)) sock.end(`* BYE\r\n${tag} OK bye\r\n`);
        else sock.write(`${tag} BAD unknown\r\n`);
      }
    });
    sock.on('error', () => {});
  });
  const smtp = createTcpServer((sock) => {
    sock.write('220 fake SMTP\r\n');
    let buf = '';
    let data: string | undefined;
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (data !== undefined) {
          if (line === '.') {
            outbox.push(data);
            data = undefined;
            sock.write('250 queued\r\n');
          } else data += `${line}\r\n`;
        } else if (/^EHLO/i.test(line)) sock.write('250-fake\r\n250 AUTH PLAIN\r\n');
        else if (/^AUTH PLAIN/i.test(line)) sock.write(Buffer.from(line.slice(11), 'base64').toString() === '\0mitzi@test.dev\0mail-pass' ? '235 ok\r\n' : '535 no\r\n');
        else if (/^(MAIL|RCPT)/i.test(line)) sock.write('250 ok\r\n');
        else if (/^DATA/i.test(line)) {
          data = '';
          sock.write('354 go\r\n');
        } else if (/^QUIT/i.test(line)) sock.end('221 bye\r\n');
      }
    });
    sock.on('error', () => {});
  });
  for (const s of [imap, smtp]) {
    servers.push(s as unknown as Server);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  }
  const deliver = (from: string, subject: string, body: string, extra = '') => {
    inbox.push({ uid: nextUid++, seen: false, raw: `From: ${from}\r\nTo: mitzi@test.dev\r\nSubject: ${subject}\r\nMessage-ID: <m${nextUid}@mail.test>\r\n${extra}\r\n${body}` });
  };
  return { imapPort: (imap.address() as AddressInfo).port, smtpPort: (smtp.address() as AddressInfo).port, inbox, outbox, deliver };
}

/** A sent message's headers and its (base64) text. */
const readMail = (raw: string) => {
  const [head, body] = raw.split('\r\n\r\n');
  return { head, text: Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf8') };
};

test('Email: reads only new mail from paired addresses, answers in the thread, choices by number', { timeout: 30_000 }, async () => {
  const mail = await fakeMail();
  // Mail from before Mitzi starts is left alone, even a pairing code.
  mail.deliver('Dana <dana@home.test>', 'pair 000000', 'old');
  const config = { address: 'mitzi@test.dev', password: 'wrong', imapHost: '127.0.0.1', imapPort: String(mail.imapPort), smtpHost: '127.0.0.1', smtpPort: String(mail.smtpPort) };
  assert.match((await call('PUT', '/api/channels/email', { config, enabled: true })).data.error, /Couldn’t sign in to 127.0.0.1: \[AUTHENTICATIONFAILED\] Invalid credentials/);
  const on = (await call('PUT', '/api/channels/email', { config: { password: 'mail-pass' }, enabled: true })).data;
  assert.equal(on.running, true);
  assert.equal(on.username, 'mitzi@test.dev');

  // A stranger's mail stays unread and unanswered.
  mail.deliver('Spammer <spam@bad.test>', 'Buy now', 'Cheap stuff');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(mail.outbox.length, 0);
  assert.ok(mail.inbox.every((m) => !m.seen));

  mail.deliver('"Dana Cohen" <Dana@Home.test>', `pair ${on.pairingCode}`, 'Hi Mitzi\r\n\r\n-- \r\nDana');
  await until(() => mail.outbox.length === 1, 'pairing reply');
  const paired = readMail(mail.outbox[0]);
  assert.match(paired.text, /Connected to Mitzi/);
  assert.match(paired.head, new RegExp(`Subject: Re: pair ${on.pairingCode}`));
  assert.match(paired.head, /In-Reply-To: <m\d+@mail.test>/);
  assert.equal(mail.inbox.at(-1)!.seen, true);
  assert.deepEqual((await channel('email')).links.map((l: any) => [l.address, l.name]), [['dana@home.test', 'Dana Cohen']]);

  // Quoted text and signatures don't reach the model; the answer is plain text.
  let asked = '';
  reply = (body) => {
    asked = JSON.stringify(body.messages.at(-1).content);
    return textChunks('**Four.** See [the docs](https://example.com).');
  };
  mail.deliver('Dana <dana@home.test>', 'Re: Mitzi', 'What is 2+2?\r\n\r\nOn Mon, 1 Jan 2026, Mitzi wrote:\r\n> earlier answer\r\n', 'Content-Type: text/plain; charset=utf-8\r\n');
  await until(() => mail.outbox.length === 2, 'answer');
  assert.equal(JSON.parse(asked), 'What is 2+2?');
  assert.equal(readMail(mail.outbox[1]).text, 'Four. See the docs (https://example.com).');

  // Choices are numbered; a reply with a number picks one.
  reply = (body) => (body.messages.at(-1).role === 'tool' ? textChunks(`Booked: ${body.messages.at(-1).content}`) : toolCallChunks('q', 'AskUser', { questions: [{ question: 'Which day?', options: [{ label: 'Monday' }, { label: 'Tuesday', description: 'busier' }] }] }));
  mail.deliver('Dana <dana@home.test>', 'Book a table', 'Please book a table');
  await until(() => mail.outbox.some((m) => /Which day\?/.test(readMail(m).text)), 'question');
  assert.match(readMail(mail.outbox.at(-1)!).text, /1\. Monday\n2\. Tuesday — busier\n\nReply with a number, or in your own words\./);
  // A multipart reply (quoted-printable) answers it.
  mail.deliver('Dana <dana@home.test>', 'Re: Book a table', '--b1\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n2\r\n--b1\r\nContent-Type: text/html\r\n\r\n<p>2</p>\r\n--b1--\r\n', 'MIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary="b1"\r\n');
  await until(() => mail.outbox.some((m) => /Booked: Which day\?\n→ Tuesday/.test(readMail(m).text)), 'booked');

  // Out-of-office replies aren't answered.
  const sent = mail.outbox.length;
  mail.deliver('Dana <dana@home.test>', 'Automatic reply', 'I am away', 'Auto-Submitted: auto-replied\r\n');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(mail.outbox.length, sent);

  await call('PUT', '/api/channels/email', { enabled: false });
});

test('mail parsing: encoded headers and bodies, HTML-only mail, attachments, quoted replies', async () => {
  const { parseMail, replyText, buildMessage } = await import('../server/channels/mail.js');
  const raw = Buffer.from(
    [
      'From: =?UTF-8?B?157XmdeY16bXmQ==?= <cat@example.com>',
      'Subject: =?utf-8?Q?Caf=C3=A9_plans?=',
      'Content-Type: multipart/mixed; boundary=outer',
      '',
      '--outer',
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('<p>Shall we meet at <b>noon</b>?</p><blockquote>old stuff</blockquote>').toString('base64'),
      '--outer',
      'Content-Type: image/png; name="map.png"',
      'Content-Transfer-Encoding: base64',
      'Content-Disposition: attachment; filename="map.png"',
      '',
      Buffer.from('PNGDATA').toString('base64'),
      '--outer--',
      '',
    ].join('\r\n'),
  );
  const m = parseMail(raw);
  assert.deepEqual(m.from, { address: 'cat@example.com', name: 'מיטצי' });
  assert.equal(m.subject, 'Café plans');
  assert.equal(m.text, 'Shall we meet at noon?');
  assert.deepEqual(m.files.map((f) => [f.name, f.type, f.data.toString()]), [['map.png', 'image/png', 'PNGDATA']]);
  assert.equal(replyText('Sure!\n\n-----Original Message-----\nFrom: x'), 'Sure!');
  assert.equal(replyText('Yes\n> quoted\nthanks'), 'Yes\nthanks');
  const built = buildMessage({ from: 'mitzi@x.dev', to: 'a@b.c', subject: 'שלום', text: 'hi', inReplyTo: '<1@x>' }, 'x.dev');
  assert.match(built.data, /Subject: =\?UTF-8\?B\?/);
  assert.match(built.data, /In-Reply-To: <1@x>\r\nReferences: <1@x>/);
  assert.match(built.id, /@x\.dev>$/);
});
