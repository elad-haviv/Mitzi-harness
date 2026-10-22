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

export interface ModelInfo {
  id: string;
  name: string;
  context_length?: number;
  pricing?: { prompt: string; completion: string };
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
}

export class OpenRouterClient {
  constructor(private readonly opts: ClientOptions) {}

  async chat(req: ChatRequest, handlers: StreamHandlers = {}): Promise<ChatResult> {
    const body = {
      model: req.model,
      messages: req.messages,
      tools: req.tools?.length ? req.tools : undefined,
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      stream: true,
      usage: { include: true },
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

  async listModels(): Promise<ModelInfo[]> {
    const res = await fetch(`${this.opts.baseUrl}/models`, { headers: this.headers() });
    if (!res.ok) throw new OpenRouterError(`Failed to list models: HTTP ${res.status}`, res.status);
    const json = (await res.json()) as { data: ModelInfo[] };
    return json.data;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.opts.apiKey}`,
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
