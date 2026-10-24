// The outcome ledger: what actually happened on every substantive task (tool errors, checks, redos, ratings, edits),
// recorded by the harness with no human in the loop, and distilled into lessons now and then.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.js';
import type { LlmClient, Message } from '../openrouter.js';
import type { ErrorKind, LessonSource, OutcomeError, TaskOutcome } from '../shared/types.js';
import { addLessons } from './lessons.js';
import type { Store } from './store.js';
import { withUsage } from './usage.js';

// ---- Failure taxonomy ---------------------------------------------------------------

/** The machine's fault: missing tools, ports, permissions, the network. Nothing to learn about the agent. */
const ENVIRONMENT = [
  /No working bash found|Failed to start bash|WSL|System32\\bash/i,
  /command not found|is not recognized as an internal or external command|not installed/i,
  /EADDRINUSE|address already in use|port \d+ (is )?(already )?(in use|taken)/i,
  /\bEACCES\b|\bEPERM\b|TrustedInstaller|Access is denied|Operation not permitted/i,
  /ENOSPC|No space left on device/i,
  /ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|getaddrinfo|network is unreachable|socket hang up/i,
  /\b(429|502|503|504)\b|rate limit|Too Many Requests|Service Unavailable/i,
  /Command timed out|timed out after/i,
  /out of memory|heap out of memory|Killed\b/i,
];

/** The agent's own mistakes: wrong file, wrong edit, malformed calls, code that doesn't compile or pass. */
const AGENT = [
  /old_string (was )?not found|not unique|must (be )?Read|Read (it|the file) first|has been modified since/i,
  /no such file|File not found|does not exist|ENOENT/i,
  /not valid JSON|Invalid (JSON|URL|argument|path|value|regex|pattern)|unknown tool|is required|must be/i,
  /error TS\d+|SyntaxError|TypeError|ReferenceError|NameError|AttributeError|ImportError|ModuleNotFoundError|IndentationError/i,
  /AssertionError|assert(ion)? failed|\bFAIL(ED)?\b|\d+ failing|tests? failed|not ok \d+/i,
  /cannot find (module|name|symbol)|undefined (reference|variable)|is not defined|unresolved import/i,
];

/** Reads a failed tool call's output: an agent mistake, the environment's, a refusal by the user, or unknown. */
export function classifyError(text: string): ErrorKind {
  if (/^(The user declined|The user interrupted|This (step|run) (runs|is) unattended|This is an unattended)/i.test(text.replace(/^Error:\s*/, ''))) return 'declined';
  if (ENVIRONMENT.some((re) => re.test(text))) return 'environment';
  if (AGENT.some((re) => re.test(text))) return 'agent';
  return 'unknown';
}

/** Shell commands that run tests or checks, so their result tells whether the work holds up. */
const TEST_COMMAND = /\b(test|tests|pytest|jest|vitest|mocha|tsc|typecheck|cargo (test|check|build)|go (test|vet|build)|make (test|check)|lint|check)\b/i;

export interface RunSummary {
  toolCalls: number;
  toolErrors: number;
  errors: OutcomeError[];
  filesTouched: string[];
  commands: { command: string; ok: boolean }[];
  /** The result of the bot's own last test run, if it ran one. */
  testsPassed?: boolean;
}

/** What a run did, from its messages: tool calls, failures (classified), files written, commands run. */
export function summarizeRun(messages: Message[]): RunSummary {
  const results = new Map(messages.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, typeof m.content === 'string' ? m.content : '']));
  const summary: RunSummary = { toolCalls: 0, toolErrors: 0, errors: [], filesTouched: [], commands: [] };
  const files = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const call of m.tool_calls ?? []) {
      const name = call.function.name;
      const out = results.get(call.id) ?? '';
      if (out.startsWith('Skipped:')) continue;
      summary.toolCalls++;
      let args: any = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch {
        // Counted below as a malformed call.
      }
      const failed = /^Error:|^The user declined|^The user interrupted/.test(out);
      const exit = name === 'Bash' && /\[(Exit code \d+|Command timed out[^\]]*)\]\s*$/.test(out);
      if (name === 'Bash' && args.command) {
        const command = String(args.command).slice(0, 300);
        summary.commands.push({ command, ok: !failed && !exit });
        if (TEST_COMMAND.test(command) && !failed) summary.testsPassed = !exit;
      }
      if (!failed && /^(Write|Edit)$/.test(name) && args.file_path) files.add(String(args.file_path));
      // A command exiting non-zero is part of the work (a failing test run, a grep with no match),
      // unless the machine itself got in the way.
      const kind = failed ? classifyError(out) : exit ? (classifyError(out) === 'environment' ? 'environment' : undefined) : undefined;
      if (!kind) continue;
      summary.errors.push({ tool: name, kind, text: out.replace(/^Error:\s*/, '').slice(0, 300), ...(name === 'Bash' && args.command ? { command: String(args.command).slice(0, 300) } : {}) });
      if (kind !== 'declined') summary.toolErrors++;
    }
  }
  summary.filesTouched = [...files];
  if (summary.commands.length > 20) summary.commands = summary.commands.slice(-20);
  if (summary.errors.length > 12) summary.errors = summary.errors.slice(-12);
  return summary;
}

