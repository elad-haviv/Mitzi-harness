// Conversation starters personalized from a bot's memory bank and its recent chats.
import type { Config } from '../config.js';
import type { LlmClient } from '../openrouter.js';
import { Bot, DEFAULT_BOT_ID, MemoryUnit } from '../shared/types.js';
import type { MemoryService } from './memory/index.js';
import type { Store } from './store.js';

/** While nothing new happened, or within this window, the last starters are reused. */
const MIN_REFRESH_MS = 10 * 60_000;
const MAX_AGE_MS = 12 * 3600_000;
const COUNT = 4;

export interface StartersResult {
  starters: string[];
  /** False when these are the bot's fixed starters (no memories or chats yet, or generation failed). */
  personalized: boolean;
}

const PROMPT = `You suggest conversation starters for an AI assistant's home screen. They should feel like the assistant \
remembers the user: follow up on what they were recently working on, check in on upcoming events and goals, or offer \
something new that fits their interests. Use what you know, but don't repeat a recent conversation word for word.

Today is {date}.
{persona}
What the assistant remembers about the user (newest first):
{memories}

The user's recent conversations (newest first):
{chats}

Write {count} starters, each a short message the USER would send (first person, under 70 characters, no quotes, no \
emoji). Make them specific: name the actual project, topic, person or date. Mix follow-ups on recent work with one or \
two fresh ideas. Reply with only a JSON array of strings.`;

interface Entry {
  key: string;
  at: number;
  result: StartersResult;
}

export class StarterService {
  private readonly cache = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<StartersResult>>();

  constructor(
    private readonly deps: {
      store: Store;
      memory: MemoryService;
      client: () => LlmClient;
      config: () => Config;
      memoryOn: (bot: Bot) => boolean;
    },
  ) {}

  private fixed(bot: Bot): StartersResult {
    return { starters: bot.starters, personalized: false };
  }

  /** The bot's recent, real conversations (not documents or scheduled runs). */
  private recentChats(bot: Bot) {
    return this.deps.store.chats
      .all()
      .filter((c) => (c.botId ?? DEFAULT_BOT_ID) === bot.id && !c.taskId && c.messages.some((m) => m.role === 'user'))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 8);
  }

  private async memories(bot: Bot): Promise<MemoryUnit[]> {
    if (!this.deps.memoryOn(bot)) return [];
    try {
      const { memory } = this.deps;
      return (await memory.backend().list(memory.bankFor(bot), { limit: 30, offset: 0 })).items;
    } catch {
      return [];
    }
  }

  async get(bot: Bot, force = false): Promise<StartersResult> {
    const running = this.pending.get(bot.id);
    if (running) return running;
    const job = this.compute(bot, force).finally(() => this.pending.delete(bot.id));
    this.pending.set(bot.id, job);
    return job;
  }

  private async compute(bot: Bot, force: boolean): Promise<StartersResult> {
    const [memories, chats] = [await this.memories(bot), this.recentChats(bot)];
    if (!memories.length && !chats.length) return this.fixed(bot);

    const key = [...memories.slice(0, 12).map((m) => m.id), ...chats.map((c) => `${c.id}@${c.updatedAt}`)].join(',');
    const cached = this.cache.get(bot.id);
    const age = cached ? Date.now() - cached.at : Infinity;
    if (cached && !force && ((cached.key === key && age < MAX_AGE_MS) || age < MIN_REFRESH_MS)) return cached.result;

    const firstUser = (c: (typeof chats)[number]) => {
      const m = c.messages.find((x) => x.role === 'user');
      const text = typeof m?.content === 'string' ? m.content : (m?.content ?? []).map((p) => (p.type === 'text' ? p.text : '')).join(' ');
      return text.replace(/<attachment[\s\S]*?<\/attachment>/g, '').replace(/\s+/g, ' ').trim().slice(0, 160);
    };
    const prompt = PROMPT.replace('{date}', new Date().toDateString())
      .replace('{persona}', bot.builtIn ? '' : `The assistant is "${bot.name}": ${bot.description || bot.systemPrompt.slice(0, 300)}\n`)
      .replace('{memories}', memories.map((m) => `- ${m.text}${m.occurredAt ? ` (${m.occurredAt.slice(0, 10)})` : ''}`).join('\n') || '(nothing yet)')
      .replace('{chats}', chats.map((c) => `- "${c.title}" (${c.updatedAt.slice(0, 10)}): ${firstUser(c)}`).join('\n') || '(none yet)')
      .replace('{count}', String(COUNT));

    try {
      const config = this.deps.config();
      const res = await this.deps.client().chat({ model: config.smallModel ?? bot.model ?? config.model, messages: [{ role: 'user', content: prompt }], maxTokens: 400, temperature: 0.8 });
      const match = /\[[\s\S]*\]/.exec(res.content);
      const list = match ? (JSON.parse(match[0]) as unknown[]) : [];
      const starters = list
        .filter((s): s is string => typeof s === 'string' && !!s.trim())
        .map((s) => s.trim().replace(/^["']|["']$/g, '').slice(0, 120))
        .slice(0, COUNT);
      if (!starters.length) throw new Error('no starters in the reply');
      const result = { starters, personalized: true };
      this.cache.set(bot.id, { key, at: Date.now(), result });
      return result;
    } catch (err) {
      console.warn(`Starters: couldn't personalize for ${bot.name}: ${(err as Error).message}`);
      return cached?.result ?? this.fixed(bot);
    }
  }
}
