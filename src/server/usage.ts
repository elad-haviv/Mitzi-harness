// Usage accounting: every model call is recorded with what it was for (a chat, a workflow, a title…),
// so costs and tokens can be totaled per response, chat, project, bot, model and day.
import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Usage } from '../openrouter.js';
import type { BudgetSettings, BudgetStatus, ModelInfo, UsageEvent, UsageKind } from '../shared/types.js';

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

/** Spending against the budget limits, from the usage log. */
export function budgetStatus(log: UsageLog, budget: BudgetSettings | undefined, now = new Date()): BudgetStatus {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const month = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const events = log.all(month);
  const spentMonth = events.reduce((n, e) => n + e.cost, 0);
  const spentToday = events.filter((e) => e.ts >= day).reduce((n, e) => n + e.cost, 0);
  const daily = budget?.daily || undefined;
  const monthly = budget?.monthly || undefined;
  const alertPercent = budget?.alertPercent ?? 80;
  const status: BudgetStatus = { daily, monthly, spentToday, spentMonth, alertPercent, hardStop: !!budget?.hardStop, state: 'ok' };
  // The tighter of the two limits decides.
  const checks: ['daily' | 'monthly', number, number | undefined][] = [
    ['daily', spentToday, daily],
    ['monthly', spentMonth, monthly],
  ];
  for (const [limit, spent, max] of checks) {
    if (!max) continue;
    if (spent >= max) return { ...status, state: 'over', limit };
    if (spent >= (max * alertPercent) / 100 && status.state === 'ok') Object.assign(status, { state: 'warn', limit });
  }
  return status;
}

/** Thrown when the budget's hard stop refuses a request. */
export class BudgetExceeded extends Error {
  readonly status = 402;
}

export function budgetMessage(s: BudgetStatus): string {
  const limit = s.limit === 'daily' ? `daily budget of $${s.daily!.toFixed(2)}` : `monthly budget of $${s.monthly!.toFixed(2)}`;
  return `You've reached your ${limit}. Raise it in Settings → Usage & budget${s.limit === 'daily' ? ', or wait until tomorrow' : ', or wait until next month'}.`;
}
