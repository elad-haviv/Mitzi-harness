// A bot's lessons: short rules it keeps in its system prompt, learned from ratings, feedback loops, task outcomes,
// the user's edits and its teammates.
import type { Bot, Lesson, LessonSource } from '../shared/types.js';
import { newId, now, Store } from './store.js';

export const MAX_LESSONS = 30;
/** Lessons that make it into the prompt. */
export const PROMPT_LESSONS = 12;

/** The lessons a bot's prompt includes, oldest first. */
export function lessonsInPrompt(bot: Bot): Lesson[] {
  return (bot.lessons ?? []).slice(-PROMPT_LESSONS);
}

/** Adds lessons to a bot (dropping the oldest past the cap). Returns what was added; exact repeats are skipped. */
export function addLessons(store: Store, botId: string, texts: string[], fields: { value?: 1 | -1; chatId?: string; source: LessonSource }): Lesson[] {
  const bot = store.bots.get(botId);
  if (!bot) return [];
  const known = new Set((bot.lessons ?? []).map((l) => normalize(l.text)));
  const added: Lesson[] = [];
  for (const raw of texts) {
    const text = raw.trim().replace(/^["'\-\s]+|["'\s]+$/g, '').slice(0, 500);
    if (!text || /^NONE\b/i.test(text) || known.has(normalize(text))) continue;
    known.add(normalize(text));
    added.push({ id: newId(), text, value: fields.value ?? -1, chatId: fields.chatId ?? '', createdAt: now(), source: fields.source });
  }
  if (!added.length) return [];
  bot.lessons = [...(bot.lessons ?? []), ...added].slice(-MAX_LESSONS);
  store.bots.put(bot);
  return added;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
