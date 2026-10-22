import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OpenRouterClient } from '../../openrouter.js';
import type { BankProfile, BankStats, MemoryBackendKind, MemoryType, MemoryUnit, RecalledMemory, ReflectResult } from '../../shared/types.js';
import { newId, now } from '../store.js';
import { graphSearch, keywordSearch, parseTimeRange, reciprocalRankFusion, semanticSearch, similarity, temporalSearch } from './search.js';

/** The bank a bot owns. */
export interface BankRef {
  id: string;
  name: string;
  profile: BankProfile;
}

export interface RetainInput {
  content: string;
  context?: string;
  timestamp?: string;
  chatId?: string;
}

export interface RecallOptions {
  maxTokens?: number;
  limit?: number;
  /** Also include the bank's strongest observations, even if the query doesn't mention them. */
  includeCore?: boolean;
}

export interface ListOptions {
  type?: MemoryType;
  q?: string;
  limit: number;
  offset: number;
}

export interface MemoryBackend {
  readonly kind: MemoryBackendKind;
  /** Learns from content (e.g. a conversation exchange). Resolves once processed. */
  retain(bank: BankRef, input: RetainInput): Promise<void>;
  /** Stores one explicit fact as given. */
  remember(bank: BankRef, text: string, source: 'user' | 'assistant'): Promise<void>;
  recall(bank: BankRef, query: string, opts?: RecallOptions): Promise<RecalledMemory[]>;
  reflect(bank: BankRef, query: string, context?: string): Promise<ReflectResult>;
  list(bank: BankRef, opts: ListOptions): Promise<{ items: MemoryUnit[]; total: number }>;
  forget(bank: BankRef, id: string): Promise<void>;
  update(bank: BankRef, id: string, text: string): Promise<void>;
  stats(bank: BankRef): Promise<BankStats>;
  clear(bank: BankRef): Promise<void>;
}

export interface LlmAccess {
  client: OpenRouterClient;
  /** Model for reflect, which deserves the bot's main model. */
  model: string;
  /** Cheaper model for extraction and consolidation. */
  fastModel: string;
  embeddingModel?: string;
}

export const estimateTokens = (text: string) => Math.ceil(text.length / 4) + 6;

/** Picks memories in rank order until the token budget or count limit is reached. */
export function fitBudget<T extends { text: string }>(items: T[], maxTokens: number, limit: number): T[] {
  const out: T[] = [];
  let used = 0;
  for (const item of items) {
    const cost = estimateTokens(item.text);
    if (out.length >= limit || used + cost > maxTokens) break;
    out.push(item);
    used += cost;
  }
  return out;
}

export function extractJson(text: string): any {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The model did not return JSON');
  return JSON.parse(text.slice(start, end + 1));
}

function describeDisposition(p: BankProfile): string {
  const { skepticism: s, literalism: l, empathy: e } = p.disposition;
  return [
    `Skepticism ${s}/5: ${s >= 4 ? 'require solid evidence before believing or concluding anything; flag uncertainty' : s <= 2 ? 'take what the user says at face value' : 'weigh evidence sensibly'}.`,
    `Literalism ${l}/5: ${l >= 4 ? 'stick to what was explicitly said; do not infer' : l <= 2 ? 'read between the lines and infer reasonable implications' : 'infer only obvious implications'}.`,
    `Empathy ${e}/5: ${e >= 4 ? 'pay close attention to feelings, motivations and wellbeing' : e <= 2 ? 'focus on facts rather than feelings' : 'note emotional context when it matters'}.`,
  ].join('\n');
}

