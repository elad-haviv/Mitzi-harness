// The project knowledge layer: memory about a repository rather than about the user. Facts (build and test commands,
// conventions, layout, this machine's gotchas) are kept per project, learned passively from outcomes, explicitly from
// the user's corrections and the bot's notes, consolidated as they pile up, and put in every prompt for the project.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.js';
import type { LlmClient } from '../openrouter.js';
import type { ProjectFact, ProjectFactKind, ProjectMemory, TaskOutcome } from '../shared/types.js';
import { Tool, ToolError } from '../tools/types.js';
import type { OutcomeLog } from './outcomes.js';
import { newId, now, Store } from './store.js';
import { withUsage } from './usage.js';

const KINDS: ProjectFactKind[] = ['command', 'convention', 'layout', 'gotcha', 'preference'];
const MAX_FACTS = 60;
/** Facts in every prompt for the project. */
const CORE_FACTS = 15;
/** Consolidate once this many facts exist and enough are new. */
const CONSOLIDATE_AT = 30;

/** Commands worth remembering when they work: building, testing, checking, running, installing. */
const USEFUL_COMMAND = /^(npm|npx|pnpm|yarn|bun|node|deno|tsc|make|cargo|go|python3?|pip|pytest|uv|poetry|dotnet|mvn|gradle|\.\/gradlew|bundle|rake|rspec|mix|swift|cmake|ctest)\b/;

