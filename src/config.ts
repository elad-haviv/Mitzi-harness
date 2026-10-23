import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'yolo';
export const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'yolo'];

export interface Config {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Cheaper model used for summarising history on /compact. Defaults to `model`. */
  smallModel?: string;
  /** Challenger for /compare. If unset, /compare needs explicit model ids. */
  compareModel?: string;
  maxTokens?: number;
  temperature?: number;
  maxTurns: number;
  permissionMode: PermissionMode;
  /** Tools that never prompt, e.g. "WebFetch" or "Bash(npm test)" (command prefix). */
  allowedTools: string[];
  /** Auto-compact once a request's prompt exceeds this many tokens. 0 disables. */
  autoCompactTokens: number;
  showReasoning: boolean;
  /**
   * Trailer appended to commit messages Mitzi writes. `true` uses the default co-author line,
   * `false` disables it, and a string replaces it (`{model}` expands to the current model id).
   */
  attribution: boolean | string;
}

export const DEFAULT_MODEL = 'anthropic/claude-sonnet-4.5';

export const MITZI_HOME = process.env.MITZI_HOME ?? join(homedir(), '.mitzi');

const DEFAULTS: Omit<Config, 'apiKey'> = {
  baseUrl: 'https://openrouter.ai/api/v1',
  model: DEFAULT_MODEL,
  maxTurns: 100,
  permissionMode: 'default',
  allowedTools: [],
  autoCompactTokens: 150_000,
  showReasoning: false,
  attribution: true,
};

function readJson(path: string): Partial<Config> {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err: any) {
    if (err?.code === 'ENOENT') return {};
    throw new Error(`Invalid config file ${path}: ${err.message}`);
  }
}

/**
 * Resolves configuration from (lowest to highest precedence):
 * defaults, ~/.mitzi/config.json, ./.mitzi/config.json, environment, CLI overrides.
 */
export function loadConfig(cwd: string, overrides: Partial<Config> = {}): Config {
  const user = readJson(join(MITZI_HOME, 'config.json'));
  const project = readJson(join(cwd, '.mitzi', 'config.json'));
  const env: Partial<Config> = {};
  if (process.env.OPENROUTER_API_KEY) env.apiKey = process.env.OPENROUTER_API_KEY;
  if (process.env.OPENROUTER_BASE_URL) env.baseUrl = process.env.OPENROUTER_BASE_URL;
  if (process.env.MITZI_MODEL) env.model = process.env.MITZI_MODEL;

  const merged = { ...DEFAULTS, ...user, ...project, ...env, ...stripUndefined(overrides) } as Config;
  merged.allowedTools = [...(user.allowedTools ?? []), ...(project.allowedTools ?? []), ...(overrides.allowedTools ?? [])];
  merged.apiKey ??= '';
  if (!PERMISSION_MODES.includes(merged.permissionMode)) {
    throw new Error(`Unknown permission mode "${merged.permissionMode}". Use one of: ${PERMISSION_MODES.join(', ')}`);
  }
  return merged;
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
