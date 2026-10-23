import {
  ArrowLeft,
  BookOpen,
  Check,
  Download,
  FileText,
  History,
  MessageSquare,
  MessageSquarePlus,
  PanelRightClose,
  PanelRightOpen,
  PenLine,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, Doc, DocComment, DocSummary, DocView, DEFAULT_BOT_ID } from '../api';
import { Markdown } from '../components/Markdown';
import { Empty, Modal, useConfirm } from '../components/ui';
import { href, navigate } from '../router';
import { relativeTime, useApp } from '../state';
import { ChatView } from './ChatView';

// ---------- List ----------

export function DocsPage() {
  const { toast, bots } = useApp();
  const [docs, setDocs] = useState<DocSummary[]>();
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    api.docs().then(setDocs, (err) => toast(err.message));
  }, [toast]);

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-header">
          <div>
            <h1 className="page-title">Docs</h1>
            <p className="page-subtitle">Write documents together with a bot: it drafts and edits, you comment, edit and ask for changes.</p>
          </div>
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            <Plus size={16} /> New document
          </button>
        </div>
        {docs && !docs.length ? (
          <Empty
            icon={<FileText size={22} />}
            title="No documents yet"
            action={
              <button className="btn btn-primary" onClick={() => setCreating(true)}>
                <Plus size={16} /> Start a document
              </button>
            }
          >
            Start from a blank page or a brief, then ask the bot to draft it. Select text to comment on it or ask for a change.
          </Empty>
        ) : (
          <div className="grid">
            {docs?.map((d) => (
              <a key={d.id} className="tile doc-tile" href={href({ page: 'doc', id: d.id })}>
                <div className="tile-head">
                  <span className="tile-icon">
                    <FileText size={18} />
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div className="tile-title">{d.title}</div>
                    <div className="muted small">
                      {d.words.toLocaleString()} words · edited {relativeTime(d.updatedAt)}
                    </div>
                  </div>
                </div>
                <p className="tile-desc">{d.excerpt || <span className="muted">Empty document</span>}</p>
                {d.openComments > 0 && (
                  <span className="badge accent">
                    <MessageSquare size={12} /> {d.openComments} open comment{d.openComments === 1 ? '' : 's'}
                  </span>
                )}
              </a>
            ))}
          </div>
        )}
      </div>
      {creating && <NewDocModal bots={bots} onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewDocModal({ bots, onClose }: { bots: ReturnType<typeof useApp>['bots']; onClose(): void }) {
  const { toast } = useApp();
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  const [botId, setBotId] = useState(DEFAULT_BOT_ID);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const doc = await api.createDoc({ title: title.trim() || 'Untitled document', botId });
      // A brief becomes the first request in the document's chat.
      navigate({ page: 'doc', id: doc.id });
      if (brief.trim()) sessionStorage.setItem(`mitzi.docBrief.${doc.id}`, brief.trim());
    } catch (err) {
      toast((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="New document"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void create()}>
            {brief.trim() ? 'Create and draft' : 'Create'}
          </button>
        </>
      }
    >
      <label className="field">
        <span className="field-label">Title</span>
        <input className="input" autoFocus value={title} placeholder="e.g. Q3 product update" onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="field">
        <span className="field-label">
          What should it say? <span className="muted">(optional; the bot writes a first draft)</span>
        </span>
        <textarea
          className="textarea"
          rows={4}
          value={brief}
          placeholder="A one-page update for the team: what shipped, what slipped and why, next quarter's priorities. Friendly, concise."
          onChange={(e) => setBrief(e.target.value)}
        />
      </label>
      <label className="field">
        <span className="field-label">Work with</span>
        <select className="select" value={botId} onChange={(e) => setBotId(e.target.value)}>
          {bots.map((b) => (
            <option key={b.id} value={b.id}>
              {b.emoji} {b.name}
            </option>
          ))}
        </select>
      </label>
    </Modal>
  );
}

