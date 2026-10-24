import { ArrowUp, Globe, Leaf, ListPlus, Loader2, Paperclip, Square, X, Zap } from 'lucide-react';
import { forwardRef, ReactNode, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { api, Attachment, BudgetStatus, ModelInfo, SlashCommandInfo } from '../api';
import { href } from '../router';
import { budgetName } from '../pages/Insights';
import { formatTokens, useApp } from '../state';
import { AttachmentChips } from './Messages';
import { ModelPicker } from './ModelPicker';
import { readFileAsDataUrl, readFileAsText, useAutoResize } from './ui';
import { extractText, isDocument } from '../documents';
import { tr } from '../i18n';

const MAX_TEXT_FILE = 1024 * 1024;
const MAX_IMAGE = 5 * 1024 * 1024;

export interface ComposerHandle {
  setText(text: string): void;
  focus(): void;
}

export function isProviderModel(id: string): boolean {
  return /^[a-z0-9-]+:/.test(id);
}

interface Props {
  onSend(text: string, attachments: Attachment[]): void;
  running?: boolean;
  onStop?(): void;
  model: string;
  onModelChange(model: string): void;
  webSearch: boolean;
  onWebSearchChange(on: boolean): void;
  placeholder?: string;
  autoFocus?: boolean;
  extra?: ReactNode;
  /** Shown after the search button, e.g. the project picker. */
  leading?: ReactNode;
  /** A spending limit is reached and requests go to the free model. */
  free?: boolean;
  /** Shown under the message box on the left, e.g. the autonomy level. */
  footer?: ReactNode;
  /** Shown under the message box on the right, after the model picker, e.g. the context usage. */
  footerEnd?: ReactNode;
  /** Shift+Tab in the message box (switches the approval level). */
  onShiftTab?(): void;
  /** While the bot works, messages are queued; `now` interrupts it to send right away (Ctrl/⌘+Enter). */
  onQueue?(text: string, attachments: Attachment[], now: boolean): void;
}

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(props, handle) {
  const { toast } = useApp();
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  /** Documents whose text is being extracted. */
  const [reading, setReading] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  useAutoResize(ref, text);
  // Other providers' models are prefixed ("openai:gpt-5"); :online search is an OpenRouter feature.
  const searchable = !isProviderModel(props.model);
  const [commands, setCommands] = useState<SlashCommandInfo[]>([]);
  const [menuIndex, setMenuIndex] = useState(0);
  useEffect(() => {
    api.commands().then(setCommands, () => {});
  }, []);
  // Typing "/" at the start opens the command menu until a space is typed.
  const slash = /^\/([\w:-]*)$/.exec(text)?.[1]?.toLowerCase();
  const matches = slash === undefined ? [] : commands.filter((c) => c.name.includes(slash)).slice(0, 12);
  const menuOpen = matches.length > 0;
  const pick = (c: SlashCommandInfo) => {
    setText(`/${c.name} `);
    setMenuIndex(0);
    ref.current?.focus();
  };

  useImperativeHandle(handle, () => ({
    setText: (t: string) => {
      setText(t);
      requestAnimationFrame(() => {
        ref.current?.focus();
        ref.current?.setSelectionRange(t.length, t.length);
      });
    },
    focus: () => ref.current?.focus(),
  }));

  const addFiles = async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      try {
        if (file.type.startsWith('image/')) {
          if (file.size > MAX_IMAGE) throw new Error(tr('{0} is larger than 5 MB', file.name));
          const content = await readFileAsDataUrl(file);
          setAttachments((a) => [...a, { name: file.name || 'image.png', content, kind: 'image' }]);
        } else if (isDocument(file.name)) {
          // PDFs and Office files are read here, in the browser; the bot gets their text.
          setReading((r) => [...r, file.name]);
          try {
            const doc = await extractText(file);
            const header = tr('(Text extracted from {0}: {1}{2}.)', file.name, doc.summary, doc.truncated ? '; the end was cut because the document is very long' : '');
            setAttachments((a) => [...a, { name: file.name, content: `${header}\n\n${doc.text}`, kind: 'text' }]);
            if (doc.truncated) toast(tr('{0} is very long, so only its first part was attached.', file.name), 'info');
          } finally {
            setReading((r) => r.filter((n) => n !== file.name));
          }
        } else {
          if (file.size > MAX_TEXT_FILE) throw new Error(tr('{0} is larger than 1 MB', file.name));
          const content = await readFileAsText(file);
          if (content.includes('\u0000')) throw new Error(tr('{0} isn\'t a file Mitzi can read. Attach text, PDF, Word, Excel or PowerPoint files, or images.', file.name));
          setAttachments((a) => [...a, { name: file.name, content, kind: 'text' }]);
        }
      } catch (err) {
        toast((err as Error).message);
      }
    }
  };

  // Side questions and goal controls can be sent while Mitzi is working.
  const sideCommand = /^\/(btw|subgoal)\s+\S|^\/goal(\s+(pause|resume|clear|status|stop))?\s*$/i.test(text.trim());
  const queueing = !!props.running && !sideCommand && !!props.onQueue;
  const canSend = (!props.running || sideCommand || queueing) && !reading.length && (text.trim() || attachments.length > 0);
  const send = (now = false) => {
    if (!canSend) return;
    if (queueing) props.onQueue!(text.trim(), attachments, now);
    else props.onSend(text.trim(), attachments);
    setText('');
    setAttachments([]);
  };

  const images = attachments.map((a, i) => ({ a, i })).filter((x) => x.a.kind === 'image');
  return (
    <div className="composer-wrap">
      <div
        style={{ position: 'relative' }}
        className={`composer${dragging ? ' dragging' : ''}${props.free ? ' free-mode' : ''}`}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void addFiles(e.dataTransfer.files);
        }}
      >
        {menuOpen && (
          <div className="slash-menu" role="listbox" aria-label={tr('Commands')}>
            {matches.map((c, i) => (
              <button
                key={c.name}
                role="option"
                aria-selected={i === menuIndex}
                className={`slash-item${i === menuIndex ? ' focused' : ''}`}
                onMouseEnter={() => setMenuIndex(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(c);
                }}
              >
                <code>/{c.name}</code>
                {c.argumentHint && <span className="muted small">{c.argumentHint}</span>}
                <span className="d">{c.description}</span>
                <span className="muted small">{c.source}</span>
              </button>
            ))}
          </div>
        )}
        {(attachments.length > 0 || reading.length > 0) && (
          <div className="composer-attachments">
            {reading.map((name) => (
              <span key={name} className="chip reading" title={tr('Reading the document')}>
                <Loader2 size={13} className="spin" />
                <span>{tr('Reading {0}…', name)}</span>
              </span>
            ))}
            {images.map(({ a, i }) => (
              <div className="thumb" key={i}>
                <img src={a.content} alt={a.name} />
                <button onClick={() => setAttachments((list) => list.filter((_, j) => j !== i))} aria-label={tr('Remove {0}', a.name)}>
                  <X size={12} />
                </button>
              </div>
            ))}
            <AttachmentChips attachments={attachments} onRemove={(i) => setAttachments((list) => list.filter((_, j) => j !== i))} />
          </div>
        )}
        <textarea
          ref={ref}
          rows={1}
          value={text}
          autoFocus={props.autoFocus}
          placeholder={queueing ? tr('Queue a message for when it’s done · {0}+Enter sends it now', /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl') : (props.placeholder ?? tr('Message Mitzi…'))}
          aria-label={tr('Message')}
          dir="auto"
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files);
            if (files.length) {
              e.preventDefault();
              void addFiles(files);
            }
          }}
          onKeyDown={(e) => {
            if (menuOpen) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                setMenuIndex((i) => (i + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length);
                return;
              }
              if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                e.preventDefault();
                pick(matches[Math.min(menuIndex, matches.length - 1)]);
                return;
              }
              if (e.key === 'Escape') {
                setText('');
                return;
              }
            }
            if (e.key === 'Tab' && e.shiftKey && props.onShiftTab) {
              e.preventDefault();
              props.onShiftTab();
              return;
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send(queueing && (e.ctrlKey || e.metaKey));
            }
          }}
        />
        <div className="composer-bar">
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => e.target.files && void addFiles(e.target.files).then(() => (e.target.value = ''))} />
 <button className="icon-btn" title={tr('Attach files, documents (PDF, Word, Excel, PowerPoint) or images')} aria-label={tr('Attach files')} onClick={() => fileInput.current?.click()}>
            <Paperclip size={17} />
          </button>
          <button
            className={`pill-btn${props.webSearch && searchable ? ' on' : ''}`}
            title={searchable ? tr('Let the model search the web (OpenRouter :online, adds cost)') : tr('Web search works with OpenRouter models')}
            aria-pressed={props.webSearch && searchable}
            disabled={!searchable}
            onClick={() => props.onWebSearchChange(!props.webSearch)}
          >
            <Globe size={15} />
            <span className="search-label">{tr('Search')}</span>
          </button>
          {props.leading}
          <div style={{ flex: 1 }} />
          {props.extra}
          {queueing && canSend && (
            <>
              <button className="pill-btn interrupt-btn" onClick={() => send(true)} title={tr('Stop the current response and send this now')}>
                <Zap size={14} /> {tr('Send now')}
              </button>
              <button className="send-btn" onClick={() => send()} title={tr('Queue: sends when the current response is done')} aria-label={tr('Queue message')}>
                <ListPlus size={17} />
              </button>
            </>
          )}
          {props.running && !sideCommand ? (
            <button className="send-btn stop" onClick={props.onStop} title={tr('Stop')} aria-label={tr('Stop generating')}>
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button className="send-btn" onClick={() => send()} disabled={!canSend} title={tr('Send')} aria-label={tr('Send message')}>
              <ArrowUp size={18} strokeWidth={2.4} />
            </button>
          )}
        </div>
      </div>
      <div className="composer-footer">
        {props.footer}
        <div style={{ flex: 1 }} />
        <ModelPicker value={props.model} onChange={props.onModelChange} auto />
        {props.footerEnd}
      </div>
    </div>
  );
});