export function normalizeFact(text: string): string {
  return text.toLowerCase().replace(/[`'"]/g, '').replace(/[^\p{L}\p{N}./-]+/gu, ' ').trim();
}

/** The command itself, without a leading `cd somewhere &&`. */
function coreCommand(command: string): string {
  return command.replace(/^\s*cd\s+\S+\s*&&\s*/, '').trim().split('\n')[0].slice(0, 200);
}

/**
 * Facts an outcome teaches about its project: the check that passed, commands that keep working (seen in
 * `history`), and commands this machine can't run.
 */
export function factsFromOutcome(o: TaskOutcome, history: TaskOutcome[]): { text: string; kind: ProjectFactKind }[] {
  const facts: { text: string; kind: ProjectFactKind }[] = [];
  if (o.checkCommand && o.testsPassed) facts.push({ text: `Verify changes with \`${o.checkCommand}\`.`, kind: 'command' });
  const worked = new Map<string, number>();
  for (const h of [...history, o]) {
    for (const c of new Set(h.commands.filter((c) => c.ok).map((c) => coreCommand(c.command)))) worked.set(c, (worked.get(c) ?? 0) + 1);
  }
  for (const c of new Set(o.commands.filter((c) => c.ok).map((c) => coreCommand(c.command)))) {
    // Seen working in two tasks: a command to rely on.
    if (USEFUL_COMMAND.test(c) && (worked.get(c) ?? 0) >= 2 && c !== o.checkCommand) facts.push({ text: `\`${c}\` works here.`, kind: 'command' });
  }
  for (const e of o.errors.filter((e) => e.kind === 'environment' && e.command)) {
    const line = e.text.split('\n').find((l) => l.trim() && !/^\[Exit code/.test(l))?.trim().slice(0, 160) ?? '';
    if (line) facts.push({ text: `On this machine, \`${coreCommand(e.command!)}\` fails: ${line}`, kind: 'gotcha' });
  }
  return facts;
}

/** Whether a message reads like the user correcting the bot about how things are done here. */
export function looksLikeCorrection(text: string): boolean {
  const t = text.trim().slice(0, 600);
  return (
    /^(no|nope|not that|wrong|actually|stop|don'?t|do not)\b/i.test(t) ||
    /\b(we|i) (use|prefer|always|never|don'?t use)\b/i.test(t) ||
    /\b(instead of|rather than|in this (repo|project|codebase))\b/i.test(t) ||
    /\buse \S+ (instead|here|not)\b/i.test(t)
  );
}

/** Adds or replaces a section of learned facts in an instruction file. */
export const MD_START = '<!-- mitzi:learned:start -->';
export const MD_END = '<!-- mitzi:learned:end -->';

/** Facts not yet in an instruction file, and the file as it would read with them added. */
export function proposeInstructions(existing: string, facts: ProjectFact[]): { added: ProjectFact[]; content: string } {
  const outside = existing.replace(new RegExp(`${MD_START}[\\s\\S]*?${MD_END}`), '');
  const known = normalizeFact(outside);
  const words = (s: string) => normalizeFact(s).split(' ').filter((w) => w.length > 2);
  // A fact counts as already there when most of its words appear in the file.
  const present = (f: ProjectFact) => {
    const w = words(f.text);
    return w.length > 0 && w.filter((x) => known.includes(x)).length / w.length >= 0.8;
  };
  const added = facts.filter((f) => f.kind !== 'preference' && !present(f));
  const order: ProjectFactKind[] = ['command', 'convention', 'layout', 'gotcha'];
  const title: Record<string, string> = { command: 'Commands', convention: 'Conventions', layout: 'Layout', gotcha: 'Gotchas on this machine' };
  const body = order
    .map((k) => {
      const items = added.filter((f) => f.kind === k);
      return items.length ? `### ${title[k]}\n${items.map((f) => `- ${f.text}`).join('\n')}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
  const section = `${MD_START}\n## Learned by Mitzi\n\n${body}\n${MD_END}`;
  const content = existing.includes(MD_START)
    ? existing.replace(new RegExp(`${MD_START}[\\s\\S]*?${MD_END}`), section)
    : `${existing.trimEnd()}${existing.trim() ? '\n\n' : ''}${section}\n`;
  return { added, content };
}

export const CORRECTION_PROMPT = `The user is working with an AI coding assistant in a repository and just said the message below. If it \
corrects how things are done in this repository (tools, commands, conventions, file layout, preferences), extract each \
durable fact it implies, phrased as a standing rule for the repository (e.g. "Use pnpm, not npm."). Ignore one-off \
instructions about the current task.

<message>
{message}
</message>

Reply with JSON only: {"facts": [{"text": "...", "kind": "command|convention|layout|gotcha|preference"}]}`;

export const CONSOLIDATE_PROMPT = `These are facts an AI coding assistant learned about one repository. Merge duplicates and facts that \
belong together into single, precise facts (e.g. "tests run with node --test dist/tests/" and "tsc must run first" become \
"Verify with \`npx tsc -p . && node --test dist/tests/\`."). Drop facts contradicted by newer ones (higher numbers are \
newer) and ones too vague to act on. Keep the wording of facts the user stated.

<facts>
{facts}
</facts>

Reply with JSON only: {"facts": [{"text": "...", "kind": "command|convention|layout|gotcha|preference", "from": [<numbers of the facts merged>]}]}`;

function parseFacts(reply: string): { text: string; kind: ProjectFactKind; from?: number[] }[] {
  try {
    const json = JSON.parse(/\{[\s\S]*\}/.exec(reply)?.[0] ?? '');
    if (!Array.isArray(json.facts)) return [];
    return json.facts
      .filter((f: any) => typeof f?.text === 'string' && f.text.trim())
      .map((f: any) => ({ text: String(f.text).trim().slice(0, 400), kind: KINDS.includes(f.kind) ? f.kind : 'convention', from: Array.isArray(f.from) ? f.from.map(Number) : undefined }));
  } catch {
    return [];
  }
}

export interface ProjectKnowledgeDeps {
  store: Store;
  client: () => LlmClient;
  config: () => Config;
  outcomes?: OutcomeLog;
}

export class ProjectKnowledge {
  private readonly busy = new Set<string>();
  readonly jobs = new Set<Promise<unknown>>();

  constructor(private readonly deps: ProjectKnowledgeDeps) {
    deps.outcomes?.listeners.add((o) => this.observe(o));
  }

  facts(projectId: string): ProjectFact[] {
    return this.deps.store.projectMemory.get(projectId)?.facts ?? [];
  }

  /** The facts every prompt for the project carries: the user's word first, then what's been seen most. */
  core(projectId: string): ProjectFact[] {
    return [...this.facts(projectId)]
      .sort((a, b) => b.priority - a.priority || b.evidence - a.evidence || b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, CORE_FACTS);
  }

  /** Adds a fact, or strengthens the same fact seen again. */
  add(projectId: string, text: string, kind: ProjectFactKind, source: ProjectFact['source'], priority = 1): ProjectFact | undefined {
    const { store } = this.deps;
    if (!store.projects.get(projectId)) return undefined;
    const clean = text.trim().replace(/\s+/g, ' ').slice(0, 400);
    if (!clean) return undefined;
    const mem: ProjectMemory = store.projectMemory.get(projectId) ?? { id: projectId, facts: [], sinceConsolidation: 0, updatedAt: now() };
    const same = mem.facts.find((f) => normalizeFact(f.text) === normalizeFact(clean));
    let fact: ProjectFact;
    if (same) {
      same.evidence++;
      same.priority = Math.max(same.priority, priority);
      same.updatedAt = now();
      fact = same;
    } else {
      fact = { id: newId(), text: clean, kind: KINDS.includes(kind) ? kind : 'convention', source, priority, evidence: 1, createdAt: now(), updatedAt: now() };
      mem.facts.push(fact);
      mem.sinceConsolidation++;
      // Over the cap, the weakest, oldest facts go.
      if (mem.facts.length > MAX_FACTS) {
        mem.facts = mem.facts.sort((a, b) => b.priority - a.priority || b.evidence - a.evidence || b.updatedAt.localeCompare(a.updatedAt)).slice(0, MAX_FACTS);
      }
    }
    mem.updatedAt = now();
    store.projectMemory.put(mem);
    if (mem.facts.length >= CONSOLIDATE_AT && mem.sinceConsolidation >= 10) this.track(this.consolidate(projectId));
    return fact;
  }

  remove(projectId: string, factId: string): ProjectFact[] {
    const mem = this.deps.store.projectMemory.get(projectId);
    if (!mem) return [];
    mem.facts = mem.facts.filter((f) => f.id !== factId);
    this.deps.store.projectMemory.put(mem);
    return mem.facts;
  }

  /** Passive learning from a finished task in a project folder. */
  observe(o: TaskOutcome): void {
    if (!o.projectId || !this.deps.store.projects.get(o.projectId)?.folder) return;
    const history = this.deps.outcomes?.all((h) => h.projectId === o.projectId && h.id !== o.id).slice(-50) ?? [];
    for (const f of factsFromOutcome(o, history)) this.add(o.projectId, f.text, f.kind, 'observed');
  }

  /** A user message that corrects how things are done here becomes high-priority facts (in the background). */
  noticeCorrection(projectId: string, message: string): void {
    if (!looksLikeCorrection(message)) return;
    this.track(
      (async () => {
        const config = this.deps.config();
        const res = await withUsage({ kind: 'learning', projectId, sink: undefined, route: undefined }, () =>
          this.deps.client().chat({ model: config.smallModel ?? config.model, messages: [{ role: 'user', content: CORRECTION_PROMPT.replace('{message}', message.slice(0, 3000)) }], maxTokens: 400 }),
        );
        for (const f of parseFacts(res.content)) this.add(projectId, f.text, f.kind, 'correction', 3);
      })(),
    );
  }

  /** Merges overlapping facts with the fast model. */
  async consolidate(projectId: string): Promise<void> {
    const { store } = this.deps;
    const mem = store.projectMemory.get(projectId);
    if (!mem || mem.facts.length < 2 || this.busy.has(projectId)) return;
    this.busy.add(projectId);
    try {
      const facts = [...mem.facts].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
      const listing = facts.map((f, i) => `${i + 1}. [${f.kind}${f.source === 'user' || f.source === 'correction' ? ', from the user' : ''}] ${f.text}`).join('\n');
      const config = this.deps.config();
      const res = await withUsage({ kind: 'learning', projectId, sink: undefined, route: undefined }, () =>
        this.deps.client().chat({ model: config.smallModel ?? config.model, messages: [{ role: 'user', content: CONSOLIDATE_PROMPT.replace('{facts}', listing) }], maxTokens: 1500 }),
      );
      const merged = parseFacts(res.content);
      if (!merged.length) return;
      const fresh = store.projectMemory.get(projectId)!;
      // Facts added while the model worked are kept as they are.
      const added = fresh.facts.filter((f) => !facts.some((x) => x.id === f.id));
      fresh.facts = [
        ...merged.map((m): ProjectFact => {
          const sources = (m.from ?? []).map((n) => facts[n - 1]).filter(Boolean);
          const single = sources.length === 1 && normalizeFact(sources[0].text) === normalizeFact(m.text) ? sources[0] : undefined;
          return (
            single ?? {
              id: newId(),
              text: m.text,
              kind: m.kind,
              source: 'consolidated',
              priority: Math.max(1, ...sources.map((f) => f.priority)),
              evidence: Math.max(1, sources.reduce((n, f) => n + f.evidence, 0)),
              createdAt: now(),
              updatedAt: now(),
            }
          );
        }),
        ...added,
      ];
      fresh.sinceConsolidation = 0;
      fresh.updatedAt = now();
      store.projectMemory.put(fresh);
    } finally {
      this.busy.delete(projectId);
    }
  }

  /** The project's instruction file, and how it would read with the learned facts added. */
  proposal(projectId: string): { path: string; exists: boolean; current: string; content: string; added: ProjectFact[] } | undefined {
    const project = this.deps.store.projects.get(projectId);
    if (!project?.folder) return undefined;
    const path = ['MITZI.md', 'AGENTS.md', 'CLAUDE.md'].map((f) => join(project.folder!, f)).find(existsSync) ?? join(project.folder, 'MITZI.md');
    const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
    // Facts seen more than once, or that the user stated, are worth writing down.
    const solid = this.core(projectId).filter((f) => f.priority >= 2 || f.evidence >= 2 || f.source === 'consolidated' || f.kind === 'command');
    const { added, content } = proposeInstructions(current, solid);
    return { path, exists: existsSync(path), current, content, added };
  }

  /** Writes the proposal into the instruction file. */
  applyProposal(projectId: string): { path: string; added: number } {
    const p = this.proposal(projectId);
    if (!p) throw new Error('This project has no folder');
    if (!p.added.length) return { path: p.path, added: 0 };
    writeFileSync(p.path, p.content);
    return { path: p.path, added: p.added.length };
  }

  /** Waits for background jobs (tests). */
  async settle(): Promise<void> {
    while (this.jobs.size) await Promise.all([...this.jobs]);
  }

  private track(job: Promise<unknown>): void {
    const p = job.catch((err) => console.warn(`Project knowledge: ${err.message}`)).finally(() => this.jobs.delete(p));
    this.jobs.add(p);
  }
}

/** The system-prompt section for a project's learned facts. */
export function projectFactsPrompt(facts: ProjectFact[]): string {
  return (
    '# What you know about this repository\nLearned from earlier work here (the user\'s own corrections are marked). Rely on it; ' +
    'when you learn something new and durable (how to build or test, a convention, a gotcha on this machine), or the user ' +
    'corrects you, record it with ProjectNote.\n' +
    facts.map((f) => `- ${f.source === 'correction' || f.source === 'user' ? '(from the user) ' : ''}${f.text}`).join('\n')
  );
}

/** ProjectNote: lets the bot record a durable fact about the repository it works in. */
export function projectNoteTool(knowledge: ProjectKnowledge, projectId: string): Tool<{ text: string; kind?: ProjectFactKind }> {
  return {
    name: 'ProjectNote',
    kind: 'read',
    description:
      'Record a durable fact about this repository for future work: how to build, test or run it, a convention, where things ' +
      'live, a gotcha on this machine, or a correction the user made. One fact per call, phrased as a standing rule. Not for ' +
      'facts about the current task only.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' }, kind: { type: 'string', enum: KINDS } },
      required: ['text'],
    },
    summarize: (a) => String(a.text ?? '').slice(0, 80),
    async run(a) {
      if (!String(a.text ?? '').trim()) throw new ToolError('text is required');
      const fact = knowledge.add(projectId, String(a.text), a.kind ?? 'convention', 'agent', 2);
      return fact ? `Noted for this repository: ${fact.text}` : 'Nothing to note.';
    },
  };
}
