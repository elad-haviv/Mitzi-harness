import type { Config } from './config.js';
import type { ContentPart, LlmClient, Message, TextPart, Usage } from './openrouter.js';
import type { PermissionChecker } from './permissions.js';
import { buildSystemPrompt } from './prompt.js';
import { toToolSpecs, Tool, ToolContext, ToolError } from './tools/index.js';
import type { UI } from './ui.js';

export interface AgentDeps {
  client: LlmClient;
  config: Config;
  tools: Tool[];
  permissions: PermissionChecker;
  ui: UI;
  cwd: string;
  /** Overrides the default coding-agent system prompt. */
  systemPrompt?: () => string;
  /** Turns an image URL the provider can't reach (a local /media/ file) into one it can. */
  inlineImage?: (url: string) => string | undefined;
}

/** Opens the user message that carries the images tools took (screenshots), so they can be found again. */
export const TOOL_IMAGES_NOTE = 'Images from the tool calls above:';
/** Older tool images are left out of requests: they cost many tokens and the latest ones show the current state. */
const KEEP_TOOL_IMAGES = 3;

export interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
  cost: number;
  requests: number;
}

export const COMPACT_PROMPT = `Summarize the conversation below so that work can continue seamlessly in a fresh context. Include:
1. The user's requests and intent, in order.
2. Key technical decisions, constraints and conventions discovered.
3. Files read, created or modified, with the important details of each change.
4. Errors encountered and how they were resolved.
5. What is in progress right now and the concrete next steps.
Be thorough but compact. Output only the summary.`;

export class Agent {
  messages: Message[] = [];
  readonly usage: UsageTotals = { promptTokens: 0, completionTokens: 0, cost: 0, requests: 0 };
  readonly ctx: ToolContext;
  private _lastPromptTokens = 0;

  constructor(private readonly deps: AgentDeps) {
    this.ctx = {
      cwd: deps.cwd,
      readFiles: new Map(),
      todos: [],
      onTodos: (todos) => deps.ui.todos(todos),
    };
  }

  get config(): Config {
    return this.deps.config;
  }

  /** Prompt size of the most recent request: how full the context window is. */
  get lastPromptTokens(): number {
    return this._lastPromptTokens;
  }

  get permissions(): PermissionChecker {
    return this.deps.permissions;
  }

  get model(): string {
    return this.deps.config.model;
  }

  set model(model: string) {
    this.deps.config.model = model;
  }

  reset(): void {
    this.messages = [];
    this.ctx.todos = [];
    this.ctx.readFiles.clear();
    this._lastPromptTokens = 0;
  }

