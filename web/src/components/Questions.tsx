// A bot's questions to the user: options to click (one or several), or an answer in the user's own words.
import { Check, MessageCircleQuestion } from 'lucide-react';
import { useState } from 'react';
import type { AskQuestion } from '../api';

export interface QuestionRequest {
  requestId: string;
  callId?: string;
  questions: AskQuestion[];
}

/** Answers are kept per question: the labels picked, or the user's own text. */
type Draft = { picked: string[]; other: string };

export function QuestionCard({ req, onAnswer }: { req: QuestionRequest; onAnswer(answers: string[][] | null): void }) {
  const [drafts, setDrafts] = useState<Draft[]>(() => req.questions.map(() => ({ picked: [], other: '' })));
  const [busy, setBusy] = useState(false);
  const answers = drafts.map((d) => (d.other.trim() ? [...d.picked, d.other.trim()] : d.picked));
  const complete = answers.every((a) => a.length > 0);
  // One single-choice question answers with one click.
  const instant = req.questions.length === 1 && !req.questions[0].multiSelect && !!req.questions[0].options?.length;

  const send = (a: string[][] | null) => {
    setBusy(true);
    onAnswer(a);
  };
  const update = (i: number, change: (d: Draft) => Draft) => setDrafts((all) => all.map((d, j) => (j === i ? change(d) : d)));
  const pick = (i: number, label: string) => {
    const q = req.questions[i];
    if (instant) return send([[label]]);
    update(i, (d) => (q.multiSelect ? { ...d, picked: d.picked.includes(label) ? d.picked.filter((l) => l !== label) : [...d.picked, label] } : { picked: [label], other: '' }));
  };

  return (
    <div className="question-card" role="group" aria-label={req.questions.length === 1 ? req.questions[0].question : 'Questions for you'}>
      {req.questions.map((q, i) => (
        <div key={i} className="question">
          <div className="question-head">
            <MessageCircleQuestion size={17} />
            <div>
              {q.header && <span className="question-tag">{q.header}</span>}
              <div className="question-text" dir="auto">
                {q.question}
              </div>
              {q.multiSelect && <div className="muted small">Pick any that apply</div>}
            </div>
          </div>
          {q.options && q.options.length > 0 && (
            <div className="question-options" role={q.multiSelect ? 'group' : 'radiogroup'}>
              {q.options.map((o) => {
                const on = drafts[i].picked.includes(o.label);
                return (
                  <button
                    key={o.label}
                    className={`question-option${on ? ' on' : ''}`}
                    role={q.multiSelect ? 'checkbox' : 'radio'}
                    aria-checked={on}
                    disabled={busy}
                    onClick={() => pick(i, o.label)}
                  >
                    <span className={`question-mark${q.multiSelect ? ' square' : ''}`}>{on && <Check size={11} strokeWidth={3} />}</span>
                    <span>
                      <span className="t" dir="auto">
                        {o.label}
                      </span>
                      {o.description && (
                        <span className="s" dir="auto">
                          {o.description}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          <input
            className="input question-other"
            dir="auto"
            placeholder={q.options?.length ? 'Or answer in your own words…' : 'Your answer…'}
            value={drafts[i].other}
            disabled={busy}
            autoFocus={i === 0 && !q.options?.length}
            onChange={(e) => {
              const other = e.target.value;
              update(i, (d) => ({ picked: q.multiSelect ? d.picked : other ? [] : d.picked, other }));
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && complete) {
                e.preventDefault();
                send(answers);
              }
            }}
          />
        </div>
      ))}
      <div className="question-actions">
        {!instant || drafts[0].other.trim() ? (
          <button className="btn btn-primary btn-sm" disabled={busy || !complete} onClick={() => send(answers)}>
            Send answer{req.questions.length > 1 ? 's' : ''}
          </button>
        ) : null}
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => send(null)} title="Let it decide for itself">
          Skip
        </button>
      </div>
    </div>
  );
}

/** A question that was answered, as it shows in the conversation afterwards. */
export function AskedCard({ args, output, isError }: { args: any; output?: string; isError?: boolean }) {
  const questions: AskQuestion[] = Array.isArray(args?.questions) ? args.questions : [];
  if (!questions.length || output === undefined) return null;
  const skipped = /^The user skipped/.test(output);
  // The tool result lists "question\n→ answer" blocks in order.
  const answers = output.split('\n\n').map((block) => /\n→ ([\s\S]*)$/.exec(block)?.[1] ?? '');
  return (
    <div className="asked-card">
      {questions.map((q, i) => (
        <div key={i} className="asked">
          <span className="muted" dir="auto">
            <MessageCircleQuestion size={13} /> {q.question}
          </span>
          <span className="asked-answer" dir="auto">
            {isError ? 'Couldn’t ask' : skipped ? 'Skipped' : answers[i] || '—'}
          </span>
        </div>
      ))}
    </div>
  );
}
