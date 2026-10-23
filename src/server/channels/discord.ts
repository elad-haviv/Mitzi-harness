// Discord: a bot application connected to Discord's gateway (a WebSocket, so it works from any computer). It
// answers direct messages, and in server channels once a channel is paired (or when mentioned, to say so).
// Answers stream by editing the reply; approvals and choices are buttons.
import type { Attachment } from '../../shared/types.js';
import type { Button, ChannelAdapter, ChannelHub, Incoming, SendOptions } from './hub.js';

/** Server messages, direct messages, and message text (a privileged intent, turned on in the developer portal). */
const INTENTS = (1 << 9) | (1 << 12) | (1 << 15);

interface DiscordMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: { id: string; username: string; global_name?: string; bot?: boolean };
  content: string;
  mentions?: { id: string }[];
  attachments?: { url: string; filename: string; content_type?: string; size: number }[];
}

interface Interaction {
  id: string;
  token: string;
  type: number;
  channel_id?: string;
  data?: { custom_id?: string };
  message?: { id: string; content: string };
}

/** Buttons in rows of up to five (one per row when labels are long). */
function components(buttons?: Button[]) {
  if (!buttons?.length) return [];
  const perRow = buttons.some((b) => b.label.length > 20) ? 1 : 5;
  const rows = [];
  for (let i = 0; i < buttons.length && rows.length < 5; i += perRow) {
    rows.push({ type: 1, components: buttons.slice(i, i + perRow).map((b, j) => ({ type: 2, style: i + j === 0 ? 1 : 2, label: b.label.slice(0, 80), custom_id: b.data })) });
  }
  return rows;
}

export class DiscordAdapter implements ChannelAdapter {
  readonly kind = 'discord' as const;
  readonly label = 'Discord';
  readonly steps = [
    'Open the [Discord Developer Portal](https://discord.com/developers/applications), choose *New Application*, then *Bot*. Turn on **Message Content Intent**, and copy the bot token (*Reset Token*).',
    'Paste the token below and turn Discord on.',
    'Invite the bot: under *OAuth2 → URL Generator*, tick `bot`, then *Send Messages*, *Read Message History* and *View Channels*, and open the link. Or just send the bot a direct message.',
    'Send the bot the pairing message, in a direct message or in the channel it should answer in.',
  ];
  readonly fields = [{ key: 'token', label: 'Bot token', secret: true, placeholder: 'MTIz…' }];
  readonly maxText = 2000;
  readonly canEdit = true;
  readonly hasButtons = true;
  readonly commandPrefix = '/';
  error?: string;
  private token = '';
  private hub?: ChannelHub;
  private socket?: WebSocket;
  private heartbeat?: NodeJS.Timeout;
  private seq: number | null = null;
  private me?: { id: string; username: string };
  private running = false;
  private reconnectTimer?: NodeJS.Timeout;

  /** `apiBase`: Discord's REST address (tests point it at a fake). */
  constructor(private readonly apiBase = 'https://discord.com/api/v10') {}

  unsupported(): string | undefined {
    return typeof WebSocket === 'undefined' ? 'Discord needs Node.js 22 or newer (for WebSocket). Update Node.js to use it.' : undefined;
  }

