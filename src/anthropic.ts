// Native client for Anthropic's Messages API, translating from the OpenAI-style
// messages the agent uses (tool calls, tool results, images) and streaming back.
import { sseEvents } from './server/mcp/client.js';
import type { ChatRequest, ChatResult, ContentPart, LlmClient, Message, StreamHandlers, ToolCall, Usage } from './openrouter.js';
import { OpenRouterError } from './openrouter.js';
import type { ModelInfo } from './shared/types.js';

type Block = Record<string, any>;
interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: Block[];
}

function text(content: Message['content']): string {
  if (typeof content === 'string') return content;
  return (content ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('\n');
}

function imageBlock(url: string): Block {
  const m = /^data:([^;]+);base64,(.*)$/.exec(url);
  return m ? { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } } : { type: 'image', source: { type: 'url', url } };
}

function userBlocks(content: Message['content']): Block[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  return (content ?? []).map((p: ContentPart) => (p.type === 'text' ? { type: 'text', text: p.text } : imageBlock(p.image_url.url)));
}

/** Converts OpenAI-style messages to Anthropic's: a separate system prompt, merged roles, tool blocks. */
export function toAnthropic(messages: Message[]): { system: Block[]; messages: AnthropicMessage[] } {
  const system: Block[] = [];
  const out: AnthropicMessage[] = [];
  const push = (role: AnthropicMessage['role'], blocks: Block[]) => {
    if (!blocks.length) return;
    const last = out.at(-1);
    // Anthropic requires alternating roles, so consecutive same-role messages merge.
    if (last?.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === 'system') {
      const t = text(m.content);
      if (t) system.push({ type: 'text', text: t });
    } else if (m.role === 'user') {
      push('user', userBlocks(m.content));
    } else if (m.role === 'assistant') {
      const blocks: Block[] = [];
      const t = text(m.content);
      if (t.trim()) blocks.push({ type: 'text', text: t });
      for (const c of m.tool_calls ?? []) {
        let input: unknown = {};
        try {
          input = JSON.parse(c.function.arguments || '{}');
        } catch {
          input = {};
        }
        blocks.push({ type: 'tool_use', id: c.id, name: c.function.name, input });
      }
      push('assistant', blocks);
    } else if (m.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: text(m.content) || '(no output)' }]);
    }
  }
  if (out[0]?.role === 'assistant') out.unshift({ role: 'user', content: [{ type: 'text', text: '(continuing)' }] });
  // Cache the stable prefix: the system prompt and everything up to the latest user turn.
  if (system.length) system[system.length - 1].cache_control = { type: 'ephemeral' };
  const lastUser = out.findLast((m) => m.role === 'user');
  if (lastUser?.content.length) lastUser.content[lastUser.content.length - 1].cache_control = { type: 'ephemeral' };
  return { system, messages: out };
}

function maxTokensFor(model: string): number {
  return /claude-(opus|sonnet|haiku)-[4-9]|claude-[4-9]/.test(model) ? 32_000 : 8192;
}

export class AnthropicClient implements LlmClient {
  constructor(
    private readonly opts: { apiKey: string; baseUrl?: string; providerId: string; providerName: string },
  ) {}

  private get base(): string {
    return (this.opts.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
  }

  private headers(): Record<string, string> {
    return { 'x-api-key': this.opts.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
  }

  async chat(req: ChatRequest, handlers: StreamHandlers = {}): Promise<ChatResult> {
    const { system, messages } = toAnthropic(req.messages);
    const body = {
      model: req.model,
      max_tokens: req.maxTokens ?? maxTokensFor(req.model),
      system: system.length ? system : undefined,
      messages,
      tools: req.tools?.length ? req.tools.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters })) : undefined,
      temperature: req.temperature,
      stream: true,
    };
    let res: Response | undefined;
    for (let attempt = 0; ; attempt++) {
      res = await fetch(`${this.base}/v1/messages`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: req.signal });
      if (res.ok) break;
      const errText = await res.text();
      if ((res.status === 429 || res.status === 529 || res.status >= 500) && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      let message = errText;
      try {
        message = JSON.parse(errText).error?.message ?? errText;
      } catch {
        // Keep the raw text.
      }
      throw new OpenRouterError(message || `HTTP ${res.status}`, res.status);
    }

    let content = '';
    let thinking = '';
    let finishReason: string | undefined;
    const usage: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    const blocks = new Map<number, { id: string; name: string; json: string }>();
    for await (const ev of sseEvents(res.body!)) {
      let data: any;
      try {
        data = JSON.parse(ev.data);
      } catch {
        continue;
      }
      switch (data.type) {
        case 'message_start': {
          const u = data.message?.usage ?? {};
          usage.prompt_tokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
          break;
        }
        case 'content_block_start':
          if (data.content_block?.type === 'tool_use') blocks.set(data.index, { id: data.content_block.id, name: data.content_block.name, json: '' });
          break;
        case 'content_block_delta': {
          const d = data.delta ?? {};
          if (d.type === 'text_delta' && d.text) {
            content += d.text;
            handlers.onText?.(d.text);
          } else if (d.type === 'input_json_delta') {
            const b = blocks.get(data.index);
            if (b) b.json += d.partial_json ?? '';
          } else if (d.type === 'thinking_delta' && d.thinking) {
            thinking += d.thinking;
            handlers.onReasoning?.(d.thinking);
          }
          break;
        }
        case 'message_delta':
          if (data.delta?.stop_reason) finishReason = data.delta.stop_reason;
          if (data.usage?.output_tokens) usage.completion_tokens = data.usage.output_tokens;
          break;
        case 'error':
          throw new OpenRouterError(data.error?.message ?? 'Stream error');
      }
    }
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
    const toolCalls: ToolCall[] = [...blocks.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, b]) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: b.json || '{}' } }));
    return {
      content,
      toolCalls,
      usage,
      finishReason: finishReason === 'tool_use' ? 'tool_calls' : finishReason === 'max_tokens' ? 'length' : 'stop',
      ...(thinking.trim() ? { reasoning: thinking } : {}),
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await fetch(`${this.base}/v1/models?limit=100`, { headers: this.headers(), signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new OpenRouterError(`Failed to list models: HTTP ${res.status}`, res.status);
    const json = (await res.json()) as { data?: { id: string; display_name?: string }[] };
    return (json.data ?? []).map((m) => ({
      id: `${this.opts.providerId}:${m.id}`,
      name: m.display_name ?? m.id,
      provider: this.opts.providerName,
      contextLength: 200_000,
      tools: true,
      vision: true,
    }));
  }

  async embed(): Promise<number[][]> {
    throw new OpenRouterError('Anthropic does not offer an embeddings API');
  }
}