/** Whether an outcome says something about how the agent works: it erred, needed a redo, or failed its checks. */
export function hasSignal(o: TaskOutcome): boolean {
  return (
    o.errors.some((e) => e.kind === 'agent') ||
    o.redone ||
    o.firstCheckPassed === false ||
    o.testsPassed === false ||
    (o.rating !== undefined && o.rating <= 2) ||
    (o.editsAfter ?? 0) > 0
  );
}

/** The outcome of the response an answer belongs to (recorded on the response's last answer). */
export function outcomeIdFor(messages: { role: string; auto?: string; outcomeId?: string }[], index: number): string | undefined {
  const end = messages.findIndex((m, i) => i > index && m.role === 'user' && !m.auto);
  return messages.slice(index, end < 0 ? undefined : end).findLast((m) => m.outcomeId)?.outcomeId;
}

// ---- The ledger -----------------------------------------------------------------------

type Line = TaskOutcome | { amend: string; patch: Partial<TaskOutcome> };

/** Monthly JSON-lines files under <data>/outcomes. Later signals are appended as amendments and merged on load. */
export class OutcomeLog {
  private outcomes?: Map<string, TaskOutcome>;
  /** Told about each new outcome. */
  readonly listeners = new Set<(o: TaskOutcome) => void>();

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private load(): Map<string, TaskOutcome> {
    if (this.outcomes) return this.outcomes;
    const map = new Map<string, TaskOutcome>();
    for (const f of readdirSync(this.dir).filter((f) => f.endsWith('.jsonl')).sort()) {
      for (const raw of readFileSync(join(this.dir, f), 'utf8').split('\n')) {
        if (!raw.trim()) continue;
        try {
          const line = JSON.parse(raw) as Line;
          if ('amend' in line) {
            const o = map.get(line.amend);
            if (o) Object.assign(o, line.patch);
          } else map.set(line.id, line);
        } catch {
          // A torn last line from a crash; skip it.
        }
      }
    }
    return (this.outcomes = map);
  }