  private async api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${this.apiBase}${path}`, {
        method,
        headers: { authorization: `Bot ${this.token}`, 'content-type': 'application/json', 'user-agent': 'DiscordBot (https://github.com/elad-haviv/mitzi-harness, 1)' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 429 && attempt < 2) {
        const wait = Number(((await res.json().catch(() => ({}))) as { retry_after?: number }).retry_after ?? 1);
        await new Promise((r) => setTimeout(r, Math.min(wait, 10) * 1000));
        continue;
      }
      const text = await res.text();
      const data = text ? JSON.parse(text) : {};
      if (!res.ok) throw new Error(res.status === 401 ? 'Discord didn’t accept the token' : (data.message ?? `Discord answered ${res.status}`));
      return data as T;
    }
  }

  async start(config: Record<string, string>, hub: ChannelHub): Promise<{ username?: string }> {
    this.token = config.token ?? '';
    this.hub = hub;
    this.me = await this.api<{ id: string; username: string }>('GET', '/users/@me');
    const { url } = await this.api<{ url: string }>('GET', '/gateway/bot');
    this.running = true;
    this.connect(url);
    return { username: this.me.username };
  }

  stop(): void {
    this.running = false;
    clearInterval(this.heartbeat);
    clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.socket = undefined;
  }

  private connect(url: string): void {
    const socket = new WebSocket(`${url}/?v=10&encoding=json`);
    this.socket = socket;
    const send = (op: number, d: unknown) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ op, d }));
    socket.addEventListener('message', (ev) => {
      let msg: { op: number; d: any; s?: number | null; t?: string };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.s != null) this.seq = msg.s;
      switch (msg.op) {
        case 10: // Hello: start the heartbeat, then identify.
          clearInterval(this.heartbeat);
          this.heartbeat = setInterval(() => send(1, this.seq), msg.d.heartbeat_interval);
          send(2, { token: this.token, intents: INTENTS, properties: { os: process.platform, browser: 'mitzi', device: 'mitzi' } });
          break;
        case 1: // The gateway wants a heartbeat now.
          send(1, this.seq);
          break;
        case 7: // Reconnect
        case 9: // Invalid session
          socket.close();
          break;
        case 0:
          this.error = undefined;
          if (msg.t === 'MESSAGE_CREATE') void this.onMessage(msg.d).catch((err) => console.warn(`Discord: ${err.message}`));
          else if (msg.t === 'INTERACTION_CREATE') void this.onInteraction(msg.d).catch((err) => console.warn(`Discord: ${err.message}`));
          break;
      }
    });
    socket.addEventListener('close', (ev) => {
      clearInterval(this.heartbeat);
      if (!this.running || this.socket !== socket) return;
      // 4004: the token was refused; 4014: an intent isn't allowed (Message Content is off).
      if (ev.code === 4004 || ev.code === 4014) {
        this.error = ev.code === 4004 ? 'Discord didn’t accept the token' : 'Turn on Message Content Intent for the bot in the Discord Developer Portal';
        return;
      }
      this.reconnectTimer = setTimeout(() => this.running && this.connect(url), 3000);
    });
    socket.addEventListener('error', () => {
      this.error = 'Lost the connection to Discord; reconnecting…';
    });
  }

  private async onMessage(m: DiscordMessage): Promise<void> {
    if (m.author.bot || !this.me) return;
    const mentioned = !!m.mentions?.some((u) => u.id === this.me!.id);
    const incoming: Incoming = {
      address: m.channel_id,
      name: m.guild_id ? `#${m.channel_id}` : (m.author.global_name ?? m.author.username),
      text: m.content.replace(new RegExp(`<@!?${this.me.id}>`, 'g'), '').trim(),
      direct: !m.guild_id,
      mentioned,
    };
    if (m.guild_id) {
      // A server channel is named after the channel when it's paired.
      const channel = await this.api<{ name?: string }>('GET', `/channels/${m.channel_id}`).catch(() => ({ name: undefined }));
      if (channel.name) incoming.name = `#${channel.name}`;
    }
    try {
      const attachments: Attachment[] = [];
      for (const a of m.attachments ?? []) {
        const type = a.content_type ?? '';
        if (a.size > 8 * 1024 * 1024) throw new Error('Files over 8 MB can’t be read here');
        const data = Buffer.from(await (await fetch(a.url)).arrayBuffer());
        if (type.startsWith('audio/')) incoming.voice = { data, mimeType: type };
        else if (type.startsWith('image/')) attachments.push({ name: a.filename, kind: 'image', content: `data:${type};base64,${data.toString('base64')}` });
        else {
          if (a.size > 1024 * 1024) throw new Error('Text files over 1 MB can’t be read here');
          const text = data.toString('utf8');
          if (text.includes('\u0000')) throw new Error('Send text files (or paste the text); other files can’t be read here');
          attachments.push({ name: a.filename, kind: 'text', content: text });
        }
      }
      if (attachments.length) incoming.attachments = attachments;
    } catch (err) {
      incoming.problem = (err as Error).message;
    }
    await this.hub!.receive(incoming);
  }

  private async onInteraction(i: Interaction): Promise<void> {
    // 3: a button was pressed.
    if (i.type !== 3 || !i.data?.custom_id) return;
    const note = this.hub!.press(i.data.custom_id);
    const respond = (type: number, data: unknown) => this.api('POST', `/interactions/${i.id}/${i.token}/callback`, { type, data });
    if (note) await respond(7, { content: `${i.message?.content ?? ''}\n\n→ ${note}`.slice(0, this.maxText), components: [] });
    else await respond(4, { content: 'This was already answered.', flags: 64 });
  }

  async send(address: string, text: string, opts: SendOptions = {}): Promise<string | undefined> {
    // Discord shows Markdown as it is.
    const m = await this.api<{ id: string }>('POST', `/channels/${address}/messages`, { content: text, components: components(opts.buttons), allowed_mentions: { parse: [] } });
    return m.id;
  }

  async edit(address: string, id: string, text: string): Promise<void> {
    await this.api('PATCH', `/channels/${address}/messages/${id}`, { content: text });
  }

  async clearButtons(address: string, id: string): Promise<void> {
    await this.api('PATCH', `/channels/${address}/messages/${id}`, { components: [] }).catch(() => {});
  }

  async typing(address: string): Promise<void> {
    await this.api('POST', `/channels/${address}/typing`);
  }
}