// ---------- Editor ----------

type Mode = 'write' | 'read';
type Side = 'comments' | 'versions' | null;

function loadMode(): Mode {
  try {
    return localStorage.getItem('mitzi.docMode') === 'write' ? 'write' : 'read';
  } catch {
    return 'read';
  }
}

export function DocPage({ id }: { id: string }) {
  const { toast, bots } = useApp();
  const [doc, setDoc] = useState<DocView>();
  const [mode, setModeState] = useState<Mode>(loadMode);
  const [side, setSide] = useState<Side>('comments');
  const [chatOpen, setChatOpen] = useState(true);
  const [draft, setDraft] = useState('');
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState<'saved' | 'saving' | 'unsaved'>('saved');
  const [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState<{ text: string; x: number; y: number } | null>(null);
  const [flash, setFlash] = useState(false);
  const [confirmNode, confirm] = useConfirm();
  const sendRef = useRef<(text: string) => void>(undefined);
  const saveTimer = useRef<number | undefined>(undefined);
  const pending = useRef<{ title?: string; content?: string }>({});
  const textarea = useRef<HTMLTextAreaElement>(null);
  const preview = useRef<HTMLDivElement>(null);
  const bot = bots.find((b) => b.id === DEFAULT_BOT_ID);

  const setMode = (m: Mode) => {
    setModeState(m);
    try {
      localStorage.setItem('mitzi.docMode', m);
    } catch {
      // Not persisted.
    }
  };

  const apply = useCallback((d: Doc | DocView) => {
    setDoc((prev) => ({ ...(prev ?? { running: false }), ...d }) as DocView);
    // Don't clobber edits the user hasn't saved yet.
    if (pending.current.content === undefined) setDraft(d.content);
    if (pending.current.title === undefined) setTitle(d.title);
  }, []);

  const load = useCallback(async () => {
    try {
      apply(await api.doc(id));
    } catch (err) {
      toast((err as Error).message);
      if ((err as { status?: number }).status === 404) navigate({ page: 'docs' }, true);
    }
  }, [id, apply, toast]);

  useEffect(() => {
    pending.current = {};
    void load();
  }, [load]);

  const flush = useCallback(async () => {
    window.clearTimeout(saveTimer.current);
    const body = pending.current;
    if (body.content === undefined && body.title === undefined) return;
    pending.current = {};
    setSaving('saving');
    try {
      apply(await api.updateDoc(id, body));
      setSaving('saved');
    } catch (err) {
      pending.current = { ...body, ...pending.current };
      setSaving('unsaved');
      toast((err as Error).message);
    }
  }, [id, apply, toast]);

  const queueSave = (patch: { title?: string; content?: string }) => {
    pending.current = { ...pending.current, ...patch };
    setSaving('unsaved');
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void flush(), 800);
  };
  useEffect(() => () => void flush(), [flush]);

  // The bot can't work on a version the user hasn't saved, so save before each request.
  const ask = async (text: string) => {
    await flush();
    sendRef.current?.(text);
    setChatOpen(true);
  };

  // A brief from the "New document" dialog starts the first draft.
  useEffect(() => {
    if (!doc) return;
    const key = `mitzi.docBrief.${doc.id}`;
    const brief = sessionStorage.getItem(key);
    if (!brief) return;
    sessionStorage.removeItem(key);
    const timer = setTimeout(() => sendRef.current?.(`Write a first draft of this document.\n\n${brief}`), 300);
    return () => clearTimeout(timer);
  }, [doc?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Selection → comment / ask ----
  const captureSelection = () => {
    let text = '';
    let rect: DOMRect | undefined;
    if (mode === 'write' && textarea.current) {
      const el = textarea.current;
      text = el.value.slice(el.selectionStart, el.selectionEnd);
      rect = el.getBoundingClientRect();
      if (text.trim()) return setSelection({ text, x: rect.left + rect.width / 2, y: rect.top + 12 });
    } else {
      const sel = window.getSelection();
      if (sel && sel.rangeCount && preview.current?.contains(sel.anchorNode)) {
        text = sel.toString();
        rect = sel.getRangeAt(0).getBoundingClientRect();
        if (text.trim() && rect) return setSelection({ text, x: rect.left + rect.width / 2, y: rect.top });
      }
    }
    setSelection(null);
  };

  /** Selected rendered text maps back to the markdown when it appears there verbatim; otherwise the plain text is quoted. */
  const quoteFor = (text: string) => text.trim().replace(/\s+/g, ' ').slice(0, 1000);

  const addComment = async (quote: string, text: string) => {
    try {
      apply(await api.addDocComment(id, quote, text));
      setSide('comments');
    } catch (err) {
      toast((err as Error).message);
    }
  };

  const openComments = doc?.comments.filter((c) => !c.resolved) ?? [];
  const resolved = doc?.comments.filter((c) => c.resolved) ?? [];

  // Highlight commented passages in the read view. The highlights change React's DOM, so the
  // rendered markdown remounts (by key) whenever the text or the comments change.
  const markKey = `${hash(draft)}:${openComments.map((c) => c.id).join(',')}`;
  useLayoutEffect(() => {
    const root = preview.current;
    if (!root || mode !== 'read') return;
    for (const c of openComments) {
      const needle = c.quote.trim().split('\n')[0].slice(0, 200).replace(/[*_`#>]/g, '').trim();
      if (needle.length < 2) continue;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
        const i = node.data.indexOf(needle);
        if (i < 0) continue;
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + needle.length);
        const mark = document.createElement('mark');
        mark.className = 'doc-mark';
        mark.dataset.comment = c.id;
        mark.title = c.text;
        range.surroundContents(mark);
        break;
      }
    }
  }, [markKey, mode, doc?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!doc) {
    return (
      <div className="page">
        <div className="page-inner muted">Loading…</div>
      </div>
    );
  }

  const exportMd = () => {
    const blob = new Blob([draft], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(title || 'document').replace(/[^\w\- ]+/g, '').trim() || 'document'}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const words = draft.trim() ? draft.trim().split(/\s+/).length : 0;
  return (
    <div className="doc-layout">
      <div className="doc-main">
        <div className="doc-toolbar">
          <a className="icon-btn" href={href({ page: 'docs' })} aria-label="All documents" title="All documents">
            <ArrowLeft size={17} />
          </a>
          <input
            className="doc-title-input"
            value={title}
            aria-label="Document title"
            onChange={(e) => {
              setTitle(e.target.value);
              if (e.target.value.trim()) queueSave({ title: e.target.value.trim() });
            }}
          />
          <span className="muted small doc-save-state">
            {busy ? 'Bot is editing…' : saving === 'saving' ? 'Saving…' : saving === 'unsaved' ? 'Unsaved' : `${words.toLocaleString()} words`}
          </span>
          <div className="segmented" role="tablist" aria-label="View">
            <button role="tab" aria-selected={mode === 'read'} className={mode === 'read' ? 'active' : ''} onClick={() => setMode('read')}>
              <BookOpen size={14} /> Read
            </button>
            <button role="tab" aria-selected={mode === 'write'} className={mode === 'write' ? 'active' : ''} onClick={() => setMode('write')}>
              <PenLine size={14} /> Write
            </button>
          </div>
          <button className={`icon-btn${side === 'comments' ? ' on' : ''}`} title="Comments" aria-label="Comments" onClick={() => setSide(side === 'comments' ? null : 'comments')}>
            <MessageSquare size={17} />
            {openComments.length > 0 && <span className="icon-badge">{openComments.length}</span>}
          </button>
          <button className={`icon-btn${side === 'versions' ? ' on' : ''}`} title="Version history" aria-label="Version history" onClick={() => setSide(side === 'versions' ? null : 'versions')}>
            <History size={17} />
          </button>
          <button className="icon-btn" title="Download as Markdown" aria-label="Download" onClick={exportMd}>
            <Download size={17} />
          </button>
          <button
            className="icon-btn"
            title="Delete document"
            aria-label="Delete document"
            onClick={async () => {
              if (!(await confirm(`“${doc.title}” and its chat will be permanently deleted.`, { title: 'Delete document?' }))) return;
              await api.deleteDoc(doc.id).catch((err) => toast(err.message));
              navigate({ page: 'docs' });
            }}
          >
            <Trash2 size={17} />
          </button>
          <button className="icon-btn" title={chatOpen ? 'Hide chat' : 'Show chat'} aria-label="Toggle chat" onClick={() => setChatOpen((o) => !o)}>
            {chatOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
          </button>
        </div>
        <div className="doc-body">
          <div className={`doc-paper-wrap${flash ? ' flash' : ''}`} onMouseUp={captureSelection} onKeyUp={captureSelection}>
            {mode === 'write' ? (
              <textarea
                ref={textarea}
                className="doc-editor"
                value={draft}
                readOnly={busy}
                spellCheck
                placeholder="Start writing, or ask the bot to draft this document →"
                onChange={(e) => {
                  setDraft(e.target.value);
                  queueSave({ content: e.target.value });
                }}
              />
            ) : (
              <div ref={preview} className="doc-paper">
                {draft.trim() ? (
                  <Markdown key={markKey} text={draft} />
                ) : (
                  <div className="muted doc-empty">
                    This document is empty. Switch to <button className="link-btn" onClick={() => setMode('write')}>Write</button> or ask the bot for a first draft.
                  </div>
                )}
              </div>
            )}
          </div>
          {side && (
            <aside className="doc-side">
              {side === 'comments' ? (
                <CommentsPanel
                  open={openComments}
                  resolved={resolved}
                  botName={bot?.name ?? 'Mitzi'}
                  onReply={async (c, text) => apply(await api.updateDocComment(id, c.id, { reply: text }))}
                  onResolve={async (c, value) => apply(await api.updateDocComment(id, c.id, { resolved: value }))}
                  onDelete={async (c) => apply(await api.deleteDocComment(id, c.id))}
                  onAskAll={() => void ask('Please address the open comments in the document: make the changes they ask for, then reply to and resolve each one.')}
                  onAskOne={(c) => void ask(`Please address comment ${c.id} on “${c.quote.slice(0, 120)}”: ${c.text}`)}
                />
              ) : (
                <VersionsPanel
                  doc={doc}
                  onRestore={async (versionId) => {
                    if (!(await confirm('The current text is kept in the history, so you can switch back.', { title: 'Restore this version?', action: 'Restore' }))) return;
                    try {
                      pending.current = {};
                      apply(await api.restoreDocVersion(id, versionId));
                    } catch (err) {
                      toast((err as Error).message);
                    }
                  }}
                />
              )}
            </aside>
          )}
        </div>
        {selection && (
          <SelectionPopover
            selection={selection}
            botName={bot?.name ?? 'Mitzi'}
            onClose={() => setSelection(null)}
            onComment={(text) => {
              void addComment(quoteFor(selection.text), text);
              setSelection(null);
            }}
            onAsk={(text) => {
              void ask(`About this passage in the document:\n\n> ${quoteFor(selection.text)}\n\n${text}`);
              setSelection(null);
            }}
          />
        )}
      </div>
      {chatOpen && (
        <aside className="doc-chat">
          <div className="doc-chat-head">
            <Sparkles size={15} className="muted" />
            <span>Work on it together</span>
            <div className="header-spacer" />
            <button className="icon-btn sm" aria-label="Hide chat" onClick={() => setChatOpen(false)}>
              <X size={15} />
            </button>
          </div>
          <ChatView
            key={doc.chatId}
            routeId={doc.chatId}
            embedded
            sendRef={sendRef}
            onDoc={(d) => {
              setBusy(true);
              pending.current = {};
              apply(d);
              setFlash(true);
              setTimeout(() => setFlash(false), 700);
            }}
            onTurnDone={() => {
              setBusy(false);
              void load();
            }}
          />
        </aside>
      )}
      {confirmNode}
    </div>
  );
}

function SelectionPopover({
  selection,
  botName,
  onComment,
  onAsk,
  onClose,
}: {
  selection: { text: string; x: number; y: number };
  botName: string;
  onComment(text: string): void;
  onAsk(text: string): void;
  onClose(): void;
}) {
  const [text, setText] = useState('');
  const [expanded, setExpanded] = useState(false);
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && !text && onClose();
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose, text]);
  const style = { left: Math.min(Math.max(selection.x - 170, 12), window.innerWidth - 352), top: Math.max(selection.y - (expanded ? 150 : 52), 64) };
  if (!expanded) {
    return (
      <div ref={(el) => void (ref.current = el)} className="sel-pop compact" style={style} onMouseDown={(e) => e.preventDefault()}>
        <button className="btn btn-sm btn-ghost" onClick={() => setExpanded(true)}>
          <MessageSquarePlus size={14} /> Comment or ask {botName}
        </button>
      </div>
    );
  }
  return (
    <form
      ref={(el) => void (ref.current = el)}
      className="sel-pop"
      style={style}
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) onAsk(text.trim());
      }}
    >
      <div className="sel-quote">“{selection.text.trim().slice(0, 140)}{selection.text.length > 140 ? '…' : ''}”</div>
      <textarea
        className="textarea"
        autoFocus
        rows={2}
        value={text}
        placeholder="Make this punchier · Is this accurate? · Add an example…"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (text.trim()) onAsk(text.trim());
          } else if (e.key === 'Escape') onClose();
        }}
      />
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-sm" disabled={!text.trim()} onClick={() => onComment(text.trim())}>
          Add comment
        </button>
        <button className="btn btn-sm btn-primary" disabled={!text.trim()}>
          <Sparkles size={13} /> Ask {botName}
        </button>
      </div>
    </form>
  );
}

function CommentsPanel({
  open,
  resolved,
  botName,
  onReply,
  onResolve,
  onDelete,
  onAskAll,
  onAskOne,
}: {
  open: DocComment[];
  resolved: DocComment[];
  botName: string;
  onReply(c: DocComment, text: string): Promise<void>;
  onResolve(c: DocComment, value: boolean): Promise<void>;
  onDelete(c: DocComment): Promise<void>;
  onAskAll(): void;
  onAskOne(c: DocComment): void;
}) {
  const [showResolved, setShowResolved] = useState(false);
  const list = useMemo(() => (showResolved ? [...open, ...resolved] : open), [open, resolved, showResolved]);
  return (
    <>
      <div className="doc-side-head">
        <strong>Comments</strong>
        {open.some((c) => c.author === 'user') && (
          <button className="btn btn-sm btn-primary" onClick={onAskAll} title={`Ask ${botName} to work through the open comments`}>
            <Sparkles size={13} /> Address all
          </button>
        )}
      </div>
      {!open.length && <p className="muted small">Select text in the document to comment on it, or ask {botName} to review it.</p>}
      {list.map((c) => (
        <CommentCard key={c.id} c={c} botName={botName} onReply={onReply} onResolve={onResolve} onDelete={onDelete} onAsk={onAskOne} />
      ))}
      {resolved.length > 0 && (
        <button className="link-btn small" onClick={() => setShowResolved((v) => !v)}>
          {showResolved ? 'Hide' : 'Show'} {resolved.length} resolved
        </button>
      )}
    </>
  );
}

function CommentCard({
  c,
  botName,
  onReply,
  onResolve,
  onDelete,
  onAsk,
}: {
  c: DocComment;
  botName: string;
  onReply(c: DocComment, text: string): Promise<void>;
  onResolve(c: DocComment, value: boolean): Promise<void>;
  onDelete(c: DocComment): Promise<void>;
  onAsk(c: DocComment): void;
}) {
  const [reply, setReply] = useState('');
  const who = (a: 'user' | 'assistant') => (a === 'user' ? 'You' : botName);
  return (
    <div
      className={`comment-card${c.resolved ? ' resolved' : ''}`}
      onMouseEnter={() => document.querySelector(`mark[data-comment="${c.id}"]`)?.classList.add('hot')}
      onMouseLeave={() => document.querySelector(`mark[data-comment="${c.id}"]`)?.classList.remove('hot')}
    >
      {c.quote && <div className="comment-quote">{c.quote.slice(0, 200)}</div>}
      <div className="comment-msg">
        <span className={`comment-who ${c.author}`}>{who(c.author)}</span> {c.text}
      </div>
      {c.replies.map((r, i) => (
        <div key={i} className="comment-msg reply">
          <span className={`comment-who ${r.author}`}>{who(r.author)}</span> {r.text}
        </div>
      ))}
      {!c.resolved && (
        <form
          className="comment-reply"
          onSubmit={(e) => {
            e.preventDefault();
            if (!reply.trim()) return;
            void onReply(c, reply.trim());
            setReply('');
          }}
        >
          <input className="input input-sm" placeholder="Reply…" value={reply} onChange={(e) => setReply(e.target.value)} />
        </form>
      )}
      <div className="comment-actions">
        {!c.resolved && c.author === 'user' && (
          <button className="btn btn-xs btn-ghost" onClick={() => onAsk(c)}>
            <Sparkles size={12} /> Ask {botName}
          </button>
        )}
        <button className="btn btn-xs btn-ghost" onClick={() => void onResolve(c, !c.resolved)}>
          {c.resolved ? <RotateCcw size={12} /> : <Check size={12} />} {c.resolved ? 'Reopen' : 'Resolve'}
        </button>
        <button className="icon-btn sm" aria-label="Delete comment" onClick={() => void onDelete(c)}>
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}

function VersionsPanel({ doc, onRestore }: { doc: Doc; onRestore(id: string): void }) {
  const [viewing, setViewing] = useState<string>();
  const versions = [...doc.versions].reverse();
  const shown = versions.find((v) => v.id === viewing);
  return (
    <>
      <div className="doc-side-head">
        <strong>Version history</strong>
      </div>
      {versions.map((v, i) => (
        <button key={v.id} className={`version-row${viewing === v.id ? ' on' : ''}`} onClick={() => setViewing(viewing === v.id ? undefined : v.id)}>
          <span className={`comment-who ${v.author}`}>{v.author === 'user' ? 'You' : 'Bot'}</span>
          <span className="grow">
            {i === 0 ? 'Current' : v.note ?? (v.author === 'user' ? 'Edited' : 'Bot edit')}
            <div className="muted small">{new Date(v.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div>
          </span>
        </button>
      ))}
      {shown && (
        <Modal
          title={`Version from ${new Date(shown.createdAt).toLocaleString()}`}
          onClose={() => setViewing(undefined)}
          wide
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setViewing(undefined)}>
                Close
              </button>
              {shown.content !== doc.content && (
                <button className="btn btn-primary" onClick={() => (setViewing(undefined), onRestore(shown.id))}>
                  <RotateCcw size={14} /> Restore this version
                </button>
              )}
            </>
          }
        >
          <div className="doc-paper" style={{ maxHeight: '60vh', overflow: 'auto' }}>
            <Markdown text={shown.content || '_(empty)_'} />
          </div>
        </Modal>
      )}
    </>
  );
}

function hash(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  return `${text.length}.${h >>> 0}`;
}
