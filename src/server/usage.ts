// Usage accounting: every model call is recorded with what it was for (a chat, a workflow, a title…),
// so costs and tokens can be totaled per response, chat, project, bot, model and day.
import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Usage } from '../openrouter.js';
import type { BudgetLimit, BudgetLimitStatus, BudgetPeriod, BudgetSettings, BudgetStatus, ModelInfo, UsageEvent, UsageKind } from '../shared/types.js';

export interface UsageTag {
  kind: UsageKind;
  chatId?: string;
  projectId?: string;
  botId?: string;
  workflowId?: string;
  taskId?: string;
  /** How Auto routed the message these calls answer. */
  route?: 'fast' | 'strong';
  /** Also told about each call (a run adds up its own cost this way). */
  sink?: (e: UsageEvent) => void;
}

const scope = new AsyncLocalStorage<UsageTag>();

/** Runs `fn` with model calls attributed to `tag` (merged into any enclosing tag). */
export function withUsage<T>(tag: Partial<UsageTag>, fn: () => T): T {
  const parent = scope.getStore();
  return scope.run({ kind: 'other', ...parent, ...tag } as UsageTag, fn);
}

export function currentUsageTag(): UsageTag | undefined {
  return scope.getStore();
}

/** Monthly JSON-lines files under <data>/usage, cached in memory. */
export class UsageLog {
  private events?: UsageEvent[];

  constructor(
    private readonly dir: string,
    private readonly prices: () => ModelInfo[] = () => [],
  ) {
    mkdirSync(dir, { recursive: true });
  }

