import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Insights {
  /** model id → number of times the user picked it over another */
  wins: Record<string, number>;
  /** model id → number of times the user saw both and picked the other one */
  losses: Record<string, number>;
  comparisons: number;
  skipped: number;
}

/** The insights home, resolved at call time so tests can point MITZI_HOME elsewhere. */
const homeDir = () => process.env.MITZI_HOME ?? join(homedir(), '.mitzi');
const insightsFile = () => join(homeDir(), 'insights.json');

/** Loads the tally from MITZI_HOME, tolerating a missing or corrupt file. */
export function loadInsights(): Insights {
  try {
    const raw = JSON.parse(readFileSync(insightsFile(), 'utf8')) as Partial<Insights>;
    return {
      wins: raw.wins && typeof raw.wins === 'object' ? { ...raw.wins } : {},
      losses: raw.losses && typeof raw.losses === 'object' ? { ...raw.losses } : {},
      comparisons: raw.comparisons ?? 0,
      skipped: raw.skipped ?? 0,
    };
  } catch {
    return { wins: {}, losses: {}, comparisons: 0, skipped: 0 };
  }
}

/** Persists the tally. Creates the home dir when missing. */
export function saveInsights(data: Insights): void {
  mkdirSync(homeDir(), { recursive: true });
  writeFileSync(insightsFile(), JSON.stringify(data, null, 2));
}

/** Records one comparison outcome. Winner/loser are model ids; undefined winner means the user skipped. */
export function recordPick(data: Insights, winner: string | undefined, loser: string | undefined): void {
  data.comparisons++;
  if (!winner) {
    data.skipped++;
    return;
  }
  data.wins[winner] = (data.wins[winner] ?? 0) + 1;
  if (loser) data.losses[loser] = (data.losses[loser] ?? 0) + 1;
}

/**
 * Renders the leaderboard as plain lines. Ranked by wins, then by win rate among
 * models with equal wins, then alphabetically.
 */
export function renderInsights(data: Insights): string[] {
  const played = (id: string) => (data.wins[id] ?? 0) + (data.losses[id] ?? 0);
  const models = [...new Set([...Object.keys(data.wins), ...Object.keys(data.losses)])];
  models.sort((a, b) => (data.wins[b] ?? 0) - (data.wins[a] ?? 0) || played(a) - played(b) || a.localeCompare(b));
  const lines = models.map((id) => {
    const w = data.wins[id] ?? 0;
    const l = data.losses[id] ?? 0;
    const games = w + l;
    const rate = Math.round((w / games) * 100);
    return `  ${w}W ${l}L  ${String(rate).padStart(3)}%  ${id}`;
  });
  if (!lines.length) lines.push('  No picks recorded yet. Race two models with /compare.');
  return lines;
}