function cleanEntities(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of list) {
    if (typeof e !== 'string') continue;
    const name = e.trim().replace(/\s+/g, ' ').slice(0, 60);
    if (name.length < 2 || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return out.slice(0, 8);
}

function validDate(s: unknown): string | undefined {
  if (typeof s !== 'string' || !s.trim()) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Capitalized words and phrases, as a cheap entity guess for facts added without an LLM. */
export function guessEntities(text: string): string[] {
  const matches = text.match(/\b[A-Z][\p{L}\d]+(?:\s+[A-Z][\p{L}\d]+)*/gu) ?? [];
  return cleanEntities(matches.filter((m, i) => !(i === 0 && text.startsWith(m) && !m.includes(' ')) && !/^(The|I|User|A|An)$/.test(m)));
}

interface BankFile {
  units: MemoryUnit[];
  /** Embedding vectors by unit id, when an embedding model is configured. */
  vectors: Record<string, number[]>;
  lastRetainAt?: string;
}

const EXTRACT_PROMPT = `You maintain the long-term memory of an AI assistant called {name}. Extract memories worth keeping from the conversation excerpt below.

Bank mission: {mission}
Today is {date}.
{disposition}

Return JSON only: {"facts": [{"text": "...", "type": "world" | "experience", "entities": ["..."], "occurred": "YYYY-MM-DD" | null}]}

- "world": facts about the user, other people, places, organizations, projects, preferences and plans. Example: "The user's daughter Maya started first grade in September 2026."
- "experience": what the assistant itself did, recommended or learned in this conversation that matters later. Example: "I recommended Postgres for the user's inventory app and they chose it."
- Each fact is one self-contained sentence. Refer to the user as "the user", resolve pronouns, and turn relative dates into absolute ones.
- "entities" lists the named people, places, organizations, products and projects the fact is about.
- Keep only durable information worth recalling weeks later. Skip greetings, small talk, general knowledge and one-off task details. Never store passwords, keys or other secrets.
- Return {"facts": []} when nothing qualifies. At most 8 facts.

<conversation>
{content}
</conversation>`;

const CONSOLIDATE_PROMPT = `You maintain "observations" for an AI assistant's memory: consolidated beliefs about the user and their world, each backed by evidence facts.

Bank mission: {mission}
{disposition}

New facts:
{newFacts}

Related earlier facts:
{oldFacts}

Existing related observations:
{observations}

Return JSON only: {"update": [{"id": "observation id", "text": "revised observation", "evidence": ["fact ids"]}], "create": [{"text": "...", "evidence": ["fact ids"], "entities": ["..."]}]}

- Create an observation for a durable pattern, preference, trait, goal or situation that the facts support, usually combining several facts. Don't just restate one trivial fact.
- Update an observation when new facts strengthen, refine or contradict it; rewrite it to reflect what is true now (e.g. "The user used to …, but since October 2026 …").
- Evidence lists the ids of the facts that support the observation.
- One or two sentences each. Return empty arrays when nothing should change.`;

const REFLECT_PROMPT = `You are the reflective memory of {name}. Answer the question using the memories below: reason over them, connect related facts, and say how confident you are. If the memories don't answer it, say so plainly rather than guessing. Cite the memories you rely on as [id].

Bank mission: {mission}
{disposition}
Today is {date}.

Memories:
{memories}

Question: {query}{context}`;

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m);
}

/**
 * Built-in memory engine: one JSON file per bank, Hindsight-style
 * retain (extract → dedupe → consolidate), multi-strategy recall and reflect.
 */
export class BuiltinMemory implements MemoryBackend {
  readonly kind = 'builtin' as const;
  private readonly banks = new Map<string, BankFile>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly pending = new Map<string, number>();
  private embeddingsFailed = false;

