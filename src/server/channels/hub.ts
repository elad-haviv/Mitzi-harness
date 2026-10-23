// What every messaging service shares: pairing conversations with a one-time code, commands, chatting in a Mitzi
// chat (streamed by editing the reply where the service allows it), approvals and questions (buttons where the
// service has them, numbered replies everywhere), workflows, and notifications. Each service only moves messages.
import { randomInt } from 'node:crypto';
import type { AskQuestion, Attachment, Chat, ChannelField, ChannelKind, ChannelLink, ChannelSettings, ChannelView, StreamEvent, Workflow, WorkflowRun } from '../../shared/types.js';
import type { MediaService } from '../media.js';
import type { ChatRunner } from '../runner.js';
import { now, Store } from '../store.js';
import type { WorkflowEngine } from '../workflows.js';
import { splitMessage } from './format.js';

export const newPairingCode = () => String(randomInt(100000, 1000000));

const EDIT_EVERY_MS = 1500;

export interface Button {
  label: string;
  /** Handed back to ChannelHub.press when the button is pressed. */
  data: string;
}

export interface SendOptions {
  /** The text is Markdown, for the service to format (with plain text as the fallback). */
  markdown?: boolean;
  /** One button per row. */
  buttons?: Button[];
}

/** A message that arrived on a service. */
export interface Incoming {
  /** The conversation it came from. */
  address: string;
  /** Who sent it (or the conversation's name), for the link. */
  name: string;
  text: string;
  attachments?: Attachment[];
  /** A voice note to transcribe. */
  voice?: { data: Buffer; mimeType: string };
  /** A one-to-one conversation (a DM), rather than a group or channel. */
  direct: boolean;
  /** Mitzi was mentioned by name (in a group). */
  mentioned?: boolean;
  /** Why what was sent couldn't be read (too big, an unsupported file…). */
  problem?: string;
}

/** One messaging service: it receives messages and calls the hub, and sends what the hub gives it. */
export interface ChannelAdapter {
  readonly kind: ChannelKind;
  readonly label: string;
  readonly steps: string[];
  readonly fields: ChannelField[];
  /** The longest message the service takes. */
  readonly maxText: number;
  /** It can edit a sent message, so answers stream in. */
  readonly canEdit: boolean;
  /** It can show buttons under a message. */
  readonly hasButtons: boolean;
  /** How commands start: "/" where the service passes them through, "!" where it would take "/" itself. */
  readonly commandPrefix: string;
  /** Strangers get no reply at all (email: no answering spam). */
  readonly quietToStrangers?: boolean;
  /** For services that call Mitzi (webhooks): the path under /hooks/channels/ they post to. */
  readonly webhookPath?: string;
  /** Doesn't work on this computer, and why. */
  unsupported?(): string | undefined;
  /** Checks the settings and starts listening; returns the bot's name on the service. Throws when it can't. */
  start(config: Record<string, string>, hub: ChannelHub): Promise<{ username?: string }>;
  stop(): void;
  /** The latest connection problem while running, if any. */
  error?: string;
  /** Sends a message; returns its id when the service can edit it later. */
  send(address: string, text: string, opts?: SendOptions): Promise<string | undefined>;
  edit?(address: string, id: string, text: string, opts?: SendOptions): Promise<void>;
  /** Removes the buttons of a message once they've been used. */
  clearButtons?(address: string, id: string): Promise<void>;
  typing?(address: string): Promise<void>;
  /** A webhook request for this service: answers it (verification, acknowledgement). */
  webhook?(req: { method: string; query: URLSearchParams; headers: Record<string, string | string[] | undefined>; body: string }): Promise<{ status: number; body?: string; type?: string }>;
}

export interface ChannelEnv {
  store: Store;
  runner: ChatRunner;
  media: MediaService;
  workflows: WorkflowEngine;
  newChat: (fields: Partial<Chat>) => Chat;
}

/** Something a conversation can answer by replying (as well as with buttons). */
type Waiting =
  | { kind: 'approval'; answer: (yes: boolean) => void }
  | { kind: 'question'; mitziChatId: string; requestId: string; questions: AskQuestion[]; answers: (string[] | undefined)[] };

