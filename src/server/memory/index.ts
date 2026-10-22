import type { Bot, UiSettings } from '../../shared/types.js';
import { Tool, ToolError } from '../../tools/types.js';
import { BankRef, BuiltinMemory, LlmAccess, MemoryBackend } from './engine.js';
import { HindsightMemory } from './hindsight.js';

export type { BankRef, MemoryBackend } from './engine.js';

/** Routes memory operations to the built-in engine or a Hindsight server, per settings. */
export class MemoryService {
  readonly builtin: BuiltinMemory;
  private remote?: { key: string; backend: HindsightMemory };

  constructor(
    dir: string,
    llm: () => LlmAccess,
    private readonly settings: () => UiSettings,
    private readonly hindsightKey: () => string | undefined,
  ) {
    this.builtin = new BuiltinMemory(dir, llm);
  }

  backend(): MemoryBackend {
    const s = this.settings();
    if (s.memoryBackend !== 'hindsight' || !s.hindsightUrl.trim()) return this.builtin;
    return this.hindsight(s.hindsightUrl.trim(), this.hindsightKey());
  }

  hindsight(url: string, apiKey?: string): HindsightMemory {
    const key = `${url}\n${apiKey ?? ''}`;
    if (this.remote?.key !== key) this.remote = { key, backend: new HindsightMemory(url, apiKey) };
    return this.remote.backend;
  }

  bankFor(bot: Bot): BankRef {
    return { id: bot.id, name: bot.name, profile: bot.memory };
  }
}

interface MemoryArgs {
  action: 'remember' | 'recall' | 'reflect' | 'forget';
  content?: string;
  query?: string;
  id?: string;
}

/** Lets the model manage its own memory bank explicitly; most learning happens automatically. */
export function memoryTool(memory: MemoryService, bank: BankRef): Tool<MemoryArgs> {
  return {
    name: 'Memory',
    kind: 'read',
    description:
      'Your long-term memory bank. Relevant memories are recalled automatically before each message and you learn from ' +
      'conversations automatically, so use this only when needed: "remember" stores something the user explicitly asks you to ' +
      'remember (content: one self-contained sentence; never secrets); "recall" searches for memories beyond those already ' +
      'provided (query); "reflect" reasons over everything you remember to answer a broad question such as "what do I know ' +
      'about the user\'s goals?" (query); "forget" deletes a memory that is wrong or that the user asks you to forget (id).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['remember', 'recall', 'reflect', 'forget'] },
        content: { type: 'string', description: 'For remember' },
        query: { type: 'string', description: 'For recall and reflect' },
        id: { type: 'string', description: 'For forget' },
      },
      required: ['action'],
    },
    summarize: (a) => `${a.action}${a.content ? `: ${a.content}` : a.query ? `: ${a.query}` : a.id ? ` ${a.id}` : ''}`,
    async run(args) {
      const backend = memory.backend();
      switch (args.action) {
        case 'remember':
          if (!args.content?.trim()) throw new ToolError('content is required');
          await backend.remember(bank, args.content, 'assistant');
          return 'Saved to memory.';
        case 'recall': {
          if (!args.query?.trim()) throw new ToolError('query is required');
          const items = await backend.recall(bank, args.query, { maxTokens: 2000, limit: 20, includeCore: false });
          return items.length ? items.map((m) => `[${m.id}] (${m.type}) ${m.text}`).join('\n') : 'No matching memories.';
        }
        case 'reflect': {
          if (!args.query?.trim()) throw new ToolError('query is required');
          return (await backend.reflect(bank, args.query)).text || 'No answer.';
        }
        case 'forget':
          if (!args.id?.trim()) throw new ToolError('id is required');
          await backend.forget(bank, args.id);
          return `Forgot memory ${args.id}.`;
        default:
          throw new ToolError('action must be remember, recall, reflect or forget');
      }
    },
  };
}
