// Just enough IMAP, SMTP and MIME for Mitzi to read and answer email, with no dependencies.
import { randomBytes } from 'node:crypto';
import { connect as netConnect, Socket } from 'node:net';
import { connect as tlsConnect, TLSSocket } from 'node:tls';

const TIMEOUT_MS = 30_000;

/** Plain connections are only for tests, against fake servers on this computer. */
const plainAllowed = () => process.env.MITZI_EMAIL_PLAIN === '1';

function open(host: string, port: number, secure: boolean): Promise<Socket | TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = secure ? tlsConnect({ host, port, servername: host }) : netConnect({ host, port });
    socket.setTimeout(TIMEOUT_MS, () => socket.destroy(new Error(`${host}:${port} didn’t answer`)));
    socket.once(secure ? 'secureConnect' : 'connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

/** Reads a connection line by line, or a given number of bytes (IMAP literals). */
class Reader {
  private buf = Buffer.alloc(0);
  private waiters: (() => void)[] = [];
  private error?: Error;

  constructor(socket: Socket | TLSSocket) {
    socket.on('data', (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.wake();
    });
    const fail = (err?: Error) => {
      this.error = err ?? new Error('The mail server closed the connection');
      this.wake();
    };
    socket.on('error', fail);
    socket.on('close', () => fail());
  }

  private wake() {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  private wait(): Promise<void> {
    if (this.error) return Promise.reject(this.error);
    return new Promise((r) => this.waiters.push(r));
  }

  async line(): Promise<string> {
    for (;;) {
      const i = this.buf.indexOf('\r\n');
      if (i >= 0) {
        const line = this.buf.subarray(0, i).toString('utf8');
        this.buf = this.buf.subarray(i + 2);
        return line;
      }
      await this.wait();
    }
  }

  async bytes(n: number): Promise<Buffer> {
    while (this.buf.length < n) await this.wait();
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return Buffer.from(out);
  }
}

// ——— IMAP ———

const quote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export interface ImapResponse {
  /** Untagged lines, with each literal's place marked as {n}. */
  lines: string[];
  /** Literals, in order. */
  literals: Buffer[];
}

export class ImapClient {
  private tag = 0;
  private constructor(
    private readonly socket: Socket | TLSSocket,
    private readonly reader: Reader,
  ) {}

  static async connect(host: string, port: number): Promise<ImapClient> {
    const socket = await open(host, port, !plainAllowed());
    const client = new ImapClient(socket, new Reader(socket));
    const greeting = await client.reader.line();
    if (!/^\* (OK|PREAUTH)/i.test(greeting)) throw new Error(`The mail server said: ${greeting}`);
    return client;
  }

  async command(cmd: string): Promise<ImapResponse> {
    const tag = `M${++this.tag}`;
    this.socket.write(`${tag} ${cmd}\r\n`);
    const out: ImapResponse = { lines: [], literals: [] };
    for (;;) {
      let line = await this.reader.line();
      // A literal: {n} at the end of a line, then n bytes, then the line goes on.
      while (/\{(\d+)\}$/.test(line)) {
        const n = Number(/\{(\d+)\}$/.exec(line)![1]);
        out.literals.push(await this.reader.bytes(n));
        line += await this.reader.line();
      }
      if (line.startsWith(`${tag} `)) {
        const status = line.slice(tag.length + 1);
        if (!/^OK/i.test(status)) throw new Error(`The mail server said: ${status.replace(/^(NO|BAD)\s*/i, '')}`);
        return out;
      }
      out.lines.push(line);
    }
  }

  login(user: string, password: string) {
    return this.command(`LOGIN ${quote(user)} ${quote(password)}`);
  }

  close(): void {
    this.socket.write(`M${++this.tag} LOGOUT\r\n`);
    this.socket.end();
  }
}

// ——— SMTP ———

export interface Outgoing {
  from: string;
  to: string;
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string;
}

/** An RFC 2047 encoded word, for headers that aren't plain ASCII. */
const encodeHeader = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);

export function buildMessage(m: Outgoing, domain: string): { id: string; data: string } {
  const id = `<${Date.now().toString(36)}.${randomBytes(6).toString('hex')}@${domain}>`;
  const body = Buffer.from(m.text, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
  const headers = [
    `From: Mitzi <${m.from}>`,
    `To: ${m.to}`,
    `Subject: ${encodeHeader(m.subject)}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${id}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo}`, `References: ${[m.references, m.inReplyTo].filter(Boolean).join(' ')}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    'Auto-Submitted: auto-replied',
  ];
  return { id, data: `${headers.join('\r\n')}\r\n\r\n${body}` };
}

/** Sends one message: implicit TLS on port 465, STARTTLS elsewhere. */
export async function sendMail(opts: { host: string; port: number; user: string; password: string }, m: Outgoing): Promise<string> {
  const implicit = opts.port === 465 && !plainAllowed();
  let socket = await open(opts.host, opts.port, implicit);
  let reader = new Reader(socket);
  const response = async (): Promise<{ code: number; text: string }> => {
    let text = '';
    for (;;) {
      const line = await reader.line();
      text += `${line.slice(4)}\n`;
      if (line[3] !== '-') return { code: Number(line.slice(0, 3)), text };
    }
  };
  const expect = async (cmd: string | undefined, ok: number[]) => {
    if (cmd !== undefined) socket.write(`${cmd}\r\n`);
    const r = await response();
    if (!ok.includes(r.code)) throw new Error(`The mail server refused ${cmd?.split(' ')[0] ?? 'the connection'}: ${r.code} ${r.text.trim()}`);
    return r;
  };
  try {
    await expect(undefined, [220]);
    let ehlo = await expect('EHLO mitzi', [250]);
    if (!implicit && !plainAllowed()) {
      if (!/STARTTLS/i.test(ehlo.text)) throw new Error('The mail server doesn’t offer encryption (STARTTLS); use port 465 or 587');
      await expect('STARTTLS', [220]);
      socket = await new Promise<TLSSocket>((resolve, reject) => {
        const secure = tlsConnect({ socket, servername: opts.host }, () => resolve(secure));
        secure.once('error', reject);
      });
      reader = new Reader(socket);
      ehlo = await expect('EHLO mitzi', [250]);
    }
    await expect(`AUTH PLAIN ${Buffer.from(`\0${opts.user}\0${opts.password}`).toString('base64')}`, [235]);
    await expect(`MAIL FROM:<${m.from}>`, [250]);
    await expect(`RCPT TO:<${m.to}>`, [250, 251]);
    await expect('DATA', [354]);
    const { id, data } = buildMessage(m, m.from.split('@')[1] ?? 'mitzi.local');
    // Lines starting with a dot get another one, so the message can't end early.
    await expect(`${data.replace(/^\./gm, '..')}\r\n.`, [250]);
    socket.write('QUIT\r\n');
    return id;
  } finally {
    socket.end();
  }
}

// ——— MIME ———

export interface ParsedMail {
  from: { address: string; name: string };
  subject: string;
  messageId?: string;
  references?: string;
  text: string;
  /** Files: images, audio and text, as bytes. */
  files: { name: string; type: string; data: Buffer }[];
  autoSubmitted: boolean;
}

function decodeWords(s: string): string {
  return s.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=(\s+(?==\?))?/g, (_, charset: string, enc: string, text: string) => {
    const bytes = enc.toUpperCase() === 'B' ? Buffer.from(text, 'base64') : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1');
    return decodeCharset(bytes, charset);
  });
}

function decodeCharset(bytes: Buffer, charset = 'utf-8'): string {
  try {
    return new TextDecoder(charset.toLowerCase()).decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
}

function parseHeaders(raw: string): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of raw.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) {
      const key = line.slice(0, i).trim().toLowerCase();
      if (!headers.has(key)) headers.set(key, line.slice(i + 1).trim());
    }
  }
  return headers;
}

const param = (header: string, name: string) => new RegExp(`${name}\\*?=(?:"([^"]*)"|([^;\\s]*))`, 'i').exec(header)?.slice(1).find((x) => x !== undefined);

function decodeBody(body: Buffer, encoding: string): Buffer {
  const enc = encoding.toLowerCase();
  if (enc === 'base64') return Buffer.from(body.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (enc === 'quoted-printable') {
    const text = body.toString('latin1').replace(/=\r?\n/g, '');
    return Buffer.from(text.replace(/=([0-9A-F]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1');
  }
  return body;
}

const stripHtml = (html: string) =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d|tr)>/gi, '\n')
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

/** Parses a raw message: who sent it, the subject, the readable text and the files. */
export function parseMail(raw: Buffer): ParsedMail {
  const files: ParsedMail['files'] = [];
  let plain: string | undefined;
  let html: string | undefined;
  const walk = (part: Buffer) => {
    const split = part.indexOf('\r\n\r\n') >= 0 ? part.indexOf('\r\n\r\n') : part.indexOf('\n\n');
    const head = parseHeaders(part.subarray(0, split < 0 ? part.length : split).toString('latin1'));
    const body = split < 0 ? Buffer.alloc(0) : part.subarray(split + (part[split] === 13 ? 4 : 2));
    const type = head.get('content-type') ?? 'text/plain';
    const mime = type.split(';')[0].trim().toLowerCase();
    if (mime.startsWith('multipart/')) {
      const boundary = param(type, 'boundary');
      if (!boundary) return;
      const text = body.toString('latin1');
      for (const piece of text.split(`--${boundary}`).slice(1)) {
        if (piece.startsWith('--')) break;
        walk(Buffer.from(piece.replace(/^\r?\n/, ''), 'latin1'));
      }
      return;
    }
    const data = decodeBody(body, head.get('content-transfer-encoding') ?? '7bit');
    const disposition = head.get('content-disposition') ?? '';
    const name = decodeWords(param(disposition, 'filename') ?? param(type, 'name') ?? '');
    if (!name && !/attachment/i.test(disposition) && (mime === 'text/plain' || mime === 'text/html')) {
      const text = decodeCharset(data, param(type, 'charset'));
      if (mime === 'text/plain') plain ??= text;
      else html ??= text;
      return;
    }
    if (/^(image|audio)\//.test(mime) || mime.startsWith('text/')) files.push({ name: name || 'file', type: mime, data });
  };
  walk(raw);
  const end = raw.indexOf('\r\n\r\n') >= 0 ? raw.indexOf('\r\n\r\n') : raw.indexOf('\n\n');
  const head = parseHeaders(raw.subarray(0, end < 0 ? raw.length : end).toString('latin1'));
  const fromHeader = decodeWords(head.get('from') ?? '');
  const address = (/<([^>]+)>/.exec(fromHeader)?.[1] ?? fromHeader).trim().toLowerCase();
  const name = fromHeader.replace(/<[^>]+>/, '').replace(/"/g, '').trim() || address;
  return {
    from: { address, name },
    subject: decodeWords(head.get('subject') ?? ''),
    messageId: head.get('message-id'),
    references: head.get('references'),
    text: replyText(plain ?? (html ? stripHtml(html) : '')),
    files,
    autoSubmitted: /auto-(replied|generated)/i.test(head.get('auto-submitted') ?? '') || /^(bulk|list|junk)$/i.test(head.get('precedence') ?? ''),
  };
}

/** Just what was written: quoted text, "On … wrote:" lines and signatures go. */
export function replyText(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (/^-- ?$/.test(line) || /^-{3,}\s*Original Message/i.test(line) || /^_{10,}$/.test(line)) break;
    if (/^On .{4,200} wrote:$/.test(line.trim()) || /^(From|Von|De): .+/.test(line) && out.length) break;
    if (line.startsWith('>')) continue;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
