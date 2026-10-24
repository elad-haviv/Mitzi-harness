// Learned routing: when Auto sends work to its strong model, it can instead pick the model that measurably does that
// kind of work best here, from the outcome ledger and eval replays. Conservative: only with enough data on both models
// and a clear margin; otherwise Auto's own choice stands.
import type { EvalRun, TaskOutcome } from '../shared/types.js';
import { wentWell } from './lesson-hygiene.js';

export type RouteCategory = 'work' | 'chat';

/** Samples a model needs in a category before it can be compared. */
export const MIN_SAMPLES = 6;
/** How much better (share of tasks that went well) a model must be to take over. */
export const MARGIN = 0.1;

export interface CategoryStats {
  samples: number;
  successes: number;
}

/** Successes per model and category, from real tasks and from eval replays (which count as work). */
export function routeStats(outcomes: TaskOutcome[], evals: EvalRun[]): Map<string, Record<RouteCategory, CategoryStats>> {
  const stats = new Map<string, Record<RouteCategory, CategoryStats>>();
  const add = (model: string, category: RouteCategory, ok: boolean) => {
    const id = model.replace(/:online$/, '');
    const s = stats.get(id) ?? { work: { samples: 0, successes: 0 }, chat: { samples: 0, successes: 0 } };
    s[category].samples++;
    if (ok) s[category].successes++;
    stats.set(id, s);
  };
  for (const o of outcomes) if (o.source !== 'backfill') add(o.model, o.mode === 'work' ? 'work' : 'chat', wentWell(o));
  for (const run of evals) for (const i of run.items) if (i.status === 'done') add(i.model, 'work', i.testsPassed !== false && (i.score ?? 3) >= 4);
  return stats;
}

/** The model to use instead of `current` for this category, or undefined to keep Auto's choice. */
export function learnedPick(category: RouteCategory, current: string, stats: Map<string, Record<RouteCategory, CategoryStats>>, allowed?: Set<string>): { model: string; reason: string } | undefined {
  const rate = (s: CategoryStats) => s.successes / s.samples;
  const mine = stats.get(current)?.[category];
  // Without enough data on the current model, there's nothing to beat.
  if (!mine || mine.samples < MIN_SAMPLES) return undefined;
  let best: { model: string; s: CategoryStats } | undefined;
  for (const [model, byCat] of stats) {
    const s = byCat[category];
    if (model === current || s.samples < MIN_SAMPLES || (allowed && !allowed.has(model))) continue;
    if (!best || rate(s) > rate(best.s)) best = { model, s };
  }
  if (!best || rate(best.s) < rate(mine) + MARGIN) return undefined;
  const pct = (s: CategoryStats) => `${Math.round(rate(s) * 100)}%`;
  return { model: best.model, reason: `Learned: does ${category === 'work' ? 'multi-step work' : 'chats'} best here (${pct(best.s)} went well vs ${pct(mine)})` };
}
