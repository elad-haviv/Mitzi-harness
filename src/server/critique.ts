// Pre-final self-review: before a work-mode turn that changed files ends, the fast model reviews the changes against
// the task and the bot's lessons. Findings send the bot back to work once. A cheap verifier that helps weaker models most.
import type { Message } from '../openrouter.js';

const MAX_CHANGES = 12_000;

/** The changes a run made with Write and Edit, as text a reviewer can read. */
export function changesFromMessages(messages: Message[]): string {
  const failed = new Set(messages.filter((m) => m.role === 'tool' && typeof m.content === 'string' && /^(Error|Skipped|The user declined)/.test(m.content)).map((m) => m.tool_call_id));
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const c of m.tool_calls ?? []) {
      if (!/^(Write|Edit)$/.test(c.function.name) || failed.has(c.id)) continue;
      let a: any;
      try {
        a = JSON.parse(c.function.arguments || '{}');
      } catch {
        continue;
      }
      if (c.function.name === 'Write') parts.push(`### Wrote ${a.file_path}\n${String(a.content ?? '').slice(0, 4000)}`);
      else parts.push(`### Edited ${a.file_path}${a.replace_all ? ' (all occurrences)' : ''}\n--- before\n${String(a.old_string ?? '').slice(0, 2000)}\n+++ after\n${String(a.new_string ?? '').slice(0, 2000)}`);
    }
  }
  const text = parts.join('\n\n');
  return text.length > MAX_CHANGES ? `${text.slice(0, MAX_CHANGES)}\n… [more changes not shown]` : text;
}

export function critiquePrompt(task: string, lessons: string[], facts: string[], changes: string, summary: string): string {
  return (
    `You review an AI coding assistant's changes before it tells the user it's done. Look for real problems only: bugs, ` +
    `missed parts of the task, broken edge cases, changes that contradict the lessons or the repository's conventions below, ` +
    `leftover debugging code. Ignore style nits and things you can't judge from the changes.\n\n` +
    `<task>\n${task.slice(0, 3000)}\n</task>\n\n` +
    (lessons.length ? `<lessons>\n${lessons.map((l) => `- ${l}`).join('\n')}\n</lessons>\n\n` : '') +
    (facts.length ? `<repository-conventions>\n${facts.map((f) => `- ${f}`).join('\n')}\n</repository-conventions>\n\n` : '') +
    `<changes>\n${changes}\n</changes>\n\n<assistant-summary>\n${summary.slice(-2000)}\n</assistant-summary>\n\n` +
    'Reply with JSON only: {"ok": true|false, "issues": ["<one concrete problem per entry, with the file>"]}'
  );
}

/** Reads the reviewer's verdict; anything unreadable passes (the review must never block work by itself). */
export function parseCritique(reply: string): { ok: boolean; issues: string[] } {
  try {
    const json = JSON.parse(/\{[\s\S]*\}/.exec(reply)?.[0] ?? '');
    const issues = Array.isArray(json.issues) ? json.issues.map(String).filter((s: string) => s.trim()).slice(0, 6) : [];
    return { ok: json.ok !== false || !issues.length, issues };
  } catch {
    return { ok: true, issues: [] };
  }
}

export function critiqueMessage(issues: string[]): string {
  return `A quick review of your changes before finishing found possible problems. Check each one; fix what's real, and say briefly why any isn't.\n\n${issues.map((i) => `- ${i}`).join('\n')}`;
}

/** Checks a plan against what the bot learned, before the user approves it. */
export function planCheckPrompt(plan: string, lessons: string[], facts: string[]): string {
  return (
    `An AI assistant proposed the plan below. Check it ONLY against the lessons it learned and the facts known about the ` +
    `repository: point out each step that goes against one of them, or something they say is needed that the plan leaves ` +
    `out (for example a test run after changing code that a lesson says breaks easily). Quote the lesson or fact. Don't ` +
    `judge anything else about the plan.\n\n<plan>\n${plan.slice(0, 8000)}\n</plan>\n\n` +
    (lessons.length ? `<lessons>\n${lessons.map((l, i) => `${i + 1}. ${l}`).join('\n')}\n</lessons>\n\n` : '') +
    (facts.length ? `<repository-facts>\n${facts.map((f) => `- ${f}`).join('\n')}\n</repository-facts>\n\n` : '') +
    'Reply with JSON only: {"ok": true|false, "issues": ["<the step, what it misses or contradicts, and which lesson or fact says so>"]}'
  );
}
