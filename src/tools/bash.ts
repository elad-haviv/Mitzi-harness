import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  async run(args, ctx) {
    if (!args.command?.trim()) throw new ToolError('command is required');
    const timeout = Math.min(Math.max(1000, args.timeout ?? DEFAULT_TIMEOUT), MAX_TIMEOUT);

    // Capture the final working directory so `cd` persists across calls.
    const dir = mkdtempSync(join(tmpdir(), 'mitzi-'));
    const cwdFile = join(dir, 'cwd');
    const script = `${args.command}\n__mitzi_ec=$?\npwd -P > '${cwdFile}'\nexit $__mitzi_ec`;

    try {
      const { output, code, timedOut, aborted } = await runShell(script, ctx.cwd, timeout, ctx.signal);
      try {
        const next = readFileSync(cwdFile, 'utf8').trim();
        if (next && statSync(next).isDirectory()) ctx.cwd = next;
      } catch {
        // Command exited before reaching pwd (e.g. `exit 1`); keep the old cwd.
      }
      let result = truncateMiddle(output.trimEnd(), MAX_OUTPUT) || '(no output)';
      if (timedOut) result += `\n[Command timed out after ${timeout / 1000}s]`;
      else if (aborted) result += '\n[Command interrupted by user]';
      else if (code !== 0) result += `\n[Exit code ${code}]`;
      return result;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};

function runShell(script: string, cwd: string, timeout: number, signal?: AbortSignal) {
  return new Promise<{ output: string; code: number | null; timedOut: boolean; aborted: boolean }>((resolve, reject) => {
    const child = spawn('bash', ['-c', script], {
      cwd,
      detached: true, // own process group, so we can kill the whole tree
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, MITZI: '1', GIT_PAGER: 'cat', PAGER: 'cat' },
    });
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
