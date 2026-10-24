// Learning metrics: is the learning system paying off? Rates over the outcome ledger, per week and per model,
// and how many lessons were in effect along the way.
import type { Lesson, RetiredLesson, TaskOutcome } from '../shared/types.js';
import { wentWell } from './lesson-hygiene.js';
import { dayOf } from './usage.js';

export interface OutcomeRates {
  tasks: number;
  /** First tries that weren't sent back for a redo. */
  firstTryAccepted?: number;
  redoRate?: number;
  /** Of tasks whose work was checked, the share whose final check passed. */
  checksPassed?: number;
  /** Of tasks the harness checked, the share that passed on the first check (the bot verified by itself). */
  firstCheckPassed?: number;
  /** Agent mistakes per task. */
  agentErrors: number;
  /** Environment failures per task. */
  environmentErrors: number;
  /** Share of tasks that went well on every signal. */
  wentWell?: number;
  /** Average rating, where rated. */
  rating?: number;
}

const share = (xs: TaskOutcome[], ok: (o: TaskOutcome) => boolean) => (xs.length ? xs.filter(ok).length / xs.length : undefined);

export function rates(outcomes: TaskOutcome[]): OutcomeRates {
  const first = outcomes.filter((o) => o.attempts === 1 && o.source !== 'backfill');
  const checked = outcomes.filter((o) => o.testsPassed !== undefined);
  const harness = outcomes.filter((o) => o.firstCheckPassed !== undefined);
  const rated = outcomes.filter((o) => o.rating !== undefined);
  const live = outcomes.filter((o) => o.source !== 'backfill');
  const count = (kind: string) => (live.length ? live.reduce((n, o) => n + o.errors.filter((e) => e.kind === kind).length, 0) / live.length : 0);
  return {
    tasks: outcomes.length,
    firstTryAccepted: share(first, (o) => !o.redone),
    redoRate: share(outcomes, (o) => o.redone),
    checksPassed: share(checked, (o) => !!o.testsPassed),
    firstCheckPassed: share(harness, (o) => !!o.firstCheckPassed),
    agentErrors: count('agent'),
    environmentErrors: count('environment'),
    wentWell: share(live, wentWell),
    rating: rated.length ? rated.reduce((n, o) => n + o.rating!, 0) / rated.length : undefined,
  };
}

/** Monday of the week a timestamp falls in, as YYYY-MM-DD (local time). */
export function weekOf(ts: number): string {
  const d = new Date(ts);
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return dayOf(d.getTime());
}

/** Lessons in the prompt at a moment: added before it, and not yet retired. */
export function lessonsAt(ts: number, lessons: Lesson[], retired: RetiredLesson[]): number {
  const born = (l: Lesson) => (Date.parse(l.createdAt) || 0) <= ts;
  return lessons.filter(born).length + retired.filter((l) => born(l) && Date.parse(l.retiredAt) > ts).length;
}

export interface LearningMetrics {
  overall: OutcomeRates;
  /** Week by week, oldest first. */
  weekly: (OutcomeRates & { week: string; lessons: number })[];
  byModel: (OutcomeRates & { model: string })[];
  bySource: { source: string; count: number }[];
  /** Lessons in effect now, by where they came from. */
  lessonsBySource: Record<string, number>;
}

export function learningMetrics(outcomes: TaskOutcome[], lessons: Lesson[], retired: RetiredLesson[]): LearningMetrics {
  const weeks = new Map<string, TaskOutcome[]>();
  for (const o of outcomes) {
    const w = weekOf(o.ts);
    weeks.set(w, [...(weeks.get(w) ?? []), o]);
  }
  const models = new Map<string, TaskOutcome[]>();
  for (const o of outcomes.filter((o) => o.source !== 'backfill')) models.set(o.model, [...(models.get(o.model) ?? []), o]);
  const sources = new Map<string, number>();
  for (const o of outcomes) sources.set(o.source, (sources.get(o.source) ?? 0) + 1);
  const lessonsBySource: Record<string, number> = {};
  for (const l of lessons) lessonsBySource[l.source ?? 'rating'] = (lessonsBySource[l.source ?? 'rating'] ?? 0) + 1;
  return {
    overall: rates(outcomes),
    weekly: [...weeks]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([week, list]) => ({ week, ...rates(list), lessons: lessonsAt(Math.max(...list.map((o) => o.ts)), lessons, retired) })),
    byModel: [...models].map(([model, list]) => ({ model, ...rates(list) })).sort((a, b) => b.tasks - a.tasks),
    bySource: [...sources].map(([source, count]) => ({ source, count })),
    lessonsBySource,
  };
}
