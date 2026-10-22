import type { ModelInfo } from './shared/types.js';

// Minimal streaming client for the OpenRouter chat completions API
// (OpenAI-compatible, with OpenRouter extensions such as usage accounting).

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface TextPart {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

export interface ImagePart {
  type: 'image_url';
  image_url: { url: string };
}

export type ContentPart = TextPart | ImagePart;

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface Message {
  role: Role;
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost?: number;
}

export interface ChatRequest {
  model: string;
  messages: Message[];
  tools?: ToolSpec[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface StreamHandlers {
  onText?(chunk: string): void;
  onReasoning?(chunk: string): void;
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  usage?: Usage;
  finishReason?: string;
}

/** What the agent needs from a model provider. */
export interface LlmClient {
  chat(req: ChatRequest, handlers?: StreamHandlers): Promise<ChatResult>;
  listModels(): Promise<ModelInfo[]>;
  embed(model: string, input: string[]): Promise<number[][]>;
}

export class OpenRouterError extends Error {
  constructor(message: string, readonly status?: number | string) {
    super(message);
    this.name = 'OpenRouterError';
  }
}

export interface ClientOptions {
  apiKey: string;
  baseUrl: string;
  appName?: string;
  appUrl?: string;
  maxRetries?: number;
  /** OpenRouter extensions (usage accounting, app headers), or plain OpenAI-compatible. */
  flavor?: 'openrouter' | 'openai';
  /** Prefix and display name for listed models (non-OpenRouter providers). */
  providerId?: string;
  providerName?: string;
  /** Which listed models can chat (OpenAI-compatible model lists include embeddings, TTS, …). */
  modelFilter?: (id: string) => boolean;
  /** Newer OpenAI reasoning models take max_completion_tokens and no temperature. */
  reasoningModels?: RegExp;
}

/** Client for OpenRouter and any OpenAI-compatible chat completions API. */
export class OpenRouterClient implements LlmClient {
  constructor(private readonly opts: ClientOptions) {}

  async chat(req: ChatRequest, handlers: StreamHandlers = {}): Promise<ChatResult> {
    const openrouter = (this.opts.flavor ?? 'openrouter') === 'openrouter';
    const reasoning = !!this.opts.reasoningModels?.test(req.model);
    const body = {
      model: req.model,
      messages: req.messages,
      tools: req.tools?.length ? req.tools : undefined,
      ...(reasoning ? { max_completion_tokens: req.maxTokens } : { max_tokens: req.maxTokens, temperature: req.temperature }),
      stream: true,
      ...(openrouter ? { usage: { include: true } } : { stream_options: { include_usage: true } }),
    };
    const res = await this.post('/chat/completions', body, req.signal);
    if (!res.body) throw new OpenRouterError('Empty response body');

    let content = '';
    let usage: Usage | undefined;
    let finishReason: string | undefined;
    const calls: ToolCall[] = [];

    for await (const data of sseData(res.body)) {
      if (data === '[DONE]') break;
      let chunk: any;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (chunk.error) throw new OpenRouterError(chunk.error.message ?? 'Stream error', chunk.error.code);
      if (chunk.usage) usage = chunk.usage;

      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (delta.reasoning) handlers.onReasoning?.(delta.reasoning);
      if (delta.content) {
        content += delta.content;
        handlers.onText?.(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const index = typeof tc.index === 'number' ? tc.index : calls.length;
        const slot = (calls[index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name && !slot.function.name) slot.function.name = tc.function.name;
        if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }

    const toolCalls = calls
      .filter((c) => c && c.function.name)
      .map((c, i) => ({ ...c, id: c.id || `call_${Date.now()}_${i}` }));
    return { content, toolCalls, usage, finishReason };
  }

  /** OpenAI-compatible embeddings, one vector per input. */
  async embed(model: string, input: string[]): Promise<number[][]> {
    const res = await this.post('/embeddings', { model, input });
    const json = (await res.json()) as { data?: { index?: number; embedding: number[] }[] };
    if (!Array.isArray(json.data) || json.data.length !== input.length) throw new OpenRouterError('Unexpected embeddings response');
    return [...json.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding);
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await fetch(`${this.opts.baseUrl}/models`, { headers: this.headers(), signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new OpenRouterError(`Failed to list models: HTTP ${res.status}`, res.status);
    const json = (await res.json()) as { data?: any[] } | any[];
    const raw = Array.isArray(json) ? json : json.data ?? [];
    if ((this.opts.flavor ?? 'openrouter') === 'openrouter') {
      return raw.map((m) => ({
        id: m.id,
        name: m.name ?? m.id,
        provider: 'OpenRouter',
        contextLength: m.context_length,
        promptPrice: m.pricing?.prompt !== undefined ? Number(m.pricing.prompt) * 1e6 : undefined,
        completionPrice: m.pricing?.completion !== undefined ? Number(m.pricing.completion) * 1e6 : undefined,
        tools: Array.isArray(m.supported_parameters) ? m.supported_parameters.includes('tools') : true,
        vision: Array.isArray(m.architecture?.input_modalities) ? m.architecture.input_modalities.includes('image') : false,
      }));
    }
    const prefix = this.opts.providerId ? `${this.opts.providerId}:` : '';
    return raw
      .map((m) => String(m.id ?? '').replace(/^models\//, ''))
      .filter((id) => id && (this.opts.modelFilter?.(id) ?? true))
      .sort()
      .map((id) => ({
        id: `${prefix}${id}`,
        name: id,
        provider: this.opts.providerName,
        contextLength: raw.find((m) => String(m.id).endsWith(id))?.context_length ?? raw.find((m) => String(m.id).endsWith(id))?.context_window,
        tools: true,
        vision: /vision|gpt-4o|gpt-4\.1|gpt-5|o3|o4|gemini|llava|pixtral|grok-[2-9]|claude/i.test(id),
      }));
  }

  private headers(): Record<string, string> {
    const auth: Record<string, string> = this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {};
    if ((this.opts.flavor ?? 'openrouter') !== 'openrouter') return { ...auth, 'Content-Type': 'application/json' };
    return {
      ...auth,
      'Content-Type': 'application/json',
      'HTTP-Referer': this.opts.appUrl ?? 'https://github.com/elad-haviv/Mitzi-harness',
      'X-Title': this.opts.appName ?? 'Mitzi',
    };
  }

  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    const maxRetries = this.opts.maxRetries ?? 3;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${this.opts.baseUrl}${path}`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal,
      });
      if (res.ok) return res;
      const text = await res.text();
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < maxRetries) {
        await sleep(1000 * 2 ** attempt, signal);
        continue;
      }
      throw new OpenRouterError(errorMessage(text) ?? `HTTP ${res.status}`, res.status);
    }
  }
}

function errorMessage(text: string): string | undefined {
  try {
    const json = JSON.parse(text);
    const msg = json?.error?.message;
    const raw = json?.error?.metadata?.raw;
    return msg ? (raw ? `${msg}: ${raw}` : msg) : undefined;
  } catch {
    return text.trim() || undefined;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/** Yields the payload of each `data:` line of a server-sent event stream. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line.startsWith('data:')) yield line.slice(5).trimStart();
    }
  }
  buf += decoder.decode();
  if (buf.startsWith('data:')) yield buf.slice(5).trimStart();
}
