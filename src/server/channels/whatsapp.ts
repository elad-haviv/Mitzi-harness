// WhatsApp: a number on Meta's WhatsApp Cloud API. Meta posts incoming messages to Mitzi's webhook (so Mitzi
// needs a public address, e.g. through a tunnel), signed with the app secret; answers go out through the Graph
// API. WhatsApp can't edit messages, so answers arrive whole; choices are reply buttons, or a list for many.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Attachment } from '../../shared/types.js';
import { toWhatsApp } from './format.js';
import type { ChannelAdapter, ChannelHub, Incoming, SendOptions } from './hub.js';

interface WaMessage {
  from: string;
  id: string;
  type: string;
  text?: { body: string };
  interactive?: { button_reply?: { id: string; title: string }; list_reply?: { id: string; title: string } };
  button?: { text: string; payload?: string };
  image?: { id: string; mime_type?: string; caption?: string };
  audio?: { id: string; mime_type?: string };
  document?: { id: string; mime_type?: string; filename?: string; caption?: string };
}

/** Interactive messages hold up to 1024 characters of text; plain ones 4096. */
const MAX_INTERACTIVE = 1024;

export class WhatsAppAdapter implements ChannelAdapter {
  readonly kind = 'whatsapp' as const;
  readonly label = 'WhatsApp';
  readonly steps = [
    'At [developers.facebook.com](https://developers.facebook.com/apps), create an app of type *Business* and add the *WhatsApp* product. Note the *Phone number ID* it shows (a test number works to start).',
    'Make a permanent access token: in *Business Settings → System users*, add one with the `whatsapp_business_messaging` permission and generate a token. Copy the *App secret* from *App settings → Basic*.',
    'Mitzi needs a public address for WhatsApp to reach it: run a tunnel (such as Cloudflare Tunnel or ngrok) to this computer.',
    'Fill in the fields below (the verify token is any word you choose) and turn WhatsApp on. Then, under *WhatsApp → Configuration*, set the callback URL to the webhook address below (on your public address), enter the same verify token, and subscribe to `messages`.',
    'Send the pairing message to your WhatsApp number. WhatsApp only lets Mitzi write first within 24 hours of your last message, so notifications reach you while a conversation is recent.',
  ];
  readonly fields = [
    { key: 'phoneNumberId', label: 'Phone number ID', placeholder: '1234567890' },
    { key: 'accessToken', label: 'Access token', secret: true, placeholder: 'EAAG…' },
    { key: 'appSecret', label: 'App secret', secret: true, placeholder: 'For checking that messages come from Meta' },
    { key: 'verifyToken', label: 'Verify token', placeholder: 'Any word, also entered in Meta’s webhook settings' },
  ];
  readonly maxText = 4000;
  readonly canEdit = false;
  readonly hasButtons = true;
  readonly commandPrefix = '/';
  readonly webhookPath = 'whatsapp';
  error?: string;
  private config: Record<string, string> = {};
  private hub?: ChannelHub;
  /** Message ids already handled (Meta retries deliveries). */
  private readonly seen = new Set<string>();

  /** `apiBase`: the Graph API address (tests point it at a fake). */
  constructor(private readonly apiBase = 'https://graph.facebook.com/v21.0') {}

