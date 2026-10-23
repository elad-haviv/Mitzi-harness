// Voice: reading answers aloud (server text-to-speech or the browser's voices) and listening
// for live mode (the browser's speech recognition, or recording + server transcription).
import { useEffect, useState } from 'react';
import { api } from './api';

/** Turns markdown into plain text that sounds right when spoken. */
export function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' (code block omitted) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\|?\s*:?-{3,}.*$/gm, '')
    .replace(/\|/g, ', ')
    .replace(/(\*\*|__|\*|_|~~)(.+?)\1/g, '$2')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{2,}/g, '.\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

export interface VoicePrefs {
  /** Browser voice name; empty = the system default. */
  voice: string;
  rate: number;
}

const PREFS_KEY = 'mitzi.voicePrefs';

export function loadVoicePrefs(): VoicePrefs {
  try {
    return { voice: '', rate: 1, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') };
  } catch {
    return { voice: '', rate: 1 };
  }
}

export function saveVoicePrefs(p: VoicePrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    // Not persisted.
  }
}

export function browserVoices(): SpeechSynthesisVoice[] {
  return typeof speechSynthesis === 'undefined' ? [] : speechSynthesis.getVoices();
}

type Listener = (id: string | null) => void;

/** Plays one thing at a time; components subscribe to know what is speaking. */
class Speaker {
  current: string | null = null;
  /** Server speech is used when Settings → Media & voice has a speech model. */
  useServer = false;
  private audio?: HTMLAudioElement;
  private listeners = new Set<Listener>();
  private token = 0;

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private set(id: string | null) {
    this.current = id;
    for (const l of this.listeners) l(id);
  }

  stop(): void {
    this.token++;
    this.audio?.pause();
    this.audio = undefined;
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    this.set(null);
  }

  /** Speaks text; resolves when it finishes or is stopped. */
  async speak(id: string, markdown: string): Promise<void> {
    this.stop();
    const token = this.token;
    const text = stripMarkdown(markdown);
    if (!text) return;
    this.set(id);
    try {
      if (this.useServer) await this.playServer(text, token);
      else await this.playBrowser(text, token);
    } finally {
      if (token === this.token) this.set(null);
    }
  }

  private async playServer(text: string, token: number): Promise<void> {
    // Long answers are spoken in chunks so playback starts quickly.
    const chunks = chunk(text, 1200);
    let next = api.tts(chunks[0]);
    for (let i = 0; i < chunks.length; i++) {
      const blob = await next;
      if (token !== this.token) return;
      if (i + 1 < chunks.length) next = api.tts(chunks[i + 1]);
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      this.audio = audio;
      await new Promise<void>((resolve) => {
        audio.onended = audio.onerror = audio.onpause = () => resolve();
        void audio.play().catch(() => resolve());
      });
      URL.revokeObjectURL(url);
      if (token !== this.token) return;
    }
  }

  private playBrowser(text: string, token: number): Promise<void> {
    if (typeof speechSynthesis === 'undefined') return Promise.reject(new Error('This browser cannot read text aloud'));
    const prefs = loadVoicePrefs();
    const voice = browserVoices().find((v) => v.name === prefs.voice);
    // Chrome stops long utterances after ~15s, so speak sentence groups one after another.
    const parts = chunk(text, 220);
    return new Promise((resolve) => {
      let i = 0;
      const speakNext = () => {
        if (token !== this.token || i >= parts.length) return resolve();
        const u = new SpeechSynthesisUtterance(parts[i++]);
        if (voice) u.voice = voice;
        u.rate = prefs.rate;
        u.onend = speakNext;
        u.onerror = () => resolve();
        speechSynthesis.speak(u);
      };
      speakNext();
    });
  }
}

function chunk(text: string, size: number): string[] {
  const sentences = text.match(/[^.!?\n]+[.!?\n]*\s*/g) ?? [text];
  const out: string[] = [];
  let cur = '';
  for (const s of sentences) {
    if (cur && cur.length + s.length > size) {
      out.push(cur);
      cur = '';
    }
    cur += s;
  }
  if (cur.trim()) out.push(cur);
  return out.length ? out : [text];
}

export const speaker = new Speaker();

/** Whether the given id is currently being spoken. */
export function useSpeaking(id: string): boolean {
  const [current, setCurrent] = useState(speaker.current);
  useEffect(() => speaker.subscribe(setCurrent), []);
  return current === id;
}

// ---------- Listening ----------

export interface ListenHandle {
  stop(): void;
}

export interface ListenCallbacks {
  onInterim?(text: string): void;
  /** Called once with the final transcript (empty when nothing was heard). */
  onFinal(text: string): void;
  onError(message: string): void;
  /** Mic level 0–1, for the orb. */
  onLevel?(level: number): void;
}

type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null;
  onend: (() => void) | null;
};

export function hasBrowserRecognition(): boolean {
  return typeof window !== 'undefined' && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
}

/** Listens for one utterance and ends after a pause. */
export function listen(cb: ListenCallbacks, opts: { preferServer: boolean }): ListenHandle {
  if (hasBrowserRecognition() && !opts.preferServer) return listenBrowser(cb);
  return listenRecorder(cb);
}

function listenBrowser(cb: ListenCallbacks): ListenHandle {
  const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  const rec: Recognition = new Ctor();
  rec.lang = navigator.language || 'en-US';
  rec.interimResults = true;
  rec.continuous = false;
  let final = '';
  let done = false;
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) final += r[0].transcript;
      else interim += r[0].transcript;
    }
    cb.onInterim?.((final + interim).trim());
    cb.onLevel?.(0.6);
  };
  rec.onerror = (e) => {
    if (done) return;
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    done = true;
    cb.onError(e.error === 'not-allowed' ? 'Microphone access was blocked. Allow it in your browser to use live mode.' : `Speech recognition failed: ${e.error}`);
  };
  rec.onend = () => {
    if (done) return;
    done = true;
    cb.onFinal(final.trim());
  };
  rec.start();
  return { stop: () => rec.stop() };
}

/** Records until about 1.2s of silence, then transcribes on the server. */
function listenRecorder(cb: ListenCallbacks): ListenHandle {
  let stopped = false;
  let stopFn = () => {
    stopped = true;
  };
  void (async () => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      return cb.onError('Microphone access was blocked. Allow it in your browser to use live mode.');
    }
    if (stopped) return stream.getTracks().forEach((t) => t.stop());
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    const recorder = new MediaRecorder(stream);
    const parts: Blob[] = [];
    recorder.ondataavailable = (e) => e.data.size && parts.push(e.data);
    let heard = false;
    let quietSince = Date.now();
    const started = Date.now();
    const timer = setInterval(() => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const v of data) sum += ((v - 128) / 128) ** 2;
      const rms = Math.sqrt(sum / data.length);
      cb.onLevel?.(Math.min(1, rms * 6));
      if (rms > 0.03) {
        heard = true;
        quietSince = Date.now();
      }
      const silentFor = Date.now() - quietSince;
      if ((heard && silentFor > 1200) || (!heard && Date.now() - started > 8000) || Date.now() - started > 60_000) stopFn();
    }, 80);
    stopFn = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      if (recorder.state !== 'inactive') recorder.stop();
    };
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
      if (!heard) return cb.onFinal('');
      const blob = new Blob(parts, { type: recorder.mimeType || 'audio/webm' });
      const dataUrl = await new Promise<string>((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.readAsDataURL(blob);
      });
      try {
        cb.onFinal((await api.transcribe(dataUrl)).text);
      } catch (err) {
        cb.onError((err as Error).message);
      }
    };
    recorder.start(250);
  })();
  return { stop: () => stopFn() };
}
