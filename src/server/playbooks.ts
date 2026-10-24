// Learned playbooks: when a task in a project goes cleanly, the fast model writes down how it was done (steps,
// commands, files, the check), and a later task of the same kind gets it in its prompt. Lessons say what to avoid;
// playbooks say how to do this kind of thing here.
import type { Config } from '../config.js';
import type { LlmClient } from '../openrouter.js';
import type { Playbook, TaskOutcome } from '../shared/types.js';
import type { OutcomeLog } from './outcomes.js';
import { newId, now, Store } from './store.js';
import { withUsage } from './usage.js';

const MAX_PER_PROJECT = 40;
/** Playbooks offered per prompt. */
const OFFERED = 2;
/** How similar a task must be to a playbook's to be offered it. */
const MIN_SCORE = 0.2;

const STOP = new Set(
  'a an and are as at be but by can do does for from have how i in is it its me my of on or our please should so that the their them then there these this to us was we what when where which will with you your add make fix update change create new code file files'.split(' '),
);

export function words(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((w) => w.length > 2 && !STOP.has(w)).map((w) => w.replace(/(ing|ed|es|s)$/, '')))];
}

/** How well a task matches a playbook: the share of the playbook's key words the task shares (0–1). */
export function similarity(task: string, playbook: Pick<Playbook, 'title' | 'when'>): number {
  const t = new Set(words(task));
  const p = words(`${playbook.title} ${playbook.when}`);
  if (!t.size || !p.length) return 0;
  const shared = p.filter((w) => t.has(w)).length;
  // Balance coverage of the playbook against coverage of the task, so long tasks don't match everything.
  return (2 * shared) / (p.length + t.size);
}

/** A task worth learning a playbook from: real work, no mistakes, checks green, no redo, no low rating. */
export function cleanRun(o: TaskOutcome): boolean {
  return (
    o.source === 'run' &&
    !!o.projectId &&
    o.toolCalls >= 3 &&
    o.filesTouched.length > 0 &&
    !o.errors.some((e) => e.kind === 'agent') &&
    o.testsPassed !== false &&
    !o.redone &&
    (o.rating === undefined || o.rating >= 4)
  );
}

export const PLAYBOOK_PROMPT = `An AI coding assistant just completed this task cleanly in a repository. Write a short, reusable \
playbook for doing this KIND of task in this repository again: generalize away the specifics of this one instance, but \
keep the concrete commands, file locations and the way the work was verified.

<task>
{task}
</task>

<what-it-did>
{trace}
</what-it-did>

{check}

Reply with JSON only: {"title": "<kind of task, a few words>", "when": "<one sentence: which tasks this applies to>", \
"steps": ["<step>", "..."], "verification": "<how to check the work>"}. If the task is too one-off to generalize, reply {"skip": true}.`;

export function playbookPrompt(playbook: Playbook, withTrace: boolean): string {
  return (
    `## ${playbook.title}\nFor: ${playbook.when}\n${playbook.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}` +
    (playbook.verification ? `\nVerify: ${playbook.verification}` : '') +
    (withTrace && playbook.trace?.length ? `\nTool calls that worked last time:\n${playbook.trace.map((t) => `- ${t}`).join('\n')}` : '')
  );
}

export interface PlaybookDeps {
  store: Store;
  client: () => LlmClient;
  config: () => Config;
  outcomes: OutcomeLog;
}

export class Playbooks {
  readonly jobs = new Set<Promise<unknown>>();

  constructor(private readonly deps: PlaybookDeps) {
    deps.outcomes.listeners.add((o) => {
      if (cleanRun(o)) this.track(this.learn(o));
    });
    // A playbook whose task was later redone or rated low was not a good way to do it.
    deps.outcomes.amendListeners.add((o, patch) => {
      if (patch.redone || (patch.rating !== undefined && patch.rating <= 2) || patch.editsAfter) this.forget(o.id);
    });
  }

  list(projectId?: string): Playbook[] {
    return this.deps.store.playbooks
      .all()
      .filter((p) => !projectId || p.projectId === projectId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Playbooks for a task in a project, best match first. */
  match(projectId: string | undefined, task: string): Playbook[] {
    if (!projectId || !task.trim()) return [];
    return this.list(projectId)
      .map((p) => ({ p, score: similarity(task, p) }))
      .filter((x) => x.score >= MIN_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, OFFERED)
      .map((x) => x.p);
  }

  /** Counts that playbooks were offered. */
  used(playbooks: Playbook[]): void {
    for (const p of playbooks) {
      const fresh = this.deps.store.playbooks.get(p.id);
      if (fresh) this.deps.store.playbooks.put({ ...fresh, uses: fresh.uses + 1 });
    }
  }

  remove(id: string): boolean {
    return this.deps.store.playbooks.delete(id);
  }

  async learn(o: TaskOutcome): Promise<Playbook | undefined> {
    const config = this.deps.config();
    const prompt = PLAYBOOK_PROMPT.replace('{task}', o.task)
      .replace('{trace}', (o.trace ?? o.commands.map((c) => `Bash ${c.command}`)).join('\n') || '(no tool calls recorded)')
      .replace('{check}', o.checkCommand ? `The work was verified with \`${o.checkCommand}\`, which passed.` : '');
    const res = await withUsage({ kind: 'learning', botId: o.botId, projectId: o.projectId, sink: undefined, route: undefined }, () =>
      this.deps.client().chat({ model: config.smallModel ?? config.model, messages: [{ role: 'user', content: prompt }], maxTokens: 700 }),
    );
    let json: any;
    try {
      json = JSON.parse(/\{[\s\S]*\}/.exec(res.content)?.[0] ?? '');
    } catch {
      return undefined;
    }
    if (json.skip || !json.title || !Array.isArray(json.steps) || !json.steps.length) return undefined;
    // The same kind of task learned again replaces the older playbook.
    const title = String(json.title).slice(0, 120);
    const when = String(json.when ?? '').slice(0, 400);
    const older = this.list(o.projectId).find((p) => similarity(`${title} ${when}`, p) >= 0.6);
    const playbook: Playbook = {
      id: older?.id ?? newId(),
      botId: o.botId,
      projectId: o.projectId,
      title,
      when,
      steps: json.steps.map(String).slice(0, 12),
      verification: json.verification ? String(json.verification).slice(0, 300) : o.checkCommand,
      trace: o.trace,
      outcomeId: o.id,
      uses: older?.uses ?? 0,
      createdAt: older?.createdAt ?? now(),
      updatedAt: now(),
    };
    this.deps.store.playbooks.put(playbook);
    const all = this.list(o.projectId);
    for (const p of all.slice(MAX_PER_PROJECT)) this.remove(p.id);
    return playbook;
  }

  async settle(): Promise<void> {
    while (this.jobs.size) await Promise.all([...this.jobs]);
  }

  private forget(outcomeId: string): void {
    for (const p of this.deps.store.playbooks.all()) if (p.outcomeId === outcomeId) this.remove(p.id);
  }

  private track(job: Promise<unknown>): void {
    const p = job.catch((err) => console.warn(`Playbooks: ${err.message}`)).finally(() => this.jobs.delete(p));
    this.jobs.add(p);
  }
}
