// Media generation and voice through provider APIs. Generated files are stored under
// <data>/media with unguessable names and served at /media/<file>.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROVIDER_PRESETS, ResolvedProvider, RoutingClient, usable } from '../providers.js';
import type { MediaKind, MediaSettings, ProviderKind } from '../shared/types.js';
import { Tool, ToolError } from '../tools/types.js';

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
};

export interface MediaFile {
  url: string;
  path: string;
  mimeType: string;
}

/** Known good choices offered in Settings; any provider:model id can be typed in. */
export const MEDIA_OPTIONS: Record<keyof Omit<MediaSettings, 'voice'>, { id: string; label: string }[]> = {
  imageModel: [
    { id: 'openai:gpt-image-1', label: 'OpenAI GPT Image 1' },
    { id: 'openai:gpt-image-1-mini', label: 'OpenAI GPT Image 1 mini' },
    { id: 'openai:dall-e-3', label: 'OpenAI DALL·E 3' },
    { id: 'google:imagen-4.0-generate-001', label: 'Google Imagen 4' },
    { id: 'google:gemini-2.5-flash-image', label: 'Google Gemini 2.5 Flash Image' },
    { id: 'google/gemini-2.5-flash-image', label: 'Gemini 2.5 Flash Image via OpenRouter' },
  ],
  videoModel: [
    { id: 'openai:sora-2', label: 'OpenAI Sora 2' },
    { id: 'openai:sora-2-pro', label: 'OpenAI Sora 2 Pro' },
    { id: 'google:veo-3.1-generate-preview', label: 'Google Veo 3.1' },
    { id: 'google:veo-3.0-generate-001', label: 'Google Veo 3' },
  ],
  speechModel: [
    { id: 'openai:gpt-4o-mini-tts', label: 'OpenAI GPT-4o mini TTS' },
    { id: 'openai:tts-1', label: 'OpenAI TTS 1' },
    { id: 'elevenlabs:eleven_multilingual_v2', label: 'ElevenLabs Multilingual v2' },
    { id: 'elevenlabs:eleven_flash_v2_5', label: 'ElevenLabs Flash v2.5' },
    { id: 'google:gemini-2.5-flash-preview-tts', label: 'Google Gemini 2.5 Flash TTS' },
    { id: 'google:gemini-2.5-pro-preview-tts', label: 'Google Gemini 2.5 Pro TTS' },
  ],
  soundModel: [{ id: 'elevenlabs:eleven_text_to_sound_v2', label: 'ElevenLabs Sound Effects v2' }],
  musicModel: [{ id: 'elevenlabs:music_v1', label: 'ElevenLabs Music' }],
  realtimeModel: [
    { id: 'openai:gpt-realtime', label: 'OpenAI GPT Realtime' },
    { id: 'openai:gpt-realtime-mini', label: 'OpenAI GPT Realtime mini' },
    { id: 'google:gemini-2.5-flash-native-audio-preview-09-2025', label: 'Google Gemini 2.5 Flash Native Audio' },
    { id: 'google:gemini-live-2.5-flash-preview', label: 'Google Gemini Live 2.5 Flash' },
  ],
  transcribeModel: [
    { id: 'openai:gpt-4o-mini-transcribe', label: 'OpenAI GPT-4o mini Transcribe' },
    { id: 'openai:whisper-1', label: 'OpenAI Whisper' },
    { id: 'groq:whisper-large-v3-turbo', label: 'Groq Whisper large v3 turbo' },
    { id: 'google:gemini-2.5-flash', label: 'Google Gemini 2.5 Flash' },
  ],
};

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';
/** Gemini Live (realtime voice): ephemeral tokens and the WebSocket. Tests point it at a fake. */
const geminiLive = () => (process.env.MITZI_GEMINI_LIVE ?? 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
/** Gemini's prebuilt voices; anything else falls back to Kore. */
const GEMINI_VOICES = new Set(['Kore', 'Puck', 'Charon', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr']);

/** What the browser needs to start a realtime call. */
export type RealtimeSession =
  | { provider: 'openai'; key: string; model: string; callUrl: string; expiresAt?: number }
  | { provider: 'google'; key: string; model: string; url: string; setup: Record<string, unknown>; expiresAt?: number };

/** Providers whose media endpoints follow OpenAI's API (images, speech, transcription). */
function openAiCompatible(kind: ProviderKind): boolean {
  return !['anthropic', 'google', 'openrouter', 'elevenlabs'].includes(kind);
}

export type MediaField = keyof Omit<MediaSettings, 'voice'>;

export interface MediaModel {
  id: string;
  name: string;
  provider: string;
}

/** Which media each provider can do through MediaService, and how to spot those models in its list. */
const KIND_PATTERNS: Partial<Record<MediaField, RegExp>> = {
  imageModel: /(gpt-image|dall-e|imagen|flux|stable-diffusion|sdxl|sd3|grok-\d?-?image|image)/i,
  videoModel: /(sora|veo)/i,
  speechModel: /(tts|speech)/i,
  transcribeModel: /(whisper|transcribe)/i,
  realtimeModel: /realtime|native-audio|(^|[-/:])live\b/i,
};

function supports(kind: ProviderKind, field: MediaField): boolean {
  switch (field) {
    case 'imageModel':
      return kind !== 'anthropic' && kind !== 'elevenlabs';
    case 'videoModel':
      return kind === 'openai' || kind === 'google';
    case 'speechModel':
      return openAiCompatible(kind) || kind === 'elevenlabs' || kind === 'openrouter' || kind === 'google';
    case 'transcribeModel':
      return openAiCompatible(kind) || kind === 'openrouter' || kind === 'google';
    case 'soundModel':
    case 'musicModel':
      return kind === 'elevenlabs';
    case 'realtimeModel':
      return kind === 'openai' || kind === 'google';
  }
}

const label = (id: string) => id.replace(/^models\//, '').replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(new Error('Cancelled'))), { once: true });
  });

/** Wraps raw 16-bit little-endian PCM (what Gemini and OpenRouter return by default) in a WAV header. */
export function pcmToWav(pcm: Buffer, sampleRate = 24_000, channels = 1): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Audio as something a browser can play: PCM gets a WAV header. */
function playable(bytes: Buffer, mimeType: string): { bytes: Buffer; mimeType: string } {
  const type = mimeType.toLowerCase();
  if (!/pcm|l16/.test(type)) return { bytes, mimeType: type.split(';')[0] || 'audio/mpeg' };
  const rate = Number(/rate=(\d+)/.exec(type)?.[1]) || 24_000;
  return { bytes: pcmToWav(bytes, rate), mimeType: 'audio/wav' };
}

async function check(res: Response, what: string): Promise<Response> {
  if (res.ok) return res;
  const text = await res.text().catch(() => '');
  let message = text;
  try {
    const j = JSON.parse(text);
    message = j.error?.message ?? j.detail?.message ?? j.detail ?? j.message ?? text;
  } catch {
    // Raw text.
  }
  throw new ToolError(`${what} failed (HTTP ${res.status}): ${String(message).slice(0, 300)}`);
}

export class MediaService {
  readonly dir: string;

  constructor(
    dataDir: string,
    private readonly router: () => RoutingClient,
    private readonly settings: () => MediaSettings,
  ) {
    this.dir = join(dataDir, 'media');
    mkdirSync(this.dir, { recursive: true });
  }

  save(bytes: Buffer, mimeType: string): MediaFile {
    const ext = EXT[mimeType.split(';')[0]] ?? 'bin';
    const name = `${randomBytes(16).toString('hex')}.${ext}`;
    const path = join(this.dir, name);
    writeFileSync(path, bytes);
    return { url: `/media/${name}`, path, mimeType };
  }

  /** Which media kinds are set up with a model and a usable provider. */
  available(): Record<MediaKind, boolean> {
    const s = this.settings();
    const ok = (id: string) => {
      if (!id) return false;
      try {
        this.resolve(id);
        return true;
      } catch {
        return false;
      }
    };
    return { image: ok(s.imageModel), video: ok(s.videoModel), speech: ok(s.speechModel), sound: ok(s.soundModel), music: ok(s.musicModel) };
  }

  /** The provider (with key) and provider-native model for a media model id. */
  resolve(id: string): { provider: ResolvedProvider; model: string; base: string; key: string } {
    const { provider, model } = this.router().route(id);
    const base = (provider.baseUrl || PROVIDER_PRESETS[provider.kind].baseUrl).replace(/\/+$/, '');
    return { provider, model, base, key: provider.apiKey ?? '' };
  }

  async image(prompt: string, opts: { aspect?: string } = {}, signal?: AbortSignal): Promise<MediaFile> {
    const id = this.settings().imageModel;
    if (!id) throw new ToolError('No image model is set up (Settings → Media & voice).');
    const { provider, model, base, key } = this.resolve(id);
    const aspect = opts.aspect ?? '1:1';
    if (openAiCompatible(provider.kind)) {
      const size = aspect === '16:9' || aspect === '3:2' ? '1536x1024' : aspect === '9:16' || aspect === '2:3' ? '1024x1536' : '1024x1024';
      const res = await check(
        await fetch(`${base}/images/generations`, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model, prompt, n: 1, ...(model.startsWith('dall-e') ? { response_format: 'b64_json', size: size === '1024x1024' ? size : aspect.startsWith('16') ? '1792x1024' : '1024x1792' } : { size }) }),
          signal,
        }),
        'Image generation',
      );
      const json = (await res.json()) as { data?: { b64_json?: string; url?: string }[] };
      const item = json.data?.[0];
      if (item?.b64_json) return this.save(Buffer.from(item.b64_json, 'base64'), 'image/png');
      if (item?.url) return this.save(Buffer.from(await (await fetch(item.url)).arrayBuffer()), 'image/png');
      throw new ToolError('The image API returned no image');
    }
    if (provider.kind === 'google' && model.startsWith('imagen')) {
      const res = await check(
        await fetch(`${GEMINI}/models/${model}:predict`, {
          method: 'POST',
          headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
          body: JSON.stringify({ instances: [{ prompt }], parameters: { sampleCount: 1, aspectRatio: aspect } }),
          signal,
        }),
        'Image generation',
      );
      const p = ((await res.json()) as any).predictions?.[0];
      if (!p?.bytesBase64Encoded) throw new ToolError('No image was returned (the prompt may have been filtered).');
      return this.save(Buffer.from(p.bytesBase64Encoded, 'base64'), p.mimeType ?? 'image/png');
    }
    if (provider.kind === 'google') {
      const res = await check(
        await fetch(`${GEMINI}/models/${model}:generateContent`, {
          method: 'POST',
          headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: aspect } } }),
          signal,
        }),
        'Image generation',
      );
      const parts: any[] = ((await res.json()) as any).candidates?.[0]?.content?.parts ?? [];
      const img = parts.find((p) => p.inlineData ?? p.inline_data);
      const data = img?.inlineData ?? img?.inline_data;
      if (!data?.data) throw new ToolError('No image was returned.');
      return this.save(Buffer.from(data.data, 'base64'), data.mimeType ?? data.mime_type ?? 'image/png');
    }
    if (provider.kind === 'openrouter') {
      const res = await check(
        await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], modalities: ['image', 'text'], image_config: { aspect_ratio: aspect } }),
          signal,
        }),
        'Image generation',
      );
      const msg = ((await res.json()) as any).choices?.[0]?.message;
      const url: string | undefined = msg?.images?.[0]?.image_url?.url ?? msg?.images?.[0]?.imageUrl?.url;
      const m = url && /^data:([^;]+);base64,(.*)$/.exec(url);
      if (!m) throw new ToolError('The model returned no image. Make sure it can output images.');
      return this.save(Buffer.from(m[2], 'base64'), m[1]);
    }
    throw new ToolError(`${provider.name} image generation isn't supported.`);
  }

  async video(prompt: string, opts: { seconds?: number; aspect?: string } = {}, signal?: AbortSignal): Promise<MediaFile> {
    const id = this.settings().videoModel;
    if (!id) throw new ToolError('No video model is set up (Settings → Media & voice).');
    const { provider, model, base, key } = this.resolve(id);
    const portrait = opts.aspect === '9:16';
    const deadline = Date.now() + 15 * 60_000;
    if (provider.kind === 'openai') {
      const form = new FormData();
      form.set('model', model);
      form.set('prompt', prompt);
      const secs = opts.seconds ?? 4;
      form.set('seconds', String(secs <= 4 ? 4 : secs <= 8 ? 8 : 12));
      form.set('size', portrait ? '720x1280' : '1280x720');
      const auth = { authorization: `Bearer ${key}` };
      let job = (await (await check(await fetch(`${base}/videos`, { method: 'POST', headers: auth, body: form, signal }), 'Video generation')).json()) as { id: string; status: string; error?: { message?: string } };
      while (job.status === 'queued' || job.status === 'in_progress') {
        if (Date.now() > deadline) throw new ToolError('Video generation timed out');
        await sleep(5000, signal);
        job = (await (await check(await fetch(`${base}/videos/${job.id}`, { headers: auth, signal }), 'Video status')).json()) as typeof job;
      }
      if (job.status !== 'completed') throw new ToolError(`Video generation failed: ${job.error?.message ?? job.status}`);
      const content = await check(await fetch(`${base}/videos/${job.id}/content`, { headers: auth, signal }), 'Video download');
      return this.save(Buffer.from(await content.arrayBuffer()), 'video/mp4');
    }
    if (provider.kind === 'google') {
      const headers = { 'x-goog-api-key': key, 'content-type': 'application/json' };
      const parameters: Record<string, unknown> = { aspectRatio: portrait ? '9:16' : '16:9' };
      if (opts.seconds) parameters.durationSeconds = Math.min(8, Math.max(4, Math.round(opts.seconds)));
      let op = (await (
        await check(await fetch(`${GEMINI}/models/${model}:predictLongRunning`, { method: 'POST', headers, body: JSON.stringify({ instances: [{ prompt }], parameters }), signal }), 'Video generation')
      ).json()) as any;
      while (!op.done) {
        if (Date.now() > deadline) throw new ToolError('Video generation timed out');
        await sleep(8000, signal);
        op = await (await check(await fetch(`${GEMINI}/${op.name}`, { headers, signal }), 'Video status')).json();
      }
      if (op.error) throw new ToolError(`Video generation failed: ${op.error.message ?? 'unknown error'}`);
      const uri: string | undefined = op.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
      if (!uri) throw new ToolError('No video was returned (the prompt may have been filtered).');
      const file = await check(await fetch(uri, { headers: { 'x-goog-api-key': key }, redirect: 'follow', signal }), 'Video download');
      return this.save(Buffer.from(await file.arrayBuffer()), 'video/mp4');
    }
    throw new ToolError(`${provider.name} video generation isn't supported.`);
  }

  /** Text to speech; also powers read-aloud and live mode. */
  async speech(text: string, voice?: string, signal?: AbortSignal): Promise<{ bytes: Buffer; mimeType: string }> {
    const s = this.settings();
    if (!s.speechModel) throw new ToolError('No speech model is set up (Settings → Media & voice).');
    const { provider, model, base, key } = this.resolve(s.speechModel);
    const v = voice || s.voice;
    if (openAiCompatible(provider.kind)) {
      const res = await check(
        await fetch(`${base}/audio/speech`, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model, input: text.slice(0, 4096), voice: v || 'alloy', response_format: 'mp3' }),
          signal,
        }),
        'Speech',
      );
      return { bytes: Buffer.from(await res.arrayBuffer()), mimeType: 'audio/mpeg' };
    }
    if (provider.kind === 'elevenlabs') {
      // "George", one of ElevenLabs' default voices, unless another voice id is set.
      const voiceId = v || 'JBFqnCBsd6RMkjVDRZzb';
      const res = await check(
        await fetch(`${base}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
          method: 'POST',
          headers: { 'xi-api-key': key, 'content-type': 'application/json' },
          body: JSON.stringify({ text: text.slice(0, 5000), model_id: model }),
          signal,
        }),
        'Speech',
      );
      return { bytes: Buffer.from(await res.arrayBuffer()), mimeType: 'audio/mpeg' };
    }
    if (provider.kind === 'openrouter') {
      // OpenAI's request shape, but voices depend on the model, so the model picks one unless a voice is set.
      const res = await check(
        await fetch(`${base}/audio/speech`, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model, input: text.slice(0, 4096), ...(v ? { voice: v } : {}), response_format: 'mp3' }),
          signal,
        }),
        'Speech',
      );
      return playable(Buffer.from(await res.arrayBuffer()), res.headers.get('content-type') ?? 'audio/mpeg');
    }
    if (provider.kind === 'google') {
      const res = await check(
        await fetch(`${GEMINI}/models/${model}:generateContent`, {
          method: 'POST',
          headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: text.slice(0, 4000) }] }],
            generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: v || 'Kore' } } } },
          }),
          signal,
        }),
        'Speech',
      );
      const parts: any[] = ((await res.json()) as any).candidates?.[0]?.content?.parts ?? [];
      const data = parts.map((p) => p.inlineData ?? p.inline_data).find(Boolean);
      if (!data?.data) throw new ToolError('Gemini returned no audio. Make sure the speech model is a TTS model (its name ends in "-tts").');
      return playable(Buffer.from(data.data, 'base64'), data.mimeType ?? data.mime_type ?? 'audio/L16;rate=24000');
    }
    throw new ToolError(`${provider.name} can't do text to speech in Mitzi yet. Pick a speech model from OpenAI, ElevenLabs, Google, OpenRouter or another OpenAI-compatible provider.`);
  }

  async sound(prompt: string, seconds?: number, signal?: AbortSignal): Promise<MediaFile> {
    const id = this.settings().soundModel;
    if (!id) throw new ToolError('No sound-effects model is set up (Settings → Media & voice).');
    const { provider, model, base, key } = this.resolve(id);
    if (provider.kind !== 'elevenlabs') throw new ToolError('Sound effects need ElevenLabs.');
    const res = await check(
      await fetch(`${base}/v1/sound-generation`, {
        method: 'POST',
        headers: { 'xi-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({ text: prompt, ...(model.startsWith('eleven_') ? { model_id: model } : {}), ...(seconds ? { duration_seconds: Math.min(22, Math.max(0.5, seconds)) } : {}) }),
        signal,
      }),
      'Sound generation',
    );
    return this.save(Buffer.from(await res.arrayBuffer()), 'audio/mpeg');
  }

  async music(prompt: string, seconds?: number, signal?: AbortSignal): Promise<MediaFile> {
    const id = this.settings().musicModel;
    if (!id) throw new ToolError('No music model is set up (Settings → Media & voice).');
    const { provider, model, base, key } = this.resolve(id);
    if (provider.kind !== 'elevenlabs') throw new ToolError('Music generation needs ElevenLabs.');
    const res = await check(
      await fetch(`${base}/v1/music`, {
        method: 'POST',
        headers: { 'xi-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, music_length_ms: Math.round(Math.min(300, Math.max(10, seconds ?? 30)) * 1000), model_id: model }),
        signal,
      }),
      'Music generation',
    );
    return this.save(Buffer.from(await res.arrayBuffer()), 'audio/mpeg');
  }

  /** `language` (BCP 47, e.g. "he-IL") helps when known; without it the model detects the language. */
  async transcribe(audio: Buffer, mimeType: string, language?: string): Promise<string> {
    const iso = language?.split('-')[0].toLowerCase();
    const id = this.settings().transcribeModel;
    if (!id) throw new ToolError('No transcription model is set up (Settings → Media & voice).');
    const { provider, model, base, key } = this.resolve(id);
    const format = EXT[mimeType.split(';')[0]] ?? 'webm';
    if (provider.kind === 'openrouter') {
      const res = await check(
        await fetch(`${base}/audio/transcriptions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model, input_audio: { data: audio.toString('base64'), format }, ...(iso ? { language: iso } : {}) }),
        }),
        'Transcription',
      );
      return String(((await res.json()) as { text?: string }).text ?? '').trim();
    }
    if (provider.kind === 'google') {
      const res = await check(
        await fetch(`${GEMINI}/models/${model}:generateContent`, {
          method: 'POST',
          headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ inline_data: { mime_type: mimeType.split(';')[0], data: audio.toString('base64') } }, {
                  text:
                    `Transcribe this recording word for word, in the language that is spoken${iso ? ` (most likely the language with ISO code "${iso}")` : ''} and in its own script. ` +
                    'Never translate. Reply with only the transcript, or nothing if no one speaks.',
                }] }],
          }),
        }),
        'Transcription',
      );
      const parts: any[] = ((await res.json()) as any).candidates?.[0]?.content?.parts ?? [];
      return parts.map((p) => p.text ?? '').join('').trim();
    }
    const form = new FormData();
    form.set('model', model);
    if (iso) form.set('language', iso);
    form.set('file', new Blob([new Uint8Array(audio)], { type: mimeType }), `speech.${format}`);
    const res = await check(await fetch(`${base}/audio/transcriptions`, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form }), 'Transcription');
    return String(((await res.json()) as { text?: string }).text ?? '').trim();
  }

  private catalog?: { key: string; at: number; models: Record<MediaField, MediaModel[]> };

  /** Media models offered by the configured providers, by setting. Listed live where the provider allows it. */
  async models(): Promise<Record<MediaField, MediaModel[]>> {
    const providers = this.router().providers.filter((p) => usable(p));
    const key = JSON.stringify(providers.map((p) => [p.id, p.kind, p.baseUrl, !!p.apiKey]));
    if (this.catalog?.key === key && Date.now() - this.catalog.at < 3600_000) return this.catalog.models;
    const out: Record<MediaField, MediaModel[]> = { imageModel: [], videoModel: [], speechModel: [], soundModel: [], musicModel: [], transcribeModel: [], realtimeModel: [] };
    const add = (field: MediaField, m: MediaModel) => !out[field].some((x) => x.id === m.id) && out[field].push(m);

    await Promise.all(
      providers.map(async (p) => {
        const base = (p.baseUrl || PROVIDER_PRESETS[p.kind].baseUrl).replace(/\/+$/, '');
        const prefix = p.kind === 'openrouter' ? '' : `${p.id}:`;
        const listed: { id: string; name?: string; image?: boolean; speech?: boolean }[] = [];
        try {
          const signal = AbortSignal.timeout(15_000);
          if (p.kind === 'google') {
            const json = (await (await check(await fetch(`${GEMINI}/models?pageSize=1000`, { headers: { 'x-goog-api-key': p.apiKey ?? '' }, signal }), 'Models')).json()) as any;
            for (const m of json.models ?? []) listed.push({ id: String(m.name).replace(/^models\//, ''), name: m.displayName });
          } else if (p.kind === 'elevenlabs') {
            const json = (await (await check(await fetch(`${base}/v1/models`, { headers: { 'xi-api-key': p.apiKey ?? '' }, signal }), 'Models')).json()) as any[];
            for (const m of json ?? []) if (m.can_do_text_to_speech) add('speechModel', { id: `${prefix}${m.model_id}`, name: m.name ?? label(m.model_id), provider: p.name });
          } else if (p.kind !== 'anthropic') {
            const json = (await (await check(await fetch(`${base}/models`, { headers: p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {}, signal }), 'Models')).json()) as any;
            for (const m of json.data ?? []) listed.push({ id: String(m.id), name: m.name, image: m.architecture?.output_modalities?.includes('image') });
            if (p.kind === 'openrouter') {
              // Speech models aren't in the default (text) list.
              const speech = (await (await check(await fetch(`${base}/models?output_modalities=speech`, { headers: p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {}, signal }), 'Models')).json()) as any;
              for (const m of speech.data ?? []) if (!listed.some((x) => x.id === m.id)) listed.push({ id: String(m.id), name: m.name, speech: true });
            }
          }
        } catch {
          // Fall back to the known models below.
        }
        for (const m of listed) {
          const name = (m.name ?? label(m.id)).replace(/^[^:]+:\s*/, '');
          if (p.kind === 'openrouter') {
            if (m.image) add('imageModel', { id: m.id, name, provider: p.name });
            if (m.speech) add('speechModel', { id: m.id, name, provider: p.name });
            continue;
          }
          for (const field of Object.keys(KIND_PATTERNS) as MediaField[]) {
            if (!supports(p.kind, field) || !KIND_PATTERNS[field]!.test(m.id)) continue;
            // "tts" models aren't transcription models and vice versa; Gemini's image *input* models aren't image generators.
            if (field === 'speechModel' && /transcribe|whisper/i.test(m.id)) continue;
            if (field === 'imageModel' && p.kind === 'google' && !/imagen|-image/.test(m.id)) continue;
            add(field, { id: `${prefix}${m.id}`, name, provider: p.name });
          }
        }
        // Known models for providers that can't (or didn't) list them.
        for (const field of Object.keys(MEDIA_OPTIONS) as MediaField[]) {
          if (!supports(p.kind, field)) continue;
          for (const o of MEDIA_OPTIONS[field]) {
            const ownPrefix = p.kind === 'openrouter' ? !/^[a-z0-9-]+:/.test(o.id) : o.id.startsWith(`${p.kind}:`);
            if (!ownPrefix) continue;
            const id = p.kind === 'openrouter' ? o.id : `${prefix}${o.id.slice(p.kind.length + 1)}`;
            // Gemini models transcribe through generateContent, so they don't look like transcription models in the list.
            if (!listed.length || field === 'soundModel' || field === 'musicModel' || (p.kind === 'google' && field === 'transcribeModel')) add(field, { id, name: o.label.replace(/ via OpenRouter$/, ''), provider: p.name });
          }
        }
      }),
    );
    for (const list of Object.values(out)) list.sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
    this.catalog = { key, at: Date.now(), models: out };
    return out;
  }

  /**
   * Starts a realtime voice session: a short-lived key the browser uses to connect to the provider directly
   * (WebRTC), so the real API key never leaves this computer.
   */
  async realtimeSession(instructions: string, voice?: string): Promise<RealtimeSession> {
    const id = this.settings().realtimeModel;
    if (!id) throw new ToolError('No realtime voice model is set up (Settings → Media & voice).');
    const { provider, model, base, key } = this.resolve(id);
    if (provider.kind === 'google') return this.geminiLiveSession(model, key, instructions, voice);
    if (provider.kind !== 'openai') throw new ToolError('Realtime voice works with OpenAI and Google realtime models.');
    const session = {
      type: 'realtime',
      model,
      instructions,
      audio: {
        input: { transcription: { model: 'gpt-4o-mini-transcribe' }, turn_detection: { type: 'semantic_vad' } },
        output: { voice: voice || 'marin' },
      },
    };
    const res = await check(
      await fetch(`${base}/realtime/client_secrets`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ session }),
        signal: AbortSignal.timeout(20_000),
      }),
      'Realtime session',
    );
    const json = (await res.json()) as { value?: string; expires_at?: number; client_secret?: { value: string; expires_at?: number } };
    const secret = json.value ?? json.client_secret?.value;
    if (!secret) throw new ToolError('The provider didn’t return a session key');
    return { provider: 'openai', key: secret, model, callUrl: `${base}/realtime/calls`, expiresAt: json.expires_at ?? json.client_secret?.expires_at };
  }

  /**
   * Gemini Live: a single-use ephemeral token with the model, voice and instructions locked in, so the API key never
   * reaches the browser. The browser opens the WebSocket with it and sends the same setup.
   */
  private async geminiLiveSession(model: string, key: string, instructions: string, voice?: string): Promise<RealtimeSession> {
    const setup = {
      model: `models/${model}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice && GEMINI_VOICES.has(voice) ? voice : 'Kore' } } },
      },
      systemInstruction: { parts: [{ text: instructions }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    };
    const now = Date.now();
    const expireTime = new Date(now + 30 * 60_000).toISOString();
    const res = await check(
      await fetch(`${geminiLive()}/v1alpha/auth_tokens`, {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
        // The call must start within a minute; it can then last until the token expires.
        body: JSON.stringify({ uses: 1, expireTime, newSessionExpireTime: new Date(now + 60_000).toISOString(), bidiGenerateContentSetup: setup }),
        signal: AbortSignal.timeout(20_000),
      }),
      'Realtime session',
    );
    const token = ((await res.json()) as { name?: string }).name;
    if (!token) throw new ToolError('Google didn’t return a session token');
    const ws = geminiLive().replace(/^http/, 'ws');
    return {
      provider: 'google',
      key: token,
      model,
      url: `${ws}/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(token)}`,
      setup,
      expiresAt: Math.floor(Date.parse(expireTime) / 1000),
    };
  }

  exists(name: string): boolean {
    return /^[a-f0-9]{32}\.\w+$/.test(name) && existsSync(join(this.dir, name));
  }
}

const ASPECTS = ['1:1', '16:9', '9:16', '3:2', '2:3', '4:3', '3:4'];

/** Agent tools for whichever media kinds are set up. Results carry a MEDIA: line the UI renders. */
export interface GeneratedMedia {
  kind: 'image' | 'video' | 'audio';
  url: string;
  prompt: string;
  callId?: string;
}

export function mediaTools(media: MediaService, onMedia?: (m: GeneratedMedia) => void): Tool[] {
  const on = media.available();
  const tools: Tool[] = [];
  const result = (kind: string, f: MediaFile, prompt: string, callId?: string) => {
    onMedia?.({ kind: kind === 'image' || kind === 'video' ? kind : 'audio', url: f.url, prompt, callId });
    return `Generated ${kind}; it is already shown to the user in the chat and in their artifacts, so don't embed or link it again in your reply.\nMEDIA: ${f.url} ${f.mimeType}`;
  };
  if (on.image) {
    tools.push({
      name: 'GenerateImage',
      kind: 'read',
      description: 'Generate an image from a detailed text description. Describe subject, style, composition, lighting and colors.',
      parameters: { type: 'object', properties: { prompt: { type: 'string' }, aspect_ratio: { type: 'string', enum: ASPECTS } }, required: ['prompt'] },
      summarize: (a) => a.prompt?.slice(0, 80) ?? '',
      run: async (a, ctx) => result('image', await media.image(String(a.prompt), { aspect: a.aspect_ratio }, ctx.signal), String(a.prompt), ctx.callId),
    });
  }
  if (on.video) {
    tools.push({
      name: 'GenerateVideo',
      // Video is slow and costly, so it asks first.
      kind: 'network',
      description: 'Generate a short video clip (4–12 seconds) from a text description of the scene, action, camera and style. Takes a few minutes.',
      parameters: {
        type: 'object',
        properties: { prompt: { type: 'string' }, seconds: { type: 'integer' }, aspect_ratio: { type: 'string', enum: ['16:9', '9:16'] } },
        required: ['prompt'],
      },
      summarize: (a) => a.prompt?.slice(0, 80) ?? '',
      run: async (a, ctx) => result('video', await media.video(String(a.prompt), { seconds: a.seconds, aspect: a.aspect_ratio }, ctx.signal), String(a.prompt), ctx.callId),
    });
  }
  if (on.speech) {
    tools.push({
      name: 'GenerateSpeech',
      kind: 'read',
      description: 'Turn text into a spoken audio file (narration, voice-over, pronunciation).',
      parameters: { type: 'object', properties: { text: { type: 'string' }, voice: { type: 'string', description: 'Optional voice name or id' } }, required: ['text'] },
      summarize: (a) => a.text?.slice(0, 80) ?? '',
      run: async (a, ctx) => {
        const { bytes, mimeType } = await media.speech(String(a.text), a.voice, ctx.signal);
        return result('speech', media.save(bytes, mimeType), String(a.text), ctx.callId);
      },
    });
  }
  if (on.sound) {
    tools.push({
      name: 'GenerateSound',
      kind: 'read',
      description: 'Generate a sound effect from a description, e.g. "rain on a tin roof with distant thunder".',
      parameters: { type: 'object', properties: { prompt: { type: 'string' }, seconds: { type: 'number' } }, required: ['prompt'] },
      summarize: (a) => a.prompt?.slice(0, 80) ?? '',
      run: async (a, ctx) => result('sound', await media.sound(String(a.prompt), a.seconds, ctx.signal), String(a.prompt), ctx.callId),
    });
  }
  if (on.music) {
    tools.push({
      name: 'GenerateMusic',
      kind: 'read',
      description: 'Compose a piece of music from a description of genre, mood, instruments and structure (10–300 seconds).',
      parameters: { type: 'object', properties: { prompt: { type: 'string' }, seconds: { type: 'number' } }, required: ['prompt'] },
      summarize: (a) => a.prompt?.slice(0, 80) ?? '',
      run: async (a, ctx) => result('music', await media.music(String(a.prompt), a.seconds, ctx.signal), String(a.prompt), ctx.callId),
    });
  }
  return tools;
}
