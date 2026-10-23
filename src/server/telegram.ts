// Chat with Mitzi from Telegram: a bot (made with @BotFather) that long-polls for messages. Each paired Telegram
// chat talks in a Mitzi chat (it shows in the app too); answers stream by editing the reply, approvals are
// buttons, voice notes are transcribed, and workflows can be run and approved.
import { randomInt } from 'node:crypto';
import type { AskQuestion, Attachment, Chat, StreamEvent, TelegramLink, TelegramSettings, Workflow, WorkflowRun } from '../shared/types.js';
import type { MediaService } from './media.js';
import type { ChatRunner } from './runner.js';
import { now, Store } from './store.js';
import type { WorkflowEngine } from './workflows.js';

const MAX_TEXT = 4000;
const EDIT_EVERY_MS = 1500;

export const newPairingCode = () => String(randomInt(100000, 1000000));

export interface TelegramDeps {
  store: Store;
  runner: ChatRunner;
  media: MediaService;
  workflows: WorkflowEngine;
  newChat: (fields: Partial<Chat>) => Chat;
  /** Telegram's API address (tests point it at a fake). */
  apiBase?: string;
}

interface TgMessage {
  message_id: number;
  chat: { id: number; first_name?: string; title?: string; username?: string };
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

/** Splits text into Telegram-sized messages, at paragraph or line breaks where possible. */
export function splitMessage(text: string, max = MAX_TEXT): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.length ? out : [''];
}

/** Markdown to the HTML subset Telegram accepts: bold, italics, code, code blocks, links; headings become bold. */
export function toTelegramHtml(md: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const blocks: string[] = [];
  // Code blocks first, so nothing inside them is formatted.
  let text = md.replace(/```[\w-]*\n?([\s\S]*?)```/g, (_, code: string) => `\u0000${blocks.push(`<pre>${esc(code.replace(/\n$/, ''))}</pre>`) - 1}\u0000`);
  text = esc(text)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, '$1<i>$2</i>')
    .replace(/(^|\W)_([^_\n]+)_(?!\w)/g, '$1<i>$2</i>')
    .replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/^(\s*)[-*]\s+/gm, '$1• ');
  return text.replace(/\u0000(\d+)\u0000/g, (_, i: string) => blocks[Number(i)]);
}

export class TelegramBot {
  private running = false;
  private offset = 0;
  private abort?: AbortController;
  private username?: string;
  private error?: string;
  /** Pending buttons: callback id → what pressing one does (returns the note Telegram shows). */
  private readonly callbacks = new Map<string, (answer: string) => string>();
  /** Questions a bot asked in a Telegram chat, answered by tapping an option or replying. */
  private readonly questions = new Map<number, { mitziChatId: string; requestId: string; questions: AskQuestion[]; answers: (string[] | undefined)[] }>();
  private nextCallback = 1;

  constructor(private readonly deps: TelegramDeps) {
    deps.workflows.approvalListeners.add((w, run, ask) => void this.askApproval(w, run, ask));
  }

  private get settings(): TelegramSettings | undefined {
    return this.deps.store.settings.telegram;
  }

  status(): { running: boolean; username?: string; error?: string } {
    return { running: this.running, username: this.username, error: this.error };
  }

  /** Starts or stops polling to match the settings. */
  async sync(): Promise<void> {
    const s = this.settings;
    const want = !!(s?.enabled && s.token);
    if (this.running) this.stop();
    if (!want) return;
    try {
      const me = await this.api<{ username: string }>('getMe');
      this.username = me.username;
      this.error = undefined;
    } catch (err) {
      this.error = (err as Error).message;
      return;
    }
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
    this.abort?.abort();
  }

