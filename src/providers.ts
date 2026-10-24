// Model providers. OpenRouter model ids are used as-is ("anthropic/claude-sonnet-4.5");
// every other provider's models are prefixed with its id ("openai:gpt-5", "anthropic:claude-…").
import { AnthropicClient } from './anthropic.js';
import type { Config } from './config.js';
import { ChatRequest, ChatResult, LlmClient, OpenRouterClient, OpenRouterError, StreamHandlers } from './openrouter.js';
import type { ModelInfo, ProviderConfig, ProviderKind, ProviderView } from './shared/types.js';

export interface ProviderPreset {
  name: string;
  baseUrl: string;
  /** Environment variables that can hold the key. */
  env?: string[];
  keyUrl?: string;
  /** Local servers that don't need a key. */
  keyless?: boolean;
  /** False for media-only providers. */
  chat: boolean;
  modelFilter?: (id: string) => boolean;
  reasoningModels?: RegExp;
}

export const PROVIDER_PRESETS: Record<ProviderKind, ProviderPreset> = {
  openrouter: { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', env: ['OPENROUTER_API_KEY'], keyUrl: 'https://openrouter.ai/keys', chat: true },
  openai: {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    env: ['OPENAI_API_KEY'],
    keyUrl: 'https://platform.openai.com/api-keys',
    chat: true,
    modelFilter: (id) =>
      /^(gpt-|o\d|chatgpt-)/.test(id) && !/(audio|realtime|transcribe|tts|image|embedding|instruct|search|moderation|codex|dall-e|whisper|computer-use|deep-research)/.test(id),
    reasoningModels: /^(o\d|gpt-5)/,
  },
  anthropic: { name: 'Anthropic', baseUrl: 'https://api.anthropic.com', env: ['ANTHROPIC_API_KEY'], keyUrl: 'https://console.anthropic.com/settings/keys', chat: true },
  google: {
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    env: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    keyUrl: 'https://aistudio.google.com/apikey',
    chat: true,
    modelFilter: (id) => /^gemini/.test(id) && !/(embedding|tts|image|live|native-audio|aqa)/.test(id),
  },
  xai: { name: 'xAI', baseUrl: 'https://api.x.ai/v1', env: ['XAI_API_KEY'], keyUrl: 'https://console.x.ai', chat: true, modelFilter: (id) => /^grok/.test(id) && !/imag/.test(id) },
  groq: { name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', env: ['GROQ_API_KEY'], keyUrl: 'https://console.groq.com/keys', chat: true, modelFilter: (id) => !/(whisper|tts|guard|orpheus|playai)/.test(id) },
  mistral: { name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', env: ['MISTRAL_API_KEY'], keyUrl: 'https://console.mistral.ai/api-keys', chat: true, modelFilter: (id) => !/(embed|moderation|ocr)/.test(id) },
  deepseek: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', env: ['DEEPSEEK_API_KEY'], keyUrl: 'https://platform.deepseek.com/api_keys', chat: true },
  together: { name: 'Together AI', baseUrl: 'https://api.together.xyz/v1', env: ['TOGETHER_API_KEY'], keyUrl: 'https://api.together.ai/settings/api-keys', chat: true },
  ollama: { name: 'Ollama', baseUrl: 'http://localhost:11434/v1', keyless: true, chat: true },
  lmstudio: { name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', keyless: true, chat: true },
  elevenlabs: { name: 'ElevenLabs', baseUrl: 'https://api.elevenlabs.io', env: ['ELEVENLABS_API_KEY'], keyUrl: 'https://elevenlabs.io/app/settings/api-keys', chat: false },
  custom: { name: 'OpenAI-compatible', baseUrl: '', chat: true },
};

export interface ResolvedProvider extends ProviderConfig {
  keySource?: 'env' | 'config';
}

/** The providers in effect: OpenRouter (the legacy apiKey), configured ones, and any found only in the environment. */
export function resolveProviders(config: Config): ResolvedProvider[] {
  const out: ResolvedProvider[] = [];
  const envKey = (kind: ProviderKind) => PROVIDER_PRESETS[kind].env?.map((e) => process.env[e]).find(Boolean);

  const orEnv = process.env.OPENROUTER_API_KEY;
  out.push({
    id: 'openrouter',
    kind: 'openrouter',
    name: 'OpenRouter',
    apiKey: config.apiKey || undefined,
    baseUrl: config.baseUrl,
    enabled: true,
    keySource: orEnv ? 'env' : config.apiKey ? 'config' : undefined,
  });
  for (const p of config.providers ?? []) {
    if (p.kind === 'openrouter' || out.some((x) => x.id === p.id)) continue;
    const env = envKey(p.kind);
    out.push({ ...p, apiKey: p.apiKey || env, keySource: p.apiKey ? 'config' : env ? 'env' : undefined });
  }
  for (const kind of Object.keys(PROVIDER_PRESETS) as ProviderKind[]) {
    if (kind === 'openrouter' || out.some((p) => p.kind === kind)) continue;
    const env = envKey(kind);
    if (env) out.push({ id: kind, kind, name: PROVIDER_PRESETS[kind].name, apiKey: env, enabled: true, keySource: 'env' });
  }
  return out;
}

export function usable(p: ResolvedProvider): boolean {
  return p.enabled && (!!p.apiKey || !!PROVIDER_PRESETS[p.kind]?.keyless || (p.kind === 'custom' && !!p.baseUrl));
}

export function providerView(p: ResolvedProvider, extra: { error?: string; modelCount?: number } = {}): ProviderView {
  const { apiKey, ...rest } = p;
  return { ...rest, hasKey: !!apiKey, ...extra };
}

/** Dispatches each request to the provider named by the model id's prefix. */
export class RoutingClient implements LlmClient {
  private readonly clients = new Map<string, LlmClient>();
  /** Errors from the last listModels(), by provider id. */
  readonly errors = new Map<string, string>();
  readonly counts = new Map<string, number>();
  /** Called before every chat call; throws to refuse it (the budget's hard stop). */
  beforeChat?: (req: ChatRequest) => string | void;
  /** Told about every chat call's token usage (for the usage log). */
  onUsage?: (model: string, usage: ChatResult['usage']) => void;

  constructor(readonly providers: ResolvedProvider[]) {}

  private client(p: ResolvedProvider): LlmClient {
    let c = this.clients.get(p.id);
    if (c) return c;
    const preset = PROVIDER_PRESETS[p.kind] ?? PROVIDER_PRESETS.custom;
    const baseUrl = (p.baseUrl || preset.baseUrl).replace(/\/+$/, '');
    if (p.kind === 'anthropic') c = new AnthropicClient({ apiKey: p.apiKey ?? '', baseUrl, providerId: p.id, providerName: p.name });
    else
      c = new OpenRouterClient({
        apiKey: p.apiKey ?? '',
        baseUrl,
        flavor: p.kind === 'openrouter' ? 'openrouter' : 'openai',
        providerId: p.id,
        providerName: p.name,
        modelFilter: preset.modelFilter,
        reasoningModels: preset.reasoningModels,
      });
    this.clients.set(p.id, c);
    return c;
  }

  /** The provider and provider-native model id for a Mitzi model id. */
  route(model: string): { provider: ResolvedProvider; model: string } {
    const prefixed = this.providers
      .filter((p) => p.kind !== 'openrouter')
      .sort((a, b) => b.id.length - a.id.length)
      .find((p) => model.startsWith(`${p.id}:`));
    const provider = prefixed ?? this.providers.find((p) => p.kind === 'openrouter')!;
    if (!usable(provider)) {
      throw new OpenRouterError(
        provider.enabled ? `Add your ${provider.name} API key in Settings → Providers to use ${model}.` : `${provider.name} is turned off in Settings → Providers.`,
        400,
      );
    }
    return { provider, model: prefixed ? model.slice(prefixed.id.length + 1) : model };
  }

  isOpenRouter(model: string): boolean {
    try {
      return this.route(model).provider.kind === 'openrouter';
    } catch {
      return false;
    }
  }

  async chat(req: ChatRequest, handlers?: StreamHandlers): Promise<ChatResult> {
    // The budget may refuse the request, or send it to another (free) model.
    const id = this.beforeChat?.(req) || req.model;
    const { provider, model } = this.route(id);
    const result = await this.client(provider).chat({ ...req, model }, handlers);
    this.onUsage?.(id, result.usage);
    return result;
  }

  embed(model: string, input: string[]): Promise<number[][]> {
    const { provider, model: id } = this.route(model);
    return this.client(provider).embed(id, input);
  }

  async listModels(): Promise<ModelInfo[]> {
    const chatProviders = this.providers.filter((p) => usable(p) && PROVIDER_PRESETS[p.kind]?.chat !== false);
    const results = await Promise.allSettled(chatProviders.map((p) => this.client(p).listModels()));
    const models: ModelInfo[] = [];
    results.forEach((r, i) => {
      const p = chatProviders[i];
      if (r.status === 'fulfilled') {
        this.errors.delete(p.id);
        this.counts.set(p.id, r.value.length);
        models.push(...r.value.map((m) => ({ ...m, provider: m.provider ?? p.name })));
      } else {
        this.errors.set(p.id, (r.reason as Error).message);
      }
    });
    if (!models.length && this.errors.size) throw new OpenRouterError([...this.errors.values()][0]);
    return models;
  }
}
