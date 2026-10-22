// Slash commands: Markdown prompt templates (Claude Code format) from plugins and
// ~/.mitzi/commands. `/name args` in a message expands to the template.
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { SlashCommandInfo } from '../../shared/types.js';
import { parseFrontmatter, str } from './frontmatter.js';

export interface CommandRoot {
  dir: string;
  source: string;
}

export interface CommandDef extends SlashCommandInfo {
  file: string;
}

function walk(dir: string, depth = 0, out: string[] = []): string[] {
  if (depth > 3 || !existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, depth + 1, out);
    else if (e.name.endsWith('.md')) out.push(full);
  }
  return out;
}

export function listCommands(roots: CommandRoot[]): CommandDef[] {
  const out: CommandDef[] = [];
  for (const root of roots) {
    for (const file of walk(root.dir)) {
      try {
        const { data } = parseFrontmatter(readFileSync(file, 'utf8'));
        const name = basename(file, '.md').toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
        // Later roots don't shadow earlier ones; the first definition of a name wins.
        if (out.some((c) => c.name === name)) continue;
        out.push({ name, description: str(data.description) || undefined, argumentHint: str(data['argument-hint']) || undefined, source: root.source, file });
      } catch {
        // Skip unreadable command files.
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function shell(command: string, cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('bash', ['-c', command], { cwd, timeout: 30_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const out = `${stdout}${stderr}`.trim();
      resolve(err && !out ? `(command failed: ${err.message})` : out.slice(0, 20_000));
    });
  });
}

/**
 * Expands a command template: $ARGUMENTS and $1…$9 become the arguments; !`cmd`
 * snippets run in the project folder (only in coding projects).
 */
export async function expandCommand(def: CommandDef, args: string, cwd?: string): Promise<string> {
  const { body } = parseFrontmatter(readFileSync(def.file, 'utf8'));
  const positional = args.match(/"[^"]*"|\S+/g)?.map((a) => a.replace(/^"|"$/g, '')) ?? [];
  // Run the template's own snippets first, so nothing in the user's arguments can become a command.
  let text = body;
  for (const m of [...body.matchAll(/!`([^`]+)`/g)]) {
    const output = cwd ? await shell(m[1], cwd) : `(not run: \`${m[1]}\` needs a project with a linked folder)`;
    text = text.replace(m[0], () => output);
  }
  text = text.replace(/\$ARGUMENTS/g, () => args).replace(/\$(\d)/g, (_, n: string) => positional[Number(n) - 1] ?? '');
  if (args && !/\$ARGUMENTS|\$\d/.test(body)) text += `\n\nARGUMENTS: ${args}`;
  return text.trim();
}

/** Splits "/name rest of message" into its parts. */
export function parseSlash(input: string): { name: string; args: string } | undefined {
  const m = /^\/([a-z0-9_:-]+)(?:\s+([\s\S]*))?$/i.exec(input.trim());
  return m ? { name: m[1].toLowerCase().split(':').pop()!, args: (m[2] ?? '').trim() } : undefined;
}
