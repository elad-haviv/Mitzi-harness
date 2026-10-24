// Per-model adaptation: the outcome ledger is tagged by model, so once there's enough data it shows each model's
// habits ("skips verification", "over-edits", "edits fail") and the prompt gets a matching note for that model.
// Deterministic rules over measured rates: no model call, and nothing until the evidence is there.
import type { TaskOutcome } from '../shared/types.js';
import { rates } from './metrics.js';

/** Tasks on a model before it gets notes. */
export const MIN_TASKS = 8;

export interface ModelHint {
  /** What the data shows, for people. */
  why: string;
  /** What the model is told. */
  hint: string;
}

/** Notes for a model from how its tasks went, compared with the other models'. */
export function modelHints(model: string, outcomes: TaskOutcome[]): ModelHint[] {
  const live = outcomes.filter((o) => o.source !== 'backfill');
  const mine = live.filter((o) => o.model === model);
  if (mine.length < MIN_TASKS) return [];
  const others = live.filter((o) => o.model !== model);
  const me = rates(mine);
  const them = others.length >= MIN_TASKS ? rates(others) : undefined;
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const hints: ModelHint[] = [];

  const checked = mine.filter((o) => o.firstCheckPassed !== undefined);
  if (checked.length >= 5 && me.firstCheckPassed !== undefined && me.firstCheckPassed < 0.6) {
    hints.push({
      why: `Only ${pct(me.firstCheckPassed)} of its checked work passed the first check.`,
      hint: "Before you say you're done, run the project's tests or checks yourself and fix what fails. Your work often fails the final check.",
    });
  }

  const agentErrors = mine.flatMap((o) => o.errors.filter((e) => e.kind === 'agent'));
  if (me.agentErrors > 0.5 && (!them || me.agentErrors > them.agentErrors * 1.5)) {
    const edits = agentErrors.filter((e) => e.tool === 'Edit' || e.tool === 'Write').length;
    hints.push(
      edits >= agentErrors.length / 2
        ? {
            why: `${me.agentErrors.toFixed(1)} failed tool calls per task, mostly edits.`,
            hint: 'Read a file right before editing it, and copy old_string exactly from what you read, including indentation.',
          }
        : {
            why: `${me.agentErrors.toFixed(1)} failed tool calls per task${them ? ` (others: ${them.agentErrors.toFixed(1)})` : ''}.`,
            hint: "Check tool arguments carefully, and when a call fails, read the error and change the approach instead of retrying the same call.",
          },
    );
  }

  if (me.redoRate !== undefined && me.redoRate > 0.25 && (!them || me.redoRate > (them.redoRate ?? 0) + 0.1)) {
    hints.push({
      why: `The user asked for a redo on ${pct(me.redoRate)} of its tasks.`,
      hint: "Make sure you do what the user actually asked: if the request is ambiguous in a way that matters, ask first; don't add things they didn't ask for.",
    });
  }

  const avgFiles = (xs: TaskOutcome[]) => (xs.length ? xs.reduce((n, o) => n + o.filesTouched.length, 0) / xs.length : 0);
  if (them && avgFiles(mine) >= 3 && avgFiles(mine) > avgFiles(others) * 2) {
    hints.push({
      why: `It changes ${avgFiles(mine).toFixed(1)} files per task, against ${avgFiles(others).toFixed(1)} for other models.`,
      hint: "Keep changes focused on the task: don't refactor, reformat or touch files the task doesn't need.",
    });
  }

  const edited = mine.filter((o) => (o.editsAfter ?? 0) > 0).length / mine.length;
  if (edited > 0.3) {
    hints.push({
      why: `The user fixed up its output after ${pct(edited)} of its tasks.`,
      hint: "Match the existing style of the code and documents you work on closely; the user often has to adjust your output.",
    });
  }
  return hints;
}

/** Caches hints per model for a few minutes (the ledger changes slowly; prompts are built every request). */
export class ModelAdaptation {
  private cache = new Map<string, { at: number; hints: ModelHint[] }>();

  constructor(private readonly outcomes: () => TaskOutcome[]) {}

  hints(model: string): ModelHint[] {
    const hit = this.cache.get(model);
    if (hit && Date.now() - hit.at < 300_000) return hit.hints;
    const hints = modelHints(model.replace(/:online$/, ''), this.outcomes());
    this.cache.set(model, { at: Date.now(), hints });
    return hints;
  }

  /** Hints for every model with data. */
  all(): { model: string; hints: ModelHint[] }[] {
    const models = new Set(this.outcomes().map((o) => o.model));
    return [...models].map((model) => ({ model, hints: this.hints(model) })).filter((m) => m.hints.length);
  }
}
