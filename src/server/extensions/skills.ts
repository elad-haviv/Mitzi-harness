// Agent Skills: folders with a SKILL.md (frontmatter name + description) and any
// supporting files. Only names and descriptions go in the prompt; the model loads a
// skill's instructions with the Skill tool when a task calls for it.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, normalize, relative, resolve, sep } from 'node:path';
import type { SkillDetail, SkillInfo } from '../../shared/types.js';
import { Tool, ToolError, truncateMiddle } from '../../tools/types.js';
import { parseFrontmatter, str } from './frontmatter.js';

export interface SkillRoot {
  dir: string;
  source: SkillInfo['source'];
  pluginId?: string;
  /** Only these skill folders (relative to dir), when a plugin lists them explicitly. */
  only?: string[];
}

const SKIP = new Set(['.git', 'node_modules', '__pycache__', '.venv']);

function listFiles(dir: string, base = dir, depth = 0, out: string[] = []): string[] {
  if (depth > 4 || out.length >= 200) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIP.has(e.name) || out.length >= 200) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) listFiles(full, base, depth + 1, out);
    else out.push(relative(base, full).split(sep).join('/'));
  }
  return out;
}

export function skillSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64) || 'skill';
}

export class Skills {
  constructor(
    private readonly roots: () => SkillRoot[],
    private readonly disabled: () => Set<string>,
    private readonly userDir: string,
  ) {}

  private load(root: SkillRoot, folder: string): SkillInfo | undefined {
    const dir = resolve(root.dir, folder);
    const file = join(dir, 'SKILL.md');
    if (!existsSync(file)) return undefined;
    try {
      const { data } = parseFrontmatter(readFileSync(file, 'utf8'));
      const name = str(data.name).trim() || folder.split('/').pop()!;
      const prefix = root.source === 'plugin' ? root.pluginId! : root.source;
      const id = `${prefix}:${skillSlug(folder.split('/').pop()!)}`;
      return {
        id,
        name,
        description: str(data.description).trim(),
        source: root.source,
        pluginId: root.pluginId,
        dir,
        enabled: !this.disabled().has(id),
        files: listFiles(dir).sort((a, b) => Number(b === 'SKILL.md') - Number(a === 'SKILL.md')),
      };
    } catch {
      return undefined;
    }
  }

