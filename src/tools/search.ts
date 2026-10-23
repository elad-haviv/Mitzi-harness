import { spawn, spawnSync } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { resolvePath, Tool, ToolContext, ToolError, truncateMiddle } from './types.js';

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'target']);
const MAX_RESULTS = 200;

let rgAvailable: boolean | undefined;
function hasRipgrep(): boolean {
  rgAvailable ??= !process.env.MITZI_NO_RG && spawnSync('rg', ['--version'], { stdio: 'ignore' }).status === 0;
  return rgAvailable;
}

function rg(args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('rg', args, { cwd, signal, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    // Exit code 1 means "no matches".
    child.on('close', (code) => (code === 0 || code === 1 ? resolve(out) : reject(new ToolError(err.trim() || `rg exited ${code}`))));
  });
}

/** Converts a glob (supporting **, *, ?, {a,b} and [abc]) to an anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let inGroup = 0;
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') re += '[^/]';
    else if (ch === '{') {
      inGroup++;
      re += '(?:';
    } else if (ch === '}' && inGroup) {
      inGroup--;
      re += ')';
    } else if (ch === ',' && inGroup) re += '|';
    else if (ch === '[') {
      const end = glob.indexOf(']', i);
      if (end < 0) re += '\\[';
      else {
        re += `[${glob.slice(i + 1, end).replace(/^!/, '^')}]`;
        i = end;
      }
    } else re += /[.+^$()|\\]/.test(ch) ? `\\${ch}` : ch;
  }
  return new RegExp(`^${re}$`);
}

async function walkFiles(root: string, signal?: AbortSignal): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string) => {
    if (signal?.aborted || files.length > 50_000) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.github') continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) await walk(full);
      } else if (e.isFile()) files.push(full);
    }
  };
  await walk(root);
  return files;
}

async function sortByMtime(paths: string[]): Promise<string[]> {
  const withTimes = await Promise.all(paths.map(async (p) => ({ p, t: (await stat(p).catch(() => null))?.mtimeMs ?? 0 })));
  return withTimes.sort((a, b) => b.t - a.t).map((x) => x.p);
}

interface GlobArgs {
  pattern: string;
  path?: string;
}

export const globTool: Tool<GlobArgs> = {
  name: 'Glob',
  kind: 'read',
  description:
    'Find files by glob pattern (e.g. "**/*.ts", "src/**/test_*.py"). Returns matching paths, most recently ' +
    `modified first, up to ${MAX_RESULTS}. Respects .gitignore when ripgrep is installed.`,
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern, relative to path' },
      path: { type: 'string', description: 'Directory to search in (default: working directory)' },
    },
    required: ['pattern'],
  },
  summarize: (a) => (a.path ? `${a.pattern} in ${a.path}` : a.pattern),
  async run(args, ctx) {
    if (!args.pattern) throw new ToolError('pattern is required');
    const root = resolvePath(ctx, args.path || '.');
    let files: string[];
    if (hasRipgrep()) {
      const out = await rg(['--files', '--hidden', '--glob', '!.git', '--glob', args.pattern], root, ctx.signal);
      files = out.split('\n').filter(Boolean).map((f) => join(root, f));
    } else {
      const re = globToRegExp(args.pattern);
      files = (await walkFiles(root, ctx.signal)).filter((f) => re.test(relative(root, f)));
    }
    if (!files.length) return 'No files found';
    const sorted = await sortByMtime(files);
    const shown = sorted.slice(0, MAX_RESULTS).map((f) => (relative(ctx.cwd, f) || f).replace(/\\/g, '/'));
    if (sorted.length > MAX_RESULTS) shown.push(`… ${sorted.length - MAX_RESULTS} more files. Narrow the pattern.`);
    return shown.join('\n');
  },
};

interface GrepArgs {
  pattern: string;
  path?: string;
  glob?: string;
  output_mode?: 'files_with_matches' | 'content' | 'count';
  case_insensitive?: boolean;
  context?: number;
  head_limit?: number;
}

