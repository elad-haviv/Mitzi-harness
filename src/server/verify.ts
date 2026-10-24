// The verification habit: in work mode, a turn that changed files isn't over until the project's checks pass.
// The harness (not the model) runs the checks and decides whether the bot keeps working.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Message } from '../openrouter.js';
import type { Project, VerifyResult } from '../shared/types.js';

/** Fix-and-recheck rounds after the first failed check, before the harness gives up and reports. */
export const MAX_VERIFY_ROUNDS = 2;
const NPM_PLACEHOLDER_TEST = /no test specified/;

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/** Works out how to check a project from its manifests: tests first, else a type check, lint or build. */
export function detectVerifyCommand(folder: string): string | undefined {
  const pkg = readJson(join(folder, 'package.json'));
  if (pkg?.scripts) {
    const runner = existsSync(join(folder, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(folder, 'yarn.lock')) ? 'yarn' : existsSync(join(folder, 'bun.lockb')) ? 'bun' : 'npm';
    const scripts = pkg.scripts as Record<string, string>;
    if (scripts.test && !NPM_PLACEHOLDER_TEST.test(scripts.test)) return `${runner} test`;
    for (const name of ['typecheck', 'check', 'lint', 'build']) if (scripts[name]) return `${runner} run ${name}`;
  }
  if (/^test:/m.test(readText(join(folder, 'Makefile')))) return 'make test';
  if (existsSync(join(folder, 'Cargo.toml'))) return 'cargo test';
  if (existsSync(join(folder, 'go.mod'))) return 'go test ./...';
  const py = readText(join(folder, 'pyproject.toml')) + readText(join(folder, 'setup.cfg'));
  if (/pytest/.test(py) || existsSync(join(folder, 'pytest.ini')) || existsSync(join(folder, 'conftest.py'))) return 'python -m pytest -q';
  return undefined;
}

/** The command that checks a project's work, or undefined when there is none or the user turned it off. */
export function verifyCommandFor(project: Project | undefined): string | undefined {
  if (!project?.folder || project.verify?.enabled === false) return undefined;
  return project.verify?.command?.trim() || detectVerifyCommand(project.folder);
}

/** Files changed by successful Write and Edit calls in these messages. */
export function touchedFiles(messages: Message[]): string[] {
  const failed = new Set(messages.filter((m) => m.role === 'tool' && typeof m.content === 'string' && /^(Error|Skipped|The user declined)/.test(m.content)).map((m) => m.tool_call_id));
  const files = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const c of m.tool_calls ?? []) {
      if (!/^(Write|Edit)$/.test(c.function.name) || failed.has(c.id)) continue;
      try {
        const path = JSON.parse(c.function.arguments || '{}').file_path;
        if (path) files.add(String(path));
      } catch {
        // Unparseable arguments never ran.
      }
    }
  }
  return [...files];
}

/** Reads the Bash tool's output: it marks failures with an exit code, a timeout or an interruption. */
export function verifyOutcome(command: string, output: string): VerifyResult {
  const passed = !/\n?\[(Exit code \d+|Command timed out[^\]]*|Command interrupted by user)\]\s*$/.test(output) && !/^Error:/.test(output);
  return { command, passed, output: output.length > 4000 ? `…${output.slice(-4000)}` : output, at: new Date().toISOString() };
}

/** The message that sends the bot back to work after a failed check. */
export function verifyMessage(result: VerifyResult, round: number): string {
  return (
    `I ran the project's checks (\`${result.command}\`) after your changes and they failed. ` +
    `Fix the cause and keep working; don't finish while they fail. If the failure is unrelated to your change or ` +
    `can't be fixed from here, say exactly why.${round > 1 ? ` (Check ${round} of ${MAX_VERIFY_ROUNDS + 1}.)` : ''}\n\n` +
    `<output>\n${result.output.slice(-3000)}\n</output>`
  );
}