  constructor(
    private readonly dir: string,
    private readonly llm: () => LlmAccess,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  private file(id: string): string {
    if (!/^[\w-]+$/.test(id)) throw new Error(`Invalid bank id: ${id}`);
    return join(this.dir, `${id}.json`);
  }

  private bank(id: string): BankFile {
    let bank = this.banks.get(id);
    if (!bank) {
      try {
        bank = { vectors: {}, ...JSON.parse(readFileSync(this.file(id), 'utf8')) } as BankFile;
      } catch {
        bank = { units: [], vectors: {} };
      }
      this.banks.set(id, bank);
    }
    return bank;
  }

  private save(id: string): void {
    const path = this.file(id);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.bank(id)));
    renameSync(tmp, path);
  }

  /** Runs jobs for one bank one at a time, so concurrent retains can't clobber each other. */
  private enqueue(id: string, job: () => Promise<void>): Promise<void> {
    this.pending.set(id, (this.pending.get(id) ?? 0) + 1);
    const run = (this.queues.get(id) ?? Promise.resolve()).catch(() => {}).then(job);
    const tail = run.finally(() => this.pending.set(id, (this.pending.get(id) ?? 1) - 1));
    this.queues.set(id, tail.catch(() => {}));
    return tail;
  }

  private async embed(texts: string[]): Promise<number[][] | undefined> {
    const { client, embeddingModel } = this.llm();
    if (!embeddingModel || this.embeddingsFailed || !texts.length) return undefined;
    try {
      return await client.embed(embeddingModel, texts);
    } catch (err) {
      // Don't retry a broken embedding setup on every message.
      this.embeddingsFailed = true;
      setTimeout(() => (this.embeddingsFailed = false), 10 * 60_000).unref();
      console.warn(`Memory: embeddings disabled for 10 minutes: ${(err as Error).message}`);
      return undefined;
    }
  }

  private async complete(prompt: string, model: string): Promise<string> {
    const { client } = this.llm();
    const res = await client.chat({ model, messages: [{ role: 'user', content: prompt }], temperature: 0 });
    return res.content;
  }

  retain(bank: BankRef, input: RetainInput): Promise<void> {
    return this.enqueue(bank.id, async () => {
      const { fastModel } = this.llm();
      const values = {
        name: bank.name,
        mission: bank.profile.mission.trim() || 'Remember what will help in future conversations with this user.',
        date: new Date().toISOString().slice(0, 10),
        disposition: describeDisposition(bank.profile),
        content: input.content.slice(0, 24_000),
      };
      const raw = extractJson(await this.complete(fill(EXTRACT_PROMPT, values), fastModel));
      const facts: { text: string; type: MemoryType; entities: string[]; occurred?: string }[] = (Array.isArray(raw?.facts) ? raw.facts : [])
        .filter((f: any) => typeof f?.text === 'string' && f.text.trim().length > 8)
        .slice(0, 8)
        .map((f: any) => ({ text: f.text.trim(), type: f.type === 'experience' ? 'experience' : 'world', entities: cleanEntities(f.entities), occurred: f.occurred }));

      const data = this.bank(bank.id);
      const added: MemoryUnit[] = [];
      for (const f of facts) {
        const duplicate = data.units.find((u) => u.type === f.type && similarity(u.text, f.text) >= 0.8);
        if (duplicate) {
          duplicate.mentionedAt = input.timestamp ?? now();
          continue;
        }
        const unit: MemoryUnit = {
          id: newId(),
          type: f.type,
          text: f.text,
          entities: f.entities,
          occurredAt: validDate(f.occurred),
          mentionedAt: input.timestamp ?? now(),
          context: input.context,
          source: 'conversation',
          chatId: input.chatId,
        };
        data.units.push(unit);
        added.push(unit);
      }
      data.lastRetainAt = now();
      await this.index(bank.id, added);
      this.save(bank.id);
      if (added.length) await this.consolidate(bank, added);
    });
  }

  async remember(bank: BankRef, text: string, source: 'user' | 'assistant'): Promise<void> {
    // Stored immediately; indexing and consolidation follow in the background.
    const unit: MemoryUnit = { id: newId(), type: 'world', text: text.trim(), entities: guessEntities(text), mentionedAt: now(), source };
    this.bank(bank.id).units.push(unit);
    this.save(bank.id);
    void this.enqueue(bank.id, async () => {
      await this.index(bank.id, [unit]);
      this.save(bank.id);
      await this.consolidate(bank, [unit]);
    }).catch((err) => console.warn(`Memory: consolidation failed for bank ${bank.id}: ${err.message}`));
  }

  private async index(bankId: string, units: MemoryUnit[]): Promise<void> {
    const vectors = await this.embed(units.map((u) => u.text));
    if (!vectors) return;
    const data = this.bank(bankId);
    units.forEach((u, i) => vectors[i] && (data.vectors[u.id] = vectors[i]));
  }

  /** Folds new facts into observations: updates beliefs they bear on and forms new ones. */
  private async consolidate(bank: BankRef, added: MemoryUnit[]): Promise<void> {
    const data = this.bank(bank.id);
    const query = added.map((u) => `${u.text} ${u.entities.join(' ')}`).join('\n');
    const observations = data.units.filter((u) => u.type === 'observation');
    const facts = data.units.filter((u) => u.type !== 'observation' && !added.includes(u));
    const pick = (pool: MemoryUnit[], n: number) => {
      const ids = reciprocalRankFusion([
        { name: 'keyword', ids: keywordSearch(query, pool) },
        { name: 'graph', ids: graphSearch(query, pool) },
      ]).slice(0, n);
      return ids.map((f) => pool.find((u) => u.id === f.id)!).filter(Boolean);
    };
    const related = pick(observations, 8);
    const earlier = pick(facts, 10);
    const line = (u: MemoryUnit) => `- [${u.id}] ${u.text}`;
    const prompt = fill(CONSOLIDATE_PROMPT, {
      mission: bank.profile.mission.trim() || 'Remember what will help in future conversations with this user.',
      disposition: describeDisposition(bank.profile),
      newFacts: added.map(line).join('\n'),
      oldFacts: earlier.map(line).join('\n') || '(none)',
      observations: related.map((o) => `- [${o.id}] (evidence: ${o.evidence?.length ?? 0}) ${o.text}`).join('\n') || '(none)',
    });
    const raw = extractJson(await this.complete(prompt, this.llm().fastModel));

    const factIds = new Set(data.units.filter((u) => u.type !== 'observation').map((u) => u.id));
    const evidenceOf = (list: unknown) => (Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string' && factIds.has(id)) : []);
    const entitiesOf = (ids: string[], extra: unknown) => cleanEntities([...ids.flatMap((id) => data.units.find((u) => u.id === id)?.entities ?? []), ...(Array.isArray(extra) ? extra : [])]);
    const confidence = (n: number) => Math.min(0.95, 0.35 + 0.15 * n);
    const changed: MemoryUnit[] = [];

    for (const u of Array.isArray(raw?.update) ? raw.update : []) {
      const obs = observations.find((o) => o.id === u?.id);
      if (!obs || typeof u.text !== 'string' || !u.text.trim()) continue;
      obs.text = u.text.trim();
      obs.evidence = [...new Set([...(obs.evidence ?? []), ...evidenceOf(u.evidence)])].slice(-40);
      obs.entities = entitiesOf(obs.evidence, obs.entities);
      obs.confidence = confidence(obs.evidence.length);
      obs.updatedAt = now();
      changed.push(obs);
    }
    // Skeptical banks need corroboration before forming a new belief.
    const minEvidence = bank.profile.disposition.skepticism >= 4 ? 2 : 1;
    for (const c of Array.isArray(raw?.create) ? raw.create : []) {
      const evidence = evidenceOf(c?.evidence);
      if (typeof c?.text !== 'string' || !c.text.trim() || evidence.length < minEvidence) continue;
      if (observations.some((o) => similarity(o.text, c.text) >= 0.8)) continue;
      const obs: MemoryUnit = {
        id: newId(),
        type: 'observation',
        text: c.text.trim(),
        entities: entitiesOf(evidence, c.entities),
        mentionedAt: now(),
        source: 'assistant',
        evidence,
        confidence: confidence(evidence.length),
      };
      data.units.push(obs);
      changed.push(obs);
    }
    if (changed.length) {
      await this.index(bank.id, changed);
      this.save(bank.id);
    }
  }

  async recall(bank: BankRef, query: string, opts: RecallOptions = {}): Promise<RecalledMemory[]> {
    const { maxTokens = 1200, limit = 12, includeCore = true } = opts;
    const data = this.bank(bank.id);
    if (!data.units.length) return [];
    const lists: { name: string; ids: string[]; weight?: number }[] = [
      { name: 'keyword', ids: keywordSearch(query, data.units) },
      { name: 'graph', ids: graphSearch(query, data.units) },
    ];
    const range = parseTimeRange(query);
    if (range) lists.push({ name: 'temporal', ids: temporalSearch(range, data.units) });
    if (Object.keys(data.vectors).length) {
      const [qv] = (await this.embed([query])) ?? [];
      if (qv) lists.push({ name: 'semantic', ids: semanticSearch(qv, new Map(Object.entries(data.vectors))) });
    }

    const byId = new Map(data.units.map((u) => [u.id, u]));
    const fused = reciprocalRankFusion(lists)
      .map((f) => {
        const u = byId.get(f.id)!;
        // Consolidated observations summarize many facts, so they get a small boost.
        const boost = u.type === 'observation' ? 1.2 + 0.3 * (u.confidence ?? 0.5) : 1;
        return { ...f, score: f.score * boost };
      })
      .sort((a, b) => b.score - a.score);

    const ranked: RecalledMemory[] = fused.map((f) => toRecalled(byId.get(f.id)!, f.strategies, f.score));
    if (includeCore) {
      // The strongest beliefs work like a profile: worth having even when the query doesn't name them.
      const core = data.units
        .filter((u) => u.type === 'observation' && !ranked.some((r) => r.id === u.id))
        .sort((a, b) => (b.evidence?.length ?? 0) - (a.evidence?.length ?? 0) || (b.confidence ?? 0) - (a.confidence ?? 0))
        .slice(0, 3)
        .map((u) => toRecalled(u, ['core'], 0));
      ranked.push(...core);
    }
    return fitBudget(ranked, maxTokens, limit);
  }

  async reflect(bank: BankRef, query: string, context?: string): Promise<ReflectResult> {
    const memories = await this.recall(bank, query, { maxTokens: 3000, limit: 40 });
    if (!memories.length) return { text: "I don't have any memories about that yet.", basedOn: [] };
    const prompt = fill(REFLECT_PROMPT, {
      name: bank.name,
      mission: bank.profile.mission.trim() || 'Remember what will help in future conversations with this user.',
      disposition: describeDisposition(bank.profile),
      date: new Date().toISOString().slice(0, 10),
      memories: memories.map((m) => `- [${m.id}] (${m.type}${m.occurredAt ? `, ${m.occurredAt.slice(0, 10)}` : ''}) ${m.text}`).join('\n'),
      query,
      context: context ? `\n\nContext: ${context}` : '',
    });
    const text = await this.complete(prompt, this.llm().model);
    return { text: text.trim(), basedOn: memories };
  }

  async list(bank: BankRef, opts: ListOptions): Promise<{ items: MemoryUnit[]; total: number }> {
    const q = opts.q?.trim().toLowerCase();
    const all = this.bank(bank.id)
      .units.filter((u) => (!opts.type || u.type === opts.type) && (!q || u.text.toLowerCase().includes(q) || u.entities.some((e) => e.toLowerCase().includes(q))))
      .sort((a, b) => (b.updatedAt ?? b.mentionedAt).localeCompare(a.updatedAt ?? a.mentionedAt));
    return { items: all.slice(opts.offset, opts.offset + opts.limit), total: all.length };
  }

  forget(bank: BankRef, id: string): Promise<void> {
    return this.enqueue(bank.id, async () => {
      const data = this.bank(bank.id);
      const before = data.units.length;
      data.units = data.units.filter((u) => u.id !== id);
      if (data.units.length === before) throw new Error(`No memory with id ${id}`);
      delete data.vectors[id];
      // Observations lose that evidence; ones left with none are dropped.
      for (const o of data.units) if (o.evidence?.includes(id)) o.evidence = o.evidence.filter((e) => e !== id);
      data.units = data.units.filter((u) => u.type !== 'observation' || u.source !== 'assistant' || (u.evidence?.length ?? 0) > 0);
      this.save(bank.id);
    });
  }

  update(bank: BankRef, id: string, text: string): Promise<void> {
    return this.enqueue(bank.id, async () => {
      const unit = this.bank(bank.id).units.find((u) => u.id === id);
      if (!unit) throw new Error(`No memory with id ${id}`);
      unit.text = text.trim();
      unit.updatedAt = now();
      await this.index(bank.id, [unit]);
      this.save(bank.id);
    });
  }

  async stats(bank: BankRef): Promise<BankStats> {
    const data = this.bank(bank.id);
    const count = (t: MemoryType) => data.units.filter((u) => u.type === t).length;
    return {
      world: count('world'),
      experience: count('experience'),
      observation: count('observation'),
      entities: new Set(data.units.flatMap((u) => u.entities.map((e) => e.toLowerCase()))).size,
      pending: this.pending.get(bank.id) ?? 0,
      lastRetainAt: data.lastRetainAt,
    };
  }

  clear(bank: BankRef): Promise<void> {
    return this.enqueue(bank.id, async () => {
      this.banks.set(bank.id, { units: [], vectors: {} });
      rmSync(this.file(bank.id), { force: true });
    });
  }

  /** Waits for queued retains (used by tests and shutdown). */
  async idle(bankId: string): Promise<void> {
    await this.queues.get(bankId);
  }
}

function toRecalled(u: MemoryUnit, strategies: string[], score: number): RecalledMemory {
  return { id: u.id, type: u.type, text: u.text, occurredAt: u.occurredAt, confidence: u.confidence, strategies, score };
}
