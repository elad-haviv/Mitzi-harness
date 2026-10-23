import { Languages, Mic, MicOff, PhoneOff, SkipForward } from 'lucide-react';
import { VoiceCat } from './VoiceCat';
import { useCallback, useEffect, useRef, useState } from 'react';
import { guessLanguage, languageName, LANGUAGES } from '../languages';
import { hasBrowserRecognition, listen, ListenHandle, loadVoicePrefs, saveVoicePrefs, speaker, stripMarkdown } from '../speech';
import { useApp } from '../state';
import { tr } from '../i18n';

type Phase = 'starting' | 'listening' | 'thinking' | 'speaking' | 'paused' | 'error';

const LABEL: Record<Phase, string> = {
  starting: tr('Starting…'),
  listening: tr('Listening'),
  thinking: tr('Thinking'),
  speaking: tr('Speaking'),
  paused: tr('Paused'),
  error: tr('Something went wrong'),
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
  recentText = '',
}: {
  title: string;
  emoji?: string;
  /** The conversation so far, to guess which language you speak. */
  recentText?: string;
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
  const spoken = useRef<string | undefined>(undefined);
  const alive = useRef(true);
  const phaseRef = useRef<Phase>('starting');
  const emptyTurns = useRef(0);
  // The chat behind onSend can change (e.g. once a new chat is created), so always call the latest.
  const sendRef = useRef(onSend);
  sendRef.current = onSend;

  const canTranscribe = !!settings?.media.transcribeModel;
  // '' = detect: with a transcription model the server detects it; otherwise guess from the chat or the browser.
  const [language, setLanguage] = useState(() => loadVoicePrefs().language);
  const languageRef = useRef(language);
  languageRef.current = language;
  const guessed = guessLanguage(recentText);
  const detecting = !language && canTranscribe;
  const listeningIn = language || guessed || navigator.language || 'en-US';
  const go = (p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  };

  const startListening = useCallback(() => {
    if (!alive.current) return;
    if (!hasBrowserRecognition() && !canTranscribe) {
      setError(tr('This browser has no built-in speech recognition. Choose a transcription model in Settings → Media & voice to use live mode here.'));
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
          // Answer in the voice of the language just spoken.
          spoken.current = guessLanguage(text) ?? (languageRef.current || guessed || undefined);
          setHeard(text);
          setAnswer('');
          go('thinking');
          const reply = await sendRef.current(text).catch(() => undefined);
          if (!alive.current || (phaseRef.current as Phase) !== 'thinking') return;
          if (!reply?.trim()) return startListening();
          setAnswer(reply);
          go('speaking');
          await speaker.speak('live', reply, spoken.current).catch((err) => {
            setError((err as Error).message);
          });
          if (alive.current && (phaseRef.current as Phase) === 'speaking') startListening();
        },
      },
      // The browser's recognizer hears one language only; the server's model detects it.
      { preferServer: canTranscribe && (!hasBrowserRecognition() || !languageRef.current), language: languageRef.current || (canTranscribe ? '' : guessed || '') },
    );
  }, [canTranscribe, guessed]);

  const changeLanguage = (code: string) => {
    setLanguage(code);
    languageRef.current = code;
    saveVoicePrefs({ ...loadVoicePrefs(), language: code });
    // Start over in the new language.
    listener.current?.stop();
    listener.current = undefined;
    speaker.stop();
    setError('');
    setTimeout(startListening, 50);
  };

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

  return (
    <div className="live-overlay" role="dialog" aria-label={tr('Live conversation')}>
      <div className="live-top">
        <span className="live-title">
          {emoji && <span>{emoji}</span>} {title}
        </span>
        <label className="live-lang" title={detecting ? tr('Your transcription model detects the language you speak') : tr('The language you speak')}>
          <Languages size={15} />
          <select value={language} onChange={(e) => changeLanguage(e.target.value)} aria-label={tr('Language you speak')}>
            <option value="">{detecting ? tr('Detect language') : tr('Auto ({0})', languageName(listeningIn))}</option>
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <span className="muted small">{tr('Live conversation · Esc to end')}</span>
      </div>
      <div className="live-center">
        <VoiceCat state={phase === 'listening' && level > 0.12 ? 'hearing' : phase} level={level} />
        <div className="live-phase" aria-live="polite">
          {LABEL[phase]}
        </div>
        {phase === 'error' ? (
          <p className="live-caption error">{error}</p>
        ) : (
          <>
            {heard && (
              <p className="live-caption you" dir="auto">
                “{heard}”
              </p>
            )}
            {answer && (phase === 'speaking' || phase === 'paused') && (
              <p className="live-caption" dir="auto">
                {stripMarkdown(answer).slice(0, 400)}
              </p>
            )}
            {phase === 'listening' && !detecting && !heard && (
              <p className="muted small live-lang-hint">
                {tr('Listening in {0}. Speaking another language? Choose it above', languageName(listeningIn))}{canTranscribe ? '' : tr(', or set a transcription model in Settings → Media & voice to detect it automatically')}.
              </p>
            )}
            {phase === 'paused' && <p className="muted small">{tr('Tap the microphone to keep talking.')}</p>}
          </>
        )}
      </div>
      <div className="live-controls">
        {phase === 'paused' || phase === 'error' ? (
          <button className="live-btn" onClick={() => (setError(''), startListening())} aria-label={tr('Resume listening')} title={tr('Resume')}>
            <Mic size={22} />
          </button>
        ) : (
          <button className="live-btn" onClick={pause} aria-label={tr('Pause')} title={tr('Pause')}>
            <MicOff size={22} />
          </button>
        )}
        {(phase === 'speaking' || phase === 'thinking') && (
          <button className="live-btn" onClick={interrupt} aria-label={tr('Interrupt')} title={tr('Interrupt and talk')}>
            <SkipForward size={22} />
          </button>
        )}
        <button className="live-btn end" onClick={onClose} aria-label={tr('End live conversation')} title={tr('End')}>
          <PhoneOff size={22} />
        </button>
      </div>
    </div>
  );
}
