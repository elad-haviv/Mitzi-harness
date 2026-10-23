// Updates for installs made with the installer, which keeps Mitzi as a git checkout: check the
// tracked branch for new commits, then pull, reinstall, rebuild, and let the launcher restart.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from './server/git.js';

/** The installed copy of Mitzi (a git checkout when installed with the installer). */
const ROOT = process.env.MITZI_APP_DIR ?? fileURLToPath(new URL('../', import.meta.url));

export function currentVersion(): string {
  return (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
}

export interface UpdateCommit {
  sha: string;
  date: string;
  subject: string;
}

export interface UpdateInfo {
  /** False when this copy can't update itself (not a git checkout, local changes…). */
  supported: boolean;
  reason?: string;
  current: { version: string; commit?: string; date?: string };
  latest?: { version: string; commit: string; date: string };
  branch?: string;
  /** New commits on the remote. */
  behind: number;
  commits: UpdateCommit[];
  checkedAt: string;
}

export type UpdateStep = 'download' | 'install' | 'build';
export type UpdateEvent =
  | { type: 'step'; step: UpdateStep; status: 'running' | 'done' | 'skipped' }
  | { type: 'log'; text: string }
  | { type: 'done'; version: string }
  | { type: 'error'; message: string };

const run = (cmd: string, args: string[], onLog: (s: string) => void, timeoutMs = 15 * 60_000): Promise<void> =>
  new Promise((resolve, reject) => {
    // npm is npm.cmd on Windows, which needs a shell.
    const p = spawn(cmd, args, { cwd: ROOT, shell: process.platform === 'win32', env: { ...process.env, npm_config_loglevel: 'error' } });
    const timer = setTimeout(() => p.kill(), timeoutMs);
    let tail = '';
    const take = (d: Buffer) => {
      const s = d.toString();
      tail = (tail + s).slice(-4000);
      for (const line of s.split('\n')) if (line.trim()) onLog(line.trimEnd());
    };
    p.stdout.on('data', take);
    p.stderr.on('data', take);
    p.on('error', (err) => (clearTimeout(timer), reject(err)));
    p.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} failed:\n${tail.trim().split('\n').slice(-8).join('\n')}`));
    });
  });

let checking: Promise<UpdateInfo> | undefined;
let busy = false;

export function updating(): boolean {
  return busy;
}

export async function checkForUpdates(): Promise<UpdateInfo> {
  checking ??= (async () => {
    const base: UpdateInfo = { supported: false, current: { version: currentVersion() }, behind: 0, commits: [], checkedAt: new Date().toISOString() };
    if (!existsSync(join(ROOT, '.git'))) {
      return { ...base, reason: 'This copy of Mitzi wasn’t installed with the installer, so it can’t update itself. Run the install command again to update.' };
    }
    try {
      const head = (await git(['log', '-1', '--format=%h%x09%cI'], ROOT)).trim().split('\t');
      base.current = { ...base.current, commit: head[0], date: head[1] };
      const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], ROOT)).trim();
      if (branch === 'HEAD') return { ...base, reason: 'This copy isn’t on a branch, so there’s nothing to follow for updates.' };
      base.branch = branch;
      await git(['fetch', '--quiet', 'origin', branch], ROOT, { timeoutMs: 60_000 });
      const remote = `origin/${branch}`;
      const behind = Number((await git(['rev-list', '--count', `HEAD..${remote}`], ROOT)).trim());
      const ahead = Number((await git(['rev-list', '--count', `${remote}..HEAD`], ROOT)).trim());
      const commits = (await git(['log', '--format=%h%x09%cI%x09%s', '-n', '40', `HEAD..${remote}`], ROOT))
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const [sha, date, ...subject] = l.split('\t');
          return { sha, date, subject: subject.join('\t') };
        });
      const latestHead = (await git(['log', '-1', '--format=%h%x09%cI', remote], ROOT)).trim().split('\t');
      let latestVersion = base.current.version;
      try {
        latestVersion = JSON.parse(await git(['show', `${remote}:package.json`], ROOT)).version ?? latestVersion;
      } catch {
        // Keep the current version number.
      }
      const info: UpdateInfo = { ...base, supported: true, behind, commits, latest: { version: latestVersion, commit: latestHead[0], date: latestHead[1] } };
      // Changes made by hand would be overwritten or block the update.
      const dirty = (await git(['status', '--porcelain', '--untracked-files=no'], ROOT)).trim();
      if (behind && dirty) return { ...info, supported: false, reason: `Files in ${ROOT} were changed by hand, so Mitzi won’t overwrite them. Undo the changes (git checkout .) or update with the installer.` };
      if (behind && ahead) return { ...info, supported: false, reason: 'This copy has its own commits, so it can’t be updated automatically. Update it with git.' };
      return info;
    } catch (err) {
      return { ...base, reason: `Couldn’t check for updates: ${(err as Error).message}` };
    }
  })().finally(() => (checking = undefined));
  return checking;
}

/** Pulls, reinstalls dependencies if they changed, and rebuilds. Rolls back if anything fails. */
export async function applyUpdate(emit: (e: UpdateEvent) => void): Promise<boolean> {
  if (busy) {
    emit({ type: 'error', message: 'An update is already running' });
    return false;
  }
  busy = true;
  const log = (text: string) => emit({ type: 'log', text });
  let before: string | undefined;
  try {
    const info = await checkForUpdates();
    if (!info.supported || !info.branch) throw new Error(info.reason ?? 'Updates aren’t available for this copy');
    if (!info.behind) {
      emit({ type: 'done', version: info.current.version });
      return false;
    }
    before = (await git(['rev-parse', 'HEAD'], ROOT)).trim();

    emit({ type: 'step', step: 'download', status: 'running' });
    await git(['merge', '--ff-only', `origin/${info.branch}`], ROOT, { timeoutMs: 120_000 });
    emit({ type: 'step', step: 'download', status: 'done' });

    const changed = (await git(['diff', '--name-only', before, 'HEAD', '--', 'package.json', 'package-lock.json'], ROOT)).trim();
    if (changed) {
      emit({ type: 'step', step: 'install', status: 'running' });
      // Not `npm ci`: it deletes node_modules, and on Windows the open window's Electron files are locked.
      await run('npm', ['install', '--no-audit', '--no-fund'], log);
      emit({ type: 'step', step: 'install', status: 'done' });
    } else {
      emit({ type: 'step', step: 'install', status: 'skipped' });
    }

    emit({ type: 'step', step: 'build', status: 'running' });
    await run('npm', ['run', 'build'], log);
    emit({ type: 'step', step: 'build', status: 'done' });
    emit({ type: 'done', version: currentVersion() });
    return true;
  } catch (err) {
    let message = (err as Error).message;
    // A half-applied update must not leave a copy that won't start: go back to what was running.
    if (before) {
      try {
        log('Rolling back…');
        await git(['reset', '--hard', before], ROOT);
        await run('npm', ['install', '--no-audit', '--no-fund'], log).catch(() => {});
        await run('npm', ['run', 'build'], log);
        message += '\n\nMitzi went back to the version you had, so nothing changed.';
      } catch (rollbackErr) {
        message += `\n\nRolling back also failed (${(rollbackErr as Error).message}). Run the install command again to repair Mitzi.`;
      }
    }
    emit({ type: 'error', message });
    return false;
  } finally {
    busy = false;
  }
}