  list(): SkillInfo[] {
    const out: SkillInfo[] = [];
    for (const root of this.roots()) {
      if (!existsSync(root.dir)) continue;
      const folders = root.only
        ? root.only.map((p) => p.replace(/^\.\//, '').replace(/\/$/, ''))
        : readdirSync(root.dir, { withFileTypes: true })
            .filter((e) => e.isDirectory() && !SKIP.has(e.name))
            .map((e) => e.name);
      for (const f of folders) {
        const skill = this.load(root, f);
        if (skill) out.push(skill);
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  enabled(): SkillInfo[] {
    return this.list().filter((s) => s.enabled);
  }

  get(id: string): SkillDetail | undefined {
    const skill = this.list().find((s) => s.id === id);
    if (!skill) return undefined;
    const { body } = parseFrontmatter(readFileSync(join(skill.dir, 'SKILL.md'), 'utf8'));
    return { ...skill, body };
  }

  /** Creates or replaces a skill in the user's skills folder. */
  save(input: { name: string; description: string; body: string; files?: { path: string; content: string }[] }, replaceId?: string): SkillInfo {
    const name = input.name.trim();
    if (!name) throw new Error('A skill needs a name');
    if (!input.description.trim()) throw new Error('A skill needs a description: it tells the model when to use it');
    let dir = join(this.userDir, skillSlug(name));
    if (replaceId) {
      const existing = this.list().find((s) => s.id === replaceId);
      if (!existing || existing.source !== 'user') throw new Error('Only your own skills can be edited');
      dir = existing.dir;
    } else if (existsSync(dir)) {
      throw new Error(`A skill folder named "${skillSlug(name)}" already exists`);
    }
    mkdirSync(dir, { recursive: true });
    const yaml = (s: string) => JSON.stringify(s.replace(/\s+/g, ' ').trim());
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${yaml(name)}\ndescription: ${yaml(input.description)}\n---\n\n${input.body.trim()}\n`);
    for (const f of input.files ?? []) {
      const target = normalize(join(dir, f.path));
      if (!target.startsWith(dir + sep) || /(^|\/)SKILL\.md$/i.test(f.path)) continue;
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, f.content);
    }
    return this.list().find((s) => s.dir === dir)!;
  }

  /** Imports an uploaded skill folder (files with relative paths, one of them SKILL.md). */
  import(files: { path: string; content: string }[]): SkillInfo {
    const clean = files.map((f) => ({ path: f.path.replace(/\\/g, '/').replace(/^\/+/, ''), content: f.content }));
    const manifest = clean.filter((f) => /(^|\/)SKILL\.md$/i.test(f.path)).sort((a, b) => a.path.length - b.path.length)[0];
    if (!manifest) throw new Error('No SKILL.md found in the uploaded files');
    const root = manifest.path.slice(0, -'SKILL.md'.length);
    const { data, body } = parseFrontmatter(manifest.content);
    const name = str(data.name).trim() || root.split('/').filter(Boolean).pop() || 'imported-skill';
    const rest = clean.filter((f) => f !== manifest && f.path.startsWith(root) && !f.path.split('/').some((p) => p === '..')).map((f) => ({ path: f.path.slice(root.length), content: f.content }));
    return this.save({ name, description: str(data.description) || name, body, files: rest });
  }

  remove(id: string): void {
    const skill = this.list().find((s) => s.id === id);
    if (!skill || skill.source !== 'user' || !skill.dir.startsWith(resolve(this.userDir) + sep)) {
      throw new Error('Only your own skills can be deleted; disable others instead');
    }
    rmSync(skill.dir, { recursive: true, force: true });
  }
}

/** The prompt section that advertises available skills. */
export function skillsPrompt(skills: SkillInfo[]): string {
  const lines = skills.map((s) => `- ${s.name}: ${s.description.replace(/\s+/g, ' ').slice(0, 400)}`);
  return (
    '# Skills\nSkills are packaged instructions and resources for specific kinds of tasks. When a task matches a skill below, ' +
    'call the Skill tool to load it BEFORE starting, then follow its instructions. Load supporting files it mentions with the same tool.\n\n' +
    lines.join('\n')
  );
}

export function skillTool(skills: Skills): Tool<{ name: string; file?: string }> {
  return {
    name: 'Skill',
    kind: 'read',
    description: 'Load a skill\'s instructions by name (from the Skills list in your instructions), or one of its supporting files with "file".',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name' },
        file: { type: 'string', description: 'Optional path of a supporting file inside the skill, e.g. "reference/forms.md"' },
      },
      required: ['name'],
    },
    summarize: (a) => (a.file ? `${a.name} / ${a.file}` : a.name),
    async run(args) {
      const all = skills.enabled();
      const wanted = String(args.name ?? '').trim().toLowerCase();
      const skill = all.find((s) => s.name.toLowerCase() === wanted || s.id.toLowerCase() === wanted) ?? all.find((s) => skillSlug(s.name) === skillSlug(wanted));
      if (!skill) throw new ToolError(`No skill named "${args.name}". Available: ${all.map((s) => s.name).join(', ') || 'none'}`);
      if (args.file) {
        const target = normalize(join(skill.dir, args.file));
        if (!target.startsWith(skill.dir + sep)) throw new ToolError('That path is outside the skill');
        if (!existsSync(target) || statSync(target).isDirectory()) throw new ToolError(`No file "${args.file}" in ${skill.name}. Files: ${skill.files.join(', ')}`);
        const buf = readFileSync(target);
        if (buf.subarray(0, 8000).includes(0)) return `${args.file} is a binary file (at ${target}).`;
        return truncateMiddle(buf.toString('utf8'), 100_000);
      }
      const { body } = parseFrontmatter(readFileSync(join(skill.dir, 'SKILL.md'), 'utf8'));
      const others = skill.files.filter((f) => f !== 'SKILL.md');
      return (
        `# Skill: ${skill.name}\nBase directory: ${skill.dir}\n\n${truncateMiddle(body.trim(), 100_000)}` +
        (others.length ? `\n\n---\nFiles in this skill (load with the "file" parameter, or use the absolute path with other tools):\n${others.map((f) => `- ${f}`).join('\n')}` : '')
      );
    },
  };
}