export function ContextRing({ used, total, onClick, active }: { used: number; total?: number; onClick(): void; active?: boolean }) {
  const window = total ?? 128_000;
  const pct = Math.min(1, used / window);
  const r = 7;
  const c = 2 * Math.PI * r;
  const color = pct > 0.85 ? 'var(--danger)' : pct > 0.6 ? 'var(--warn)' : 'var(--accent)';
  return (
    <button
      className="ring-btn"
      onClick={onClick}
      title={tr('Context: {0} of {1} tokens', used.toLocaleString(), window.toLocaleString())}
      aria-label={tr('Context usage')}
      style={active ? { color: 'var(--text)', background: 'var(--surface-2)' } : undefined}
    >
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
        <circle cx="9" cy="9" r={r} fill="none" strokeWidth="2.4" className="ring-track" />
        <circle
          cx="9"
          cy="9"
          r={r}
          fill="none"
          strokeWidth="2.4"
          stroke={color}
          strokeLinecap="round"
          className="ring-fill"
          strokeDasharray={`${Math.max(pct * c, used ? 1.5 : 0)} ${c}`}
          transform="rotate(-90 9 9)"
        />
      </svg>
      {Math.round(pct * 100)}%<span className="muted"> · {formatTokens(used)}</span>
    </button>
  );
}

