// Search across everything Mitzi keeps: chat messages, artifacts and memories. Keyword ranking (BM25)
// always; with an embedding model set, meaning-based ranking too, merged by reciprocal rank fusion.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LlmClient } from '../openrouter.js';
import type { ChatMessage, SearchHit, SearchKind } from '../shared/types.js';
import type { MemoryService } from './memory/index.js';
import { cosine, reciprocalRankFusion, tokenize } from './memory/search.js';
import type { Store } from './store.js';

interface Doc {
  key: string;
  kind: SearchKind;
  text: string;
  title: string;
  ts: string;
  chatId?: string;
  index?: number;
  artifactId?: string;
  memoryId?: string;
  botId?: string;
  projectId?: string;
  terms: Map<string, number>;
  length: number;
}

function messageText(m: ChatMessage): string {
  if (typeof m.content === 'string') return m.content;
  return (m.content ?? []).map((p) => (p.type === 'text' ? p.text : '')).join(' ');
}

function termCounts(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

/** The part of a text around the best cluster of query words, with the matches marked. */
export function snippet(text: string, query: string, width = 220): { text: string; marks: [number, number][] } {
  const flat = text
    .replace(/<attachment[\s\S]*?<\/attachment>/g, ' ')
    // Markdown symbols read as noise in a one-line preview.
    .replace(/```\w*/g, ' ')
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+[.)]|>)\s+/gm, '')
    .replace(/(\*\*|__|`|~~)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu) ?? [])].filter((w) => w.length > 1);
  const lower = flat.toLowerCase();
  // Prefix matches, so "sleep" finds "sleeping" and a stemmed word still lights up.
  const hits: [number, number][] = [];
  for (const w of words) {
    const stemmed = w.length > 4 ? w.replace(/(ing|ed|es|s)$/, '') : w;
    let i = lower.indexOf(stemmed);
    while (i >= 0 && hits.length < 200) {
      const before = i === 0 ? ' ' : lower[i - 1];
      if (!/[\p{L}\p{N}]/u.test(before)) {
        let end = i + stemmed.length;
        while (end < lower.length && /[\p{L}\p{N}]/u.test(lower[end])) end++;
        hits.push([i, end]);
      }
      i = lower.indexOf(stemmed, i + 1);
    }
  }
  hits.sort((a, b) => a[0] - b[0]);
  // The window holding the most distinct matches.
  let start = 0;
  let best = -1;
  for (const [s] of hits) {
    const inWindow = new Set(hits.filter(([a, b]) => a >= s - 40 && b <= s - 40 + width).map(([a, b]) => lower.slice(a, b)));
    if (inWindow.size > best) {
      best = inWindow.size;
      start = Math.max(0, s - 40);
    }
  }
  if (start > 0) {
    const space = flat.indexOf(' ', start);
    if (space > 0 && space - start < 20) start = space + 1;
  }
  const end = Math.min(flat.length, start + width);
  const text2 = `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
  const offset = start > 0 ? 1 - start : -start;
  const marks = hits.filter(([a, b]) => a >= start && b <= end).map(([a, b]) => [a + offset, b + offset] as [number, number]);
  return { text: text2, marks };
}

export interface SearchOptions {
  kinds?: SearchKind[];
  projectId?: string;
  botId?: string;
  limit?: number;
}

export class SearchIndex {
  /** Documents per source, rebuilt when the source changes. */
  private chats = new Map<string, { stamp: string; docs: Doc[] }>();
  private artifacts = new Map<string, { stamp: string; doc: Doc }>();
  private memories?: { stamp: string; docs: Doc[] };
  private vectors = new Map<string, number[]>();
  private vectorsFile: string;
  private indexing = false;

  constructor(
    dir: string,
    private readonly store: Store,
    private readonly memory: MemoryService,
    private readonly embedder: () => { client: LlmClient; model: string } | undefined,
  ) {
    mkdirSync(dir, { recursive: true });
    this.vectorsFile = join(dir, 'vectors.json');
    try {
      if (existsSync(this.vectorsFile)) this.vectors = new Map(Object.entries(JSON.parse(readFileSync(this.vectorsFile, 'utf8'))));
    } catch {
      // Rebuilt on demand.
    }
  }

  private doc(d: Omit<Doc, 'terms' | 'length'>): Doc {
    const tokens = tokenize(`${d.title} ${d.text}`);
    return { ...d, terms: termCounts(tokens), length: tokens.length };
  }

  /** All documents, refreshing only what changed since the last search. */
  private async docs(): Promise<Doc[]> {
    const { store } = this;
    const seen = new Set<string>();
    for (const chat of store.chats.all()) {
      seen.add(chat.id);
      const stamp = `${chat.updatedAt}:${chat.messages.length}:${chat.title}:${chat.projectId ?? ''}`;
      if (this.chats.get(chat.id)?.stamp === stamp) continue;
      const docs: Doc[] = [];
      chat.messages.forEach((m, index) => {
        if ((m.role !== 'user' && m.role !== 'assistant') || m.auto === 'goal') return;
        const text = (m.command ?? messageText(m)).replace(/<attachment name="([^"]*)">[\s\S]*?<\/attachment>/g, '[$1]').trim();
        if (!text) return;
        docs.push(
          this.doc({
            key: `m:${chat.id}:${index}`,
            kind: 'message',
            text,
            title: chat.title,
            ts: m.ts ? new Date(m.ts).toISOString() : chat.updatedAt,
            chatId: chat.id,
            index,
            botId: chat.botId,
            projectId: chat.projectId,
          }),
        );
      });
      this.chats.set(chat.id, { stamp, docs });
    }
    for (const id of this.chats.keys()) if (!seen.has(id)) this.chats.delete(id);

    const seenArtifacts = new Set<string>();
    for (const a of store.artifacts.all()) {
      seenArtifacts.add(a.id);
      const stamp = `${a.updatedAt}:${a.versions.length}`;
      if (this.artifacts.get(a.id)?.stamp === stamp) continue;
      const media = ['image', 'video', 'audio'].includes(a.type);
      const content = media ? (a.versions.at(-1)?.note ?? '') : (a.versions.at(-1)?.content ?? '');
      this.artifacts.set(a.id, {
        stamp,
        doc: this.doc({ key: `a:${a.id}`, kind: 'artifact', text: content.slice(0, 20_000), title: a.title, ts: a.updatedAt, artifactId: a.id, chatId: a.chatId, projectId: a.projectId }),
      });
    }
    for (const id of this.artifacts.keys()) if (!seenArtifacts.has(id)) this.artifacts.delete(id);

    // Memories of the built-in engine (a Hindsight server is searched on its own pages).
    const bots = store.bots.all();
    const lists = await Promise.all(bots.map((b) => this.memory.builtin.list(this.memory.bankFor(b), { limit: 5000, offset: 0 }).catch(() => ({ items: [], total: 0 }))));
    const stamp = lists.map((l, i) => `${bots[i].id}:${l.total}:${l.items[0]?.updatedAt ?? l.items[0]?.mentionedAt ?? ''}`).join('|');
    if (this.memories?.stamp !== stamp) {
      this.memories = {
        stamp,
        docs: lists.flatMap((l, i) =>
          l.items.map((u) =>
            this.doc({ key: `k:${bots[i].id}:${u.id}`, kind: 'memory', text: u.text, title: `${bots[i].emoji} ${bots[i].name}`, ts: u.updatedAt ?? u.mentionedAt, memoryId: u.id, botId: bots[i].id }),
          ),
        ),
      };
    }
    return [...[...this.chats.values()].flatMap((c) => c.docs), ...[...this.artifacts.values()].map((a) => a.doc), ...this.memories.docs];
  }

  private bm25(query: string, docs: Doc[]): Doc[] {
    const q = [...new Set(tokenize(query))];
    if (!q.length || !docs.length) return [];
    const avg = docs.reduce((n, d) => n + d.length, 0) / docs.length || 1;
    const df = new Map<string, number>();
    for (const term of q) df.set(term, docs.reduce((n, d) => n + (d.terms.has(term) ? 1 : 0), 0));
    const phrase = query.trim().toLowerCase();
    const scored: { d: Doc; s: number }[] = [];
    for (const d of docs) {
      let s = 0;
      let matched = 0;
      for (const term of q) {
        const tf = d.terms.get(term);
        if (!tf) continue;
        matched++;
        const n = df.get(term)!;
        s += Math.log(1 + (docs.length - n + 0.5) / (n + 0.5)) * ((tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * d.length) / avg)));
      }
      if (!s) continue;
      // Every word, and the exact phrase, count extra.
      if (matched === q.length) s *= 1.3;
      if (phrase.includes(' ') && `${d.title} ${d.text}`.toLowerCase().includes(phrase)) s *= 1.6;
      scored.push({ d, s });
    }
    return scored.sort((a, b) => b.s - a.s).map((x) => x.d);
  }

  private hash(d: Doc): string {
    return createHash('sha1').update(`${d.title}\n${d.text.slice(0, 4000)}`).digest('hex').slice(0, 20);
  }

  /** Embeds documents that have no vector yet, newest first, in the background. */
  private backfill(docs: Doc[]): void {
    const e = this.embedder();
    if (!e || this.indexing) return;
    const missing = docs
      .filter((d) => !this.vectors.has(this.hash(d)))
      .sort((a, b) => b.ts.localeCompare(a.ts))
      .slice(0, 2000);
    if (!missing.length) return;
    this.indexing = true;
    void (async () => {
      try {
        for (let i = 0; i < missing.length; i += 64) {
          const batch = missing.slice(i, i + 64);
          const vecs = await e.client.embed(e.model, batch.map((d) => `${d.title}\n${d.text.slice(0, 4000)}`));
          batch.forEach((d, j) => vecs[j] && this.vectors.set(this.hash(d), vecs[j]));
        }
        writeFileSync(this.vectorsFile, JSON.stringify(Object.fromEntries(this.vectors)));
      } catch (err) {
        console.warn(`Search: embedding failed: ${(err as Error).message}`);
      } finally {
        this.indexing = false;
      }
    })();
  }

  async search(query: string, opts: SearchOptions = {}): Promise<{ hits: SearchHit[]; semantic: boolean }> {
    const all = (await this.docs()).filter(
      (d) => (!opts.kinds?.length || opts.kinds.includes(d.kind)) && (!opts.projectId || d.projectId === opts.projectId) && (!opts.botId || d.botId === opts.botId),
    );
    const keyword = this.bm25(query, all);
    let ranked = keyword;
    let semantic = false;
    const e = this.embedder();
    if (e && query.trim().length > 2) {
      try {
        const [qv] = await e.client.embed(e.model, [query]);
        const byMeaning = all
          .map((d) => ({ d, s: this.vectors.get(this.hash(d)) }))
          .filter((x): x is { d: Doc; s: number[] } => !!x.s)
          .map((x) => ({ d: x.d, score: cosine(qv, x.s) }))
          .filter((x) => x.score > 0.3)
          .sort((a, b) => b.score - a.score)
          .slice(0, 50)
          .map((x) => x.d);
        if (byMeaning.length) {
          semantic = true;
          const byKey = new Map(all.map((d) => [d.key, d]));
          ranked = reciprocalRankFusion([
            { name: 'keyword', ids: keyword.slice(0, 100).map((d) => d.key), weight: 1 },
            { name: 'meaning', ids: byMeaning.map((d) => d.key), weight: 0.8 },
          ]).map((f) => byKey.get(f.id)!);
        }
      } catch {
        // Keyword results only.
      }
      this.backfill(all);
    }
    const limit = opts.limit ?? 40;
    const hits: SearchHit[] = [];
    // Messages are grouped by chat: the best one, plus how many others matched.
    const chatHits = new Map<string, SearchHit>();
    for (const d of ranked) {
      if (hits.length >= limit) break;
      if (d.kind === 'message' && d.chatId) {
        const existing = chatHits.get(d.chatId);
        if (existing) {
          existing.more = (existing.more ?? 0) + 1;
          continue;
        }
      }
      const snip = snippet(d.text, query);
      const hit: SearchHit = {
        kind: d.kind,
        title: d.title,
        snippet: snip.text,
        marks: snip.marks,
        ts: d.ts,
        chatId: d.chatId,
        index: d.index,
        artifactId: d.artifactId,
        memoryId: d.memoryId,
        botId: d.botId,
        projectId: d.projectId,
      };
      if (d.kind === 'message' && d.chatId) chatHits.set(d.chatId, hit);
      hits.push(hit);
    }
    return { hits, semantic };
  }
}
