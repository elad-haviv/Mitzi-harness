import { Mic, MicOff, PhoneOff, SkipForward } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { hasBrowserRecognition, listen, ListenHandle, speaker, stripMarkdown } from '../speech';
import { useApp } from '../state';

type Phase = 'starting' | 'listening' | 'thinking' | 'speaking' | 'paused' | 'error';

const LABEL: Record<Phase, string> = {
  starting: 'Starting…',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  paused: 'Paused',
  error: 'Something went wrong',
};

/**
 * A hands-free conversation: listen → send → speak the answer → listen again.
 * `onSend` sends the transcript as a chat message and resolves to the answer text.
 */
export function LiveMode({
  title,
  emoji,
  onSend,
  onInterrupt,
  onClose,
}: {
  title: string;
  emoji?: string;
  onSend(text: string): Promise<string | undefined>;
  onInterrupt(): void;
  onClose(): void;
}) {
  const { settings } = useApp();
  const [phase, setPhase] = useState<Phase>('starting');
  const [heard, setHeard] = useState('');
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState('');
  const [level, setLevel] = useState(0);
  const listener = useRef<ListenHandle | undefined>(undefined);
  const alive = useRef(true);
  const phaseRef = useRef<Phase>('starting');
  const emptyTurns = useRef(0);
  // The chat behind onSend can change (e.g. once a new chat is created), so always call the latest.
  const sendRef = useRef(onSend);
  sendRef.current = onSend;

  const canTranscribe = !!settings?.media.transcribeModel;
  const go = (p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  };

  const startListening = useCallback(() => {
    if (!alive.current) return;
    if (!hasBrowserRecognition() && !canTranscribe) {
      setError('This browser has no built-in speech recognition. Choose a transcription model in Settings → Media & voice to use live mode here.');
      return go('error');
    }
    go('listening');
    setHeard('');
    setLevel(0);
    listener.current = listen(
      {
        onInterim: setHeard,
        onLevel: setLevel,
        onError: (msg) => {
          if (!alive.current) return;
          setError(msg);
          go('error');
        },
        onFinal: async (text) => {
          listener.current = undefined;
          if (!alive.current || phaseRef.current !== 'listening') return;
          if (!text.trim()) {
            // Keep listening through a few silences, then pause rather than listen forever.
            if (++emptyTurns.current >= 3) return go('paused');
            return startListening();
          }
          emptyTurns.current = 0;
          setHeard(text);
          setAnswer('');
          go('thinking');
          const reply = await sendRef.current(text).catch(() => undefined);
          if (!alive.current || (phaseRef.current as Phase) !== 'thinking') return;
          if (!reply?.trim()) return startListening();
          setAnswer(reply);
          go('speaking');
          await speaker.speak('live', reply).catch((err) => {
            setError((err as Error).message);
          });
          if (alive.current && (phaseRef.current as Phase) === 'speaking') startListening();
        },
      },
      { preferServer: canTranscribe && !hasBrowserRecognition() },
    );
  }, [canTranscribe]);

  useEffect(() => {
    alive.current = true;
    speaker.useServer = !!settings?.media.speechModel;
    startListening();
    return () => {
      alive.current = false;
      listener.current?.stop();
      speaker.stop();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const pause = () => {
    listener.current?.stop();
    listener.current = undefined;
    speaker.stop();
    go('paused');
  };
  /** Cuts the answer short (or stops the request) and listens again. */
  const interrupt = () => {
    if (phaseRef.current === 'thinking') onInterrupt();
    speaker.stop();
    startListening();
  };

  const scale = phase === 'listening' ? 1 + level * 0.35 : 1;
  return (
    <div className="live-overlay" role="dialog" aria-label="Live conversation">
      <div className="live-top">
        <span className="live-title">
          {emoji && <span>{emoji}</span>} {title}
        </span>
        <span className="muted small">Live conversation · Esc to end</span>
      </div>
      <div className="live-center">
        <div className={`live-orb ${phase}`} style={{ transform: `scale(${scale})` }} aria-hidden>
          <span />
        </div>
        <div className="live-phase" aria-live="polite">
          {LABEL[phase]}
        </div>
        {phase === 'error' ? (
          <p className="live-caption error">{error}</p>
        ) : (
          <>
            {heard && <p className="live-caption you">“{heard}”</p>}
            {answer && (phase === 'speaking' || phase === 'paused') && <p className="live-caption">{stripMarkdown(answer).slice(0, 400)}</p>}
            {phase === 'paused' && <p className="muted small">Tap the microphone to keep talking.</p>}
          </>
        )}
      </div>
      <div className="live-controls">
        {phase === 'paused' || phase === 'error' ? (
          <button className="live-btn" onClick={() => (setError(''), startListening())} aria-label="Resume listening" title="Resume">
            <Mic size={22} />
          </button>
        ) : (
          <button className="live-btn" onClick={pause} aria-label="Pause" title="Pause">
            <MicOff size={22} />
          </button>
        )}
        {(phase === 'speaking' || phase === 'thinking') && (
          <button className="live-btn" onClick={interrupt} aria-label="Interrupt" title="Interrupt and talk">
            <SkipForward size={22} />
          </button>
        )}
        <button className="live-btn end" onClick={onClose} aria-label="End live conversation" title="End">
          <PhoneOff size={22} />
        </button>
      </div>
    </div>
  );
}
