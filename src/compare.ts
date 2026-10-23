import type { Agent } from './agent.js';
import type { OpenRouterClient, Usage } from './openrouter.js';
import type { CompareUI } from './ui.js';

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

export type ComparePick = (outcome: CompareOutcome) => Promise<'A' | 'B' | 'skip'>;

/** A token that could be an OpenRouter model id: exactly one `/`, no spaces. */
export function looksLikeModelId(token: string): boolean {
  return /^[^\s/]+\/[^\s/]+$/.test(token);
}

/**
 * Splits `/compare` arguments into models and prompt.
 * - no model ids: current model vs the configured `compareModel`
 * - one id: current model vs that id
 * - two ids: those two
 * Leading tokens are treated as model ids only when they look like one
 * (`vendor/model`) and, when `knownIds` (the OpenRouter catalog) is available,
 * are actually known — so a prompt that happens to start with something like
 * "src/index.ts" still parses as a prompt.
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

/**
 * Sends one prompt to two models in parallel, streaming both into the UI.
 * Per-side failures are recorded on the outcome instead of throwing, so one
 * bad model never hides the other's answer. The pick is requested unless both
 * sides failed or the race was interrupted.
 */
export async function runCompare(opts: {
  client: OpenRouterClient;
  ui: CompareUI;
  modelA: string;
  modelB: string;
  prompt: string;
  signal?: AbortSignal;
  onUsage?: (usage?: Usage) => void;
  pick: ComparePick;
}): Promise<CompareOutcome> {
  const { client, ui, modelA, modelB, prompt, signal, onUsage, pick } = opts;
  const messages = [{ role: 'user' as const, content: prompt }];
  const outcome: CompareOutcome = { modelA, modelB, textA: '', textB: '' };

  const run = async (side: 'A' | 'B', model: string) => {
    try {
      const res = await client.chat({ model, messages, signal }, { onText: (c) => (side === 'A' ? ui.pushA(c) : ui.pushB(c)) });
      onUsage?.(res.usage);
      if (side === 'A') {
        outcome.textA = res.content;
        ui.endA();
      } else {
        outcome.textB = res.content;
        ui.endB();
      }
    } catch (err: any) {
      const message = signal?.aborted ? 'skipped (interrupted)' : err?.message ?? String(err);
      if (side === 'A') {
        outcome.errorA = message;
        ui.failA(message);
      } else {
        outcome.errorB = message;
        ui.failB(message);
      }
    }
  };

  ui.start();
  await Promise.all([run('A', modelA), run('B', modelB)]);
  ui.finish();
  if (!(outcome.errorA && outcome.errorB) && !signal?.aborted) {
    const choice = await pick(outcome);
    if (choice !== 'skip') outcome.winner = choice;
  }
  return outcome;
}

/** Adds the chosen answer to the session as this turn's user/assistant exchange. */
export function applyOutcome(agent: Agent, outcome: CompareOutcome, prompt: string): void {
  if (!outcome.winner) return;
  const text = (outcome.winner === 'A' ? outcome.textA : outcome.textB) || '(the model returned no content)';
  agent.messages.push({ role: 'user', content: prompt });
  agent.messages.push({ role: 'assistant', content: text });
}

/** Which ids to tally for the outcome; a loss is only counted against a model that actually answered. */
export function tallyFor(outcome: CompareOutcome): { winner?: string; loser?: string } {
  if (!outcome.winner) return {};
  const winner = outcome.winner === 'A' ? outcome.modelA : outcome.modelB;
  const loserSide = outcome.winner === 'A' ? 'B' : 'A';
  const loser = loserSide === 'A' ? outcome.modelA : outcome.modelB;
  const loserFailed = loserSide === 'A' ? !!outcome.errorA : !!outcome.errorB;
  return { winner, loser: loserFailed ? undefined : loser };
}