  private async api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.config.accessToken}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } } & T;
    if (!res.ok) throw new Error(res.status === 401 ? 'WhatsApp didn’t accept the access token' : `WhatsApp: ${data.error?.message ?? res.status}`);
    return data;
  }

  async start(config: Record<string, string>, hub: ChannelHub): Promise<{ username?: string }> {
    this.config = config;
    this.hub = hub;
    const number = await this.api<{ display_phone_number?: string; verified_name?: string }>('GET', `/${encodeURIComponent(config.phoneNumberId)}?fields=display_phone_number,verified_name`);
    return { username: [number.verified_name, number.display_phone_number].filter(Boolean).join(' · ') || undefined };
  }

  stop(): void {}

  async webhook(req: { method: string; query: URLSearchParams; headers: Record<string, string | string[] | undefined>; body: string }): Promise<{ status: number; body?: string; type?: string }> {
    // Meta checks the address once, with the verify token.
    if (req.method === 'GET') {
      const ok = req.query.get('hub.mode') === 'subscribe' && !!this.config.verifyToken && req.query.get('hub.verify_token') === this.config.verifyToken;
      return ok ? { status: 200, body: req.query.get('hub.challenge') ?? '' } : { status: 403, body: 'Wrong verify token' };
    }
    if (req.method !== 'POST') return { status: 405 };
    const signature = String(req.headers['x-hub-signature-256'] ?? '');
    const expected = `sha256=${createHmac('sha256', this.config.appSecret ?? '').update(req.body).digest('hex')}`;
    if (!this.config.appSecret || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return { status: 401, body: 'Bad signature' };
    let payload: any;
    try {
      payload = JSON.parse(req.body);
    } catch {
      return { status: 400 };
    }
    // Answer Meta right away; the messages are handled after.
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value ?? {};
        const names = new Map<string, string>((value.contacts ?? []).map((c: any) => [c.wa_id, c.profile?.name]));
        for (const m of (value.messages ?? []) as WaMessage[]) {
          if (this.seen.has(m.id)) continue;
          this.seen.add(m.id);
          if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value!);
          void this.onMessage(m, names.get(m.from) ?? `+${m.from}`).catch((err) => console.warn(`WhatsApp: ${(err as Error).message}`));
        }
      }
    }
    return { status: 200, body: 'ok' };
  }

  private async download(id: string): Promise<Buffer> {
    const media = await this.api<{ url: string; file_size?: number }>('GET', `/${id}`);
    if ((media.file_size ?? 0) > 8 * 1024 * 1024) throw new Error('Files over 8 MB can’t be read here');
    const res = await fetch(media.url, { headers: { authorization: `Bearer ${this.config.accessToken}` } });
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }

  private async onMessage(m: WaMessage, name: string): Promise<void> {
    const hub = this.hub!;
    // A tapped reply button or list row carries the button's data.
    const picked = m.interactive?.button_reply ?? m.interactive?.list_reply;
    if (picked) {
      hub.press(picked.id);
      return;
    }
    const incoming: Incoming = { address: m.from, name, text: m.text?.body ?? m.button?.text ?? m.image?.caption ?? m.document?.caption ?? '', direct: true };
    try {
      const attachments: Attachment[] = [];
      if (m.audio) incoming.voice = { data: await this.download(m.audio.id), mimeType: m.audio.mime_type ?? 'audio/ogg' };
      if (m.image) {
        const type = m.image.mime_type ?? 'image/jpeg';
        attachments.push({ name: 'photo.jpg', kind: 'image', content: `data:${type};base64,${(await this.download(m.image.id)).toString('base64')}` });
      }
      if (m.document) {
        const file = await this.download(m.document.id);
        const text = file.toString('utf8');
        if (text.includes('\u0000') || file.length > 1024 * 1024) throw new Error('Send text files up to 1 MB (or paste the text); other files can’t be read here');
        attachments.push({ name: m.document.filename ?? 'file.txt', kind: 'text', content: text });
      }
      if (attachments.length) incoming.attachments = attachments;
      if (!['text', 'interactive', 'button', 'image', 'audio', 'document'].includes(m.type)) incoming.problem = `${m.type} messages can’t be read here`;
    } catch (err) {
      incoming.problem = (err as Error).message;
    }
    await hub.receive(incoming);
  }

  async send(address: string, text: string, opts: SendOptions = {}): Promise<string | undefined> {
    const body = opts.markdown ? toWhatsApp(text) : text;
    const to = { messaging_product: 'whatsapp', recipient_type: 'individual', to: address };
    const buttons = opts.buttons ?? [];
    if (!buttons.length) {
      const m = await this.api<{ messages?: { id: string }[] }>('POST', `/${this.config.phoneNumberId}/messages`, { ...to, type: 'text', text: { body, preview_url: false } });
      return m.messages?.[0]?.id;
    }
    // Long text goes first on its own; the choices follow with a short prompt.
    let prompt = body;
    if (body.length > MAX_INTERACTIVE) {
      await this.send(address, text, { markdown: opts.markdown });
      prompt = 'Choose:';
    }
    // Up to three short choices are buttons; more (or longer ones) go in a list.
    const interactive =
      buttons.length <= 3 && buttons.every((b) => b.label.length <= 20)
        ? { type: 'button', body: { text: prompt }, action: { buttons: buttons.map((b) => ({ type: 'reply', reply: { id: b.data, title: b.label } })) } }
        : {
            type: 'list',
            body: { text: prompt },
            action: { button: 'Choose', sections: [{ title: 'Options', rows: buttons.slice(0, 10).map((b) => ({ id: b.data, title: b.label.slice(0, 24), ...(b.label.length > 24 ? { description: b.label.slice(0, 72) } : {}) })) }] },
          };
    const m = await this.api<{ messages?: { id: string }[] }>('POST', `/${this.config.phoneNumberId}/messages`, { ...to, type: 'interactive', interactive });
    return m.messages?.[0]?.id;
  }
}
