import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { riskyCommand } from './sensitive.js';
import { Tool, ToolError, truncateMiddle } from './types.js';

const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 600_000;
const MAX_OUTPUT = 30_000;

interface BashArgs {
  command: string;
  timeout?: number;
  description?: string;
}

export const bashTool: Tool<BashArgs> = {
  name: 'Bash',
  kind: 'exec',
  description:
    'Run a shell command with bash and return its combined output and exit code. The working directory ' +
    'persists between calls (a `cd` carries over), but environment variables do not. ' +
    `Default timeout ${DEFAULT_TIMEOUT / 1000}s, max ${MAX_TIMEOUT / 1000}s. Output over ${MAX_OUTPUT} characters is truncated. ` +
    'Prefer the Read, Glob and Grep tools over cat, find and grep. Do not run interactive commands.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command to run' },
      timeout: { type: 'integer', description: `Timeout in milliseconds (max ${MAX_TIMEOUT})` },
      description: { type: 'string', description: 'Five to ten words describing what the command does' },
    },
    required: ['command'],
  },
  summarize: (a) => a.command,
  sensitive: (a) => riskyCommand(String(a?.command ?? '')),
  async run(args, ctx) {
    if (!args.command?.trim()) throw new ToolError('command is required');
    const timeout = Math.min(Math.max(1000, args.timeout ?? DEFAULT_TIMEOUT), MAX_TIMEOUT);

    // Capture the final working directory so `cd` persists across calls. The cwd is
    // emitted on stdout behind a sentinel (cygpath translates MSYS paths like /tmp/...
    // or /c/... to Windows form when available) and stripped from the visible output.
    const SENTINEL = '__MITZI_CWD__:';
    const script =
      `${args.command}\n__mitzi_ec=$?\n` +
      `{ if command -v cygpath >/dev/null 2>&1; then cygpath -w "$PWD"; else pwd -P; fi; } | sed 's/^/${SENTINEL}/'\n` +
      `exit $__mitzi_ec`;

    const { output, code, timedOut, aborted } = await runShell(script, ctx.cwd, timeout, ctx.signal);
    let visible = output;
    const cwdMatch = new RegExp(`\\n?${SENTINEL}([^\\n]*)`).exec(output);
    if (cwdMatch) {
      visible = output.slice(0, cwdMatch.index) + output.slice(cwdMatch.index + cwdMatch[0].length);
      const next = cwdMatch[1].trim();
      try {
        if (next && statSync(next).isDirectory()) ctx.cwd = next;
      } catch {
        // Not a directory on this side (e.g. a WSL-native path); keep the old cwd.
      }
    }
    let result = truncateMiddle(visible.trimEnd(), MAX_OUTPUT) || '(no output)';
    if (timedOut) result += `\n[Command timed out after ${timeout / 1000}s]`;
    else if (aborted) result += '\n[Command interrupted by user]';
    else if (code !== 0) result += `\n[Exit code ${code}]`;
    return result;
  },
};

/**
 * Locates a working bash. On Windows, `bash` on PATH can be the WSL stub
 * (System32\bash.exe), which exits 1 with no output when no distro is installed —
 * so we verify the candidate actually runs, and also probe Git for Windows paths.
 */
let bashPath: string | undefined;
function findBash(): string {
  if (bashPath) return bashPath;
  const candidates = ['bash'];
  if (process.platform === 'win32') {
    for (const root of [process.env['ProgramFiles'], process.env['ProgramFiles(x86)']]) {
      if (root) candidates.push(join(root, 'Git', 'bin', 'bash.exe'), join(root, 'Git', 'usr', 'bin', 'bash.exe'));
    }
  }
  for (const c of candidates) {
    try {
      if (c.includes('\\') || c.includes('/')) {
        if (!existsSync(c)) continue;
        if (spawnSync(c, ['-c', 'true'], { stdio: 'ignore' }).status === 0) return (bashPath = c);
      } else if (spawnSync(c, ['-c', 'true'], { stdio: 'ignore' }).status === 0) {
        return (bashPath = c);
      }
    } catch {
      // not usable; try the next candidate
    }
  }
  throw new ToolError('No working bash found. Install Git for Windows or enable WSL, and make sure bash is on PATH.');
}

function runShell(script: string, cwd: string, timeout: number, signal?: AbortSignal) {
  return new Promise<{ output: string; code: number | null; timedOut: boolean; aborted: boolean }>((resolve, reject) => {
    let child;
    try {
      child = spawn(findBash(), ['-c', script], {
        cwd,
        detached: true, // own process group, so we can kill the whole tree
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, MITZI: '1', GIT_PAGER: 'cat', PAGER: 'cat' },
      });
    } catch (err: any) {
      reject(err instanceof ToolError ? err : new ToolError(`Failed to start bash: ${err.message}`));
      return;
    }
    let output = '';
    let timedOut = false;
    let aborted = false;
    const collect = (d: Buffer) => {
      output += d.toString();
      if (output.length > MAX_OUTPUT * 4) output = output.slice(-MAX_OUTPUT * 2);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const kill = () => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeout);
    const onAbort = () => {
      aborted = true;
      kill();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new ToolError(`Failed to start bash: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ output, code, timedOut, aborted });
    });
  });
}
