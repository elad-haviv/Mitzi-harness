// Retrieval strategies for the built-in memory engine. Like Hindsight's recall,
// several independent strategies rank memories and reciprocal rank fusion merges them.
import type { MemoryUnit } from '../../shared/types.js';

const STOPWORDS = new Set(
  (
    'a an and are as at be been but by can could did do does for from had has have he her his how i if in into is it its ' +
    'me my no not of on or our she so than that the their them then there these they this to was we were what when where ' +
    'which who why will with would you your about just like also any some all more most very really please tell know think ' +
    'want get got make made let us'
  ).split(' '),
);

function stem(word: string): string {
  if (word.length > 4 && word.endsWith("'s")) word = word.slice(0, -2);
  if (word.length > 5 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu) ?? [])
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map(stem);
}

/** Okapi BM25 over memory texts (plus their entities). Returns ids, best first. */
export function keywordSearch(query: string, units: MemoryUnit[], limit = 50): string[] {
  const q = [...new Set(tokenize(query))];
  if (!q.length || !units.length) return [];
  const docs = units.map((u) => tokenize(`${u.text} ${u.entities.join(' ')}`));
  const avgLen = docs.reduce((n, d) => n + d.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const k1 = 1.2;
  const b = 0.75;
  const scored = docs.map((d, i) => {
    let score = 0;
    for (const term of q) {
      const n = df.get(term);
      if (!n) continue;
      const tf = d.filter((t) => t === term).length;
      if (!tf) continue;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * d.length) / avgLen)));
    }
    return { id: units[i].id, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.id);
}

/**
 * Entity-graph search: memories that mention entities named in the query rank first,
 * then memories about entities one hop away (mentioned alongside them elsewhere).
 */
export function graphSearch(query: string, units: MemoryUnit[], limit = 50): string[] {
  const text = ` ${query.toLowerCase()} `;
  const queryTokens = new Set(tokenize(query));
  const byEntity = new Map<string, MemoryUnit[]>();
  for (const u of units) for (const e of u.entities) byEntity.set(e.toLowerCase(), [...(byEntity.get(e.toLowerCase()) ?? []), u]);

  const matched = [...byEntity.keys()].filter((e) => {
    const escaped = e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`[^\\p{L}\\p{N}]${escaped}[^\\p{L}\\p{N}]`, 'u').test(text)) return true;
    // Single-word entities also match their stemmed form ("Maya's" → maya).
    const tokens = tokenize(e);
    return tokens.length === 1 && queryTokens.has(tokens[0]);
  });
  if (!matched.length) return [];

  const direct = new Map<string, number>();
  for (const e of matched) for (const u of byEntity.get(e)!) direct.set(u.id, (direct.get(u.id) ?? 0) + 1);

  const neighbors = new Set<string>();
  for (const e of matched) for (const u of byEntity.get(e)!) for (const other of u.entities) if (!matched.includes(other.toLowerCase())) neighbors.add(other.toLowerCase());
  const hop = new Map<string, number>();
  for (const e of neighbors) for (const u of byEntity.get(e) ?? []) if (!direct.has(u.id)) hop.set(u.id, (hop.get(u.id) ?? 0) + 1);

  const rank = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  return [...rank(direct), ...rank(hop)].slice(0, limit);
}

export interface TimeRange {
  start: Date;
  end: Date;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Recognizes common time expressions ("yesterday", "last week", "in March", "3 days ago", "2025"). */
export function parseTimeRange(query: string, now = new Date()): TimeRange | undefined {
  const q = query.toLowerCase();
  const day = 86_400_000;
  const today = startOfDay(now);
  if (/\btoday\b|\bthis morning\b|\btonight\b/.test(q)) return { start: today, end: now };
  if (/\byesterday\b/.test(q)) return { start: new Date(today.getTime() - day), end: today };
  // Weeks start on Monday.
  const monday = new Date(today.getTime() - ((today.getDay() + 6) % 7) * day);
  if (/\bthis week\b/.test(q)) return { start: monday, end: now };
  if (/\blast week\b/.test(q)) return { start: new Date(monday.getTime() - 7 * day), end: monday };
  if (/\bthis month\b/.test(q)) return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: now };
  if (/\blast month\b/.test(q)) return { start: new Date(now.getFullYear(), now.getMonth() - 1, 1), end: new Date(now.getFullYear(), now.getMonth(), 1) };
  if (/\bthis year\b/.test(q)) return { start: new Date(now.getFullYear(), 0, 1), end: now };
  if (/\blast year\b/.test(q)) return { start: new Date(now.getFullYear() - 1, 0, 1), end: new Date(now.getFullYear(), 0, 1) };
  if (/\b(recently|lately|the other day)\b/.test(q)) return { start: new Date(today.getTime() - 14 * day), end: now };
  const ago = /\b(\d+|a|an|one|two|three|few|couple of)\s+(day|week|month|year)s?\s+ago\b/.exec(q);
  if (ago) {
    const n = /^\d+$/.test(ago[1]) ? Number(ago[1]) : ({ a: 1, an: 1, one: 1, two: 2, three: 3, few: 3, 'couple of': 2 } as Record<string, number>)[ago[1]] ?? 1;
    const unit = { day: 1, week: 7, month: 30, year: 365 }[ago[2] as 'day']! * day;
    const center = now.getTime() - n * unit;
    return { start: new Date(center - unit), end: new Date(center + unit) };
  }
  const month = new RegExp(`\\b(?:in|during|since|last)\\s+(${MONTHS.join('|')})\\b`).exec(q);
  if (month) {
    const m = MONTHS.indexOf(month[1]);
    const year = m > now.getMonth() ? now.getFullYear() - 1 : now.getFullYear();
    return { start: new Date(year, m, 1), end: new Date(year, m + 1, 1) };
  }
  const year = /\b(?:in|during|since)\s+((?:19|20)\d{2})\b/.exec(q);
  if (year) return { start: new Date(Number(year[1]), 0, 1), end: new Date(Number(year[1]) + 1, 0, 1) };
  return undefined;
}

/** Memories whose event (or learning) time falls inside the range, most recent first. */
export function temporalSearch(range: TimeRange, units: MemoryUnit[], limit = 50): string[] {
  return units
    .map((u) => ({ id: u.id, t: new Date(u.occurredAt ?? u.mentionedAt).getTime() }))
    .filter((x) => x.t >= range.start.getTime() && x.t < range.end.getTime())
    .sort((a, b) => b.t - a.t)
    .slice(0, limit)
    .map((x) => x.id);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length && i < b.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export function semanticSearch(queryVector: number[], vectors: Map<string, number[]>, limit = 50, minScore = 0.25): string[] {
  return [...vectors.entries()]
    .map(([id, v]) => ({ id, score: cosine(queryVector, v) }))
    .filter((x) => x.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.id);
}

export interface Fused {
  id: string;
  score: number;
  strategies: string[];
}

/** Reciprocal rank fusion: rewards memories ranked highly by several strategies. */
export function reciprocalRankFusion(lists: { name: string; ids: string[]; weight?: number }[], k = 60): Fused[] {
  const out = new Map<string, Fused>();
  for (const list of lists) {
    list.ids.forEach((id, rank) => {
      const f = out.get(id) ?? { id, score: 0, strategies: [] };
      f.score += (list.weight ?? 1) / (k + rank + 1);
      f.strategies.push(list.name);
      out.set(id, f);
    });
  }
  return [...out.values()].sort((a, b) => b.score - a.score);
}

/** Lowercased word-set similarity, used to skip near-duplicate facts. */
export function similarity(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}
