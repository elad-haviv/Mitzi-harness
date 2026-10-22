// Scheduled tasks: prompts that run on a schedule, each run answered in a chat.
import type { ScheduledTask, TaskSchedule } from '../shared/types.js';
import type { Store } from './store.js';

const TICK_MS = 30_000;
const MAX_RUNS_KEPT = 50;

type Field = Set<number>;

function parseField(spec: string, min: number, max: number): Field {
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`Invalid cron field "${part}"`);
    const step = m[4] ? Number(m[4]) : 1;
    let lo = min;
    let hi = max;
    if (m[2] !== undefined) {
      lo = Number(m[2]);
      hi = m[3] !== undefined ? Number(m[3]) : m[4] ? max : lo;
    }
    if (lo < min || hi > max || lo > hi || step < 1) throw new Error(`Cron field "${part}" is out of range ${min}-${max}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export interface Cron {
  minute: Field;
  hour: Field;
  dom: Field;
  month: Field;
  dow: Field;
  domAny: boolean;
  dowAny: boolean;
}

/** Parses a five-field cron expression (minute hour day-of-month month day-of-week). */
export function parseCron(expr: string): Cron {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error('A cron expression has five fields: minute hour day-of-month month day-of-week');
  const dow = parseField(f[4], 0, 7);
  if (dow.has(7)) dow.add(0);
  return {
    minute: parseField(f[0], 0, 59),
    hour: parseField(f[1], 0, 23),
    dom: parseField(f[2], 1, 31),
    month: parseField(f[3], 1, 12),
    dow,
    domAny: f[2] === '*',
    dowAny: f[4] === '*',
  };
}

function cronMatchesDay(c: Cron, d: Date): boolean {
  if (!c.month.has(d.getMonth() + 1)) return false;
  const dom = c.dom.has(d.getDate());
  const dow = c.dow.has(d.getDay());
  // Standard cron: when both day fields are restricted, either may match.
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return dow;
  if (c.dowAny) return dom;
  return dom || dow;
}

function nextCron(c: Cron, after: Date): Date | undefined {
  const d = new Date(after);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = after.getTime() + 366 * 24 * 3600_000;
  while (d.getTime() <= limit) {
    if (!cronMatchesDay(c, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!c.hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!c.minute.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1);
      continue;
    }
    return d;
  }
  return undefined;
}

function parseTime(time: string | undefined): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time ?? '');
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error('Time must be HH:MM');
  return [Number(m[1]), Number(m[2])];
}

/** Checks a schedule, throwing a readable error when it can't run. */
export function validateSchedule(s: TaskSchedule): void {
  switch (s.kind) {
    case 'once':
      if (!s.at || Number.isNaN(Date.parse(s.at))) throw new Error('Pick a date and time');
      return;
    case 'interval':
      if (!s.everyMinutes || s.everyMinutes < 5) throw new Error('The interval must be at least 5 minutes');
      return;
    case 'daily':
      parseTime(s.time);
      return;
    case 'weekly':
      parseTime(s.time);
      if (!s.days?.length || s.days.some((d) => d < 0 || d > 6)) throw new Error('Pick at least one day');
      return;
    case 'cron':
      parseCron(s.cron ?? '');
      return;
    default:
      throw new Error('Unknown schedule');
  }
}

/** When a schedule next fires after `after` (local time), or undefined if never again. */
export function nextRun(s: TaskSchedule, after: Date, lastRun?: Date): Date | undefined {
  switch (s.kind) {
    case 'once': {
      const at = new Date(s.at!);
      return lastRun ? undefined : at;
    }
    case 'interval': {
      const every = s.everyMinutes! * 60_000;
      return new Date(lastRun ? Math.max(lastRun.getTime() + every, after.getTime()) : after.getTime() + every);
    }
    case 'daily':
    case 'weekly': {
      const [h, m] = parseTime(s.time);
      const d = new Date(after);
      d.setHours(h, m, 0, 0);
      if (d <= after) d.setDate(d.getDate() + 1);
      for (let i = 0; i < 8; i++) {
        if (s.kind === 'daily' || s.days!.includes(d.getDay())) return d;
        d.setDate(d.getDate() + 1);
      }
      return undefined;
    }
    case 'cron':
      return nextCron(parseCron(s.cron!), after);
  }
}

export function describeSchedule(s: TaskSchedule): string {
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  switch (s.kind) {
    case 'once':
      return `Once on ${new Date(s.at!).toLocaleString()}`;
    case 'interval':
      return s.everyMinutes! % 60 === 0 ? `Every ${s.everyMinutes! / 60} hour(s)` : `Every ${s.everyMinutes} minutes`;
    case 'daily':
      return `Every day at ${s.time}`;
    case 'weekly':
      return `${s.days!.map((d) => DAYS[d]).join(', ')} at ${s.time}`;
    case 'cron':
      return `Cron ${s.cron}`;
  }
}

/** Runs due tasks. `execute` runs one task and records the outcome on it. */
export class Scheduler {
  private timer?: NodeJS.Timeout;
  private readonly running = new Set<string>();

  constructor(
    private readonly store: Store,
    private readonly execute: (task: ScheduledTask) => Promise<void>,
  ) {}

  start(): void {
    // Runs missed while Mitzi was closed fire once on startup (then follow their schedule).
    for (const t of this.store.tasks.all()) {
      if (t.runs.some((r) => r.status === 'running')) {
        for (const r of t.runs) if (r.status === 'running') Object.assign(r, { status: 'error', error: 'Mitzi was closed during this run', finishedAt: new Date().toISOString() });
        this.store.tasks.put(t);
      }
    }
    void this.tick();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  /** Recomputes a task's next run, e.g. after its schedule changed. */
  plan(task: ScheduledTask, from = new Date()): ScheduledTask {
    const lastRun = task.runs.at(-1);
    try {
      const next = task.enabled ? nextRun(task.schedule, from, lastRun ? new Date(lastRun.startedAt) : undefined) : undefined;
      task.nextRunAt = next?.toISOString();
    } catch {
      task.nextRunAt = undefined;
    }
    return task;
  }

  async tick(at = new Date()): Promise<void> {
    const due = this.store.tasks.all().filter((t) => t.enabled && t.nextRunAt && Date.parse(t.nextRunAt) <= at.getTime() && !this.running.has(t.id));
    await Promise.all(due.map((t) => this.runNow(t)));
  }

  async runNow(task: ScheduledTask): Promise<void> {
    if (this.running.has(task.id)) return;
    this.running.add(task.id);
    try {
      await this.execute(task);
    } finally {
      this.running.delete(task.id);
      const fresh = this.store.tasks.get(task.id);
      if (fresh) {
        if (fresh.runs.length > MAX_RUNS_KEPT) fresh.runs = fresh.runs.slice(-MAX_RUNS_KEPT);
        if (fresh.schedule.kind === 'once') fresh.enabled = false;
        this.store.tasks.put(this.plan(fresh));
      }
    }
  }
}
