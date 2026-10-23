// Realtime voice: a spoken conversation with a speech-to-speech model (OpenAI or Google; see realtime.ts). Each
// finished line is saved to the chat.
import { Mic, MicOff, PhoneOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Call, callGemini, callOpenAI, CallEvents, Line } from '../realtime';
import { VoiceCat } from './VoiceCat';
import { tr } from '../i18n';

type Phase = 'connecting' | 'listening' | 'hearing' | 'speaking' | 'muted' | 'error';

const LABEL: Record<Phase, string> = {
  connecting: tr('Connecting…'),
  listening: tr('Listening'),
  hearing: tr('Hearing you'),
  speaking: tr('Speaking'),
  muted: tr('Muted'),
  error: tr('Something went wrong'),
};

export function RealtimeMode({ chatId, title, emoji, onClose, onSaved }: { chatId: string; title: string; emoji?: string; onClose(): void; onSaved(): void }) {
  const [phase, setPhase] = useState<Phase>('connecting');
  const [error, setError] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [level, setLevel] = useState(0);
  const [voice, setVoice] = useState(0);
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
    let call: Call | undefined;
    let ctx: AudioContext | undefined;
    (async () => {
      try {
        const session = await api.realtimeSession(chatId);
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        if (!alive) return stream.getTracks().forEach((t) => t.stop());
        mic.current = stream;
        ctx = new AudioContext();
        // Level meters: yours for the cat's ears and eyes, Mitzi's for its mouth.
        const mine = ctx.createAnalyser();
        mine.fftSize = 256;
        ctx.createMediaStreamSource(stream).connect(mine);
        let out: AnalyserNode | undefined;
        const buf = new Uint8Array(mine.frequencyBinCount);
        const loudness = (a: AnalyserNode) => {
          a.getByteFrequencyData(buf);
          return Math.min(1, buf.reduce((n, v) => n + v, 0) / buf.length / 80);
        };
        const tick = () => {
          setLevel(muted.current ? 0 : loudness(mine));
          if (out) setVoice(loudness(out));
          meter = requestAnimationFrame(tick);
        };
        tick();
        const events: CallEvents = {
          upsert,
          phase: (p) => alive && setPhase(muted.current && p !== 'speaking' ? 'muted' : p),
          error: (message) => alive && (setError(message), setPhase('error')),
          output: (node) => (out = node),
        };
        call = session.provider === 'google' ? await callGemini(session, stream, ctx, events) : await callOpenAI(session, stream, ctx, events);
        if (!alive) return call.close();
        // Gemini says when it's ready; WebRTC is ready once connected.
        if (session.provider === 'openai') setPhase('listening');
      } catch (err) {
        if (!alive) return;
        setError((err as Error).name === 'NotAllowedError' ? tr('Mitzi needs your microphone. Allow it in the browser and try again.') : (err as Error).message);
        setPhase('error');
      }
    })();
    return () => {
      alive = false;
      if (meter) cancelAnimationFrame(meter);
      call?.close();
      mic.current?.getTracks().forEach((t) => t.stop());
      void ctx?.close();
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
    <div className="live-overlay" role="dialog" aria-label={tr('Voice conversation')}>
      <div className="live-top">
        <span className="live-title">
          {emoji && <span>{emoji}</span>} {title}
        </span>
        <span className="muted small">{tr('Realtime voice · Esc to end')}</span>
      </div>
      <div className="live-center">
        <VoiceCat state={phase === 'muted' ? 'paused' : phase === 'connecting' ? 'starting' : phase} level={level} voice={voice} />
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
            {!recent.length && phase === 'listening' && <p className="muted small">{tr('Just start talking. You can interrupt any time.')}</p>}
          </div>
        )}
      </div>
      <div className="live-controls">
        <button className="live-btn" onClick={toggleMute} disabled={phase === 'connecting' || phase === 'error'} aria-label={muted.current ? tr('Unmute') : tr('Mute')} title={muted.current ? tr('Unmute') : tr('Mute')}>
          {muted.current ? <Mic size={22} /> : <MicOff size={22} />}
        </button>
        <button className="live-btn end" onClick={onClose} aria-label={tr('End voice conversation')} title={tr('End')}>
          <PhoneOff size={22} />
        </button>
      </div>
    </div>
  );
}
