// Lesson hygiene: lessons are measured against outcomes (were tasks going better while a lesson was in the prompt?),
// near-duplicates and contradictions are merged by the fast model, and lessons that stop paying their way retire.
// A lesson system that can't forget can't scale.
import type { Config } from '../config.js';
import type { LlmClient } from '../openrouter.js';
import type { Bot, Lesson, LessonSource, TaskOutcome } from '../shared/types.js';
import { MAX_LESSONS } from './lessons.js';
import type { OutcomeLog } from './outcomes.js';
import { newId, now, Store } from './store.js';
import { withUsage } from './usage.js';

/** Uses before a lesson is judged. */
export const MIN_USES = 8;
/** How far below the bot's baseline a lesson's success rate may fall before it retires. */
export const RETIRE_MARGIN = 0.15;
/** Merge lessons once a bot has this many. */
export const TIDY_AT = 20;
const MAX_RETIRED = 30;

/** Whether a task went well: no redo, no failing checks, no agent mistakes, no low rating, no fix-ups by the user. */
export function wentWell(o: TaskOutcome): boolean {
  return !o.redone && o.testsPassed !== false && !o.errors.some((e) => e.kind === 'agent') && (o.rating === undefined || o.rating >= 4) && !(o.editsAfter ?? 0);
}

export interface LessonScore {
  lessonId: string;
  /** Tasks run with the lesson in the prompt. */
  uses: number;
  /** Share of those that went well. */
  successRate?: number;
  /** Share of the bot's tasks without the lesson that went well. */
  baseline?: number;
  verdict: 'unproven' | 'helping' | 'neutral' | 'hurting';
}

/** Scores each lesson by how tasks went with it in the prompt, against the bot's tasks without it. */
export function scoreLessons(lessons: Lesson[], outcomes: TaskOutcome[]): LessonScore[] {
  const own = outcomes.filter((o) => o.source !== 'backfill');
  return lessons.map((l) => {
    const withIt = own.filter((o) => o.lessonIds.includes(l.id));
    const without = own.filter((o) => !o.lessonIds.includes(l.id));
    const rate = (xs: TaskOutcome[]) => (xs.length ? xs.filter(wentWell).length / xs.length : undefined);
    const successRate = rate(withIt);
    const baseline = rate(without);
    let verdict: LessonScore['verdict'] = 'unproven';
    if (withIt.length >= MIN_USES && successRate !== undefined && baseline !== undefined) {
      verdict = successRate < baseline - RETIRE_MARGIN ? 'hurting' : successRate > baseline + 0.05 ? 'helping' : 'neutral';
    }
    return { lessonId: l.id, uses: withIt.length, successRate, baseline, verdict };
  });
}

export const TIDY_PROMPT = `These are lessons an AI assistant keeps in its system prompt (higher numbers are newer). Tidy them: \
merge near-duplicates into one lesson, resolve contradictions in favor of the newer lesson, and drop lessons too vague to act \
on. Keep every distinct, useful lesson, with its wording where it's already good.

<lessons>
{lessons}
</lessons>

Reply with JSON only: {"lessons": [{"text": "...", "from": [<numbers it came from>]}], "dropped": [{"n": <number>, "reason": "..."}]}`;

export interface HygieneDeps {
  store: Store;
  log: OutcomeLog;
  client: () => LlmClient;
  config: () => Config;
}

export class LessonHygiene {
  private readonly busy = new Set<string>();

  constructor(private readonly deps: HygieneDeps) {}

  scores(bot: Bot): LessonScore[] {
    return scoreLessons(bot.lessons ?? [], this.deps.log.all((o) => o.botId === bot.id));
  }

  /** Retires lessons that measurably hurt, then merges the rest when there are many. */
  async tidy(botId: string, force = false): Promise<{ retired: number; merged: number }> {
    if (this.busy.has(botId)) return { retired: 0, merged: 0 };
    this.busy.add(botId);
    try {
      const retired = this.retireHurting(botId);
      const bot = this.deps.store.bots.get(botId);
      const merged = bot && (force || (bot.lessons?.length ?? 0) >= TIDY_AT) ? await this.merge(botId) : 0;
      return { retired, merged };
    } finally {
      this.busy.delete(botId);
    }
  }

