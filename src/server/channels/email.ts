// Email: Mitzi checks a mailbox (IMAP) and answers by mail (SMTP), in the same thread. It only reads mail that
// arrives while it's running, leaves mail from strangers unread and unanswered, and marks what it handles as read.
import type { Attachment } from '../../shared/types.js';
import { toPlainText } from './format.js';
import type { ChannelAdapter, ChannelHub, SendOptions } from './hub.js';
import { ImapClient, parseMail, sendMail } from './mail.js';

const PAIRING = /^(?:[/!]?(?:start|pair)\s+)?\d{6}$/i;

export class EmailAdapter implements ChannelAdapter {
  readonly kind = 'email' as const;
  readonly label = 'Email';
  readonly steps = [
    'Give Mitzi a mailbox of its own (a new address is best: Mitzi reads everything that arrives there). It needs IMAP and SMTP, which most providers have.',
    'For Gmail, turn on 2-Step Verification and make an *App password*; the servers are `imap.gmail.com` and `smtp.gmail.com`. For Outlook.com: `outlook.office365.com` and `smtp-mail.outlook.com` (port 587). iCloud: `imap.mail.me.com` and `smtp.mail.me.com` (port 587).',
    'Fill in the fields below and turn email on. Mitzi checks for new mail every half minute.',
    'From your own address, send Mitzi an email with the pairing message as its subject. Mitzi answers paired addresses only, in the same thread.',
  ];
  readonly fields = [
    { key: 'address', label: 'Mitzi’s email address', placeholder: 'mitzi@example.com' },
    { key: 'password', label: 'Password (or app password)', secret: true },
    { key: 'imapHost', label: 'IMAP server', placeholder: 'imap.example.com' },
    { key: 'imapPort', label: 'IMAP port', placeholder: '993', optional: true },
    { key: 'smtpHost', label: 'SMTP server', placeholder: 'smtp.example.com' },
    { key: 'smtpPort', label: 'SMTP port', placeholder: '465 (or 587)', optional: true },
    { key: 'username', label: 'User name', placeholder: 'If it isn’t the address', optional: true },
  ];
  readonly maxText = 50_000;
  readonly canEdit = false;
  readonly hasButtons = false;
  readonly commandPrefix = '/';
  readonly quietToStrangers = true;
  error?: string;
  private config: Record<string, string> = {};
  private hub?: ChannelHub;
  private timer?: NodeJS.Timeout;
  private running = false;
  /** Mail that came before this UID was there before Mitzi started, and is left alone. */
  private firstUid = 0;
  private readonly done = new Set<number>();
  /** The latest thread with each address, so replies stay in it. */
  private readonly threads = new Map<string, { subject: string; messageId?: string; references?: string }>();

  private get user() {
    return this.config.username || this.config.address;
  }

  private async imap(): Promise<ImapClient> {
    const client = await ImapClient.connect(this.config.imapHost, Number(this.config.imapPort) || 993);
    try {
      await client.login(this.user, this.config.password);
    } catch (err) {
      client.close();
      throw new Error(`Couldn’t sign in to ${this.config.imapHost}: ${(err as Error).message.replace(/^The mail server said: /, '')}`);
    }
    return client;
  }

  async start(config: Record<string, string>, hub: ChannelHub): Promise<{ username?: string }> {
    this.config = config;
    this.hub = hub;
    if (!/^[^@\s]+@[^@\s]+$/.test(config.address ?? '')) throw new Error('Enter Mitzi’s email address');
    const client = await this.imap();
    try {
      const select = await client.command('SELECT INBOX');
      this.firstUid = Number(/UIDNEXT (\d+)/i.exec(select.lines.join('\n'))?.[1] ?? 1);
    } finally {
      client.close();
    }
    this.running = true;
    this.schedule();
    return { username: config.address };
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => void this.poll().finally(() => this.schedule()), Number(process.env.MITZI_EMAIL_POLL_MS) || 30_000);
  }

  /** Looks for new mail, and hands what paired addresses (or pairing codes) sent to the hub. */
  private async poll(): Promise<void> {
    let client: ImapClient | undefined;
    try {
      client = await this.imap();
      await client.command('SELECT INBOX');
      const search = await client.command(`UID SEARCH UNSEEN UID ${this.firstUid}:*`);
      const uids = (/^\* SEARCH ?(.*)$/m.exec(search.lines.join('\n'))?.[1] ?? '')
        .split(/\s+/)
        .map(Number)
        .filter((u) => u >= this.firstUid && !this.done.has(u));
      const paired = new Set(this.hub!.settings()?.links.map((l) => l.address) ?? []);
      for (const uid of uids) {
        // The sender and subject first: strangers' mail isn't downloaded or marked read.
        const head = await client.command(`UID FETCH ${uid} (BODY.PEEK[HEADER.FIELDS (FROM SUBJECT)])`);
        const headers = parseMail(head.literals[0] ?? Buffer.alloc(0));
        this.done.add(uid);
        if (!paired.has(headers.from.address) && !PAIRING.test(headers.subject.trim())) continue;
        const full = await client.command(`UID FETCH ${uid} (BODY.PEEK[])`);
        await client.command(`UID STORE ${uid} +FLAGS (\\Seen)`);
        const mail = parseMail(full.literals[0] ?? Buffer.alloc(0));
        // Out-of-office replies and mailing lists aren't answered.
        if (mail.autoSubmitted) continue;
        this.threads.set(mail.from.address, { subject: mail.subject, messageId: mail.messageId, references: mail.references });
        const attachments: Attachment[] = [];
        let voice: { data: Buffer; mimeType: string } | undefined;
        for (const f of mail.files) {
          if (f.type.startsWith('image/')) attachments.push({ name: f.name, kind: 'image', content: `data:${f.type};base64,${f.data.toString('base64')}` });
          else if (f.type.startsWith('audio/')) voice = { data: f.data, mimeType: f.type };
          else if (f.data.length <= 1024 * 1024) attachments.push({ name: f.name, kind: 'text', content: f.data.toString('utf8') });
        }
        const subject = mail.subject.replace(/^((re|fwd?|aw|sv):\s*)+/i, '').trim();
        // A pairing code can be the subject; otherwise the subject goes with the text when it adds something.
        const text = PAIRING.test(subject) ? subject : mail.text || subject;
        void this.hub!.receive({ address: mail.from.address, name: mail.from.name, text, attachments, voice, direct: true });
      }
      this.error = undefined;
    } catch (err) {
      this.error = (err as Error).message;
    } finally {
      client?.close();
    }
  }

  async send(address: string, text: string, opts: SendOptions = {}): Promise<string | undefined> {
    const thread = this.threads.get(address);
    const body = opts.markdown ? toPlainText(text) : text;
    const subject = thread ? (/^re:/i.test(thread.subject) ? thread.subject : `Re: ${thread.subject || 'Mitzi'}`) : `Mitzi: ${body.split('\n')[0].slice(0, 60)}`;
    const id = await sendMail(
      { host: this.config.smtpHost, port: Number(this.config.smtpPort) || 465, user: this.user, password: this.config.password },
      { from: this.config.address, to: address, subject, text: body, inReplyTo: thread?.messageId, references: thread?.references },
    );
    if (thread) thread.messageId = id;
    else this.threads.set(address, { subject, messageId: id });
    return undefined;
  }
}
