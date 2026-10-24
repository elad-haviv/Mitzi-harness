// Learning from silent corrections: when the user rewrites what the bot made (an artifact, or a file it wrote in the
// project folder), the difference says what they prefer. The fast model turns it into a style lesson, without asking.
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { Config } from '../config.js';
import type { LlmClient } from '../openrouter.js';
import type { Artifact, Chat } from '../shared/types.js';
import { addLessons } from './lessons.js';
import type { OutcomeLog } from './outcomes.js';
import type { Store } from './store.js';
import { withUsage } from './usage.js';

const MAX_DIFF = 4000;
const MAX_FILE = 50_000;

/** A line diff of two texts ("- " removed, "+ " added, with a little context), for the model to read. */
export function lineDiff(before: string, after: string, context = 1): string {
  let a = before.split('\n');
  let b = after.split('\n');
  // Trim the shared start and end, so long unchanged documents stay cheap.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const head = a.slice(Math.max(0, start - context), start);
  const tail = a.slice(a.length - end, a.length - end + context);
  a = a.slice(start, a.length - end);
  b = b.slice(start, b.length - end);
  const out: string[] = head.map((l) => `  ${l}`);
  if (a.length * b.length > 250_000) {
    out.push(...a.map((l) => `- ${l}`), ...b.map((l) => `+ ${l}`));
  } else {
    // Longest common subsequence of the changed middle.
    const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) out.push(`  ${a[i++]}`), j++;
      else if (i < a.length && (j >= b.length || lcs[i + 1][j] >= lcs[i][j + 1])) out.push(`- ${a[i++]}`);
      else out.push(`+ ${b[j++]}`);
    }
  }
  out.push(...tail.map((l) => `  ${l}`));
  const text = out.join('\n');
  return text.length > MAX_DIFF ? `${text.slice(0, MAX_DIFF)}\n… [diff truncated]` : text;
}

/** Whether an edit is worth learning from: more than whitespace changed. */
export function meaningfulEdit(before: string, after: string): boolean {
  const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
  return squash(before) !== squash(after);
}

export const EDIT_LESSON_PROMPT = `An AI assistant produced the {what} below, and the user then edited it themselves without \
saying anything. From the difference, infer the user's reusable preference: one short rule in the imperative that would \
have made the assistant's version closer to theirs next time (e.g. "Use early returns instead of nested ifs", "Write in \
the active voice", "Don't put emoji in code comments"). If the edit only changes facts or content specific to this one \
piece (a name, a number, a new paragraph of their own) rather than a style or habit, reply NONE.

<diff>
{diff}
</diff>

Reply with only the rule, or NONE.`;

export interface EditMinerDeps {
  store: Store;
  client: () => LlmClient;
  config: () => Config;
  botFor: (chat: Chat) => { id: string };
  outcomes?: OutcomeLog;
  /** How long to wait after the user's last keystroke before learning (autosaves fold into one edit). */
  delayMs?: number;
}

interface FileSnapshot {
  path: string;
  hash: string;
  content: string;
}

/** Watches for the user editing the bot's work and learns style lessons from it. */
export class EditMiner {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** Files the bot wrote in each chat, as it left them. */
  private readonly written = new Map<string, FileSnapshot[]>();
  /** Lesson jobs in flight (for tests and shutdown). */
  readonly jobs = new Set<Promise<unknown>>();

  constructor(private readonly deps: EditMinerDeps) {}

  /** The user edited an artifact: learn once they've paused, if it rewrote the bot's version. */
  artifactEdited(artifact: Artifact): void {
    clearTimeout(this.timers.get(artifact.id));
    this.timers.set(
      artifact.id,
      setTimeout(() => {
        this.timers.delete(artifact.id);
        const fresh = this.deps.store.artifacts.get(artifact.id);
        if (fresh) this.track(this.learnFromArtifact(fresh));
      }, this.deps.delayMs ?? 90_000).unref(),
    );
  }

