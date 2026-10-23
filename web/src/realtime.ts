// Realtime voice connections. The server mints a short-lived key; audio goes straight between the browser and the
// provider: OpenAI over WebRTC, Google (Gemini Live) over a WebSocket with raw PCM audio both ways.
import type { RealtimeSessionInfo } from './api';
import { tr } from './i18n';

export interface Line {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  done: boolean;
}

export interface CallEvents {
  /** Adds or changes a transcript line. */
  upsert(id: string, role: Line['role'], change: (l: Line) => Line): void;
  phase(p: 'listening' | 'hearing' | 'speaking'): void;
  error(message: string): void;
  /** Mitzi's voice, to measure for the cat's mouth. */
  output(node: AnalyserNode): void;
}

export interface Call {
  close(): void;
}

function analyser(ctx: AudioContext, source: AudioNode): AnalyserNode {
  const a = ctx.createAnalyser();
  a.fftSize = 256;
  source.connect(a);
  return a;
}

// ——— OpenAI: WebRTC, with events on a data channel ———

export async function callOpenAI(session: Extract<RealtimeSessionInfo, { provider: 'openai' }>, mic: MediaStream, ctx: AudioContext, ev: CallEvents): Promise<Call> {
  const audio = new Audio();
  audio.autoplay = true;
  const peer = new RTCPeerConnection();
  peer.ontrack = (e) => {
    audio.srcObject = e.streams[0];
    ev.output(analyser(ctx, ctx.createMediaStreamSource(e.streams[0])));
  };
  mic.getTracks().forEach((t) => peer.addTrack(t, mic));
  const events = peer.createDataChannel('oai-events');
  events.onmessage = (m) => {
    const e = JSON.parse(m.data);
    switch (e.type) {
      case 'input_audio_buffer.speech_started':
        ev.phase('hearing');
        if (e.item_id) ev.upsert(e.item_id, 'user', (l) => l);
        break;
      case 'input_audio_buffer.speech_stopped':
        ev.phase('listening');
        break;
      case 'conversation.item.input_audio_transcription.delta':
        ev.upsert(e.item_id, 'user', (l) => ({ ...l, text: l.text + (e.delta ?? '') }));
        break;
      case 'conversation.item.input_audio_transcription.completed':
        ev.upsert(e.item_id, 'user', (l) => ({ ...l, text: e.transcript ?? l.text, done: true }));
        break;
      case 'conversation.item.input_audio_transcription.failed':
        ev.upsert(e.item_id, 'user', (l) => ({ ...l, done: true }));
        break;
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta':
        ev.phase('speaking');
        ev.upsert(e.item_id, 'assistant', (l) => ({ ...l, text: l.text + (e.delta ?? '') }));
        break;
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
        ev.upsert(e.item_id, 'assistant', (l) => ({ ...l, text: e.transcript ?? l.text, done: true }));
        break;
      case 'response.done':
        ev.phase('listening');
        break;
      case 'error':
        ev.error(e.error?.message ?? tr('The voice service reported an error'));
        break;
    }
  };
  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  const res = await fetch(session.callUrl, { method: 'POST', body: offer.sdp, headers: { authorization: `Bearer ${session.key}`, 'content-type': 'application/sdp' } });
  if (!res.ok) {
    peer.close();
    throw new Error(tr('The voice service refused the call ({0}): {1}', res.status, (await res.text()).slice(0, 200)));
  }
  await peer.setRemoteDescription({ type: 'answer', sdp: await res.text() });
  return {
    close() {
      peer.close();
      audio.srcObject = null;
    },
  };
}

// ——— Google: Gemini Live over a WebSocket ———

/** Passes the microphone's samples to the page as they come. */
const CAPTURE = `class MitziCapture extends AudioWorkletProcessor {
  process(inputs) { const ch = inputs[0] && inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true; }
}
registerProcessor('mitzi-capture', MitziCapture);`;

const IN_RATE = 16000;
const OUT_RATE = 24000;

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Float samples at `from` Hz to 16-bit PCM at `to` Hz (linear interpolation). */
export function toPcm16(samples: Float32Array, from: number, to: number): Uint8Array {
  const n = Math.floor((samples.length * to) / from);
  const out = new DataView(new ArrayBuffer(n * 2));
  for (let i = 0; i < n; i++) {
    const pos = (i * from) / to;
    const j = Math.floor(pos);
    const v = samples[j] + ((samples[Math.min(j + 1, samples.length - 1)] ?? samples[j]) - samples[j]) * (pos - j);
    out.setInt16(i * 2, Math.max(-1, Math.min(1, v)) * 0x7fff, true);
  }
  return new Uint8Array(out.buffer);
}