/**
 * Tells the user a spending limit is reached and Mitzi has switched to the free model, until the limit starts over.
 * Dismissing it hides it for the rest of that period.
 */
export function FreeModeNotice({ budget, models }: { budget: BudgetStatus; models: ModelInfo[] }) {
  const l = budget.limit;
  const key = `mitzi.freeNotice.${l?.id}.${l?.start}`;
  const [hidden, setHidden] = useState(() => {
    try {
      return sessionStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  });
  if (!l || hidden) return null;
  const name = models.find((m) => m.id === budget.freeModel)?.name ?? budget.freeModel;
  const until = l.resetsAt ? new Date(l.resetsAt).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }) : undefined;
  return (
    <div className="free-notice" role="status">
      <Leaf size={16} />
      <span className="grow">
        {until ? tr('You’ve reached your {0}. Mitzi is using the free model {1} until {2}.', budgetName(l), name, until) : tr('You’ve reached your {0}. Mitzi is using the free model {1}.', budgetName(l), name)}{' '}
        <a href={href({ page: 'settings', section: 'budget' })}>{tr('Change the budget')}</a>
      </span>
      <button
        className="icon-btn sm"
        aria-label={tr('Dismiss')}
        onClick={() => {
          try {
            sessionStorage.setItem(key, '1');
          } catch {
            // Hidden for now only.
          }
          setHidden(true);
        }}
      >
        <X size={14} />
      </button>
    </div>
  );
}