  /** Remembers the files the bot just wrote, so a later change by the user can be noticed. */
  rememberWrites(chatId: string, folder: string, files: string[]): void {
    const snaps: FileSnapshot[] = [];
    for (const f of files.slice(0, 10)) {
      const path = isAbsolute(f) ? f : join(folder, f);
      const content = readSmall(path);
      if (content !== undefined) snaps.push({ path, content, hash: hash(content) });
    }
    if (snaps.length) this.written.set(chatId, snaps);
  }

  /** Before the next turn: did the user change any file the bot wrote last time? */
  checkWrites(chat: Chat): void {
    const snaps = this.written.get(chat.id);
    if (!snaps) return;
    this.written.delete(chat.id);
    const changed = snaps.flatMap((s) => {
      const now = readSmall(s.path) ?? '';
      return hash(now) !== s.hash && meaningfulEdit(s.content, now) ? [{ path: s.path, before: s.content, after: now }] : [];
    });
    if (!changed.length) return;
    this.noteEdit(chat);
    const diff = changed.map((c) => `--- ${c.path}\n${lineDiff(c.before, c.after)}`).join('\n\n');
    this.track(this.learn(chat, 'code', diff));
  }

  /** Waits for pending lesson jobs (tests). */
  async settle(): Promise<void> {
    while (this.jobs.size) await Promise.all([...this.jobs]);
  }

  /** Runs pending artifact timers now (tests). */
  flush(): void {
    for (const [id, timer] of this.timers) {
      clearTimeout(timer);
      this.timers.delete(id);
      const a = this.deps.store.artifacts.get(id);
      if (a) this.track(this.learnFromArtifact(a));
    }
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private track(job: Promise<unknown>): void {
    const p = job.catch((err) => console.warn(`Couldn't learn from an edit: ${err.message}`)).finally(() => this.jobs.delete(p));
    this.jobs.add(p);
  }

  private async learnFromArtifact(artifact: Artifact): Promise<void> {
    const versions = artifact.versions;
    const last = versions.at(-1);
    if (!last || last.author !== 'user') return;
    // The bot's latest version before the user's edits.
    const botIndex = versions.findLastIndex((v) => v.author !== 'user');
    if (botIndex < 0 || last.learned) return;
    const before = versions[botIndex].content;
    if (!meaningfulEdit(before, last.content)) return;
    const chat = this.deps.store.chats.get(artifact.chatId);
    if (!chat) return;
    last.learned = true;
    this.deps.store.artifacts.put(artifact);
    this.noteEdit(chat);
    await this.learn(chat, `${artifact.type}${artifact.language ? ` (${artifact.language})` : ''} "${artifact.title}"`, lineDiff(before, last.content));
  }

  /** Counts the edit on the chat's latest outcome. */
  private noteEdit(chat: Chat): void {
    const id = chat.messages.findLast((m) => m.outcomeId)?.outcomeId;
    const o = id ? this.deps.outcomes?.get(id) : undefined;
    if (o) this.deps.outcomes!.amend(o.id, { editsAfter: (o.editsAfter ?? 0) + 1 });
  }

  private async learn(chat: Chat, what: string, diff: string): Promise<void> {
    const bot = this.deps.botFor(chat);
    const config = this.deps.config();
    const res = await withUsage({ kind: 'learning', chatId: chat.id, botId: bot.id, sink: undefined, route: undefined }, () =>
      this.deps.client().chat({ model: config.smallModel ?? config.model, messages: [{ role: 'user', content: EDIT_LESSON_PROMPT.replace('{what}', what).replace('{diff}', diff) }], maxTokens: 150 }),
    );
    addLessons(this.deps.store, bot.id, [res.content.split('\n')[0]], { source: 'edit', chatId: chat.id });
  }
}

function readSmall(path: string): string | undefined {
  try {
    if (statSync(path).size > MAX_FILE) return undefined;
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function hash(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}
