// Working in folders on this computer: browsing for a folder, cloning a remote repository into
// one, and keeping track of a repository's state. A folder becomes a project with coding tools.
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { MITZI_HOME } from '../config.js';
import type { DirListing, Project, RepoStatus } from '../shared/types.js';
import { git } from './git.js';
import { Collection, newId, now, Store } from './store.js';
import { fail, HttpError, Route, str } from './util.js';

/** Where repositories are cloned unless the user picks another folder. */
export const DEFAULT_CLONE_DIR = join(MITZI_HOME, 'repos');

export function expandHome(p: string): string {
  return resolve(p.trim().replace(/^~(?=$|[\\/])/, homedir()));
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

function places(): DirListing['places'] {
  const home = homedir();
  const out = [{ label: 'Home', path: home }];
  for (const name of ['Desktop', 'Documents', 'Downloads', 'Projects', 'projects', 'code', 'Code', 'dev', 'src', 'repos', 'GitHub']) {
    const p = join(home, name);
    if (isDir(p) && !out.some((x) => x.path.toLowerCase() === p.toLowerCase())) out.push({ label: name, path: p });
  }
  if (isDir(DEFAULT_CLONE_DIR)) out.push({ label: 'Cloned repositories', path: DEFAULT_CLONE_DIR });
  if (process.platform === 'win32') {
    for (const letter of 'CDEFGHIJ') if (isDir(`${letter}:\\`)) out.push({ label: `${letter}:`, path: `${letter}:\\` });
  } else {
    out.push({ label: 'Computer', path: '/' });
  }
  return out;
}

/** The subfolders of a folder, for the folder picker. Hidden folders only when asked. */
export function listDirs(input: string, showHidden = false): DirListing {
  const path = expandHome(input || '~');
  if (!isDir(path)) throw new HttpError(404, `Not a folder: ${path}`);
  let names: string[];
  try {
    names = readdirSync(path);
  } catch {
    throw new HttpError(403, `Can't open ${path}: permission denied`);
  }
  const dirs = names
    .filter((n) => (showHidden || !n.startsWith('.')) && n !== 'node_modules' && n !== '$RECYCLE.BIN')
    .map((name) => ({ name, path: join(path, name) }))
    .filter((d) => isDir(d.path))
    .map((d) => ({ ...d, git: existsSync(join(d.path, '.git')) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const parent = dirname(path);
  return { path, parent: parent === path || parse(path).root === path ? undefined : parent, dirs, places: places(), git: existsSync(join(path, '.git')) };
}

/** "owner/repo" means GitHub; https, ssh and git@ URLs pass through. */
export function normalizeRepoUrl(input: string): string {
  const s = input.trim().replace(/\/+$/, '');
  if (!s) throw new HttpError(400, 'Enter a repository URL or owner/repo');
  // Never let a "URL" be read as a git option.
  if (s.startsWith('-')) throw new HttpError(400, 'That is not a repository URL');
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) return `https://github.com/${s}.git`;
  if (/^(https?:\/\/|ssh:\/\/|file:\/\/|git@[\w.-]+:)/.test(s)) return s;
  throw new HttpError(400, 'Use a URL like https://github.com/owner/repo, git@github.com:owner/repo.git, or owner/repo');
}

export function repoName(url: string): string {
  return (
    basename(url.replace(/\.git$/, '').replace(/[:/]+$/, ''))
      .replace(/[^\w.-]+/g, '-')
      .replace(/^[.-]+/, '') || 'repository'
  );
}

/** Authenticates one git command with a token, without writing it into the repository's config. */
function authEnv(url: string, token?: string): Record<string, string> {
  if (!token || !/^https:\/\//.test(url)) return {};
  const host = new URL(url).host;
  // GitHub takes any username with a token; GitLab and Bitbucket expect these ones.
  const user = /gitlab/.test(host) ? 'oauth2' : /bitbucket/.test(host) ? 'x-token-auth' : 'x-access-token';
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.https://${host}/.extraheader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`,
  };
}

function friendlyGitError(err: Error, url: string): HttpError {
  const m = err.message;
  if (/Authentication failed|could not read Username|terminal prompts disabled|403|401|Repository not found|not found/i.test(m)) {
    return new HttpError(400, `Couldn't access ${url}. If it's private, add an access token (or set up git credentials on this computer). Git said: ${m}`);
  }
  if (/Permission denied \(publickey\)/.test(m)) return new HttpError(400, `SSH key rejected for ${url}. Use the https URL with a token instead. Git said: ${m}`);
  return new HttpError(400, m);
}

export async function repoStatus(folder: string): Promise<RepoStatus | undefined> {
  if (!existsSync(join(folder, '.git'))) return undefined;
  try {
    const out = await git(['status', '--porcelain=v1', '--branch'], folder, { timeoutMs: 15_000 });
    const [head, ...files] = out.split('\n').filter(Boolean);
    const branch = /^## (?:No commits yet on )?([^.\s]+)/.exec(head ?? '')?.[1];
    const remote = await git(['remote', 'get-url', 'origin'], folder, { timeoutMs: 5000 }).then((r) => r.trim(), () => undefined);
    return {
      branch,
      ahead: Number(/ahead (\d+)/.exec(head ?? '')?.[1] ?? 0),
      behind: Number(/behind (\d+)/.exec(head ?? '')?.[1] ?? 0),
      changed: files.length,
      // Never show credentials embedded in a remote URL.
      remote: remote?.replace(/\/\/[^@/]+@/, '//'),
    };
  } catch {
    return undefined;
  }
}

interface RepoSecret {
  id: string;
  token: string;
}

export function registerFolderRoutes(route: Route, store: Store, projectView: (p: Project) => unknown): void {
  // Tokens for private repositories, kept apart from projects and readable only by the user.
  const secrets = new Collection<RepoSecret>(join(store.root, 'repo-tokens'), 0o600);

  const forFolder = (folder: string, fields: Partial<Project> = {}): Project => {
    const existing = store.projects.all().find((p) => p.folder && resolve(p.folder) === resolve(folder));
    if (existing) return existing;
    return store.projects.put({
      id: newId(),
      name: basename(folder) || folder,
      description: '',
      instructions: '',
      files: [],
      folder,
      permissionMode: 'default',
      createdAt: now(),
      updatedAt: now(),
      ...fields,
    });
  };

  route('GET', '/api/fs/dirs', ({ query }) => listDirs(query.get('path') ?? '~', query.get('hidden') === '1'));

  route('POST', '/api/fs/mkdir', ({ body }) => {
    const parent = expandHome(str(body?.parent));
    const name = str(body?.name).trim();
    if (!name || /[\\/]/.test(name) || name === '.' || name === '..') throw new HttpError(400, 'Enter a folder name');
    if (!isDir(parent)) throw new HttpError(404, `Not a folder: ${parent}`);
    const path = join(parent, name);
    if (existsSync(path)) throw new HttpError(409, `${name} already exists`);
    mkdirSync(path);
    return listDirs(path);
  });

  // Opening a folder reuses its project, or makes one.
  route('POST', '/api/projects/open-folder', async ({ body }) => {
    const folder = expandHome(str(body?.folder));
    if (!isDir(folder)) throw new HttpError(400, `Not a folder: ${folder}`);
    const status = await repoStatus(folder);
    return projectView(forFolder(folder, status?.remote ? { repo: { url: status.remote, branch: status.branch } } : {}));
  });

  route('POST', '/api/repos/clone', async ({ body }) => {
    const url = normalizeRepoUrl(str(body?.url));
    const branch = str(body?.branch).trim();
    if (branch.startsWith('-')) throw new HttpError(400, 'That is not a branch name');
    const token = str(body?.token).trim() || undefined;
    const parent = expandHome(str(body?.parent) || DEFAULT_CLONE_DIR);
    mkdirSync(parent, { recursive: true });
    const folder = join(parent, str(body?.name).trim().replace(/[\\/]/g, '-') || repoName(url));

    if (existsSync(folder)) {
      // Already cloned: reuse it if it's the same repository.
      const status = await repoStatus(folder);
      const same = status?.remote && normalizeRepoUrl(status.remote).replace(/\.git$/, '') === url.replace(/\.git$/, '').replace(/\/\/[^@/]+@/, '//');
      if (!same) throw new HttpError(409, `${folder} already exists. Pick another folder or name.`);
    } else {
      try {
        await git(['clone', ...(branch ? ['--branch', branch] : []), '--', url, folder], parent, { timeoutMs: 15 * 60_000, env: authEnv(url, token) });
      } catch (err) {
        throw friendlyGitError(err as Error, url);
      }
    }
    const status = await repoStatus(folder);
    const project = forFolder(folder, { repo: { url, branch: status?.branch ?? (branch || undefined) } });
    if (!project.repo) store.projects.put({ ...project, repo: { url, branch: status?.branch }, updatedAt: now() });
    if (token) secrets.put({ id: project.id, token });
    return projectView(store.projects.get(project.id)!);
  });

  const getRepoProject = (id: string) => {
    const p = store.projects.get(id) ?? fail(404, 'Project not found');
    if (!p.folder || !existsSync(join(p.folder, '.git'))) throw new HttpError(400, 'This project’s folder is not a git repository');
    return p;
  };

  route('GET', '/api/projects/:id/git', async ({ params }) => (await repoStatus(getRepoProject(params.id).folder!)) ?? null);

  route('POST', '/api/projects/:id/pull', async ({ params }) => {
    const p = getRepoProject(params.id);
    const remote = (await repoStatus(p.folder!))?.remote ?? p.repo?.url ?? '';
    try {
      const out = await git(['pull', '--ff-only'], p.folder!, { timeoutMs: 5 * 60_000, env: authEnv(remote, secrets.get(p.id)?.token) });
      return { output: out.trim() || 'Already up to date.', status: await repoStatus(p.folder!) };
    } catch (err) {
      const e = friendlyGitError(err as Error, remote);
      if (/Not possible to fast-forward|diverged/i.test(e.message)) throw new HttpError(409, 'Your branch and the remote have diverged. Ask the bot to merge or rebase, or resolve it in a terminal.');
      throw e;
    }
  });
}