  /** Puts a retired lesson back. */
  restore(botId: string, lessonId: string): Bot | undefined {
    const bot = this.deps.store.bots.get(botId);
    const r = bot?.retiredLessons?.find((l) => l.id === lessonId);
    if (!bot || !r) return bot;
    const { retiredAt: _at, reason: _reason, ...lesson } = r;
    bot.retiredLessons = bot.retiredLessons!.filter((l) => l.id !== lessonId);
    bot.lessons = [...(bot.lessons ?? []), lesson].slice(-MAX_LESSONS);
    this.deps.store.bots.put(bot);
    return bot;
  }

  private retireHurting(botId: string): number {
    const bot = this.deps.store.bots.get(botId);
    if (!bot?.lessons?.length) return 0;
    const hurting = this.scores(bot).filter((s) => s.verdict === 'hurting');
    if (!hurting.length) return 0;
    for (const s of hurting) {
      const lesson = bot.lessons.find((l) => l.id === s.lessonId)!;
      this.retire(bot, lesson, `Tasks went well ${Math.round(s.successRate! * 100)}% of the time with it, ${Math.round(s.baseline! * 100)}% without (${s.uses} uses).`);
    }
    this.deps.store.bots.put(bot);
    return hurting.length;
  }

  private retire(bot: Bot, lesson: Lesson, reason: string): void {
    bot.lessons = (bot.lessons ?? []).filter((l) => l.id !== lesson.id);
    bot.retiredLessons = [...(bot.retiredLessons ?? []), { ...lesson, retiredAt: now(), reason }].slice(-MAX_RETIRED);
  }

  /** Merges duplicates and contradictions with the fast model. Returns how many lessons fewer there are. */
  private async merge(botId: string): Promise<number> {
    const { store } = this.deps;
    const bot = store.bots.get(botId);
    const lessons = bot?.lessons ?? [];
    if (lessons.length < 2) return 0;
    const config = this.deps.config();
    const res = await withUsage({ kind: 'learning', botId, sink: undefined, route: undefined }, () =>
      this.deps.client().chat({
        model: config.smallModel ?? config.model,
        messages: [{ role: 'user', content: TIDY_PROMPT.replace('{lessons}', lessons.map((l, i) => `${i + 1}. ${l.text}`).join('\n')) }],
        maxTokens: 2000,
      }),
    );
    let json: { lessons?: { text?: string; from?: number[] }[]; dropped?: { n?: number; reason?: string }[] };
    try {
      json = JSON.parse(/\{[\s\S]*\}/.exec(res.content)?.[0] ?? '');
    } catch {
      return 0;
    }
    if (!Array.isArray(json.lessons) || !json.lessons.length) return 0;
    const fresh = store.bots.get(botId)!;
    const current = fresh.lessons ?? [];
    // Only lessons that still exist are touched; any added meanwhile stay.
    const at = (n: number) => (lessons[n - 1] && current.some((l) => l.id === lessons[n - 1].id) ? lessons[n - 1] : undefined);
    const used = new Set<string>();
    const next: Lesson[] = [];
    for (const m of json.lessons) {
      const text = String(m.text ?? '').trim().slice(0, 500);
      const from = (m.from ?? []).map(Number).map(at).filter((l): l is Lesson => !!l);
      if (!text || !from.length) continue;
      from.forEach((l) => used.add(l.id));
      if (from.length === 1 && from[0].text === text) next.push(from[0]);
      else {
        const sources = from.map((l) => l.source ?? 'rating');
        const source = sources.sort((a, b) => sources.filter((x) => x === b).length - sources.filter((x) => x === a).length)[0] as LessonSource;
        next.push({ id: newId(), text, value: from[0].value, chatId: from.at(-1)!.chatId, createdAt: now(), source });
        // Merged lessons are kept as retired, so the history stays visible.
        for (const l of from) fresh.retiredLessons = [...(fresh.retiredLessons ?? []), { ...l, retiredAt: now(), reason: `Merged into: ${text}` }].slice(-MAX_RETIRED);
      }
    }
    for (const d of json.dropped ?? []) {
      const l = at(Number(d.n));
      if (!l || used.has(l.id)) continue;
      used.add(l.id);
      fresh.retiredLessons = [...(fresh.retiredLessons ?? []), { ...l, retiredAt: now(), reason: String(d.reason ?? 'Dropped while tidying').slice(0, 300) }].slice(-MAX_RETIRED);
    }
    const untouched = current.filter((l) => !used.has(l.id));
    const before = current.length;
    fresh.lessons = [...next, ...untouched].slice(-MAX_LESSONS);
    store.bots.put(fresh);
    return before - fresh.lessons.length;
  }
}
