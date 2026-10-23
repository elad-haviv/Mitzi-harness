import { Columns2, Loader2, Trophy, XCircle } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api';
import { Markdown } from './Markdown';

/** Live state of a /compare race, fed by compare_* stream events. */
export interface CompareState {
  modelA: string;
  modelB: string;
  prompt: string;
  textA: string;
  textB: string;
  doneA?: string; // undefined until side A ends; holds the error when it failed
  doneB?: string;
  errorA?: string;
  errorB?: string;
  /** Set once compare_pick arrived: show the picker. */
  picking: boolean;
  /** Set after the user picked, so the buttons disable. */
  picked?: 'A' | 'B' | 'skip';
}

export function applyCompareEvent(state: CompareState | undefined, e: { type: string; [k: string]: any }): CompareState | undefined {
  switch (e.type) {
    case 'compare_start':
      return { modelA: e.modelA, modelB: e.modelB, prompt: e.prompt, textA: '', textB: '', picking: false };
    case 'compare_text':
      if (!state) return state;
      return e.side === 'A' ? { ...state, textA: state.textA + e.text } : { ...state, textB: state.textB + e.text };
    case 'compare_end':
      if (!state) return state;
      return e.side === 'A' ? { ...state, doneA: e.error ?? '', errorA: e.error } : { ...state, doneB: e.error ?? '', errorB: e.error };
    case 'compare_pick':
      return state ? { ...state, picking: true } : state;
    default:
      return state;
  }
}

function Side({ label, model, text, done, error, winner }: { label: string; model: string; text: string; done: boolean; error?: string; winner?: boolean }) {
  return (
    <div className={`compare-side${winner ? ' winner' : ''}`}>
      <div className="compare-head">
        <span className="compare-badge">{label}</span>
        <code className="compare-model" title={model}>{model}</code>
        {winner && <Trophy size={13} className="compare-trophy" aria-label="Winner" />}
        {!done && <Loader2 size={13} className="spin muted" />}
      </div>
      <div className="compare-body">
        {error ? (
          <div className="compare-error">
            <XCircle size={14} /> {error}
          </div>
        ) : text ? (
          <Markdown text={text} />
        ) : (
          <span className="muted small">Waiting for {model}…</span>
        )}
      </div>
    </div>
  );
}

export function CompareView({ chatId, state, onPicked }: { chatId: string; state: CompareState; onPicked(choice: 'A' | 'B' | 'skip'): void }) {
  const [busy, setBusy] = useState(false);
  const pick = async (choice: 'A' | 'B' | 'skip') => {
    if (busy || state.picked) return;
    setBusy(true);
    try {
      await api.comparePick(chatId, choice);
      onPicked(choice);
    } finally {
      setBusy(false);
    }
  };
  const showPicker = state.picking && !state.picked;
  const bothFailed = state.errorA !== undefined && state.errorB !== undefined && state.doneA !== undefined && state.doneB !== undefined;
  return (
    <div className="compare">
      <div className="compare-title">
        <Columns2 size={14} />
        <span>Comparing two models</span>
      </div>
      <div className="compare-grid">
        <Side label="A" model={state.modelA} text={state.textA} done={state.doneA !== undefined} error={state.errorA} winner={state.picked === 'A'} />
        <Side label="B" model={state.modelB} text={state.textB} done={state.doneB !== undefined} error={state.errorB} winner={state.picked === 'B'} />
      </div>
      {showPicker && !bothFailed && (
        <div className="compare-pick" role="group" aria-label="Pick the winner">
          <span className="small">Which answer is better?</span>
          <button className="pill-btn" disabled={busy || state.errorA !== undefined} onClick={() => void pick('A')}>
            A {state.errorA === undefined ? 'wins' : ''}
          </button>
          <button className="pill-btn" disabled={busy || state.errorB !== undefined} onClick={() => void pick('B')}>
            B {state.errorB === undefined ? 'wins' : ''}
          </button>
          <button className="pill-btn" disabled={busy} onClick={() => void pick('skip')}>
            skip
          </button>
        </div>
      )}
      {state.picked && state.picked !== 'skip' && <div className="small muted">Picked {state.picked === 'A' ? state.modelA : state.modelB} — kept as this turn's answer.</div>}
      {state.picked === 'skip' && <div className="small muted">Skipped — neither answer was kept.</div>}
    </div>
  );
}
