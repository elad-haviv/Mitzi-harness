import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { platform } from 'node:os';
import { dirname, join } from 'node:path';
import { MITZI_HOME, PermissionMode } from './config.js';

export const INSTRUCTION_FILES = ['MITZI.md', 'AGENTS.md', 'CLAUDE.md'];
const MAX_INSTRUCTION_CHARS = 40_000;

export interface InstructionFile {
  path: string;
  content: string;
}

/** Collects instruction files from ~/.mitzi and from the root of the tree down to cwd. */
export function findInstructionFiles(cwd: string): InstructionFile[] {
  const dirs: string[] = [];
  for (let dir = cwd; ; dir = dirname(dir)) {
    dirs.unshift(dir);
    if (dirname(dir) === dir) break;
  }
  const paths = [join(MITZI_HOME, 'MITZI.md'), ...dirs.flatMap((d) => INSTRUCTION_FILES.map((f) => join(d, f)))];
  const seen = new Set<string>();
  const files: InstructionFile[] = [];
  for (const path of paths) {
    if (seen.has(path) || !existsSync(path)) continue;
    seen.add(path);
    try {
      files.push({ path, content: readFileSync(path, 'utf8').slice(0, MAX_INSTRUCTION_CHARS) });
    } catch {
      // Unreadable; skip.
    }
  }
  return files;
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString().trim();
  } catch {
    return undefined;
  }
}

export function buildSystemPrompt(opts: { cwd: string; model: string; mode: PermissionMode }): string {
  const branch = git(opts.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const status = branch !== undefined ? git(opts.cwd, ['status', '--short']) : undefined;
  const instructions = findInstructionFiles(opts.cwd);

  const sections = [
    `You are Mitzi, an interactive command-line coding agent. You help the user with software engineering tasks: \
fixing bugs, adding features, refactoring, explaining code, running commands and more. You work directly in the \
user's repository using the tools available to you.`,

    `# How to work
- Understand before acting: use Glob, Grep, LS and Read to explore the codebase. Follow its existing conventions, \
libraries and style. Never assume a library is available; check the project's manifests first.
- For multi-step tasks, plan with TodoWrite and keep it updated as you go.
- Make changes with Edit (preferred) or Write. Always Read a file before modifying it.
- After changing code, verify it: run the project's tests, type checker, linter or build where they exist.
- Call independent tools together in a single response when possible.
- Do what was asked; nothing more, nothing less. Don't create files (especially docs) unless needed for the task.
- Never commit, push or perform destructive or irreversible operations unless the user explicitly asks.
- Never reveal or log secrets, and don't introduce code that does.
- If a tool call is denied, don't retry it verbatim; adjust or ask the user.`,

    `# Communication
- Your output is shown in a terminal; be concise and direct. Use GitHub-flavored markdown sparingly.
- Don't narrate every tool call. Briefly say what you're about to do when it isn't obvious, and summarize results at the end.
- Reference code as \`path/to/file.ts:42\` so the user can jump to it.
- If the request is ambiguous in a way that matters, ask a short clarifying question instead of guessing.`,

    `# Environment
- Working directory: ${opts.cwd}
- Platform: ${platform()}
- Date: ${new Date().toISOString().slice(0, 10)}
- Model: ${opts.model}
- Git repository: ${branch !== undefined ? `yes (branch: ${branch})` : 'no'}${
      status ? `\n- Git status (short):\n${status.split('\n').slice(0, 30).map((l) => `    ${l}`).join('\n')}` : ''
    }`,
  ];

  if (opts.mode === 'plan') {
    sections.push(`# Plan mode
Plan mode is ON. Do not modify files or run commands with side effects. Research the codebase with read-only tools, \
then present a concrete step-by-step plan and wait for the user to approve it.`);
  }

  if (instructions.length) {
    sections.push(
      `# Project instructions\nThe user provided these instructions. Follow them; they override the defaults above.\n\n` +
        instructions.map((f) => `<instructions path="${f.path}">\n${f.content}\n</instructions>`).join('\n\n'),
    );
  }

  return sections.join('\n\n');
}
