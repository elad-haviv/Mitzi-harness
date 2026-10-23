import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { resolvePath, Tool, ToolContext, ToolError } from './types.js';

const MAX_LINES = 2000;
const MAX_LINE_LENGTH = 2000;

function display(ctx: ToolContext, abs: string): string {
  const rel = relative(ctx.cwd, abs);
  return (rel && !rel.startsWith('..') ? rel : abs).replace(/\\/g, '/');
}

async function statOrNull(path: string) {
  try {
    return await stat(path);
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

/** Refuses to modify an existing file the agent has not read, or that changed since. */
async function assertFresh(ctx: ToolContext, abs: string): Promise<void> {
  const st = await statOrNull(abs);
  if (!st) return;
  const seen = ctx.readFiles.get(abs);
  if (seen === undefined) throw new ToolError(`File has not been read yet. Read ${display(ctx, abs)} before modifying it.`);
  if (st.mtimeMs > seen + 1) throw new ToolError(`${display(ctx, abs)} was modified since it was last read. Read it again first.`);
}

async function recordWrite(ctx: ToolContext, abs: string): Promise<void> {
  ctx.readFiles.set(abs, (await stat(abs)).mtimeMs);
}

export function numberLines(lines: string[], start: number): string {
  const width = String(start + lines.length - 1).length;
  return lines
    .map((line, i) => {
      const text = line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}… [line truncated]` : line;
      return `${String(start + i).padStart(width)}\t${text}`;
    })
    .join('\n');
}

/** A compact line diff: common prefix/suffix trimmed, the rest shown as -/+. */
export function simpleDiff(before: string, after: string, context = 2): string {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const out: string[] = [];
  const from = Math.max(0, start - context);
  for (let i = from; i < start; i++) out.push(`  ${a[i]}`);
  for (let i = start; i < endA; i++) out.push(`- ${a[i]}`);
  for (let i = start; i < endB; i++) out.push(`+ ${b[i]}`);
  for (let i = endA; i < Math.min(a.length, endA + context); i++) out.push(`  ${a[i]}`);
  return `@@ line ${from + 1} @@\n${out.join('\n')}`;
}

interface ReadArgs {
  file_path: string;
  offset?: number;
  limit?: number;
}

export const readTool: Tool<ReadArgs> = {
  name: 'Read',
  kind: 'read',
  description:
    'Read a text file from the filesystem. Returns lines prefixed with their line number and a tab. ' +
    `Reads up to ${MAX_LINES} lines by default; use offset (1-based line) and limit for large files. ` +
    'You must Read a file before editing or overwriting it.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path, or path relative to the working directory' },
      offset: { type: 'integer', description: '1-based line number to start reading from' },
      limit: { type: 'integer', description: 'Maximum number of lines to read' },
    },
    required: ['file_path'],
  },
  summarize: (a, ctx) => display(ctx, resolvePath(ctx, a.file_path)),
  async run(args, ctx) {
    const abs = resolvePath(ctx, args.file_path);
    const st = await statOrNull(abs);
    if (!st) throw new ToolError(`File does not exist: ${abs}`);
    if (st.isDirectory()) throw new ToolError(`${abs} is a directory. Use LS to list it.`);
    const buf = await readFile(abs);
    if (buf.subarray(0, 8000).includes(0)) throw new ToolError(`${abs} appears to be a binary file.`);
    ctx.readFiles.set(abs, st.mtimeMs);

    const text = buf.toString('utf8');
    if (!text) return '(file is empty)';
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const start = Math.max(1, Math.floor(args.offset ?? 1));
    const limit = Math.max(1, Math.floor(args.limit ?? MAX_LINES));
    const slice = lines.slice(start - 1, start - 1 + limit);
    if (!slice.length) return `(file has ${lines.length} lines; offset ${start} is past the end)`;
    let out = numberLines(slice, start);
    const remaining = lines.length - (start - 1 + slice.length);
    if (remaining > 0) out += `\n… ${remaining} more lines. Use offset=${start + slice.length} to continue.`;
    return out;
  },
};

interface WriteArgs {
  file_path: string;
  content: string;
}

export const writeTool: Tool<WriteArgs> = {
  name: 'Write',
  kind: 'edit',
  description:
    'Create a file or overwrite it entirely. Parent directories are created as needed. ' +
    'An existing file must be Read first. Prefer Edit for changing part of a file.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path, or path relative to the working directory' },
      content: { type: 'string', description: 'Full contents of the file' },
    },
    required: ['file_path', 'content'],
  },
  summarize: (a, ctx) => display(ctx, resolvePath(ctx, a.file_path)),
  async preview(args, ctx) {
    const abs = resolvePath(ctx, args.file_path);
    const old = await readFile(abs, 'utf8').catch(() => null);
    if (old === null) {
      const lines = String(args.content ?? '').split('\n');
      return lines.slice(0, 20).map((l) => `+ ${l}`).join('\n') + (lines.length > 20 ? `\n… +${lines.length - 20} lines` : '');
    }
    return simpleDiff(old, String(args.content ?? ''));
  },
  async run(args, ctx) {
    if (typeof args.content !== 'string') throw new ToolError('content must be a string');
    const abs = resolvePath(ctx, args.file_path);
    await assertFresh(ctx, abs);
    const existed = (await statOrNull(abs)) !== null;
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, args.content);
    await recordWrite(ctx, abs);
    const lines = args.content.split('\n').length;
    return `${existed ? 'Updated' : 'Created'} ${display(ctx, abs)} (${lines} lines)`;
  },
};

interface EditArgs {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

function applyEdit(content: string, args: EditArgs): string {
  if (args.old_string === args.new_string) throw new ToolError('old_string and new_string are identical');
  if (args.old_string === '') throw new ToolError('old_string must not be empty. Use Write to create a file.');
  const count = content.split(args.old_string).length - 1;
  if (count === 0) throw new ToolError('old_string was not found in the file. Match the text exactly, including whitespace.');
  if (count > 1 && !args.replace_all) {
    throw new ToolError(`old_string appears ${count} times. Add surrounding context to make it unique, or set replace_all.`);
  }
  return args.replace_all
    ? content.split(args.old_string).join(args.new_string)
    : content.replace(args.old_string, () => args.new_string);
}

export const editTool: Tool<EditArgs> = {
  name: 'Edit',
  kind: 'edit',
  description:
    'Replace an exact string in a file. old_string must match the file exactly (including indentation) ' +
    'and be unique unless replace_all is true. The file must be Read first.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path, or path relative to the working directory' },
      old_string: { type: 'string', description: 'Exact text to replace' },
      new_string: { type: 'string', description: 'Replacement text' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  summarize: (a, ctx) => display(ctx, resolvePath(ctx, a.file_path)),
  async preview(args, ctx) {
    try {
      const old = await readFile(resolvePath(ctx, args.file_path), 'utf8');
      return simpleDiff(old, applyEdit(old, args));
    } catch {
      return undefined;
    }
  },
  async run(args, ctx) {
    const abs = resolvePath(ctx, args.file_path);
    if (!(await statOrNull(abs))) throw new ToolError(`File does not exist: ${abs}`);
    await assertFresh(ctx, abs);
    const before = await readFile(abs, 'utf8');
    const after = applyEdit(before, args);
    await writeFile(abs, after);
    await recordWrite(ctx, abs);

    // Show the edited region so the model can confirm the result.
    const at = after.indexOf(args.new_string);
    const line = at < 0 ? 1 : after.slice(0, at).split('\n').length;
    const lines = after.split('\n');
    const from = Math.max(1, line - 3);
    const to = Math.min(lines.length, line + args.new_string.split('\n').length + 2);
    return `Edited ${display(ctx, abs)}:\n${numberLines(lines.slice(from - 1, to), from)}`;
  },
};

interface LsArgs {
  path?: string;
}

const LS_IGNORE = new Set(['node_modules', '.git', '__pycache__', '.venv', 'dist', 'build', '.next']);

export const lsTool: Tool<LsArgs> = {
  name: 'LS',
  kind: 'read',
  description: 'List files and directories in a directory (two levels deep, skipping node_modules, .git and build output).',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Directory to list (default: working directory)' } },
  },
  summarize: (a, ctx) => display(ctx, resolvePath(ctx, a.path || '.')) || '.',
  async run(args, ctx) {
    const root = resolvePath(ctx, args.path || '.');
    const out: string[] = [];
    let count = 0;
    const walk = async (dir: string, depth: number) => {
      const entries = await readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      for (const e of entries) {
        if (count >= 500) return;
        count++;
        const indent = '  '.repeat(depth);
        if (e.isDirectory()) {
          const skipped = LS_IGNORE.has(e.name);
          out.push(`${indent}${e.name}/${skipped ? ' (skipped)' : ''}`);
          if (!skipped && depth < 1) await walk(join(dir, e.name), depth + 1);
        } else {
          out.push(`${indent}${e.name}`);
        }
      }
    };
    try {
      await walk(root, 0);
    } catch (err: any) {
      throw new ToolError(err?.code === 'ENOENT' ? `Directory does not exist: ${root}` : err.message);
    }
    if (count >= 500) out.push('… (listing truncated at 500 entries)');
    return `${root}/\n${out.join('\n') || '(empty)'}`;
  },
};