  private append(line: Line): void {
    const d = new Date();
    appendFileSync(join(this.dir, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}.jsonl`), `${JSON.stringify(line)}\n`);
  }

  record(o: TaskOutcome): TaskOutcome {
    this.load().set(o.id, o);
    this.append(o);
    for (const l of this.listeners) l(o);
    return o;
  }

  amend(id: string, patch: Partial<TaskOutcome>): TaskOutcome | undefined {
    const o = this.load().get(id);
    if (!o) return undefined;
    Object.assign(o, patch);
    this.append({ amend: id, patch });
    return o;
  }

  get(id: string): TaskOutcome | undefined {
    return this.load().get(id);
  }

  /** Oldest first. */
  all(filter: (o: TaskOutcome) => boolean = () => true): TaskOutcome[] {
    return [...this.load().values()].filter(filter).sort((a, b) => a.ts - b.ts);
  }

  /** Whether history from before the ledger (feedback loops) was brought in. */
  get backfilled(): boolean {
    return existsSync(join(this.dir, '.backfilled'));
  }

  markBackfilled(): void {
    writeFileSync(join(this.dir, '.backfilled'), new Date().toISOString());
  }
}

/** Brings feedback loops from before the ledger in as outcomes, once, so history isn't wasted. */
export function backfillOutcomes(log: OutcomeLog, store: Store): number {
  if (log.backfilled) return 0;
  let n = 0;
  for (const loop of store.feedback.all()) {
    if (!loop.iterations.length) continue;
    const chat = store.chats.get(loop.chatId);
    const first = chat?.messages[loop.iterations[0].messageIndex];
    log.record({
      id: `fb-${loop.id}`,
      ts: Date.parse(loop.createdAt) || Date.now(),
      chatId: loop.chatId,
      botId: loop.botId,
      projectId: loop.projectId,
      model: first?.model ?? 'unknown',
      task: loop.task.slice(0, 500),
      mode: chat?.mode === 'work' ? 'work' : 'chat',
      source: 'backfill',
      attempts: loop.iterations.length,
      toolCalls: 0,
      toolErrors: 0,
      errors: [],
      errorKinds: [],
      filesTouched: [],
      commands: [],
      redone: loop.iterations.length > 1,
      rating: loop.iterations.at(-1)!.rating,
      lessonIds: [],
      // Feedback loops already taught their lesson.
      distilled: true,
    });
    n++;
  }
  log.markBackfilled();
  return n;
}

// ---- Distilling lessons from outcomes ---------------------------------------------------

export const OUTCOME_LESSON_PROMPT = `You review how an AI coding assistant's recent tasks actually went, judged by objective signals \
(failed tool calls, failing checks, redo requests, low ratings, the user fixing its output), and distill what it should do \
differently. Write at most 3 short, reusable lessons in the imperative ("When editing…, …"), each grounded in a pattern \
that shows up in the outcomes below. Generalize beyond one task. Prefer nothing over a weak lesson.

Learn only from the assistant's own mistakes. The environment problems listed separately (missing tools, ports in use, \
permissions, the network) are not the assistant's fault: never turn them into lessons like "avoid bash".

Lessons the assistant already has (don't repeat them):
{known}

<outcomes>
{outcomes}
</outcomes>

<environment-problems>
{environment}
</environment-problems>

Reply with JSON only: {"lessons": ["..."]}`;

/** Renders outcomes for the distillation prompt: agent errors in full, environment errors set apart. */
export function describeOutcomes(outcomes: TaskOutcome[]): { outcomes: string; environment: string } {
  const lines = outcomes.map((o, i) => {
    const facts = [
      `model ${o.model}`,
      o.attempts > 1 && `attempt ${o.attempts}`,
      o.redone && 'the user asked for a redo',
      o.rating !== undefined && `rated ${o.rating}/5`,
      o.firstCheckPassed === false && 'finished with failing checks; the harness had to send it back',
      o.testsPassed !== undefined && `final checks ${o.testsPassed ? 'passed' : 'failed'}`,
      o.editsAfter && `the user edited its output ${o.editsAfter} time(s) afterwards`,
      `${o.toolCalls} tool calls`,
    ].filter(Boolean);
    const mistakes = o.errors.filter((e) => e.kind === 'agent' || e.kind === 'unknown').map((e) => `  - ${e.tool} failed: ${e.text.slice(0, 200)}`);
    return `${i + 1}. Task: ${o.task.slice(0, 300)}\n   ${facts.join('; ')}${mistakes.length ? `\n${mistakes.join('\n')}` : ''}`;
  });
  const env = [...new Set(outcomes.flatMap((o) => o.errors.filter((e) => e.kind === 'environment').map((e) => `- ${e.tool}: ${e.text.slice(0, 150)}`)))];
  return { outcomes: lines.join('\n'), environment: env.join('\n') || '(none)' };
}

/** Parses {"lessons": [...]} out of a model reply; anything else yields none. */
export function parseLessons(reply: string): string[] {
  try {
    const json = JSON.parse(/\{[\s\S]*\}/.exec(reply)?.[0] ?? '');
    return Array.isArray(json.lessons) ? json.lessons.map(String).filter((l: string) => l.trim()).slice(0, 3) : [];
  } catch {
    return [];
  }
}

export interface LearnerDeps {
  store: Store;
  log: OutcomeLog;
  client: () => LlmClient;
  config: () => Config;
}

/** Distills outcomes into lessons with the fast model: after enough new ones for a bot, and hourly in the background. */
export class OutcomeLearner {
  /** Undistilled outcomes with a signal that start a distillation. */
  static readonly BATCH = 6;
  private timer?: NodeJS.Timeout;
  private readonly busy = new Set<string>();

  constructor(private readonly deps: LearnerDeps) {
    deps.log.listeners.add((o) => {
      if (this.pending(o.botId).length >= OutcomeLearner.BATCH) void this.learn(o.botId).catch((err) => console.warn(`Couldn't learn from outcomes: ${err.message}`));
    });
  }

  start(intervalMs = 3_600_000): void {
    this.timer = setInterval(() => {
      const bots = new Set(this.deps.log.all((o) => !o.distilled && hasSignal(o)).map((o) => o.botId));
      for (const botId of bots) void this.learn(botId).catch(() => {});
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** Outcomes not yet learned from that say something. */
  pending(botId: string): TaskOutcome[] {
    return this.deps.log.all((o) => o.botId === botId && !o.distilled && hasSignal(o));
  }

  /** Distills lessons for a bot from its pending outcomes. Resolves to the lessons added. */
  async learn(botId: string): Promise<string[]> {
    const { store, log } = this.deps;
    if (this.busy.has(botId)) return [];
    const pending = this.pending(botId).slice(-20);
    if (!pending.length) return [];
    this.busy.add(botId);
    try {
      // A few clean tasks for contrast, so lessons aren't drawn from failures alone.
      const clean = log.all((o) => o.botId === botId && !hasSignal(o) && o.source !== 'backfill').slice(-3);
      const bot = store.bots.get(botId);
      const known = (bot?.lessons ?? []).map((l) => `- ${l.text}`).join('\n') || '(none)';
      const { outcomes, environment } = describeOutcomes([...pending, ...clean]);
      const prompt = OUTCOME_LESSON_PROMPT.replace('{known}', known).replace('{outcomes}', outcomes).replace('{environment}', environment);
      const config = this.deps.config();
      const res = await withUsage({ kind: 'learning', botId, sink: undefined, route: undefined }, () =>
        this.deps.client().chat({ model: config.smallModel ?? config.model, messages: [{ role: 'user', content: prompt }], maxTokens: 500 }),
      );
      for (const o of pending) log.amend(o.id, { distilled: true });
      // Lessons from teammates' work serve the whole team.
      const source: LessonSource = pending.every((o) => o.source === 'teammate') ? 'teammate' : 'outcome';
      return addLessons(store, botId, parseLessons(res.content), { source, chatId: pending.at(-1)?.chatId }).map((l) => l.text);
    } finally {
      this.busy.delete(botId);
    }
  }
}
