// The feedback loop: rate a result, tell the bot what you meant and what it did, have it redo the
// task until you're happy, and let it learn from the whole exchange.
import { Brain, Check, ListChecks, Loader2, RotateCcw, Star, Target } from 'lucide-react';
import { useState } from 'react';
import { api, ChatMessage, FeedbackLoop } from '../api';
import { useApp } from '../state';
import { useChatActions } from './Work';

const LABELS = ['', 'Way off', 'Not right', 'Close', 'Good', 'Exactly right'];

export function Stars({ value, onChange, size = 18 }: { value: number; onChange?(v: number): void; size?: number }) {
  const [hover, setHover] = useState(0);
  const shown = hover || value;
  return (
    <span className="stars" role={onChange ? 'radiogroup' : undefined} aria-label={`${value} of 5`} onMouseLeave={() => setHover(0)}>
      {[1, 2, 3, 4, 5].map((n) =>
        onChange ? (
          <button key={n} type="button" role="radio" aria-checked={value === n} aria-label={`${n}: ${LABELS[n]}`} className={n <= shown ? 'on' : ''} onMouseEnter={() => setHover(n)} onClick={() => onChange(n)}>
            <Star size={size} />
          </button>
        ) : (
          <Star key={n} size={size} className={n <= shown ? 'on' : ''} />
        ),
      )}
    </span>
  );
}

/** Review under an answer: rate it, and either accept it or have it redone with directions. */
export function ReviewBox({ index, loop, onDone }: { index: number; loop?: FeedbackLoop; onDone(): void }) {
  const actions = useChatActions();
  const { toast } = useApp();
  const previous = loop?.iterations.find((it) => it.messageIndex === index);
  const [rating, setRating] = useState(previous?.rating ?? 0);
  const [meant, setMeant] = useState(previous?.meant ?? '');
  const [did, setDid] = useState(previous?.did ?? '');
  const [directions, setDirections] = useState(previous?.directions ?? '');
  const [busy, setBusy] = useState<'redo' | 'save'>();
  const chatId = actions?.chat?.id;
  if (!chatId) return null;
  const wantsRedo = rating > 0 && rating <= 3;

  const submit = async (redo: boolean) => {
    setBusy(redo ? 'redo' : 'save');
    try {
      const res = await api.review(chatId, index, { rating, meant, did, directions, redo });
      if (redo && res.redo) actions.sendAuto(res.redo, 'redo', res.loop.id);
      else if (res.loop.status === 'accepted') {
        toast(res.loop.iterations.length > 1 ? 'Glad it worked out. Mitzi is turning your directions into a lesson for next time.' : 'Thanks! Saved as a good result.', 'info');
        setTimeout(() => actions.reload(), 4000);
      }
      actions.reload();
      onDone();
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="review-box">
      <div className="review-row">
        <span className="review-label">How well did this do the task?</span>
        <Stars value={rating} onChange={setRating} />
        {rating > 0 && <span className="muted small">{LABELS[rating]}</span>}
      </div>
      {wantsRedo && (
        <div className="review-fields">
          <label>
            <span>What did you mean?</span>
            <textarea className="textarea" rows={2} value={meant} onChange={(e) => setMeant(e.target.value)} placeholder="The result you had in mind" />
          </label>
          <label>
            <span>What did it do instead?</span>
            <textarea className="textarea" rows={2} value={did} onChange={(e) => setDid(e.target.value)} placeholder="What missed the mark" />
          </label>
          <label>
            <span>Directions for the redo</span>
            <textarea className="textarea" rows={2} value={directions} onChange={(e) => setDirections(e.target.value)} placeholder="Concrete changes: keep it under a page, use a table, friendlier tone…" />
          </label>
        </div>
      )}
      <div className="review-actions">
        {wantsRedo ? (
          <>
            <button className="btn btn-primary btn-sm" disabled={!!busy || actions.running || !(meant || did || directions).trim()} onClick={() => void submit(true)}>
              {busy === 'redo' ? <Loader2 size={13} className="spin" /> : <RotateCcw size={13} />} Redo with these directions
            </button>
            <button className="btn btn-sm btn-ghost" disabled={!!busy} onClick={() => void submit(false)}>
              Just save the rating
            </button>
          </>
        ) : (
          <button className="btn btn-primary btn-sm" disabled={!rating || !!busy} onClick={() => void submit(false)}>
            {busy ? <Loader2 size={13} className="spin" /> : <Check size={13} />} {rating >= 4 ? 'Accept this result' : 'Save'}
          </button>
        )}
        <button className="btn btn-sm btn-ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
      {loop && loop.iterations.length > 0 && (
        <div className="muted small">
          Attempt {loop.iterations.findIndex((it) => it.messageIndex === index) + 1 || loop.iterations.length + 1} on this task. When you accept a result, Mitzi turns your
          directions into a lesson for similar tasks.
        </div>
      )}
    </div>
  );
}

/** A chip on answers that are part of a feedback loop. */
export function LoopBadge({ loop, index }: { loop: FeedbackLoop; index: number }) {
  const n = loop.iterations.findIndex((it) => it.messageIndex === index);
  const it = loop.iterations[n];
  const attempt = n >= 0 ? n + 1 : loop.iterations.length + 1;
  return (
    <div className={`loop-badge ${loop.status}`}>
      <Target size={13} />
      <span>
        Attempt {attempt}
        {it ? <> · rated <Stars value={it.rating} size={11} /></> : loop.status === 'open' ? ' · waiting for your review' : ''}
        {loop.status === 'accepted' && loop.iterations.at(-1)?.messageIndex === index && ' · accepted'}
      </span>
      {loop.lesson && loop.iterations.at(-1)?.messageIndex === index && (
        <span className="loop-lesson" title="Saved to the bot's lessons">
          <Brain size={12} /> {loop.lesson}
        </span>
      )}
    </div>
  );
}

/** User messages Mitzi sent for the user: redo directions, plan approval, goal follow-ups. */
export function AutoMessage({ message }: { message: ChatMessage }) {
  const text = typeof message.content === 'string' ? message.content : '';
  if (message.auto === 'goal') {
    const check = /Last check: ([\s\S]*)$/.exec(text)?.[1];
    return (
      <div className="auto-divider">
        <Target size={13} />
        <span>Goal not met yet{check ? `: ${check}` : ''} · continuing</span>
      </div>
    );
  }
  if (message.auto === 'plan') {
    return (
      <div className="auto-divider">
        <ListChecks size={13} />
        <span>Plan approved · working on it</span>
      </div>
    );
  }
  const lines = text.split('\n\n').slice(1);
  const rating = Number(/rated it (\d)\/5/.exec(text)?.[1] ?? 0);
  return (
    <div className="turn turn-user">
      <div className="redo-card">
        <div className="redo-head">
          <RotateCcw size={14} /> Redo requested {rating > 0 && <Stars value={rating} size={12} />}
        </div>
        {lines.map((l, i) => {
          const m = /^([^:]+): ([\s\S]*)$/.exec(l);
          return m ? (
            <div key={i} className="redo-line">
              <span className="muted">{m[1]}</span> {m[2]}
            </div>
          ) : null;
        })}
      </div>
    </div>
  );
}
