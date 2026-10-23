// The messaging services Mitzi can be reached through, their settings routes, and their webhooks.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CHANNEL_KINDS, ChannelKind, ChannelSettings } from '../../shared/types.js';
import { readRaw } from '../workflow-triggers.js';
import { ChannelAdapter, ChannelEnv, ChannelHub, newPairingCode } from './hub.js';
import { DiscordAdapter } from './discord.js';
import { SlackAdapter } from './slack.js';
import { TelegramAdapter } from './telegram.js';

export { ChannelHub, newPairingCode } from './hub.js';

export interface ChannelOptions {
  /** API addresses for tests (fakes), by service. */
  apiBase?: Partial<Record<ChannelKind, string>>;
}

export class Channels {
  readonly hubs = new Map<ChannelKind, ChannelHub>();

  constructor(env: ChannelEnv, opts: ChannelOptions = {}) {
    migrateTelegram(env);
    const adapters: ChannelAdapter[] = [new TelegramAdapter(opts.apiBase?.telegram), new DiscordAdapter(opts.apiBase?.discord), new SlackAdapter(opts.apiBase?.slack)];
    for (const a of adapters) this.hubs.set(a.kind, new ChannelHub(a, env));
    env.workflows.approvalListeners.add((w, run, ask) => {
      for (const hub of this.hubs.values()) void hub.askWorkflowApproval(w, run, ask);
    });
  }

  get(kind: string): ChannelHub | undefined {
    return CHANNEL_KINDS.includes(kind as ChannelKind) ? this.hubs.get(kind as ChannelKind) : undefined;
  }

  /** Connects every service that's turned on. */
  start(): void {
    for (const hub of this.hubs.values()) void hub.sync();
  }

  stop(): void {
    for (const hub of this.hubs.values()) hub.stop();
  }

  notify(text: string): void {
    for (const hub of this.hubs.values()) void hub.notify(text);
  }

  /** A webhook call from a service, at /hooks/channels/<path>. */
  async webhook(path: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const hub = [...this.hubs.values()].find((h) => h.adapter.webhookPath === path);
    if (!hub?.adapter.webhook || !hub.isRunning()) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ error: 'Not turned on' }));
    }
    let body = '';
    try {
      body = req.method === 'POST' ? await readRaw(req) : '';
    } catch {
      res.writeHead(413);
      return void res.end();
    }
    const out = await hub.adapter.webhook({ method: req.method ?? 'GET', query: new URL(req.url ?? '/', 'http://x').searchParams, headers: req.headers, body }).catch((err) => {
      console.warn(`${hub.adapter.label} webhook: ${(err as Error).message}`);
      return { status: 500 } as { status: number; body?: string; type?: string };
    });
    res.writeHead(out.status, { 'content-type': out.type ?? 'text/plain' });
    res.end(out.body ?? '');
  }
}

/** Settings from before messaging channels kept Telegram on its own; it moves under `channels`. */
function migrateTelegram(env: ChannelEnv): void {
  const old = env.store.settings.telegram;
  if (!old) return;
  const channels = { ...env.store.settings.channels };
  if (!channels.telegram) {
    const moved: ChannelSettings = {
      enabled: old.enabled,
      config: old.token ? { token: old.token } : {},
      pairingCode: old.pairingCode || newPairingCode(),
      links: old.links.map((l) => ({ address: String(l.chatId), name: l.name, mitziChatId: l.mitziChatId, linkedAt: l.linkedAt })),
      notify: old.notify,
    };
    channels.telegram = moved;
  }
  env.store.updateSettings({ channels, telegram: undefined });
}
