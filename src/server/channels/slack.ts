// Slack: an app in Socket Mode (a WebSocket Mitzi opens, so it works from any computer without a public address).
// It answers direct messages, and in channels once a channel is paired (mention @Mitzi there to pair it).
// Answers stream by updating the reply; approvals and choices are buttons.
import type { Attachment } from '../../shared/types.js';
import { toSlackMrkdwn } from './format.js';
import type { Button, ChannelAdapter, ChannelHub, Incoming, SendOptions } from './hub.js';

interface SlackFile {
  name?: string;
  mimetype?: string;
  size?: number;
  url_private?: string;
}

interface SlackEvent {
  type: string;
  subtype?: string;
  channel: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  files?: SlackFile[];
}

/** Slack's section blocks hold up to 3000 characters. */
const MAX = 3000;

const blocks = (text: string, buttons?: Button[]) => [
  { type: 'section', text: { type: 'mrkdwn', text: text.slice(0, MAX) || ' ' } },
  ...(buttons?.length
    ? [{ type: 'actions', elements: buttons.slice(0, 25).map((b, i) => ({ type: 'button', text: { type: 'plain_text', text: b.label.slice(0, 75) }, action_id: `mitzi_${i}`, value: b.data, ...(i === 0 ? { style: 'primary' } : {}) })) }]
    : []),
];

export class SlackAdapter implements ChannelAdapter {
  readonly kind = 'slack' as const;
  readonly label = 'Slack';
  readonly steps = [
    'At [api.slack.com/apps](https://api.slack.com/apps), choose *Create New App → From scratch* and pick your workspace.',
    'Under *Socket Mode*, turn it on and make an app-level token with the `connections:write` scope (it starts with `xapp-`).',
    'Under *OAuth & Permissions*, add the bot scopes `chat:write`, `im:history`, `channels:history`, `groups:history`, `app_mentions:read`, `users:read` and `files:read`, then *Install to Workspace* and copy the bot token (it starts with `xoxb-`).',
    'Under *Event Subscriptions*, turn events on and subscribe to the bot events `message.im`, `message.channels`, `message.groups` and `app_mention`. Under *App Home*, allow users to send messages in the Messages tab.',
    'Paste both tokens below and turn Slack on, then send Mitzi the pairing message (in a DM, or mention @Mitzi in a channel).',
  ];
  readonly fields = [
    { key: 'appToken', label: 'App-level token', secret: true, placeholder: 'xapp-…' },
    { key: 'botToken', label: 'Bot token', secret: true, placeholder: 'xoxb-…' },
  ];
  readonly maxText = MAX;
  readonly canEdit = true;
  readonly hasButtons = true;
  // Slack takes messages starting with "/" as its own commands.
  readonly commandPrefix = '!';
  error?: string;
  private config: Record<string, string> = {};
  private hub?: ChannelHub;
  private socket?: WebSocket;
  private running = false;
  private me?: { userId: string; name: string };
  private reconnectTimer?: NodeJS.Timeout;
  /** Messages already handled (a mention comes both as a message and as a mention). */
  private readonly seen = new Set<string>();
  /** The text of messages with buttons, to put back without them. */
  private readonly withButtons = new Map<string, string>();
  private readonly names = new Map<string, string>();

  /** `apiBase`: Slack's Web API address (tests point it at a fake). */
  constructor(private readonly apiBase = 'https://slack.com/api') {}

  unsupported(): string | undefined {
    return typeof WebSocket === 'undefined' ? 'Slack needs Node.js 22 or newer (for WebSocket). Update Node.js to use it.' : undefined;
  }

