// Telegram: a bot made with @BotFather, long-polling for messages. Answers stream by editing the reply.
import type { Attachment } from '../../shared/types.js';
import { toTelegramHtml } from './format.js';
import type { Button, ChannelAdapter, ChannelHub, Incoming, SendOptions } from './hub.js';

interface TgMessage {
  message_id: number;
  chat: { id: number; type?: string; first_name?: string; title?: string; username?: string };
  from?: { first_name?: string; username?: string };
  text?: string;
  caption?: string;
  voice?: { file_id: string; mime_type?: string };
  audio?: { file_id: string; mime_type?: string };
  photo?: { file_id: string; width: number }[];
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: { id: string; data?: string; message?: TgMessage };
}

const keyboard = (buttons?: Button[]) => (buttons?.length ? { reply_markup: { inline_keyboard: buttons.map((b) => [{ text: b.label.slice(0, 60), callback_data: b.data }]) } } : {});

export class TelegramAdapter implements ChannelAdapter {
  readonly kind = 'telegram' as const;
  readonly label = 'Telegram';
  readonly steps = [
    'In Telegram, open [@BotFather](https://t.me/BotFather), send `/newbot` and pick a name. It gives you a token.',
    'Paste the token below and turn the bot on.',
    'Open your bot in Telegram and send it the pairing message. Only paired chats can use it.',
  ];
  readonly fields = [{ key: 'token', label: 'Bot token', secret: true, placeholder: '123456:ABC-DEF…' }];
  readonly maxText = 4000;
  readonly canEdit = true;
  readonly hasButtons = true;
  readonly commandPrefix = '/';
  error?: string;
  private token = '';
  private running = false;
  private offset = 0;
  private abort?: AbortController;
  private hub?: ChannelHub;

  /** `apiBase`: Telegram's API address (tests point it at a fake). */
  constructor(private readonly apiBase = 'https://api.telegram.org') {}

  async start(config: Record<string, string>, hub: ChannelHub): Promise<{ username?: string }> {
    this.token = config.token ?? '';
    this.hub = hub;
    const me = await this.api<{ username: string }>('getMe');
    this.running = true;
    this.error = undefined;
    void this.loop();
    return { username: me.username };
  }

  stop(): void {
    this.running = false;
    this.abort?.abort();
  }

  private async api<T = any>(method: string, body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    if (!this.token) throw new Error('No bot token');
    const res = await fetch(`${this.apiBase}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(30_000),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
    if (!data.ok) throw new Error(data.description ?? `Telegram answered ${res.status}`);
    return data.result as T;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      this.abort = new AbortController();
      try {
        const updates = await this.api<TgUpdate[]>('getUpdates', { offset: this.offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, AbortSignal.any([this.abort.signal, AbortSignal.timeout(40_000)]));
        for (const u of updates) {
          this.offset = u.update_id + 1;
          // Each message is handled in the background, so a long answer doesn't hold up the others.
          void this.handle(u).catch((err) => console.warn(`Telegram: ${err.message}`));
        }
        this.error = undefined;
      } catch (err) {
        if (!this.running) return;
        this.error = (err as Error).message;
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  private async handle(u: TgUpdate): Promise<void> {
    const hub = this.hub!;
    if (u.callback_query) {
      const note = hub.press(String(u.callback_query.data ?? ''));
      await this.api('answerCallbackQuery', { callback_query_id: u.callback_query.id, text: note || 'This was already answered' }).catch(() => {});
      const m = u.callback_query.message;
      if (note && m) await this.clearButtons(String(m.chat.id), String(m.message_id));
      return;
    }
    const msg = u.message;
    if (!msg) return;
    const incoming: Incoming = {
      address: String(msg.chat.id),
      name: msg.chat.title ?? msg.chat.first_name ?? msg.chat.username ?? String(msg.chat.id),
      text: msg.text ?? msg.caption ?? '',
      direct: !msg.chat.type || msg.chat.type === 'private',
    };
    try {
      const voice = msg.voice ?? msg.audio;
      if (voice) incoming.voice = { data: await this.download(voice.file_id), mimeType: voice.mime_type ?? 'audio/ogg' };
      const attachments: Attachment[] = [];
      if (msg.photo?.length) {
        const best = [...msg.photo].sort((a, b) => b.width - a.width)[0];
        attachments.push({ name: 'photo.jpg', kind: 'image', content: `data:image/jpeg;base64,${(await this.download(best.file_id)).toString('base64')}` });
      }
      if (msg.document) {
        if ((msg.document.file_size ?? 0) > 1024 * 1024) throw new Error('Files over 1 MB can’t be read here');
        const file = (await this.download(msg.document.file_id)).toString('utf8');
        if (file.includes('\u0000')) throw new Error('Send text files (or paste the text); other files can’t be read here');
        attachments.push({ name: msg.document.file_name ?? 'file.txt', kind: 'text', content: file });
      }
      if (attachments.length) incoming.attachments = attachments;
    } catch (err) {
      incoming.problem = (err as Error).message;
    }
    await hub.receive(incoming);
  }

  private async download(fileId: string): Promise<Buffer> {
    const file = await this.api<{ file_path: string }>('getFile', { file_id: fileId });
    const res = await fetch(`${this.apiBase}/file/bot${this.token}/${file.file_path}`);
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }

  async send(address: string, text: string, opts: SendOptions = {}): Promise<string | undefined> {
    const send = (body: string, html: boolean) => this.api<TgMessage>('sendMessage', { chat_id: Number(address), text: body, ...(html ? { parse_mode: 'HTML' } : {}), ...keyboard(opts.buttons) });
    // If Telegram won't take the formatting, the plain text goes.
    const m = opts.markdown ? await send(toTelegramHtml(text), true).catch(() => send(text, false)) : await send(text, false);
    return String(m.message_id);
  }

  async edit(address: string, id: string, text: string, opts: SendOptions = {}): Promise<void> {
    await this.api('editMessageText', { chat_id: Number(address), message_id: Number(id), text: opts.markdown ? toTelegramHtml(text) : text, ...(opts.markdown ? { parse_mode: 'HTML' } : {}) });
  }

  async clearButtons(address: string, id: string): Promise<void> {
    await this.api('editMessageReplyMarkup', { chat_id: Number(address), message_id: Number(id), reply_markup: { inline_keyboard: [] } }).catch(() => {});
  }

  async typing(address: string): Promise<void> {
    await this.api('sendChatAction', { chat_id: Number(address), action: 'typing' });
  }
}