  private async api<T = any>(method: string, body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const token = this.settings?.token;
    if (!token) throw new Error('No bot token');
    const res = await fetch(`${this.deps.apiBase ?? 'https://api.telegram.org'}/bot${token}/${method}`, {
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

  private send(chatId: number, text: string, extra: Record<string, unknown> = {}): Promise<TgMessage> {
    return this.api<TgMessage>('sendMessage', { chat_id: chatId, text: text.slice(0, MAX_TEXT) || '…', ...extra });
  }

  private saveLinks(links: TelegramLink[]): void {
    const s = this.settings!;
    this.deps.store.updateSettings({ telegram: { ...s, links } });
  }

  async handle(u: TgUpdate): Promise<void> {
    if (u.callback_query) {
      const [kind, id, answer] = String(u.callback_query.data ?? '').split(':');
      const resolve = kind === 'cb' ? this.callbacks.get(id) : undefined;
      const note = resolve?.(answer ?? '');
      await this.api('answerCallbackQuery', { callback_query_id: u.callback_query.id, text: note || 'This was already answered' }).catch(() => {});
      if (resolve) {
        this.callbacks.delete(id);
        const m = u.callback_query.message;
        if (m) await this.api('editMessageReplyMarkup', { chat_id: m.chat.id, message_id: m.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
      }
      return;
    }
    const msg = u.message;
    if (!msg) return;
    const chatId = msg.chat.id;
    const text = (msg.text ?? msg.caption ?? '').trim();
    const s = this.settings;
    if (!s) return;
    let link = s.links.find((l) => l.chatId === chatId);

    // Pairing: "/start 123456" with the code shown in Mitzi's settings.
    const start = /^\/start(?:@\w+)?\s*(\S*)/.exec(text);
    if (start) {
      if (link) return void (await this.send(chatId, 'You’re already connected. Just write to me. /new starts a new chat, /help lists commands.'));
      if (start[1] && start[1] === s.pairingCode) {
        link = { chatId, name: msg.chat.title ?? msg.chat.first_name ?? msg.chat.username ?? String(chatId), linkedAt: now() };
        this.saveLinks([...s.links, link]);
        // A used code can't pair anyone else.
        this.deps.store.updateSettings({ telegram: { ...this.settings!, pairingCode: newPairingCode() } });
        return void (await this.send(chatId, '🐱 Connected to Mitzi! Write to me here, send voice notes or photos. /help lists commands.'));
      }
      return void (await this.send(chatId, 'To connect, send /start followed by the pairing code from Mitzi → Settings → Telegram.'));
    }
    if (!link) return void (await this.send(chatId, 'This Mitzi is private. Pair it from Mitzi → Settings → Telegram.'));

    const command = /^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/.exec(text);
    if (command) {
      const [, name, args] = command;
      switch (name.toLowerCase()) {
        case 'help':
          return void (await this.send(chatId, 'Write to chat with Mitzi (voice notes and photos work too).\n\n/new: start a new chat\n/stop: stop the current answer\n/workflows: list workflows\n/workflow <name> <input>: run a workflow'));
        case 'new':
          this.saveLinks(this.settings!.links.map((l) => (l.chatId === chatId ? { ...l, mitziChatId: undefined } : l)));
          return void (await this.send(chatId, '✨ New chat. What’s on your mind?'));
        case 'stop':
          if (link.mitziChatId && this.deps.runner.stop(link.mitziChatId)) return void (await this.send(chatId, 'Stopped.'));
          return void (await this.send(chatId, 'Nothing is running.'));
        case 'workflows': {
          const list = this.deps.store.workflows.all();
          return void (await this.send(chatId, list.length ? list.map((w) => `${w.emoji} ${w.name}${w.description ? ` — ${w.description}` : ''}`).join('\n') : 'No workflows yet.'));
        }
        case 'workflow':
          return this.runWorkflow(chatId, args);
      }
    }

    // A reply while a question waits answers it.
    if (text && this.questions.has(chatId)) return this.answerQuestion(chatId, undefined, [text]);

    // The message: text, a transcribed voice note, a photo, or a text file.
    let content = text;
    const attachments: Attachment[] = [];
    try {
      const voice = msg.voice ?? msg.audio;
      if (voice) {
        const audio = await this.download(voice.file_id);
        const transcript = await this.deps.media.transcribe(audio, voice.mime_type ?? 'audio/ogg');
        content = [transcript, content].filter(Boolean).join('\n\n');
        await this.send(chatId, `🎤 ${transcript}`);
      }
      if (msg.photo?.length) {
        const best = [...msg.photo].sort((a, b) => b.width - a.width)[0];
        const image = await this.download(best.file_id);
        attachments.push({ name: 'photo.jpg', kind: 'image', content: `data:image/jpeg;base64,${image.toString('base64')}` });
      }
      if (msg.document) {
        if ((msg.document.file_size ?? 0) > 1024 * 1024) throw new Error('Files over 1 MB can’t be read here');
        const file = (await this.download(msg.document.file_id)).toString('utf8');
        if (file.includes('\u0000')) throw new Error('Send text files (or paste the text); other files can’t be read here');
        attachments.push({ name: msg.document.file_name ?? 'file.txt', kind: 'text', content: file });
      }
    } catch (err) {
      return void (await this.send(chatId, `Couldn’t read that: ${(err as Error).message}`));
    }
    if (!content && !attachments.length) return;
    await this.chat(link, content, attachments);
  }

  private async download(fileId: string): Promise<Buffer> {
    const file = await this.api<{ file_path: string }>('getFile', { file_id: fileId });
    const res = await fetch(`${this.deps.apiBase ?? 'https://api.telegram.org'}/file/bot${this.settings!.token}/${file.file_path}`);
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** Sends a message to the link's Mitzi chat and streams the answer back. */
  private async chat(link: TelegramLink, content: string, attachments: Attachment[]): Promise<void> {
    const { store, runner } = this.deps;
    let chatId = link.mitziChatId && store.chats.get(link.mitziChatId) ? link.mitziChatId : undefined;
    if (!chatId) {
      chatId = store.chats.put(this.deps.newChat({ title: `Telegram: ${link.name}` })).id;
      this.saveLinks(this.settings!.links.map((l) => (l.chatId === link.chatId ? { ...l, mitziChatId: chatId } : l)));
    }
    if (runner.isRunning(chatId)) {
      runner.enqueue(chatId, { content, ...(attachments.length ? { attachments } : {}) });
      return void (await this.send(link.chatId, '⏳ Queued: I’ll answer once I’m done with the last one.'));
    }
    await this.api('sendChatAction', { chat_id: link.chatId, action: 'typing' }).catch(() => {});
    let text = '';
    let reply: TgMessage | undefined;
    let shown = '';
    let lastEdit = 0;
    let status = '';
    const show = async (final = false) => {
      const body = (text.trim() || status || '…').slice(0, MAX_TEXT);
      if (body === shown || (!final && Date.now() - lastEdit < EDIT_EVERY_MS)) return;
      lastEdit = Date.now();
      shown = body;
      if (!reply) reply = await this.send(link.chatId, body);
      else await this.api('editMessageText', { chat_id: link.chatId, message_id: reply.message_id, text: body }).catch(() => {});
    };
    const emit = (e: StreamEvent) => {
      if (e.type === 'text') {
        text += e.text;
        void show();
      } else if (e.type === 'tool_call') {
        status = `🔧 ${e.name}: ${e.summary}`.slice(0, 200);
        if (!text.trim()) void show();
      } else if (e.type === 'permission') {
        const id = String(this.nextCallback++);
        this.callbacks.set(id, (a) => (runner.resolvePermission(chatId!, e.requestId, { kind: a === 'yes' ? 'yes' : 'no' }) ? (a === 'yes' ? 'Allowed' : 'Declined') : ''));
        void this.send(link.chatId, `🐾 May I ${e.tool}?\n${e.summary}${e.why ? `\n(${e.why})` : ''}`, {
          reply_markup: { inline_keyboard: [[{ text: '✅ Allow', callback_data: `cb:${id}:yes` }, { text: '✋ Deny', callback_data: `cb:${id}:no` }]] },
        });
      } else if (e.type === 'question') {
        void this.askQuestions(link.chatId, chatId!, e.requestId, e.questions);
      } else if (e.type === 'question_resolved') {
        if (this.questions.get(link.chatId)?.requestId === e.requestId) this.questions.delete(link.chatId);
      } else if (e.type === 'error') {
        void this.send(link.chatId, `⚠️ ${e.message}`);
      }
    };
    await runner.run(chatId, { kind: 'message', content, attachments }, emit, new AbortController().signal);
    // The whole answer, formatted: the first part replaces the streamed message, the rest follow. If Telegram
    // won't take the formatting, the plain text stays.
    const parts = splitMessage(text);
    text = parts[0];
    await show(true);
    if (reply && parts[0].trim()) {
      await this.api('editMessageText', { chat_id: link.chatId, message_id: reply.message_id, text: toTelegramHtml(parts[0]), parse_mode: 'HTML' }).catch(() => {});
    }
    for (const part of parts.slice(1)) await this.send(link.chatId, toTelegramHtml(part), { parse_mode: 'HTML' }).catch(() => this.send(link.chatId, part));
  }

  private async runWorkflow(chatId: number, args: string): Promise<void> {
    const list = this.deps.store.workflows.all();
    const lower = args.toLowerCase();
    // The longest name that starts the arguments; the rest is the input.
    const w = [...list].sort((a, b) => b.name.length - a.name.length).find((x) => lower.startsWith(x.name.toLowerCase()));
    if (!w) return void (await this.send(chatId, `Which one? ${list.map((x) => x.name).join(', ') || 'There are no workflows yet.'}`));
    if (this.deps.workflows.isRunning(w.id)) return void (await this.send(chatId, `${w.name} is already running.`));
    await this.send(chatId, `${w.emoji} Running ${w.name}…`);
    const run = await this.deps.workflows.run(w, args.slice(w.name.length).trim(), 'chat');
    if (run.status === 'error') return void (await this.send(chatId, `⚠️ ${w.name} failed: ${run.error}`));
    for (const part of splitMessage(run.output || 'Done (no result).')) await this.send(chatId, part);
  }

  /** A bot's questions: one message each, with its options as buttons; a reply answers in the user's own words. */
  private async askQuestions(tgChat: number, mitziChatId: string, requestId: string, questions: AskQuestion[]): Promise<void> {
    const pending = { mitziChatId, requestId, questions, answers: questions.map(() => undefined as string[] | undefined) };
    this.questions.set(tgChat, pending);
    for (const [qi, q] of questions.entries()) {
      const id = String(this.nextCallback++);
      const options = q.options ?? [];
      this.callbacks.set(id, (a) => {
        const label = options[Number(a)]?.label;
        if (!label || this.questions.get(tgChat) !== pending) return '';
        this.answerQuestion(tgChat, qi, [label]);
        return label;
      });
      const lines = [`❓ ${q.question}`, ...options.filter((o) => o.description).map((o) => `• ${o.label}: ${o.description}`)];
      if (qi === questions.length - 1) lines.push('', options.length ? 'Tap an option, or reply in your own words.' : 'Reply with your answer.');
      await this.send(tgChat, lines.join('\n').slice(0, MAX_TEXT), options.length ? { reply_markup: { inline_keyboard: options.map((o, i) => [{ text: o.label, callback_data: `cb:${id}:${i}` }]) } } : {}).catch(() => {});
    }
  }

  /** Records an answer; once every question has one, the bot carries on. */
  private answerQuestion(tgChat: number, index: number | undefined, answer: string[]): void {
    const pending = this.questions.get(tgChat);
    if (!pending) return;
    const i = index ?? pending.answers.findIndex((a) => !a);
    if (i < 0) return;
    pending.answers[i] = answer;
    if (pending.answers.every(Boolean)) {
      this.questions.delete(tgChat);
      this.deps.runner.resolveQuestion(pending.mitziChatId, pending.requestId, pending.answers as string[][]);
    }
  }

  /** A workflow waiting for approval asks the paired chats. */
  private async askApproval(w: Workflow, run: WorkflowRun, ask: string): Promise<void> {
    const s = this.settings;
    if (!this.running || !s?.notify || !s.links.length) return;
    const id = String(this.nextCallback++);
    this.callbacks.set(id, (a) => (this.deps.workflows.decide(run.id, { approved: a === 'yes' }), a === 'yes' ? 'Approved' : 'Rejected'));
    for (const link of s.links) {
      await this.send(link.chatId, `${w.emoji} ${w.name} needs your approval:\n\n${ask}`.slice(0, MAX_TEXT), {
        reply_markup: { inline_keyboard: [[{ text: '✅ Approve', callback_data: `cb:${id}:yes` }, { text: '✋ Reject', callback_data: `cb:${id}:no` }]] },
      }).catch(() => {});
    }
  }

  /** Tells the paired chats something (a scheduled task finished…), when notifications are on. */
  async notify(text: string): Promise<void> {
    const s = this.settings;
    if (!this.running || !s?.notify) return;
    for (const link of s.links) await this.send(link.chatId, text).catch(() => {});
  }
}