const YES = /^(y|yes|ok|okay|allow|approve|sure|go|go ahead|👍|✅)[.!]*$/i;
const NO = /^(n|no|deny|reject|stop|don'?t|👎|✋)[.!]*$/i;

export class ChannelHub {
  private running = false;
  private username?: string;
  private startError?: string;
  /** Pending buttons: id → what pressing one does (returns a short note, or '' when it's no longer pending). */
  private readonly callbacks = new Map<string, (answer: string) => string>();
  private readonly waiting = new Map<string, Waiting>();
  private nextCallback = 1;

  constructor(
    readonly adapter: ChannelAdapter,
    private readonly env: ChannelEnv,
  ) {}

  get kind(): ChannelKind {
    return this.adapter.kind;
  }

  settings(): ChannelSettings | undefined {
    return this.env.store.settings.channels?.[this.kind];
  }

  private save(patch: Partial<ChannelSettings>): void {
    const cur = this.settings() ?? { enabled: false, config: {}, pairingCode: newPairingCode(), links: [], notify: true };
    this.env.store.updateSettings({ channels: { ...this.env.store.settings.channels, [this.kind]: { ...cur, ...patch } } });
  }

  isRunning(): boolean {
    return this.running;
  }

  view(): ChannelView {
    const s = this.settings();
    const values: Record<string, string | boolean> = {};
    for (const f of this.adapter.fields) values[f.key] = f.secret ? !!s?.config[f.key] : (s?.config[f.key] ?? '');
    return {
      kind: this.kind,
      label: this.adapter.label,
      steps: this.adapter.steps,
      fields: this.adapter.fields,
      values,
      pairHint: this.pairHint(s?.pairingCode ?? ''),
      ...(this.adapter.webhookPath ? { webhookPath: `/hooks/channels/${this.adapter.webhookPath}` } : {}),
      ...(this.adapter.unsupported?.() ? { unsupported: this.adapter.unsupported() } : {}),
      running: this.running,
      username: this.username,
      error: this.startError ?? this.adapter.error,
      enabled: !!s?.enabled,
      pairingCode: s?.pairingCode ?? '',
      notify: s?.notify ?? true,
      links: s?.links ?? [],
    };
  }

  private pairHint(code: string): string {
    return this.kind === 'telegram' ? `/start ${code}` : `pair ${code}`;
  }

  /** Changes the settings and restarts the connection when they affect it. */
  async update(body: { config?: Record<string, unknown>; enabled?: boolean; notify?: boolean; newCode?: boolean; unlink?: string }): Promise<void> {
    const cur = this.settings() ?? { enabled: false, config: {}, pairingCode: newPairingCode(), links: [], notify: true };
    const next: ChannelSettings = { ...cur, config: { ...cur.config } };
    let restart = false;
    if (body.config && typeof body.config === 'object') {
      for (const f of this.adapter.fields) {
        const v = body.config[f.key];
        if (typeof v !== 'string') continue;
        // An empty secret keeps the saved one; other empty fields clear.
        if (f.secret && !v.trim()) continue;
        next.config[f.key] = v.trim();
        restart = true;
      }
    }
    if (typeof body.enabled === 'boolean') {
      next.enabled = body.enabled;
      restart = true;
    }
    if (typeof body.notify === 'boolean') next.notify = body.notify;
    if (body.newCode === true) next.pairingCode = newPairingCode();
    if (typeof body.unlink === 'string') next.links = next.links.filter((l) => l.address !== body.unlink);
    const missing = this.adapter.fields.filter((f) => !f.optional && !next.config[f.key]);
    if (next.enabled && missing.length) throw Object.assign(new Error(`Fill in ${missing.map((f) => f.label).join(', ')} first`), { status: 400 });
    this.save(next);
    if (restart) await this.sync();
  }

  /** Starts or stops the connection to match the settings. */
  async sync(): Promise<void> {
    const s = this.settings();
    if (this.running) this.stop();
    this.startError = undefined;
    if (!s?.enabled) return;
    const why = this.adapter.unsupported?.();
    if (why) {
      this.startError = why;
      return;
    }
    try {
      const { username } = await this.adapter.start(s.config, this);
      this.username = username;
      this.running = true;
    } catch (err) {
      const e = err as Error & { cause?: { code?: string } };
      // fetch's own errors say only "fetch failed"; the cause has the reason.
      this.startError = e.message === 'fetch failed' || e.name === 'TimeoutError' ? `Couldn’t reach ${this.adapter.label}${e.cause?.code ? ` (${e.cause.code})` : ''}. Check the internet connection.` : e.message;
    }
  }

  stop(): void {
    this.running = false;
    this.adapter.stop();
  }

  private links(): ChannelLink[] {
    return this.settings()?.links ?? [];
  }

  private saveLinks(links: ChannelLink[]): void {
    this.save({ links });
  }

  private reply(address: string, text: string, opts?: SendOptions): Promise<string | undefined> {
    return this.adapter.send(address, text.slice(0, this.adapter.maxText) || '…', opts).catch((err) => {
      console.warn(`${this.adapter.label}: couldn't send: ${(err as Error).message}`);
      return undefined;
    });
  }

  /** Registers a set of buttons and returns them, ready to send. */
  private buttons(options: string[], handle: (index: number) => string): Button[] {
    const id = String(this.nextCallback++);
    this.callbacks.set(id, (a) => handle(Number(a)));
    return options.map((label, i) => ({ label, data: `${id}:${i}` }));
  }

  /** A button was pressed; returns the note to show for it ('' when it was already answered). */
  press(data: string): string {
    const [id, answer] = data.split(':');
    const handle = this.callbacks.get(id);
    if (!handle) return '';
    const note = handle(answer ?? '');
    if (note) this.callbacks.delete(id);
    return note;
  }

  /** A message arrived. */
  async receive(msg: Incoming): Promise<void> {
    const s = this.settings();
    if (!s) return;
    const text = msg.text.trim();
    const { address } = msg;
    let link = s.links.find((l) => l.address === address);
    const p = this.adapter.commandPrefix;

    // Pairing: "/start 123456", "pair 123456", or just the code.
    const pair = /^(?:[/!]start|[/!]?pair)(?:@\S+)?\s*(\d{6})?\s*$|^(\d{6})$/i.exec(text);
    if (pair) {
      const code = pair[1] ?? pair[2];
      if (link) return void (await this.reply(address, `You’re already connected. Just write to me. ${p}new starts a new chat, ${p}help lists commands.`));
      if (code && code === s.pairingCode) {
        link = { address, name: msg.name, linkedAt: now() };
        // A used code can't pair anyone else.
        this.save({ links: [...s.links, link], pairingCode: newPairingCode() });
        return void (await this.reply(address, `🐱 Connected to Mitzi! Write to me here${this.adapter.kind === 'email' ? '' : ', send voice notes or photos'}. ${p}help lists commands.`));
      }
      if (this.adapter.quietToStrangers && !link) return;
      return void (await this.reply(address, `To connect, send the pairing code from Mitzi → Settings → Messaging → ${this.adapter.label}.`));
    }
    if (!link) {
      if ((msg.direct || msg.mentioned) && !this.adapter.quietToStrangers) await this.reply(address, `This Mitzi is private. Pair it from Mitzi → Settings → Messaging → ${this.adapter.label}.`);
      return;
    }

    const command = new RegExp(`^[/!](\\w+)(?:@\\S+)?\\s*([\\s\\S]*)$`).exec(text);
    if (command) {
      const [, name, args] = command;
      switch (name.toLowerCase()) {
        case 'help':
          return void (await this.reply(
            address,
            `Write to chat with Mitzi${this.adapter.kind === 'email' ? '' : ' (voice notes and photos work too)'}.\n\n${p}new: start a new chat\n${p}stop: stop the current answer\n${p}workflows: list workflows\n${p}workflow <name> <input>: run a workflow`,
          ));
        case 'new':
          this.saveLinks(this.links().map((l) => (l.address === address ? { ...l, mitziChatId: undefined } : l)));
          return void (await this.reply(address, '✨ New chat. What’s on your mind?'));
        case 'stop':
          if (link.mitziChatId && this.env.runner.stop(link.mitziChatId)) return void (await this.reply(address, 'Stopped.'));
          return void (await this.reply(address, 'Nothing is running.'));
        case 'workflows': {
          const list = this.env.store.workflows.all();
          return void (await this.reply(address, list.length ? list.map((w) => `${w.emoji} ${w.name}${w.description ? ` — ${w.description}` : ''}`).join('\n') : 'No workflows yet.'));
        }
        case 'workflow':
          return this.runWorkflow(address, args);
      }
    }

    // A reply while Mitzi waits for an answer answers it.
    const waiting = this.waiting.get(address);
    if (waiting && text && !msg.attachments?.length) {
      if (waiting.kind === 'approval') {
        if (YES.test(text) || NO.test(text)) {
          this.waiting.delete(address);
          return waiting.answer(YES.test(text));
        }
      } else return this.answerQuestion(address, undefined, text);
    }

    if (msg.problem) return void (await this.reply(address, `Couldn’t read that: ${msg.problem}`));
    let content = text;
    if (msg.voice) {
      try {
        const transcript = await this.env.media.transcribe(msg.voice.data, msg.voice.mimeType);
        content = [transcript, content].filter(Boolean).join('\n\n');
        await this.reply(address, `🎤 ${transcript}`);
      } catch (err) {
        return void (await this.reply(address, `Couldn’t read that: ${(err as Error).message}`));
      }
    }
    const attachments = msg.attachments ?? [];
    if (!content && !attachments.length) return;
    await this.chat(link, content, attachments);
  }

  /** Sends a message to the link's Mitzi chat and streams the answer back. */
  private async chat(link: ChannelLink, content: string, attachments: Attachment[]): Promise<void> {
    const { store, runner } = this.env;
    const { adapter } = this;
    const address = link.address;
    let chatId = link.mitziChatId && store.chats.get(link.mitziChatId) ? link.mitziChatId : undefined;
    if (!chatId) {
      chatId = store.chats.put(this.env.newChat({ title: `${adapter.label}: ${link.name}` })).id;
      this.saveLinks(this.links().map((l) => (l.address === address ? { ...l, mitziChatId: chatId } : l)));
    }
    const mitziChatId = chatId;
    if (runner.isRunning(mitziChatId)) {
      runner.enqueue(mitziChatId, { content, ...(attachments.length ? { attachments } : {}) });
      return void (await this.reply(address, '⏳ Queued: I’ll answer once I’m done with the last one.'));
    }
    await adapter.typing?.(address).catch(() => {});
    let text = '';
    let replyId: string | undefined;
    let shown = '';
    let lastEdit = 0;
    let status = '';
    // Services that can edit show the answer as it comes; others get it whole at the end. Sends and edits go
    // one after another, so a quick answer can't overtake the first send and post twice.
    let updates = Promise.resolve();
    const show = (final = false): Promise<void> => {
      if (!adapter.canEdit) return updates;
      const body = (text.trim() || status || '…').slice(0, adapter.maxText);
      if (body === shown || (!final && Date.now() - lastEdit < EDIT_EVERY_MS)) return updates;
      lastEdit = Date.now();
      shown = body;
      updates = updates.then(async () => {
        if (!replyId) replyId = await this.reply(address, body);
        else await adapter.edit?.(address, replyId, body).catch(() => {});
      });
      return updates;
    };
    const emit = (e: StreamEvent) => {
      if (e.type === 'text') {
        text += e.text;
        void show();
      } else if (e.type === 'tool_call') {
        status = `🔧 ${e.name}: ${e.summary}`.slice(0, 200);
        if (!text.trim()) void show();
      } else if (e.type === 'permission') {
        void this.askApproval(address, `🐾 May I ${e.tool}?\n${e.summary}${e.why ? `\n(${e.why})` : ''}`, ['✅ Allow', '✋ Deny'], (yes) => {
          runner.resolvePermission(mitziChatId, e.requestId, { kind: yes ? 'yes' : 'no' });
        });
      } else if (e.type === 'permission_resolved') {
        if (this.waiting.get(address)?.kind === 'approval') this.waiting.delete(address);
      } else if (e.type === 'question') {
        void this.askQuestions(address, mitziChatId, e.requestId, e.questions);
      } else if (e.type === 'question_resolved') {
        const w = this.waiting.get(address);
        if (w?.kind === 'question' && w.requestId === e.requestId) this.waiting.delete(address);
      } else if (e.type === 'error') {
        void this.reply(address, `⚠️ ${e.message}`);
      }
    };
    await runner.run(mitziChatId, { kind: 'message', content, attachments }, emit, new AbortController().signal);
    // The whole answer, formatted: the first part replaces the streamed message, the rest follow.
    const parts = splitMessage(text, adapter.maxText);
    await updates;
    if (adapter.canEdit && replyId) {
      text = parts[0];
      await show(true);
      if (parts[0].trim()) await adapter.edit?.(address, replyId, parts[0], { markdown: true }).catch(() => {});
      for (const part of parts.slice(1)) await this.reply(address, part, { markdown: true });
    } else {
      for (const part of parts) if (part.trim()) await this.reply(address, part, { markdown: true });
    }
  }

  /** Asks yes or no: buttons where the service has them; a "yes"/"no" reply works everywhere. */
  private async askApproval(address: string, text: string, labels: [string, string], answer: (yes: boolean) => void): Promise<void> {
    let done = false;
    const decide = (yes: boolean) => {
      if (done) return '';
      done = true;
      answer(yes);
      return yes ? 'Allowed' : 'Declined';
    };
    this.waiting.set(address, { kind: 'approval', answer: (yes) => void decide(yes) });
    const buttons = this.adapter.hasButtons ? this.buttons(labels, (i) => (this.waiting.delete(address), decide(i === 0))) : undefined;
    await this.reply(address, buttons ? text : `${text}\n\nReply yes or no.`, { buttons });
  }

  /** A bot's questions: one message each, with its options as buttons (or numbered); a reply answers in the user's own words. */
  private async askQuestions(address: string, mitziChatId: string, requestId: string, questions: AskQuestion[]): Promise<void> {
    const pending: Waiting = { kind: 'question', mitziChatId, requestId, questions, answers: questions.map(() => undefined) };
    this.waiting.set(address, pending);
    for (const [qi, q] of questions.entries()) {
      const options = q.options ?? [];
      const useButtons = this.adapter.hasButtons && options.length > 0;
      const lines = [`❓ ${q.question}`];
      if (useButtons) lines.push(...options.filter((o) => o.description).map((o) => `• ${o.label}: ${o.description}`));
      else lines.push(...options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`));
      if (qi === questions.length - 1) {
        lines.push('', options.length ? (useButtons ? 'Tap an option, or reply in your own words.' : 'Reply with a number, or in your own words.') : 'Reply with your answer.');
      }
      const buttons = useButtons
        ? this.buttons(
            options.map((o) => o.label),
            (i) => {
              const label = options[i]?.label;
              if (!label || this.waiting.get(address) !== pending) return '';
              this.answerQuestion(address, qi, label);
              return label;
            },
          )
        : undefined;
      await this.reply(address, lines.join('\n'), { buttons });
    }
  }

  /** Records an answer (a number picks that option); once every question has one, the bot carries on. */
  private answerQuestion(address: string, index: number | undefined, answer: string): void {
    const pending = this.waiting.get(address);
    if (pending?.kind !== 'question') return;
    const i = index ?? pending.answers.findIndex((a) => !a);
    if (i < 0) return;
    const options = pending.questions[i].options ?? [];
    const n = /^\d+$/.test(answer.trim()) ? Number(answer.trim()) : 0;
    pending.answers[i] = [options[n - 1]?.label ?? answer];
    if (pending.answers.every(Boolean)) {
      this.waiting.delete(address);
      this.env.runner.resolveQuestion(pending.mitziChatId, pending.requestId, pending.answers as string[][]);
    }
  }

  private async runWorkflow(address: string, args: string): Promise<void> {
    const list = this.env.store.workflows.all();
    const lower = args.toLowerCase();
    // The longest name that starts the arguments; the rest is the input.
    const w = [...list].sort((a, b) => b.name.length - a.name.length).find((x) => lower.startsWith(x.name.toLowerCase()));
    if (!w) return void (await this.reply(address, `Which one? ${list.map((x) => x.name).join(', ') || 'There are no workflows yet.'}`));
    if (this.env.workflows.isRunning(w.id)) return void (await this.reply(address, `${w.name} is already running.`));
    await this.reply(address, `${w.emoji} Running ${w.name}…`);
    const run = await this.env.workflows.run(w, args.slice(w.name.length).trim(), 'chat');
    if (run.status === 'error') return void (await this.reply(address, `⚠️ ${w.name} failed: ${run.error}`));
    for (const part of splitMessage(run.output || 'Done (no result).', this.adapter.maxText)) await this.reply(address, part, { markdown: true });
  }

  /** A workflow waiting for approval asks the paired conversations. */
  async askWorkflowApproval(w: Workflow, run: WorkflowRun, ask: string): Promise<void> {
    const s = this.settings();
    if (!this.running || !s?.notify) return;
    let decided = false;
    for (const link of s.links) {
      await this.askApproval(link.address, `${w.emoji} ${w.name} needs your approval:\n\n${ask}`, ['✅ Approve', '✋ Reject'], (yes) => {
        if (decided) return;
        decided = true;
        this.env.workflows.decide(run.id, { approved: yes });
      });
    }
  }

  /** Tells the paired conversations something (a scheduled task finished…), when notifications are on. */
  async notify(text: string): Promise<void> {
    const s = this.settings();
    if (!this.running || !s?.notify) return;
    for (const link of s.links) await this.reply(link.address, text);
  }
}
