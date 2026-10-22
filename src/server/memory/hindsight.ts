// Adapter for an external Hindsight server (https://github.com/vectorize-io/hindsight).
// Paths and payloads follow the official client, @vectorize-io/hindsight-client.
import type { BankStats, MemoryType, MemoryUnit, RecalledMemory, ReflectResult } from '../../shared/types.js';
import type { BankRef, ListOptions, MemoryBackend, RecallOptions, RetainInput } from './engine.js';
import { fitBudget } from './engine.js';

const TYPES: MemoryType[] = ['world', 'experience', 'observation'];

function asType(t: unknown): MemoryType {
  return TYPES.includes(t as MemoryType) ? (t as MemoryType) : 'world';
}

export class HindsightMemory implements MemoryBackend {
  readonly kind = 'hindsight' as const;
  /** Profiles already sent, so banks are created/updated once per change. */
  private readonly synced = new Map<string, string>();

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
  ) {}

  /** Bot banks are namespaced so Mitzi can share a server with other apps. */
  private bankPath(bank: BankRef, suffix = ''): string {
    return `/v1/default/banks/${encodeURIComponent(`mitzi-${bank.id}`)}${suffix}`;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl.replace(/\/+$/, '')}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text;
      try {
        const json = JSON.parse(text);
        detail = typeof json.detail === 'string' ? json.detail : JSON.stringify(json.detail ?? json);
      } catch {
        // Keep the raw text.
      }
      throw new Error(`Hindsight ${method} ${path} failed (${res.status}): ${detail.slice(0, 300)}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  private async ensureBank(bank: BankRef): Promise<void> {
    const profile = JSON.stringify({ name: bank.name, ...bank.profile });
    if (this.synced.get(bank.id) === profile) return;
    await this.request('PUT', this.bankPath(bank), {
      name: bank.name,
      mission: bank.profile.mission || undefined,
      disposition: bank.profile.disposition,
    });
    this.synced.set(bank.id, profile);
  }

  async retain(bank: BankRef, input: RetainInput): Promise<void> {
    await this.ensureBank(bank);
    await this.request('POST', this.bankPath(bank, '/memories'), {
      items: [{ content: input.content, context: input.context, timestamp: input.timestamp, metadata: input.chatId ? { chat_id: input.chatId } : undefined }],
      async: true,
    });
  }

  async remember(bank: BankRef, text: string, source: 'user' | 'assistant'): Promise<void> {
    await this.retain(bank, { content: text, context: source === 'user' ? 'Added manually by the user' : 'Saved by the assistant' });
  }

  async recall(bank: BankRef, query: string, opts: RecallOptions = {}): Promise<RecalledMemory[]> {
    await this.ensureBank(bank);
    const res = await this.request<{ results?: any[] }>('POST', this.bankPath(bank, '/memories/recall'), {
      query,
      budget: 'mid',
      max_tokens: opts.maxTokens ?? 1200,
    });
    const items: RecalledMemory[] = (res.results ?? []).map((r) => ({
      id: String(r.id),
      type: asType(r.type),
      text: String(r.text ?? ''),
      occurredAt: r.occurred_start ?? r.mentioned_at ?? undefined,
      strategies: ['hindsight'],
    }));
    return fitBudget(items, opts.maxTokens ?? 1200, opts.limit ?? 12);
  }

  async reflect(bank: BankRef, query: string, context?: string): Promise<ReflectResult> {
    await this.ensureBank(bank);
    const res = await this.request<{ text?: string }>('POST', this.bankPath(bank, '/reflect'), { query, context, budget: 'mid' });
    return { text: res.text ?? '', basedOn: [] };
  }

  async list(bank: BankRef, opts: ListOptions): Promise<{ items: MemoryUnit[]; total: number }> {
    await this.ensureBank(bank);
    const params = new URLSearchParams({ limit: String(opts.limit), offset: String(opts.offset) });
    if (opts.type) params.set('type', opts.type);
    if (opts.q) params.set('q', opts.q);
    const res = await this.request<{ items?: any[]; total?: number }>('GET', `${this.bankPath(bank, '/memories/list')}?${params}`);
    const items: MemoryUnit[] = (res.items ?? []).map((m) => ({
      id: String(m.id),
      type: asType(m.fact_type),
      text: String(m.text ?? ''),
      entities: typeof m.entities === 'string' ? m.entities.split(',').map((e: string) => e.trim()).filter(Boolean) : [],
      occurredAt: m.occurred_start ?? undefined,
      mentionedAt: m.mentioned_at ?? m.date ?? new Date().toISOString(),
      context: m.context || undefined,
      source: 'conversation',
      evidence: Array.isArray(m.source_memory_ids) ? m.source_memory_ids : undefined,
    }));
    return { items, total: res.total ?? items.length };
  }

  async forget(): Promise<void> {
    throw new Error('Deleting single memories is managed in the Hindsight UI when using a Hindsight server.');
  }

  async update(): Promise<void> {
    throw new Error('Editing memories is managed in the Hindsight UI when using a Hindsight server.');
  }

  async stats(bank: BankRef): Promise<BankStats> {
    const totals = await Promise.all(TYPES.map((type) => this.list(bank, { type, limit: 1, offset: 0 }).then((r) => r.total)));
    return { world: totals[0], experience: totals[1], observation: totals[2], entities: 0, pending: 0 };
  }

  async clear(bank: BankRef): Promise<void> {
    await this.request('DELETE', this.bankPath(bank));
    this.synced.delete(bank.id);
  }

  /** Checks the server is reachable and the key is accepted. */
  async check(): Promise<void> {
    await this.request('GET', '/v1/default/banks');
  }
}