  private async api<T = any>(method: string, body: Record<string, unknown> = {}, token = this.config.botToken): Promise<T> {
    const res = await fetch(`${this.apiBase}/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string } & T;
    if (!data.ok) throw new Error(data.error === 'invalid_auth' || data.error === 'not_authed' ? 'Slack didn’t accept the token' : `Slack: ${data.error ?? res.status}`);
    return data;
  }

  async start(config: Record<string, string>, hub: ChannelHub): Promise<{ username?: string }> {
    this.config = config;
    this.hub = hub;
    if (!config.appToken?.startsWith('xapp-')) throw new Error('The app-level token starts with xapp-');
    if (!config.botToken?.startsWith('xoxb-')) throw new Error('The bot token starts with xoxb-');
    const auth = await this.api<{ user_id: string; user: string; team?: string }>('auth.test');
    this.me = { userId: auth.user_id, name: auth.user };
    this.running = true;
    await this.connect();
    return { username: `@${auth.user}${auth.team ? ` in ${auth.team}` : ''}` };
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.socket = undefined;
  }

  private async connect(): Promise<void> {
    const { url } = await this.api<{ url: string }>('apps.connections.open', {}, this.config.appToken);
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.addEventListener('message', (ev) => {
      let msg: { type: string; envelope_id?: string; payload?: any };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      // Every envelope is acknowledged, or Slack sends it again.
      if (msg.envelope_id) socket.send(JSON.stringify({ envelope_id: msg.envelope_id }));
      if (msg.type === 'hello') this.error = undefined;
      else if (msg.type === 'disconnect') socket.close();
      else if (msg.type === 'events_api') void this.onEvent(msg.payload?.event).catch((err) => console.warn(`Slack: ${err.message}`));
      else if (msg.type === 'interactive') void this.onAction(msg.payload).catch((err) => console.warn(`Slack: ${err.message}`));
    });
    socket.addEventListener('close', () => {
      if (!this.running || this.socket !== socket) return;
      this.reconnectTimer = setTimeout(() => this.running && this.connect().catch((err) => (this.error = (err as Error).message)), 2000);
    });
    socket.addEventListener('error', () => {
      this.error = 'Lost the connection to Slack; reconnecting…';
    });
  }

  private async nameOf(user: string): Promise<string> {
    if (!this.names.has(user)) {
      const info = await this.api<{ user: { real_name?: string; name?: string; profile?: { display_name?: string } } }>('users.info', { user }).catch(() => undefined);
      this.names.set(user, info?.user.profile?.display_name || info?.user.real_name || info?.user.name || user);
    }
    return this.names.get(user)!;
  }

  private async onEvent(e?: SlackEvent): Promise<void> {
    if (!e || (e.type !== 'message' && e.type !== 'app_mention') || e.bot_id || !e.user || e.user === this.me?.userId) return;
    // Edits, joins and the like aren't messages to answer.
    if (e.subtype && e.subtype !== 'file_share') return;
    const key = `${e.channel}:${e.ts}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value!);
    const direct = e.channel_type === 'im';
    const mentioned = e.type === 'app_mention' || (!!this.me && (e.text ?? '').includes(`<@${this.me.userId}>`));
    const incoming: Incoming = {
      address: e.channel,
      name: direct ? await this.nameOf(e.user) : `#${(await this.api<{ channel: { name?: string } }>('conversations.info', { channel: e.channel }).catch(() => undefined))?.channel.name ?? e.channel}`,
      text: (e.text ?? '').replace(/<@[A-Z0-9]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim(),
      direct,
      mentioned,
    };
    try {
      const attachments: Attachment[] = [];
      for (const f of e.files ?? []) {
        if (!f.url_private) continue;
        if ((f.size ?? 0) > 8 * 1024 * 1024) throw new Error('Files over 8 MB can’t be read here');
        const res = await fetch(f.url_private, { headers: { authorization: `Bearer ${this.config.botToken}` } });
        if (!res.ok) throw new Error(`download failed (${res.status}); the app needs the files:read scope`);
        const data = Buffer.from(await res.arrayBuffer());
        const type = f.mimetype ?? '';
        if (type.startsWith('audio/') || type.startsWith('video/webm')) incoming.voice = { data, mimeType: type };
        else if (type.startsWith('image/')) attachments.push({ name: f.name ?? 'image', kind: 'image', content: `data:${type};base64,${data.toString('base64')}` });
        else {
          const text = data.toString('utf8');
          if (text.includes('\u0000') || data.length > 1024 * 1024) throw new Error('Send text files up to 1 MB (or paste the text); other files can’t be read here');
          attachments.push({ name: f.name ?? 'file.txt', kind: 'text', content: text });
        }
      }
      if (attachments.length) incoming.attachments = attachments;
    } catch (err) {
      incoming.problem = (err as Error).message;
    }
    await this.hub!.receive(incoming);
  }

  private async onAction(p: any): Promise<void> {
    if (p?.type !== 'block_actions') return;
    const action = p.actions?.[0];
    const channel = p.channel?.id ?? p.container?.channel_id;
    const ts = p.message?.ts ?? p.container?.message_ts;
    if (!action?.value) return;
    const note = this.hub!.press(String(action.value));
    if (!channel || !ts) return;
    const text = this.withButtons.get(ts) ?? p.message?.text ?? '';
    this.withButtons.delete(ts);
    await this.api('chat.update', { channel, ts, text, blocks: blocks(`${text}\n\n→ ${note || 'This was already answered'}`) }).catch(() => {});
  }

  async send(address: string, text: string, opts: SendOptions = {}): Promise<string | undefined> {
    const body = opts.markdown ? toSlackMrkdwn(text) : text;
    const m = await this.api<{ ts: string }>('chat.postMessage', { channel: address, text: body.slice(0, MAX), blocks: blocks(body, opts.buttons), unfurl_links: false });
    if (opts.buttons?.length) this.withButtons.set(m.ts, body);
    return m.ts;
  }

  async edit(address: string, id: string, text: string, opts: SendOptions = {}): Promise<void> {
    const body = opts.markdown ? toSlackMrkdwn(text) : text;
    await this.api('chat.update', { channel: address, ts: id, text: body.slice(0, MAX), blocks: blocks(body) });
  }

  async clearButtons(address: string, id: string): Promise<void> {
    const text = this.withButtons.get(id);
    if (text === undefined) return;
    this.withButtons.delete(id);
    await this.api('chat.update', { channel: address, ts: id, text, blocks: blocks(text) }).catch(() => {});
  }
}