  private load(): UsageEvent[] {
    if (this.events) return this.events;
    const events: UsageEvent[] = [];
    for (const f of readdirSync(this.dir).filter((f) => f.endsWith('.jsonl')).sort()) {
      for (const line of readFileSync(join(this.dir, f), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line));
        } catch {
          // A torn last line from a crash; skip it.
        }
      }
    }
    return (this.events = events);
  }

  /** Records one model call. Providers that don't report cost are priced from the model list. */
  record(model: string, usage: Usage | undefined, tag = currentUsageTag()): UsageEvent | undefined {
    if (!usage) return undefined;
    const prompt = usage.prompt_tokens ?? 0;
    const completion = usage.completion_tokens ?? 0;
    const cost = usage.cost ?? this.priceOf(model, prompt, completion) ?? 0;
    const event: UsageEvent = { ts: Date.now(), model: model.replace(/:online$/, ''), prompt, completion, cost, kind: tag?.kind ?? 'other' };
    for (const k of ['chatId', 'projectId', 'botId', 'workflowId', 'taskId'] as const) if (tag?.[k]) event[k] = tag[k];
    if (tag?.route) event.route = tag.route;
    tag?.sink?.(event);
    this.load().push(event);
    const d = new Date(event.ts);
    appendFileSync(join(this.dir, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}.jsonl`), `${JSON.stringify(event)}\n`);
    return event;
  }

  /** What tokens cost on a model, from the model list; undefined when its prices aren't known. */
  priceOf(model: string, prompt: number, completion: number): number | undefined {
    const info = this.prices().find((m) => m.id === model.replace(/:online$/, ''));
    return info?.promptPrice !== undefined ? (prompt * info.promptPrice + completion * (info.completionPrice ?? 0)) / 1e6 : undefined;
  }

  all(since = 0): UsageEvent[] {
    return since ? this.load().filter((e) => e.ts >= since) : this.load();
  }
}

export interface Totals {
  prompt: number;
  completion: number;
  cost: number;
  requests: number;
}

export function total(events: UsageEvent[]): Totals {
  const t: Totals = { prompt: 0, completion: 0, cost: 0, requests: 0 };
  for (const e of events) {
    t.prompt += e.prompt;
    t.completion += e.completion;
    t.cost += e.cost;
    t.requests++;
  }
  return t;
}

/** Totals grouped by a key, largest cost first. */
export function groupBy(events: UsageEvent[], key: (e: UsageEvent) => string | undefined): { key: string; totals: Totals }[] {
  const groups = new Map<string, UsageEvent[]>();
  for (const e of events) {
    const k = key(e);
    if (k === undefined) continue;
    let g = groups.get(k);
    if (!g) groups.set(k, (g = []));
    g.push(e);
  }
  return [...groups].map(([key, list]) => ({ key, totals: total(list) })).sort((a, b) => b.totals.cost - a.totals.cost || b.totals.prompt - a.totals.prompt);
}

/** Local calendar day, YYYY-MM-DD. */
export function dayOf(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The limits in a budget: its list, or the daily and monthly limits from before there was one. */
export function budgetLimits(budget: BudgetSettings | undefined): BudgetLimit[] {
  if (budget?.limits) return budget.limits.filter((l) => l.amount > 0);
  const legacy: BudgetLimit[] = [];
  if (budget?.daily) legacy.push({ id: 'daily', amount: budget.daily, period: 'day' });
  if (budget?.monthly) legacy.push({ id: 'monthly', amount: budget.monthly, period: 'month', resetDay: 1 });
  return legacy;
}

/** The current period of a limit, in local time: when it started and when it starts over. */
export function periodOf(limit: BudgetLimit, now = new Date()): { start: Date; end?: Date } {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  switch (limit.period) {
    case 'day':
      return { start: midnight, end: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1) };
    case 'week': {
      const resetDay = (limit.resetDay ?? 1) % 7;
      const back = (midnight.getDay() - resetDay + 7) % 7;
      const start = new Date(midnight.getFullYear(), midnight.getMonth(), midnight.getDate() - back);
      return { start, end: new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7) };
    }
    case 'month': {
      const day = Math.min(28, Math.max(1, limit.resetDay ?? 1));
      const thisMonth = new Date(now.getFullYear(), now.getMonth(), day);
      const start = thisMonth <= now ? thisMonth : new Date(now.getFullYear(), now.getMonth() - 1, day);
      return { start, end: new Date(start.getFullYear(), start.getMonth() + 1, day) };
    }
    case 'year':
      return { start: new Date(now.getFullYear(), 0, 1), end: new Date(now.getFullYear() + 1, 0, 1) };
    case 'total':
      return { start: new Date(limit.since ? Date.parse(limit.since) : 0) };
  }
}

/** Spending against each budget limit, from the usage log. The limit that's furthest along decides the state. */
export function budgetStatus(log: UsageLog, budget: BudgetSettings | undefined, now = new Date()): BudgetStatus {
  const alertPercent = budget?.alertPercent ?? 80;
  const limits: BudgetLimitStatus[] = budgetLimits(budget).map((l) => {
    const { start, end } = periodOf(l, now);
    const spent = log.all(start.getTime()).reduce((n, e) => n + e.cost, 0);
    const state = spent >= l.amount ? 'over' : spent >= (l.amount * alertPercent) / 100 ? 'warn' : 'ok';
    return { ...l, spent, start: start.toISOString(), ...(end ? { resetsAt: end.toISOString() } : {}), state };
  });
  const rank = { over: 2, warn: 1, ok: 0 } as const;
  const worst = [...limits].sort((a, b) => rank[b.state] - rank[a.state] || b.spent / b.amount - a.spent / a.amount)[0];
  const state = worst?.state ?? 'ok';
  const freeModel = budget?.freeModel?.trim() || undefined;
  return {
    limits,
    alertPercent,
    hardStop: !!budget?.hardStop,
    ...(freeModel ? { freeModel } : {}),
    state,
    ...(worst && state !== 'ok' ? { limit: worst } : {}),
    freeMode: state === 'over' && !!freeModel,
  };
}

/** Thrown when the budget's hard stop refuses a request. */
export class BudgetExceeded extends Error {
  readonly status = 402;
}

const PERIOD_NAME: Record<BudgetPeriod, string> = { day: 'daily', week: 'weekly', month: 'monthly', year: 'yearly', total: 'total' };

export function budgetMessage(s: BudgetStatus): string {
  const l = s.limit!;
  const when = l.resetsAt ? `, or wait until it starts over on ${new Date(l.resetsAt).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}` : '';
  return `You've reached your ${PERIOD_NAME[l.period]} budget of $${l.amount.toFixed(2)}. Raise it or set a free model in Settings → Usage & budget${when}.`;
}
