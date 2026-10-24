// The personal eval suite: your own past tasks, with known-good outcomes, replayed with other models. Each replay starts
// from the commit the task started on, in a throwaway git worktree, and is scored by the project's checks, its tool
// errors, and the fast model comparing it with the answer you accepted.
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../config.js';
import type { LlmClient } from '../openrouter.js';
import type { EvalItem, EvalRun, TaskOutcome } from '../shared/types.js';
import { bashTool } from '../tools/bash.js';
import { git } from './git.js';
import type { OutcomeLog } from './outcomes.js';
import { summarizeRun } from './outcomes.js';
import type { ChatRunner } from './runner.js';
import { newId, now, Store } from './store.js';
import { withUsage } from './usage.js';
import { detectVerifyCommand, verifyOutcome } from './verify.js';

/** Past tasks good enough to replay: they started on a clean commit and ended accepted (checks passed or rated well). */
export function evalCandidates(outcomes: TaskOutcome[], projectId?: string, limit = 50): TaskOutcome[] {
  const seen = new Set<string>();
  return outcomes
    .filter((o) => o.source === 'run' && o.gitHead && o.projectId && (!projectId || o.projectId === projectId))
    .filter((o) => !o.redone && (o.testsPassed === true || (o.rating ?? 0) >= 4) && o.filesTouched.length > 0)
    .sort((a, b) => b.ts - a.ts)
    .filter((o) => {
      const key = o.task.trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

export interface EvalModelSummary {
  model: string;
  done: number;
  /** Of replays with checks, the share that passed. */
  passRate?: number;
  avgScore?: number;
  avgToolErrors?: number;
  cost: number;
  avgDurationMs?: number;
}

/** Per-model totals of an eval run. */
export function summarizeEval(run: EvalRun): EvalModelSummary[] {
  return run.models.map((model) => {
    const done = run.items.filter((i) => i.model === model && i.status === 'done');
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined);
    const checked = done.filter((i) => i.testsPassed !== undefined);
    return {
      model,
      done: done.length,
      passRate: checked.length ? checked.filter((i) => i.testsPassed).length / checked.length : undefined,
      avgScore: avg(done.flatMap((i) => (i.score ? [i.score] : []))),
      avgToolErrors: avg(done.map((i) => i.toolErrors ?? 0)),
      cost: done.reduce((n, i) => n + (i.cost ?? 0), 0),
      avgDurationMs: avg(done.map((i) => i.durationMs ?? 0)),
    };
  });
}

export const RUBRIC_PROMPT = `Score how well an AI coding assistant did a task, from 1 (didn't do it) to 5 (did it fully and well). \
The reference is an earlier attempt the user accepted; the new attempt doesn't have to match it, only to do the task as well.

<task>
{task}
</task>

<accepted-answer>
{reference}
</accepted-answer>

<new-attempt-answer>
{answer}
</new-attempt-answer>

<new-attempt-changes>
{diff}
</new-attempt-changes>

{checks}

Reply with JSON only: {"score": 1-5, "notes": "<one sentence>"}`;

export function parseScore(reply: string): { score?: number; notes?: string } {
  try {
    const json = JSON.parse(/\{[\s\S]*\}/.exec(reply)?.[0] ?? '');
    const score = Math.round(Number(json.score));
    return { score: score >= 1 && score <= 5 ? score : undefined, notes: json.notes ? String(json.notes).slice(0, 300) : undefined };
  } catch {
    return {};
  }
}

export interface EvalDeps {
  store: Store;
  runner: ChatRunner;
  outcomes: OutcomeLog;
  client: () => LlmClient;
  config: () => Config;
}

export class EvalService {
  private readonly controllers = new Map<string, AbortController>();
  /** Finished runs, for tests. */
  readonly done = new Map<string, Promise<void>>();

  constructor(private readonly deps: EvalDeps) {
    // Runs cut short by a restart can't resume; their unfinished items are marked.
    for (const run of deps.store.evals.all()) {
      if (run.status !== 'running') continue;
      for (const i of run.items) if (i.status === 'pending' || i.status === 'running') Object.assign(i, { status: 'skipped', error: 'Mitzi was closed during this run' });
      deps.store.evals.put({ ...run, status: 'stopped', finishedAt: now() });
    }
  }

  candidates(projectId?: string): TaskOutcome[] {
    return evalCandidates(this.deps.outcomes.all(), projectId).filter((o) => !!this.deps.store.projects.get(o.projectId!)?.folder);
  }

  /** Starts replaying the given tasks with each model, one replay at a time, in the background. */
  start(projectId: string, outcomeIds: string[], models: string[]): EvalRun {
    const project = this.deps.store.projects.get(projectId);
    if (!project?.folder) throw new Error('Evals replay tasks in a project with a folder');
    const tasks = outcomeIds.map((id) => this.deps.outcomes.get(id)).filter((o): o is TaskOutcome => !!o?.gitHead && o.projectId === projectId);
    if (!tasks.length) throw new Error('Pick at least one task that can be replayed');
    const unique = [...new Set(models.map((m) => m.trim()).filter(Boolean))];
    if (!unique.length) throw new Error('Pick at least one model');
    const run: EvalRun = {
      id: newId(),
      projectId,
      models: unique,
      status: 'running',
      items: tasks.flatMap((o) => unique.map((model): EvalItem => ({ outcomeId: o.id, task: o.task, model, status: 'pending' }))),
      createdAt: now(),
    };
    this.deps.store.evals.put(run);
    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    this.done.set(
      run.id,
      this.execute(run, controller.signal)
        .catch((err) => console.warn(`Eval ${run.id} failed: ${err.message}`))
        .finally(() => this.controllers.delete(run.id)),
    );
    return run;
  }

  stop(id: string): boolean {
    const c = this.controllers.get(id);
    c?.abort();
    return !!c;
  }

  private async execute(run: EvalRun, signal: AbortSignal): Promise<void> {
    const save = () => this.deps.store.evals.put(run);
    for (const item of run.items) {
      if (signal.aborted) {
        item.status = 'skipped';
        continue;
      }
      item.status = 'running';
      save();
      try {
        Object.assign(item, await this.replay(run.projectId, item, signal), { status: 'done' });
      } catch (err: any) {
        Object.assign(item, { status: signal.aborted ? 'skipped' : 'error', error: err?.message ?? String(err) });
      }
      save();
    }
    run.status = signal.aborted ? 'stopped' : 'done';
    run.finishedAt = now();
    save();
  }

  /** Replays one task with one model in a fresh worktree at the task's starting commit, and scores it. */
  private async replay(projectId: string, item: EvalItem, signal: AbortSignal): Promise<Partial<EvalItem>> {
    const { store, outcomes, runner } = this.deps;
    const project = store.projects.get(projectId)!;
    const original = outcomes.get(item.outcomeId)!;
    const dir = mkdtempSync(join(tmpdir(), 'mitzi-eval-'));
    const started = Date.now();
    let cost = 0;
    try {
      await git(['worktree', 'add', '--detach', dir, original.gitHead!], project.folder, { timeoutMs: 120_000 });
      // Installed dependencies aren't in git; the copy borrows the project's so its checks can run.
      if (existsSync(join(project.folder!, 'node_modules')) && !existsSync(join(dir, 'node_modules'))) {
        try {
          symlinkSync(join(project.folder!, 'node_modules'), join(dir, 'node_modules'), 'junction');
        } catch {
          // The checks may fail for want of dependencies; the score will show it.
        }
      }
      // The replay runs unattended in the throwaway copy; nothing it does touches the project's own folder.
      const result = await withUsage({ kind: 'eval', projectId, botId: original.botId, sink: (e) => (cost += e.cost), route: undefined }, () =>
        runner.runOnceDetailed({ botId: original.botId, model: item.model, prompt: original.task, projectId, tools: true, autoApprove: true, folder: dir, signal }),
      );
      const run = summarizeRun(result.messages);
      const checkCommand = project.verify?.enabled === false ? undefined : project.verify?.command || detectVerifyCommand(dir);
      let testsPassed: boolean | undefined;
      let checkOutput = '';
      if (checkCommand && !signal.aborted) {
        const ctx = { cwd: dir, readFiles: new Map(), todos: [], signal };
        const out = await bashTool.run({ command: checkCommand, timeout: 600_000 }, ctx).catch((err: Error) => `Error: ${err.message}`);
        const verdict = verifyOutcome(checkCommand, out);
        testsPassed = verdict.passed;
        checkOutput = verdict.output.slice(-1500);
      }
      // Untracked files show up in the diff once they're marked as intended additions (only in the throwaway copy).
      await git(['add', '-N', '.'], dir).catch(() => '');
      const diff = (await git(['diff'], dir).catch(() => '')).slice(0, 12_000);
      const reference = this.acceptedAnswer(original);
      const rubric = await withUsage({ kind: 'eval', projectId, sink: (e) => (cost += e.cost), route: undefined }, () =>
        this.deps.client().chat({
          model: this.deps.config().smallModel ?? this.deps.config().model,
          messages: [
            {
              role: 'user',
              content: RUBRIC_PROMPT.replace('{task}', original.task)
                .replace('{reference}', reference.slice(0, 4000) || '(not available)')
                .replace('{answer}', result.answer.slice(0, 4000) || '(no answer)')
                .replace('{diff}', diff || '(no changes)')
                .replace('{checks}', checkCommand ? `The project's checks (\`${checkCommand}\`) ${testsPassed ? 'passed' : `failed:\n${checkOutput}`}` : ''),
            },
          ],
          maxTokens: 300,
          signal,
        }),
      );
      return { ...parseScore(rubric.content), testsPassed, checkCommand, toolCalls: run.toolCalls, toolErrors: run.toolErrors, durationMs: Date.now() - started, cost };
    } finally {
      await git(['worktree', 'remove', '--force', dir], project.folder).catch(() => '');
      rmSync(dir, { recursive: true, force: true });
      await git(['worktree', 'prune'], project.folder).catch(() => '');
    }
  }

  /** The answer the user accepted for the original task. */
  private acceptedAnswer(o: TaskOutcome): string {
    const chat = this.deps.store.chats.get(o.chatId);
    const m = chat?.messages.find((m) => m.outcomeId === o.id);
    return typeof m?.content === 'string' ? m.content : '';
  }
}
