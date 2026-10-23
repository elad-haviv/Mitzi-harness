// /compare: race one prompt against two models, stream both answers live side by side,
// and let the user pick the winner. Picks are tallied in compare-insights.json.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CompareInsights, StreamEvent } from '../shared/types.js';
import type { LlmClient } from '../openrouter.js';

/** A token that could be a model id: exactly one `/`, no spaces; or a provider-prefixed id like "openai:gpt-5". */
export function looksLikeModelId(token: string): boolean {
  return /^[^\s/]+\/[^\s/]+$/.test(token) || /^[a-z0-9-]+:\S+$/.test(token);
}

/**
 * Splits `/compare` arguments into models and prompt.
 * - no model ids: chat model vs the configured `compareModel`
 * - one id: chat model vs that id
 * - two ids: those two
 * Leading tokens count as model ids only when they look like one and, when `knownIds`
 * (the catalog) is available, are actually known — so a prompt starting with something
 * like "src/index.ts" still parses as a prompt.
 */
export function parseCompareArgs(
  arg: string,
  currentModel: string,
  compareModel: string | undefined,
  knownIds?: Set<string>,
): { modelA: string; modelB: string; prompt: string } | { error: string } {
  const tokens = arg.trim().split(/\s+/).filter(Boolean);
  const taken: string[] = [];
  let i = 0;
  while (taken.length < 2 && i < tokens.length && looksLikeModelId(tokens[i]) && (!knownIds || knownIds.has(tokens[i]))) {
    taken.push(tokens[i++]);
  }
  const prompt = tokens.slice(i).join(' ');
  if (!prompt) return { error: 'Usage: /compare [modelA] [modelB] <prompt>' };

  let modelA = currentModel;
  let modelB: string | undefined;
  if (taken.length === 1) modelB = taken[0];
  else if (taken.length >= 2) [modelA, modelB] = [taken[0], taken[1]];
  else modelB = compareModel;
  if (!modelB) {
    return { error: 'No challenger configured. Set "compareModel" in ~/.mitzi/config.json, or use /compare <model-id> <prompt>.' };
  }
  return { modelA, modelB, prompt };
}

export interface CompareOutcome {
  modelA: string;
  modelB: string;
  textA: string;
  textB: string;
  errorA?: string;
  errorB?: string;
  /** Set when the user picked a side. */
  winner?: 'A' | 'B';
}

export type ComparePick = 'A' | 'B' | 'skip';

/**
 * Sends one prompt to two models in parallel, streaming each side as `compare` events.
 * Per-side failures land on the outcome instead of throwing, so one bad model never
 * hides the other's answer.
 */
export async function runCompareRace(opts: {
  client: LlmClient;
  modelA: string;
  modelB: string;
  prompt: string;
  signal?: AbortSignal;
  emit: (e: StreamEvent) => void;
  /** Resolves with the user's pick once both sides finished. */
  waitForPick: (outcome: CompareOutcome) => Promise<ComparePick>;
}): Promise<CompareOutcome> {
  const { client, modelA, modelB, prompt, signal, emit, waitForPick } = opts;
  const messages = [{ role: 'user' as const, content: prompt }];
  const outcome: CompareOutcome = { modelA, modelB, textA: '', textB: '' };

  emit({ type: 'compare_start', modelA, modelB, prompt });
  const run = async (side: 'A' | 'B', model: string) => {
    try {
      const res = await client.chat({ model, messages, signal }, { onText: (c) => emit({ type: 'compare_text', side, text: c }) });
      if (side === 'A') outcome.textA = res.content;
      else outcome.textB = res.content;
      emit({ type: 'compare_end', side });
    } catch (err: any) {
      const message = signal?.aborted ? 'skipped (interrupted)' : (err?.message ?? String(err));
      if (side === 'A') outcome.errorA = message;
      else outcome.errorB = message;
      emit({ type: 'compare_end', side, error: message });
    }
  };
  await Promise.all([run('A', modelA), run('B', modelB)]);

  if (!(outcome.errorA && outcome.errorB) && !signal?.aborted) {
    const choice = await waitForPick(outcome);
    if (choice !== 'skip') outcome.winner = choice;
  }
  return outcome;
}

/** Which ids to tally; a loss only counts against a model that actually answered. */
export function tallyFor(outcome: CompareOutcome): { winner?: string; loser?: string } {
  if (!outcome.winner) return {};
  const winner = outcome.winner === 'A' ? outcome.modelA : outcome.modelB;
  const loserSide = outcome.winner === 'A' ? 'B' : 'A';
  const loser = loserSide === 'A' ? outcome.modelA : outcome.modelB;
  const loserFailed = loserSide === 'A' ? !!outcome.errorA : !!outcome.errorB;
  return { winner, loser: loserFailed ? undefined : loser };
}

/** Records one pick into the tally (mutates). Undefined winner means the user skipped. */
export function recordPick(data: CompareInsights, winner: string | undefined, loser: string | undefined): void {
  data.comparisons++;
  if (!winner) {
    data.skipped++;
    return;
  }
  data.wins[winner] = (data.wins[winner] ?? 0) + 1;
  if (loser) data.losses[loser] = (data.losses[loser] ?? 0) + 1;
}

/** Persistent tally of /compare picks, one JSON file at the store root (like settings.json). */
export class CompareInsightsStore {
  private readonly path: string;
  private data: CompareInsights;

  constructor(root: string) {
    this.path = join(root, 'compare-insights.json');
    mkdirSync(root, { recursive: true });
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<CompareInsights>;
      this.data = {
        wins: raw.wins && typeof raw.wins === 'object' ? { ...raw.wins } : {},
        losses: raw.losses && typeof raw.losses === 'object' ? { ...raw.losses } : {},
        comparisons: raw.comparisons ?? 0,
        skipped: raw.skipped ?? 0,
      };
    } catch {
      this.data = { wins: {}, losses: {}, comparisons: 0, skipped: 0 };
    }
  }

  get insights(): CompareInsights {
    return { wins: { ...this.data.wins }, losses: { ...this.data.losses }, comparisons: this.data.comparisons, skipped: this.data.skipped };
  }

  record(winner: string | undefined, loser: string | undefined): void {
    recordPick(this.data, winner, loser);
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    renameSync(tmp, this.path);
  }
}
