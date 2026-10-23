// Bringing your context over from other assistants: what they remember about you, and your chats.
import type { Config } from '../config.js';
import type { LlmClient } from '../openrouter.js';
import { Bot, Chat, ChatMessage, DEFAULT_BOT_ID, ImportedConversation, ImportSource } from '../shared/types.js';
import type { MemoryService } from './memory/index.js';
import { Store } from './store.js';
import { fail, HttpError, Route, str } from './util.js';

const SOURCE_NAME: Record<ImportSource, string> = { chatgpt: 'ChatGPT', claude: 'Claude' };

/** What the user runs in their old assistant. Mirrors what that assistant's memory holds. */
export const EXPORT_PROMPT = `I'm moving to a new AI assistant and want to bring my context with me. Please list everything you know or remember about me from our conversations and your memory, including:

- Who I am: name, where I live, languages, background
- Work, studies and current projects
- Interests, hobbies and things I care about
- How I like you to respond (tone, length, format, things to avoid)
- People in my life that I've mentioned, and how they relate to me
- Goals, plans and important dates
- Anything else that would help an assistant help me

Write one fact per line as a short, self-contained statement, include dates where you know them, and leave out anything you're unsure of or anything sensitive like passwords. Don't add commentary before or after the list.`;

const EXTRACT_PROMPT = `Below is a summary another AI assistant wrote about a user. Split it into separate, self-contained memories \
about the user, one fact each, written in the third person ("The user …"). Keep every concrete detail (names, dates, \
places, preferences). Drop filler, headings and anything that isn't about the user. Never include passwords, keys or \
other secrets.

Reply with only JSON: {"memories": ["…", "…"]}

<summary>
{text}
</summary>`;

/** Splits text into lines as a fallback when the model can't be reached. */
function splitLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter((l) => l.length > 3 && !/:$/.test(l) && !/^#+\s/.test(l));
}

export function registerImportRoutes(
  route: Route,
  deps: {
    store: Store;
    memory: MemoryService;
    client: () => LlmClient;
    config: () => Config;
    newChat: (fields: Partial<Chat>) => Chat;
    memoryOn: (bot: Bot) => boolean;
  },
): void {
  const { store, memory } = deps;
  const getBot = (id: string) => store.bots.get(id || DEFAULT_BOT_ID) ?? fail(404, 'Bot not found');

  route('GET', '/api/import/prompt', () => ({ prompt: EXPORT_PROMPT }));

  // 1. Turn pasted text into separate memories for the user to review.
  route('POST', '/api/import/memory/parse', async ({ body }) => {
    const text = str(body?.text).trim();
    if (!text) throw new HttpError(400, 'Paste what your other assistant said first');
    if (text.length > 60_000) throw new HttpError(413, 'That’s too long to import at once; split it into parts');
    try {
      const config = deps.config();
      const res = await deps.client().chat({ model: config.smallModel ?? config.model, messages: [{ role: 'user', content: EXTRACT_PROMPT.replace('{text}', text) }], maxTokens: 4000, temperature: 0 });
      const json = JSON.parse(/\{[\s\S]*\}/.exec(res.content)?.[0] ?? '{}');
      const memories = (Array.isArray(json.memories) ? json.memories : []).filter((m: unknown): m is string => typeof m === 'string' && !!m.trim()).map((m: string) => m.trim());
      if (memories.length) return { memories };
    } catch {
      // Fall through to splitting by line.
    }
    return { memories: splitLines(text), fallback: true };
  });

  // 2. Save the reviewed memories to a bot's bank.
  route('POST', '/api/import/memory', async ({ body }) => {
    const bot = getBot(str(body?.botId));
    const items: string[] = (Array.isArray(body?.memories) ? body.memories : []).filter((m: unknown) => typeof m === 'string' && m.trim()).map((m: string) => m.trim().slice(0, 1000));
    if (!items.length) throw new HttpError(400, 'Nothing to import');
    if (items.length > 500) throw new HttpError(413, 'Import at most 500 memories at a time');
    const bank = memory.bankFor(bot);
    for (const m of items) await memory.backend().remember(bank, m, 'user');
    return { imported: items.length };
  });

  // 3. Conversations, sent in batches by the browser after it unpacks the export.
  route('POST', '/api/import/chats', ({ body }) => {
    const source = str(body?.source) as ImportSource;
    if (!SOURCE_NAME[source]) throw new HttpError(400, 'Unknown source');
    const bot = getBot(str(body?.botId));
    const conversations: ImportedConversation[] = Array.isArray(body?.conversations) ? body.conversations : [];
    const existing = new Set(
      store.chats
        .all()
        .filter((c) => c.imported?.source === source)
        .map((c) => c.imported!.id),
    );
    let imported = 0;
    let skipped = 0;
    const toLearn: Chat[] = [];
    for (const conv of conversations) {
      const id = str(conv?.id);
      if (!id || existing.has(id) || !Array.isArray(conv.messages) || !conv.messages.length) {
        skipped++;
        continue;
      }
      const messages: ChatMessage[] = conv.messages
        .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && m.text.trim())
        .map((m) => ({ role: m.role, content: m.text, ...(typeof m.ts === 'number' ? { ts: m.ts } : {}), ...(m.role === 'assistant' ? { model: SOURCE_NAME[source] } : {}) }));
      if (!messages.length) {
        skipped++;
        continue;
      }
      const createdAt = Number.isNaN(Date.parse(conv.createdAt)) ? new Date().toISOString() : conv.createdAt;
      const chat = store.chats.put(
        deps.newChat({
          title: str(conv.title).trim().slice(0, 120) || 'Imported chat',
          botId: bot.id,
          messages,
          imported: { source, id },
          // An estimate, so long imported chats get compacted before the first new reply instead of overflowing.
          lastPromptTokens: Math.ceil(messages.reduce((n, m) => n + String(m.content).length, 0) / 4),
          createdAt,
          updatedAt: Number.isNaN(Date.parse(conv.updatedAt)) ? createdAt : conv.updatedAt,
        }),
      );
      existing.add(id);
      imported++;
      if (body?.learn === true) toLearn.push(chat);
    }
    // Learning reads each conversation with the fast model, so it runs in the background, newest first.
    if (toLearn.length && deps.memoryOn(bot)) {
      const bank = memory.bankFor(bot);
      void (async () => {
        for (const chat of toLearn.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
          const transcript = chat.messages
            .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${typeof m.content === 'string' ? m.content.slice(0, 3000) : ''}`)
            .join('\n\n')
            .slice(0, 16_000);
          await memory
            .backend()
            .retain(bank, { content: transcript, context: `Conversation "${chat.title}" imported from ${SOURCE_NAME[source]}`, timestamp: chat.updatedAt, chatId: chat.id })
            .catch((err) => console.warn(`Import: couldn't learn from "${chat.title}": ${err.message}`));
        }
      })();
    }
    return { imported, skipped, learning: toLearn.length && deps.memoryOn(bot) ? toLearn.length : 0 };
  });
}
