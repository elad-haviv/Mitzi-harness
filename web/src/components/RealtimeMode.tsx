// Realtime voice: a spoken conversation with a speech-to-speech model over WebRTC. The server mints a short-lived
// key; audio goes straight between the browser and the provider. Each finished exchange is saved to the chat.
import { Mic, MicOff, PhoneOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

type Phase = 'connecting' | 'listening' | 'hearing' | 'speaking' | 'muted' | 'error';

const LABEL: Record<Phase, string> = {
  connecting: 'Connecting…',
  listening: 'Listening',
  hearing: 'Hearing you',
  speaking: 'Speaking',
  muted: 'Muted',
  error: 'Something went wrong',
};

interface Line {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  done: boolean;
}

export function RealtimeMode({ chatId, title, emoji, onClose, onSaved }: { chatId: string; title: string; emoji?: string; onClose(): void; onSaved(): void }) {
  const [phase, setPhase] = useState<Phase>('connecting');
  const [error, setError] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [level, setLevel] = useState(0);
  const pc = useRef<RTCPeerConnection>(undefined);
  const mic = useRef<MediaStream>(undefined);
  const muted = useRef(false);
  const saved = useRef(new Set<string>());

  // Saves finished lines in order; a user line whose transcript is still coming holds back the ones after it.
  const flush = (all: Line[]) => {
    for (const l of all) {
      if (saved.current.has(l.id)) continue;
      if (!l.done) break;
      saved.current.add(l.id);
      if (l.text.trim()) void api.saveSpoken(chatId, l.role, l.text.trim()).then(onSaved, () => {});
    }
  };
  const upsert = (id: string, role: Line['role'], change: (l: Line) => Line) =>
    setLines((all) => {
      const i = all.findIndex((l) => l.id === id);
      const next = i >= 0 ? all.map((l, j) => (j === i ? change(l) : l)) : [...all, change({ id, role, text: '', done: false })];
      flush(next);
      return next;
    });

  useEffect(() => {
    let alive = true;
    let meter: number | undefined;
    const audio = new Audio();
    audio.autoplay = true;
    (async () => {
      try {
        const session = await api.realtimeSession(chatId);
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        if (!alive) return stream.getTracks().forEach((t) => t.stop());
        mic.current = stream;
        // A level meter for the orb.
        const ctx = new AudioContext();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        ctx.createMediaStreamSource(stream).connect(analyser);
        const buf = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          analyser.getByteFrequencyData(buf);
          setLevel(muted.current ? 0 : Math.min(1, buf.reduce((n, v) => n + v, 0) / buf.length / 80));
          meter = requestAnimationFrame(tick);
        };
        tick();

        const peer = new RTCPeerConnection();
        pc.current = peer;
        peer.ontrack = (e) => (audio.srcObject = e.streams[0]);
        stream.getTracks().forEach((t) => peer.addTrack(t, stream));
        const events = peer.createDataChannel('oai-events');
        events.onmessage = (m) => {
          const e = JSON.parse(m.data);
          switch (e.type) {
            case 'input_audio_buffer.speech_started':
              setPhase('hearing');
              // Interrupting: what was being said stops where it was.
              if (e.item_id) upsert(e.item_id, 'user', (l) => l);
              break;
            case 'input_audio_buffer.speech_stopped':
              setPhase('listening');
              break;
            case 'conversation.item.input_audio_transcription.delta':
              upsert(e.item_id, 'user', (l) => ({ ...l, text: l.text + (e.delta ?? '') }));
              break;
            case 'conversation.item.input_audio_transcription.completed':
              upsert(e.item_id, 'user', (l) => ({ ...l, text: e.transcript ?? l.text, done: true }));
              break;
            case 'conversation.item.input_audio_transcription.failed':
              upsert(e.item_id, 'user', (l) => ({ ...l, done: true }));
              break;
            case 'response.output_audio_transcript.delta':
            case 'response.audio_transcript.delta':
              setPhase('speaking');
              upsert(e.item_id, 'assistant', (l) => ({ ...l, text: l.text + (e.delta ?? '') }));
              break;
            case 'response.output_audio_transcript.done':
            case 'response.audio_transcript.done':
              upsert(e.item_id, 'assistant', (l) => ({ ...l, text: e.transcript ?? l.text, done: true }));
              break;
            case 'response.done':
              setPhase(muted.current ? 'muted' : 'listening');
              break;
            case 'error':
              setError(e.error?.message ?? 'The voice service reported an error');
              break;
          }
        };
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        const res = await fetch(session.callUrl, { method: 'POST', body: offer.sdp, headers: { authorization: `Bearer ${session.key}`, 'content-type': 'application/sdp' } });
        if (!res.ok) throw new Error(`The voice service refused the call (${res.status}): ${(await res.text()).slice(0, 200)}`);
        await peer.setRemoteDescription({ type: 'answer', sdp: await res.text() });
        if (alive) setPhase('listening');
      } catch (err) {
        if (!alive) return;
        setError((err as Error).name === 'NotAllowedError' ? 'Mitzi needs your microphone. Allow it in the browser and try again.' : (err as Error).message);
        setPhase('error');
      }
    })();
    return () => {
      alive = false;
      if (meter) cancelAnimationFrame(meter);
      pc.current?.close();
      mic.current?.getTracks().forEach((t) => t.stop());
      audio.srcObject = null;
    };
  }, [chatId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggleMute = () => {
    muted.current = !muted.current;
    mic.current?.getAudioTracks().forEach((t) => (t.enabled = !muted.current));
    setPhase(muted.current ? 'muted' : 'listening');
  };

  const recent = lines.filter((l) => l.text.trim()).slice(-4);
  return (
    <div className="live-overlay" role="dialog" aria-label="Voice conversation">
      <div className="live-top">
        <span className="live-title">
          {emoji && <span>{emoji}</span>} {title}
        </span>
        <span className="muted small">Realtime voice · Esc to end</span>
      </div>
      <div className="live-center">
        <div className={`live-orb ${phase === 'hearing' ? 'listening' : phase === 'muted' ? 'paused' : phase === 'connecting' ? 'starting' : phase}`} style={{ transform: `scale(${1 + level * 0.35})` }} aria-hidden>
          <span />
        </div>
        <div className="live-phase" aria-live="polite">
          {LABEL[phase]}
        </div>
        {phase === 'error' || error ? (
          <p className="live-caption error">{error}</p>
        ) : (
          <div className="realtime-transcript">
            {recent.map((l) => (
              <p key={l.id} className={`live-caption${l.role === 'user' ? ' you' : ''}`} dir="auto">
                {l.role === 'user' ? `“${l.text}”` : l.text}
              </p>
            ))}
            {!recent.length && phase === 'listening' && <p className="muted small">Just start talking. You can interrupt any time.</p>}
          </div>
        )}
      </div>
      <div className="live-controls">
        <button className="live-btn" onClick={toggleMute} disabled={phase === 'connecting' || phase === 'error'} aria-label={muted.current ? 'Unmute' : 'Mute'} title={muted.current ? 'Unmute' : 'Mute'}>
          {muted.current ? <Mic size={22} /> : <MicOff size={22} />}
        </button>
        <button className="live-btn end" onClick={onClose} aria-label="End voice conversation" title="End">
          <PhoneOff size={22} />
        </button>
      </div>
    </div>
  );
}
