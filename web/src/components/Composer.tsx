import { ArrowUp, Globe, Loader2, Paperclip, Square, X } from 'lucide-react';
import { forwardRef, ReactNode, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { api, Attachment, SlashCommandInfo } from '../api';
import { formatTokens, useApp } from '../state';
import { AttachmentChips } from './Messages';
import { ModelPicker } from './ModelPicker';
import { readFileAsDataUrl, readFileAsText, useAutoResize } from './ui';
import { extractText, isDocument } from '../documents';

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
  /** Shown after the model picker, e.g. the project picker. */
  leading?: ReactNode;
  /** Shift+Tab in the message box (switches the approval level). */
  onShiftTab?(): void;
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
          if (file.size > MAX_IMAGE) throw new Error(`${file.name} is larger than 5 MB`);
          const content = await readFileAsDataUrl(file);
          setAttachments((a) => [...a, { name: file.name || 'image.png', content, kind: 'image' }]);
        } else if (isDocument(file.name)) {
          // PDFs and Office files are read here, in the browser; the bot gets their text.
          setReading((r) => [...r, file.name]);
          try {
            const doc = await extractText(file);
            const header = `(Text extracted from ${file.name}: ${doc.summary}${doc.truncated ? '; the end was cut because the document is very long' : ''}.)`;
            setAttachments((a) => [...a, { name: file.name, content: `${header}\n\n${doc.text}`, kind: 'text' }]);
            if (doc.truncated) toast(`${file.name} is very long, so only its first part was attached.`, 'info');
          } finally {
            setReading((r) => r.filter((n) => n !== file.name));
          }
        } else {
          if (file.size > MAX_TEXT_FILE) throw new Error(`${file.name} is larger than 1 MB`);
          const content = await readFileAsText(file);
          if (content.includes('\u0000')) throw new Error(`${file.name} isn't a file Mitzi can read. Attach text, PDF, Word, Excel or PowerPoint files, or images.`);
          setAttachments((a) => [...a, { name: file.name, content, kind: 'text' }]);
        }
      } catch (err) {
        toast((err as Error).message);
      }
    }
  };

  // Side questions and goal controls can be sent while Mitzi is working.
  const sideCommand = /^\/(btw|subgoal)\s+\S|^\/goal(\s+(pause|resume|clear|status|stop))?\s*$/i.test(text.trim());
  const canSend = (!props.running || sideCommand) && !reading.length && (text.trim() || attachments.length > 0);
  const send = () => {
    if (!canSend) return;
    props.onSend(text.trim(), attachments);
    setText('');
    setAttachments([]);
  };

  const images = attachments.map((a, i) => ({ a, i })).filter((x) => x.a.kind === 'image');
  return (
    <div className="composer-wrap">
      <div
        style={{ position: 'relative' }}
        className={`composer${dragging ? ' dragging' : ''}`}
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
          <div className="slash-menu" role="listbox" aria-label="Commands">
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
              <span key={name} className="chip reading" title="Reading the document">
                <Loader2 size={13} className="spin" />
                <span>Reading {name}…</span>
              </span>
            ))}
            {images.map(({ a, i }) => (
              <div className="thumb" key={i}>
                <img src={a.content} alt={a.name} />
                <button onClick={() => setAttachments((list) => list.filter((_, j) => j !== i))} aria-label={`Remove ${a.name}`}>
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
          placeholder={props.placeholder ?? 'Message Mitzi…'}
          aria-label="Message"
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
              send();
            }
          }}
        />
        <div className="composer-bar">
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => e.target.files && void addFiles(e.target.files).then(() => (e.target.value = ''))} />
 <button className="icon-btn" title="Attach files, documents (PDF, Word, Excel, PowerPoint) or images" aria-label="Attach files" onClick={() => fileInput.current?.click()}>
            <Paperclip size={17} />
          </button>
          <button
            className={`pill-btn${props.webSearch && searchable ? ' on' : ''}`}
            title={searchable ? 'Let the model search the web (OpenRouter :online, adds cost)' : 'Web search works with OpenRouter models'}
            aria-pressed={props.webSearch && searchable}
            disabled={!searchable}
            onClick={() => props.onWebSearchChange(!props.webSearch)}
          >
            <Globe size={15} />
            <span className="search-label">Search</span>
          </button>
          <ModelPicker value={props.model} onChange={props.onModelChange} auto />
          {props.leading}
          <div style={{ flex: 1 }} />
          {props.extra}
          {props.running && !sideCommand ? (
            <button className="send-btn stop" onClick={props.onStop} title="Stop" aria-label="Stop generating">
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button className="send-btn" onClick={send} disabled={!canSend} title="Send" aria-label="Send message">
              <ArrowUp size={18} strokeWidth={2.4} />
            </button>
          )}
        </div>
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
      title={`Context: ${used.toLocaleString()} of ${window.toLocaleString()} tokens`}
      aria-label="Context usage"
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