async function grepFallback(args: GrepArgs, root: string, ctx: ToolContext): Promise<string[]> {
  let re: RegExp;
  try {
    re = new RegExp(args.pattern, args.case_insensitive ? 'i' : '');
  } catch (err: any) {
    throw new ToolError(`Invalid regex: ${err.message}`);
  }
  const globRe = args.glob ? globToRegExp(args.glob.includes('/') ? args.glob : `**/${args.glob}`) : undefined;
  const isFile = (await stat(root).catch(() => null))?.isFile();
  const files = isFile ? [root] : await walkFiles(root, ctx.signal);
  const mode = args.output_mode ?? 'files_with_matches';
  const ctxLines = Math.max(0, args.context ?? 0);
  const out: string[] = [];
  for (const file of files) {
    if (globRe && !globRe.test(relative(root, file))) continue;
    const buf = await readFile(file).catch(() => null);
    if (!buf || buf.subarray(0, 8000).includes(0)) continue;
    const lines = buf.toString('utf8').split('\n');
    const hits = lines.flatMap((l, i) => (re.test(l) ? [i] : []));
    if (!hits.length) continue;
    const rel = (relative(ctx.cwd, file) || file).replace(/\\/g, '/');
    if (mode === 'files_with_matches') out.push(rel);
    else if (mode === 'count') out.push(`${rel}:${hits.length}`);
    else {
      const shown = new Set<number>();
      for (const h of hits) for (let i = Math.max(0, h - ctxLines); i <= Math.min(lines.length - 1, h + ctxLines); i++) shown.add(i);
      for (const i of [...shown].sort((a, b) => a - b)) out.push(`${rel}:${i + 1}${hits.includes(i) ? ':' : '-'}${lines[i]}`);
    }
  }
  return out;
}

export const grepTool: Tool<GrepArgs> = {
  name: 'Grep',
  kind: 'read',
  description:
    'Search file contents with a regular expression (ripgrep syntax). output_mode "files_with_matches" (default) ' +
    'lists matching files, "content" shows matching lines with line numbers, "count" shows match counts. ' +
    'Filter files with glob (e.g. "*.ts").',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for' },
      path: { type: 'string', description: 'File or directory to search (default: working directory)' },
      glob: { type: 'string', description: 'Only search files matching this glob, e.g. "*.{ts,tsx}"' },
      output_mode: { type: 'string', enum: ['files_with_matches', 'content', 'count'] },
      case_insensitive: { type: 'boolean' },
      context: { type: 'integer', description: 'Lines of context around each match (content mode)' },
      head_limit: { type: 'integer', description: 'Return at most this many result lines (default 250)' },
    },
    required: ['pattern'],
  },
  summarize: (a) => `"${a.pattern}"${a.path ? ` in ${a.path}` : ''}${a.glob ? ` (${a.glob})` : ''}`,
  async run(args, ctx) {
    if (!args.pattern) throw new ToolError('pattern is required');
    const root = resolvePath(ctx, args.path || '.');
    const mode = args.output_mode ?? 'files_with_matches';
    let lines: string[];
    if (hasRipgrep()) {
      const rgArgs = ['--hidden', '--glob', '!.git', '--no-heading', '--color', 'never'];
      if (args.case_insensitive) rgArgs.push('-i');
      if (args.glob) rgArgs.push('--glob', args.glob);
      if (mode === 'files_with_matches') rgArgs.push('-l');
      else if (mode === 'count') rgArgs.push('-c');
      else {
        rgArgs.push('-n');
        if (args.context) rgArgs.push('-C', String(args.context));
      }
      rgArgs.push('-e', args.pattern);
      // Pass the path relative to cwd so results come back as short relative paths.
      const rel = relative(ctx.cwd, root);
      if (rel) rgArgs.push('--', rel.startsWith('..') ? root : rel);
      const out = await rg(rgArgs, ctx.cwd, ctx.signal);
      // rg prints Windows-style paths; normalize the path portion (before the first `:` line-number separator) to forward slashes.
      lines = out
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const m = /^((?:[A-Za-z]:)?[^:]*)((?::\d+.*)?)$/.exec(l);
          return m ? m[1].replace(/\\/g, '/') + m[2] : l.replace(/\\/g, '/');
        });
    } else {
      lines = await grepFallback(args, root, ctx);
    }
    if (!lines.length) return 'No matches found';
    const limit = args.head_limit ?? 250;
    const shown = lines.slice(0, limit);
    if (lines.length > limit) shown.push(`… ${lines.length - limit} more results`);
    return truncateMiddle(shown.join('\n'), 30_000);
  },
};