  private systemMessage(): Message {
    const text = this.deps.systemPrompt?.() ?? buildSystemPrompt({ cwd: this.ctx.cwd, model: this.model, mode: this.deps.permissions.mode });
    // Anthropic models only cache prompts with explicit breakpoints.
    return this.isAnthropic()
      ? { role: 'system', content: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }] }
      : { role: 'system', content: text };
  }

  private isAnthropic(): boolean {
    return this.model.startsWith('anthropic/');
  }

  /** Keeps only the latest tool images, and makes local image URLs reachable for the provider. */
  private withToolImages(messages: Message[]): Message[] {
    const isToolImages = (m: Message) => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'text' && m.content[0].text === TOOL_IMAGES_NOTE;
    let kept = 0;
    const out = messages.slice();
    for (let i = out.length - 1; i >= 0; i--) {
      const m = out[i];
      if (!isToolImages(m)) continue;
      if (++kept > KEEP_TOOL_IMAGES) {
        out[i] = { role: 'user', content: '(Earlier screenshots were left out to save space.)' };
        continue;
      }
      const inline = this.deps.inlineImage;
      if (inline) {
        out[i] = { ...m, content: (m.content as ContentPart[]).map((p) => (p.type === 'image_url' ? { ...p, image_url: { url: inline(p.image_url.url) ?? p.image_url.url } } : p)) };
      }
    }
    return out;
  }

  /** Adds a cache breakpoint on the latest user message so the growing history is reused across turns. */
  private withCacheBreakpoints(messages: Message[]): Message[] {
    if (!this.isAnthropic()) return messages;
    const i = messages.findLastIndex((m) => m.role === 'user' && typeof m.content === 'string');
    if (i < 0) return messages;
    const copy = messages.slice();
    const part: TextPart = { type: 'text', text: copy[i].content as string, cache_control: { type: 'ephemeral' } };
    copy[i] = { ...copy[i], content: [part] };
    return copy;
  }

  private recordUsage(usage?: Usage): void {
    this.usage.requests++;
    if (!usage) return;
    this.usage.promptTokens += usage.prompt_tokens ?? 0;
    this.usage.completionTokens += usage.completion_tokens ?? 0;
    this.usage.cost += usage.cost ?? 0;
    this._lastPromptTokens = usage.prompt_tokens ?? 0;
  }

  /**
   * Runs one user turn: calls the model and executes tools until it stops asking for them.
   * Pass `null` when the user message is already the last entry in `messages`.
   */
  async run(input: string | ContentPart[] | null, signal?: AbortSignal): Promise<void> {
    const { client, config, tools, ui } = this.deps;
    this.ctx.signal = signal;

    if (config.autoCompactTokens > 0 && this._lastPromptTokens > config.autoCompactTokens) {
      ui.info(`Context is ${this._lastPromptTokens.toLocaleString()} tokens; compacting conversation…`);
      await this.compact(undefined, signal);
    }

    if (input !== null) this.messages.push({ role: 'user', content: input });
    const specs = toToolSpecs(tools);

    for (let turn = 0; turn < config.maxTurns; turn++) {
      ui.startThinking();
      let result;
      try {
        result = await client.chat(
          {
            model: this.model,
            messages: [this.systemMessage(), ...this.withCacheBreakpoints(this.withToolImages(this.messages))],
            tools: specs,
            maxTokens: config.maxTokens,
            temperature: config.temperature,
            signal,
          },
          { onText: (t) => ui.text(t), onReasoning: (t) => ui.reasoning(t) },
        );
      } finally {
        ui.stopThinking();
      }
      this.recordUsage(result.usage);

      this.messages.push({
        role: 'assistant',
        content: result.content || null,
        ...(result.toolCalls.length ? { tool_calls: result.toolCalls } : {}),
        ...(result.reasoning ? { reasoning: result.reasoning } : {}),
      });
      if (!result.toolCalls.length) {
        if (result.finishReason === 'length') ui.warn('Response was cut off by the max token limit.');
        ui.endTurn();
        return;
      }

      let stop = false;
      for (const call of result.toolCalls) {
        // Every tool call must get a result, even when skipped, to keep the history valid.
        if (stop || signal?.aborted) {
          this.messages.push({ role: 'tool', tool_call_id: call.id, content: 'Skipped: the turn was stopped before this ran.' });
          continue;
        }
        const outcome = await this.executeTool(call.id, call.function.name, call.function.arguments, signal);
        this.messages.push({ role: 'tool', tool_call_id: call.id, content: outcome.content });
        stop = outcome.stop;
      }
      // Tool results can only be text, so images for the model follow them as a user message.
      const images = this.ctx.images?.splice(0) ?? [];
      if (images.length) {
        this.messages.push({ role: 'user', content: [{ type: 'text', text: TOOL_IMAGES_NOTE }, ...images.map((url): ContentPart => ({ type: 'image_url', image_url: { url } }))] });
      }
      if (stop || signal?.aborted) {
        ui.endTurn();
        return;
      }
    }
    ui.warn(`Stopped after ${config.maxTurns} turns. Send a message to continue.`);
  }

  private async executeTool(id: string, name: string, rawArgs: string, signal?: AbortSignal): Promise<{ content: string; stop: boolean }> {
    const { tools, permissions, ui } = this.deps;
    const tool = tools.find((t) => t.name === name);
    if (!tool) {
      ui.toolCall(name, '', id);
      ui.toolResult(`Unknown tool`, true, id);
      return { content: `Error: unknown tool "${name}". Available: ${tools.map((t) => t.name).join(', ')}`, stop: false };
    }

    let args: any;
    try {
      args = rawArgs.trim() ? JSON.parse(rawArgs) : {};
    } catch {
      ui.toolCall(name, '', id);
      ui.toolResult('Invalid JSON arguments', true, id);
      return { content: `Error: arguments were not valid JSON: ${rawArgs.slice(0, 500)}`, stop: false };
    }

    let summary = '';
    try {
      summary = tool.summarize(args, this.ctx);
    } catch {
      // Malformed args; run() will report the problem.
    }

    const decision = await permissions.check(tool, args, this.ctx, signal, id);
    if (!decision.allow) {
      ui.toolCall(name, summary, id, args);
      ui.toolResult(decision.reason, true, id);
      return { content: decision.reason, stop: decision.stop };
    }

    ui.toolCall(name, summary, id, args);
    this.ctx.callId = id;
    try {
      const output = await tool.run(args, this.ctx);
      ui.toolResult(output, false, id);
      return { content: output, stop: false };
    } catch (err: any) {
      const message = err instanceof ToolError ? err.message : `${err?.name ?? 'Error'}: ${err?.message ?? String(err)}`;
      ui.toolResult(message, true, id);
      return { content: `Error: ${message}`, stop: false };
    }
  }

  /** Replaces the history with a model-written summary of it. */
  async compact(instructions?: string, signal?: AbortSignal): Promise<void> {
    if (!this.messages.length) return;
    const transcript = this.messages.map(renderForTranscript).join('\n\n');
    const prompt = `${COMPACT_PROMPT}${instructions ? `\n\nAdditional instructions: ${instructions}` : ''}\n\n<conversation>\n${transcript}\n</conversation>`;
    this.deps.ui.startThinking();
    let result;
    try {
      result = await this.deps.client.chat({
        model: this.config.smallModel ?? this.model,
        messages: [{ role: 'user', content: prompt }],
        signal,
      });
    } finally {
      this.deps.ui.stopThinking();
    }
    this.recordUsage(result.usage);
    this._lastPromptTokens = 0;
    this.messages = [
      { role: 'user', content: `This conversation was compacted to save context. Summary of everything so far:\n\n${result.content}` },
      { role: 'assistant', content: 'Understood. I have the context from the summary and will continue from there.' },
    ];
  }
}

export function renderForTranscript(m: Message): string {
  const text = messageText(m);
  const clip = (s: string) => (s.length > 4000 ? `${s.slice(0, 4000)}… [truncated]` : s);
  if (m.role === 'tool') return `[tool result]\n${clip(text)}`;
  if (m.role === 'assistant') {
    const calls = (m.tool_calls ?? []).map((c) => `[tool call] ${c.function.name} ${clip(c.function.arguments)}`).join('\n');
    return `[assistant]\n${text}${calls ? `\n${calls}` : ''}`;
  }
  return `[${m.role}]\n${clip(text)}`;
}

/** The text of a message, with images shown as a placeholder. */
export function messageText(m: Message): string {
  if (typeof m.content === 'string') return m.content;
  return (m.content ?? []).map((p) => (p.type === 'text' ? p.text : '[image]')).join('\n');
}
