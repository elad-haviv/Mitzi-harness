import { execFile } from 'node:child_process';

/** Runs git without ever prompting for credentials. Rejects with git's last error line. */
export function git(args: string[], cwd?: string, opts: { timeoutMs?: number; env?: Record<string, string> } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, timeout: opts.timeoutMs ?? 180_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...opts.env }, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error((err as NodeJS.ErrnoException).code === 'ENOENT' ? 'git is not installed. Install it from https://git-scm.com.' : stderr.trim().split('\n').pop() || err.message));
        else resolve(stdout);
      },
    );
  });
}