export async function callGemini(session: Extract<RealtimeSessionInfo, { provider: 'google' }>, mic: MediaStream, ctx: AudioContext, ev: CallEvents): Promise<Call> {
  const socket = new WebSocket(session.url);
  // Listen for the connection right away: it can open while the microphone is still being set up.
  const opened = new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error(tr('Couldn’t reach the voice service')));
  });
  const player = new AudioContext({ sampleRate: OUT_RATE });
  const gain = player.createGain();
  gain.connect(player.destination);
  ev.output(analyser(player as unknown as AudioContext, gain));
  const playing = new Set<AudioBufferSourceNode>();
  let playAt = 0;
  let turn = 0;
  let ready = false;
  let closed = false;

  const stopPlayback = () => {
    for (const s of playing) s.stop();
    playing.clear();
    playAt = 0;
  };
  const play = (base64: string) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    const samples = new Float32Array(bytes.length / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 0x8000;
    const buffer = player.createBuffer(1, samples.length, OUT_RATE);
    buffer.copyToChannel(samples, 0);
    const source = player.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    playAt = Math.max(playAt, player.currentTime);
    source.start(playAt);
    playAt += buffer.duration;
    playing.add(source);
    source.onended = () => {
      playing.delete(source);
      if (!playing.size) ev.phase('listening');
    };
    ev.phase('speaking');
  };

  // The microphone, as 16 kHz PCM in 100 ms chunks.
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([CAPTURE], { type: 'application/javascript' })));
  const capture = new AudioWorkletNode(ctx, 'mitzi-capture');
  const source = ctx.createMediaStreamSource(mic);
  source.connect(capture);
  let pending: Float32Array[] = [];
  let pendingLength = 0;
  capture.port.onmessage = (m) => {
    if (!ready || socket.readyState !== WebSocket.OPEN) return;
    pending.push(m.data as Float32Array);
    pendingLength += (m.data as Float32Array).length;
    if (pendingLength < ctx.sampleRate / 10) return;
    const all = new Float32Array(pendingLength);
    let at = 0;
    for (const p of pending) {
      all.set(p, at);
      at += p.length;
    }
    pending = [];
    pendingLength = 0;
    socket.send(JSON.stringify({ realtimeInput: { audio: { data: toBase64(toPcm16(all, ctx.sampleRate, IN_RATE)), mimeType: `audio/pcm;rate=${IN_RATE}` } } }));
  };

  const onMessage = (msg: any) => {
    if (msg.setupComplete) {
      ready = true;
      ev.phase('listening');
      return;
    }
    const c = msg.serverContent;
    if (!c) return;
    // A new turn's lines get their own ids; the user's line comes first even if its words arrive later.
    if (c.inputTranscription?.text) {
      ev.phase('hearing');
      ev.upsert(`u${turn}`, 'user', (l) => ({ ...l, text: l.text + c.inputTranscription.text }));
    }
    if (c.outputTranscription?.text) {
      ev.upsert(`u${turn}`, 'user', (l) => l);
      ev.upsert(`a${turn}`, 'assistant', (l) => ({ ...l, text: l.text + c.outputTranscription.text }));
    }
    for (const part of c.modelTurn?.parts ?? []) if (part.inlineData?.data && /audio/.test(part.inlineData.mimeType ?? 'audio')) play(part.inlineData.data);
    if (c.interrupted) {
      // You started talking: what it was saying stops where it was.
      stopPlayback();
      ev.upsert(`a${turn}`, 'assistant', (l) => ({ ...l, done: true }));
      ev.phase('hearing');
    }
    if (c.turnComplete) {
      ev.upsert(`u${turn}`, 'user', (l) => ({ ...l, done: true }));
      ev.upsert(`a${turn}`, 'assistant', (l) => ({ ...l, done: true }));
      turn++;
      if (!playing.size) ev.phase('listening');
    }
  };

  await opened;
  socket.send(JSON.stringify({ setup: session.setup }));
  socket.onmessage = (m) => {
    const parse = (text: string) => {
      try {
        onMessage(JSON.parse(text));
      } catch {
        // Not JSON: ignore.
      }
    };
    if (typeof m.data === 'string') parse(m.data);
    else void (m.data as Blob).text().then(parse);
  };
  socket.onclose = (e) => {
    if (closed) return;
    if (e.code !== 1000) ev.error(e.reason ? tr('The voice service ended the call: {0}', e.reason) : tr('The voice service ended the call ({0})', e.code));
  };
  return {
    close() {
      closed = true;
      socket.close();
      capture.port.onmessage = null;
      source.disconnect();
      stopPlayback();
      void player.close();
    },
  };
}
