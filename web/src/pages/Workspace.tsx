import {
  ArrowLeft,
  BookOpen,
  Check,
  Code,
  Download,
  Eye,
  History,
  Layers,
  MessageSquare,
  MessageSquarePlus,
  PanelRightClose,
  PanelRightOpen,
  PenLine,
  Plus,
  Presentation,
  RotateCcw,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, Artifact, ArtifactComment, ArtifactListItem, ArtifactType, ArtifactWork, DEFAULT_BOT_ID, TEXT_ARTIFACT_TYPES } from '../api';
import { artifactDocument, ArtifactIcon, ArtifactThumb, download, HighlightedCode, isMedia, MediaView, SlidesView, TYPE_LABEL } from '../components/Artifacts';
import { Markdown } from '../components/Markdown';
import { Empty, Modal, useConfirm } from '../components/ui';
import { href, navigate } from '../router';
import { relativeTime, useApp } from '../state';
import { ChatView } from './ChatView';
import { tr } from '../i18n';

// ---------- Gallery ----------

/** What you can start from scratch; images, video and audio are generated in chats. */
const NEW_TYPES: { type: ArtifactType; hint: string; placeholder: string }[] = [
  { type: 'markdown', hint: tr('Reports, plans, letters, notes'), placeholder: tr('A one-page update for the team: what shipped, what slipped and why, Q4 priorities. Friendly, concise.') },
  { type: 'slides', hint: tr('A slide deck you can present'), placeholder: tr('A 10-slide pitch for our coffee subscription: problem, solution, market, traction, team, ask.') },
  { type: 'html', hint: tr('A complete, interactive page'), placeholder: tr('A landing page for a neighborhood bakery with a menu, opening hours and a contact form.') },
  { type: 'react', hint: tr('An interactive app or widget'), placeholder: tr('A habit tracker with a weekly grid, streaks and a dark mode toggle.') },
  { type: 'code', hint: tr('A script or source file'), placeholder: tr('A Python script that renames photos by the date they were taken.') },
  { type: 'mermaid', hint: tr('Flowcharts, sequences, timelines'), placeholder: tr('The sign-up flow: landing page → form → email check → onboarding.') },
];

export function ArtifactsPage() {
  const { toast } = useApp();
  const [items, setItems] = useState<ArtifactListItem[]>();
  const [filter, setFilter] = useState<ArtifactType | 'all'>('all');
  const [creating, setCreating] = useState(false);
  const [confirmNode, confirm] = useConfirm();
  useEffect(() => {
    api.artifacts().then(setItems, (err) => toast(err.message));
  }, [toast]);

  const types = useMemo(() => [...new Set((items ?? []).map((a) => a.type))], [items]);
  const shown = (items ?? []).filter((a) => filter === 'all' || a.type === filter);

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-header">
          <div>
            <h1 className="page-title">{tr('Library')}</h1>
            <p className="page-subtitle">{tr('Documents, presentations, web pages, apps, code, diagrams, images, video and audio. Open one to edit it with the bot, comment and see its versions.')}</p>
          </div>
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            <Plus size={16} /> {tr('New')}
          </button>
        </div>
        {types.length > 1 && (
          <div className="segmented" style={{ marginBottom: 16, flexWrap: 'wrap' }}>
            <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>
              {tr('All')}
            </button>
            {types.map((t) => (
              <button key={t} className={filter === t ? 'active' : ''} onClick={() => setFilter(t)}>
                <ArtifactIcon type={t} size={13} /> {TYPE_LABEL[t]}
              </button>
            ))}
          </div>
        )}
        {items && items.length === 0 ? (
          <Empty
            icon={<Layers size={22} />}
            title={tr('No artifacts yet')}
            action={
              <button className="btn btn-primary" onClick={() => setCreating(true)}>
                <Plus size={16} /> {tr('Create one')}
              </button>
            }
          >
            {tr('Start a document, presentation or web page here, or ask for something substantial in any chat, like “make an interactive budget calculator”.')}
          </Empty>
        ) : (
          <div className="grid">
            {shown.map((a) => {
              const latest = a.versions.at(-1)?.content ?? '';
              return (
                <a key={a.id} className="tile artifact-tile has-thumb" href={href({ page: 'artifact', id: a.id })}>
                  <div className="tile-actions">
                    <button
                      className="icon-btn sm"
                      aria-label={tr('Delete {0}', a.title)}
                      onClick={async (e) => {
                        e.preventDefault();
                        if (!(await confirm(tr('Delete “{0}” and all its versions?', a.title), { title: tr('Delete artifact?') }))) return;
                        await api.deleteArtifact(a.id).catch((err) => toast(err.message));
                        setItems((list) => list?.filter((x) => x.id !== a.id));
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  <ArtifactThumb type={a.type} content={latest} language={a.language} />
                  <div className="tile-title">
                    <ArtifactIcon type={a.type} size={14} /> {a.title}
                  </div>
                  <div className="tile-desc">{a.chatTitle ? tr('In “{0}”', a.chatTitle) : tr('Chat deleted')}</div>
                  <div className="tile-foot">
                    <span className="badge">{TYPE_LABEL[a.type]}</span>
                    {a.versions.length > 1 && <span>v{a.versions.length}</span>}
                    {(a.comments?.filter((c) => !c.resolved).length ?? 0) > 0 && (
                      <span>
                        <MessageSquare size={11} /> {a.comments!.filter((c) => !c.resolved).length}
                      </span>
                    )}
                    <span style={{ marginLeft: 'auto' }}>{relativeTime(a.updatedAt)}</span>
                  </div>
                </a>
              );
            })}
          </div>
        )}
      </div>
      {creating && <NewArtifactModal onClose={() => setCreating(false)} />}
      {confirmNode}
    </div>
  );
}

function NewArtifactModal({ onClose }: { onClose(): void }) {
  const { toast, bots } = useApp();
  const [type, setType] = useState<ArtifactType>('markdown');
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  const [botId, setBotId] = useState(DEFAULT_BOT_ID);
  const [busy, setBusy] = useState(false);
  const spec = NEW_TYPES.find((t) => t.type === type)!;
  const create = async () => {
    setBusy(true);
    try {
      const artifact = await api.createArtifact({ type, title: title.trim() || tr('Untitled {0}', TYPE_LABEL[type].toLowerCase()), botId });
      // A brief becomes the first request in the artifact's chat.
      if (brief.trim()) sessionStorage.setItem(`mitzi.brief.${artifact.id}`, brief.trim());
      navigate({ page: 'artifact', id: artifact.id });
    } catch (err) {
      toast((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={tr('New artifact')}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            {tr('Cancel')}
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void create()}>
            {brief.trim() ? tr('Create and draft') : tr('Create')}
          </button>
        </>
      }
    >
      <div className="type-grid" role="radiogroup" aria-label={tr('Type')}>
        {NEW_TYPES.map((t) => (
          <button key={t.type} role="radio" aria-checked={type === t.type} className={`type-card${type === t.type ? ' on' : ''}`} onClick={() => setType(t.type)}>
            <span className="artifact-icon">
              <ArtifactIcon type={t.type} />
            </span>
            <span>
              <span className="t">{TYPE_LABEL[t.type]}</span>
              <span className="s">{t.hint}</span>
            </span>
          </button>
        ))}
      </div>
      <label className="field">
        <span className="field-label">{tr('Title')}</span>
        <input className="input" autoFocus value={title} placeholder={tr('Untitled {0}', TYPE_LABEL[type].toLowerCase())} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="field">
        <span className="field-label">
          {tr('What should it be?')}{' '}<span className="muted">{tr('(optional; the bot makes a first version)')}</span>
        </span>
        <textarea className="textarea" rows={3} value={brief} placeholder={spec.placeholder} onChange={(e) => setBrief(e.target.value)} />
      </label>
      <label className="field">
        <span className="field-label">{tr('Work with')}</span>
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

// ---------- Workspace ----------

type Mode = 'view' | 'edit';
type Side = 'comments' | 'versions' | null;

/** How each type is viewed and edited: [view label, edit label]. */
const MODES: Partial<Record<ArtifactType, [string, string]>> = {
  markdown: [tr('Read'), tr('Write')],
  slides: [tr('Slides'), tr('Write')],
  code: [tr('Read'), tr('Edit')],
  html: [tr('Preview'), tr('Code')],
  react: [tr('Preview'), tr('Code')],
  svg: [tr('Preview'), tr('Code')],
  mermaid: [tr('Preview'), tr('Code')],
};

const latestOf = (a: Artifact) => a.versions.at(-1)?.content ?? '';

export function ArtifactPage({ id }: { id: string }) {
  const { toast, bots, chats } = useApp();
  const [artifact, setArtifact] = useState<ArtifactWork>();
  const [mode, setMode] = useState<Mode>('view');
  const [side, setSide] = useState<Side>(null);
  const [chatOpen, setChatOpen] = useState(() => window.matchMedia('(min-width: 861px)').matches);
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

  const apply = useCallback((a: Artifact | ArtifactWork) => {
    setArtifact((prev) => ({ ...(prev ?? { running: false }), ...a }) as ArtifactWork);
    // Don't clobber edits the user hasn't saved yet.
    if (pending.current.content === undefined) setDraft(latestOf(a));
    if (pending.current.title === undefined) setTitle(a.title);
  }, []);

  const load = useCallback(async () => {
    try {
      apply(await api.artifact(id));
    } catch (err) {
      toast((err as Error).message);
      if ((err as { status?: number }).status === 404) navigate({ page: 'artifacts' }, true);
    }
  }, [id, apply, toast]);

  useEffect(() => {
    pending.current = {};
    void load();
  }, [load]);

  // An empty artifact opens ready to write.
  useEffect(() => {
    if (artifact && !latestOf(artifact).trim() && MODES[artifact.type]) setMode('edit');
  }, [artifact?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const flush = useCallback(async () => {
    window.clearTimeout(saveTimer.current);
    const body = pending.current;
    if (body.content === undefined && body.title === undefined) return;
    pending.current = {};
    setSaving('saving');
    try {
      apply(await api.updateArtifact(id, body));
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

  // The bot works from the saved version, so save before each request.
  const ask = async (text: string) => {
    await flush();
    sendRef.current?.(text);
    setChatOpen(true);
  };

  // A brief from the "New" dialog starts the first version.
  useEffect(() => {
    if (!artifact) return;
    const key = `mitzi.brief.${artifact.id}`;
    const brief = sessionStorage.getItem(key);
    if (!brief) return;
    sessionStorage.removeItem(key);
    setMode('view');
    const timer = setTimeout(() => sendRef.current?.(`Create the first version of this ${TYPE_LABEL[artifact.type].toLowerCase()}.\n\n${brief}`), 300);
    return () => clearTimeout(timer);
  }, [artifact?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const text = !!artifact && TEXT_ARTIFACT_TYPES.includes(artifact.type);
  const iframeDoc = artifact && mode === 'view' ? artifactDocument(artifact.type, draft) : undefined;
  // Comments work on text you can select: the editor, or rendered documents, slides and code.
  const selectable = text && (mode === 'edit' || !iframeDoc);

  const captureSelection = () => {
    if (!selectable) return;
    if (mode === 'edit' && textarea.current) {
      const el = textarea.current;
      const sel = el.value.slice(el.selectionStart, el.selectionEnd);
      const rect = el.getBoundingClientRect();
      if (sel.trim()) return setSelection({ text: sel, x: rect.left + rect.width / 2, y: rect.top + 12 });
    } else {
      const sel = window.getSelection();
      if (sel && sel.rangeCount && preview.current?.contains(sel.anchorNode)) {
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        if (sel.toString().trim() && rect) return setSelection({ text: sel.toString(), x: rect.left + rect.width / 2, y: rect.top });
      }
    }
    setSelection(null);
  };

  const quoteFor = (t: string) => t.trim().replace(/\s+/g, ' ').slice(0, 1000);

  const addComment = async (quote: string, body: string) => {
    try {
      apply(await api.addComment(id, quote, body));
      setSide('comments');
    } catch (err) {
      toast((err as Error).message);
    }
  };

  const comments = artifact?.comments ?? [];
  const openComments = comments.filter((c) => !c.resolved);
  const resolved = comments.filter((c) => c.resolved);

  // Highlight commented passages in rendered documents and code. The highlights change React's DOM,
  // so the rendered view remounts (by key) whenever the text or the comments change.
  const marks = mode === 'view' && (artifact?.type === 'markdown' || artifact?.type === 'code');
  const markKey = `${hash(draft)}:${openComments.map((c) => c.id).join(',')}`;
  useLayoutEffect(() => {
    const root = preview.current;
    if (!root || !marks) return;
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
  }, [markKey, marks, artifact?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!artifact) {
    return (
      <div className="page">
        <div className="page-inner muted">{tr('Loading…')}</div>
      </div>
    );
  }

  const bot = bots.find((b) => b.id === (chats.find((c) => c.id === artifact.chatId)?.botId ?? DEFAULT_BOT_ID));
  const botName = bot?.name ?? 'Mitzi';
  const modes = MODES[artifact.type];
  const words = artifact.type === 'markdown' && draft.trim() ? tr('{0} words', draft.trim().split(/\s+/).length.toLocaleString()) : '';
  const status = busy ? tr('{0} is working…', botName) : saving === 'saving' ? tr('Saving…') : saving === 'unsaved' ? tr('Unsaved') : words;
  const kind = TYPE_LABEL[artifact.type].toLowerCase();

  let body;
  if (!text) {
    body = (
      <div className="ws-media">
        <MediaView type={artifact.type} url={draft} title={artifact.title} />
        {artifact.versions.at(-1)?.note && <p className="muted small">{artifact.versions.at(-1)!.note}</p>}
      </div>
    );
  } else if (mode === 'edit') {
    body = (
      <textarea
        ref={textarea}
        className={`doc-editor${artifact.type === 'markdown' ? '' : ' code'}`}
        value={draft}
        readOnly={busy}
        spellCheck={artifact.type === 'markdown' || artifact.type === 'slides'}
        placeholder={
          artifact.type === 'slides'
            ? tr('# Title\nA subtitle\n\n---\n\n## First slide\n- A point\n- Another point\n\n(Separate slides with ---, or ask {0} to draft it →)', botName)
            : tr('Start writing, or ask {0} to draft it →', botName)
        }
        onChange={(e) => {
          setDraft(e.target.value);
          queueSave({ content: e.target.value });
        }}
      />
    );
  } else if (iframeDoc) {
    body = <iframe className="ws-frame" title={artifact.title} sandbox="allow-scripts allow-popups allow-forms allow-modals allow-downloads" srcDoc={iframeDoc} />;
  } else if (!draft.trim()) {
    body = (
      <div className="muted doc-empty">
        {tr('This {0} is empty. Switch to', kind)}{' '}<button className="link-btn" onClick={() => setMode('edit')}>{modes?.[1]}</button>{' '}{tr('or ask {0} for a first version.', botName)}
      </div>
    );
  } else if (artifact.type === 'slides') {
    body = (
      <div ref={preview} className="ws-slides">
        <SlidesView content={draft} />
      </div>
    );
  } else {
    body = (
      <div ref={preview} className={artifact.type === 'code' ? 'ws-code' : 'doc-paper'}>
        <div key={markKey}>{artifact.type === 'code' ? <HighlightedCode code={draft} language={artifact.language} /> : <Markdown text={draft} />}</div>
      </div>
    );
  }

  return (
    <div className="doc-layout">
      <div className="doc-main">
        <div className="doc-toolbar">
          <a className="icon-btn" href={href({ page: 'artifacts' })} aria-label={tr('All artifacts')} title={tr('All artifacts')}>
            <ArrowLeft size={17} />
          </a>
          <span className="artifact-icon ws-type" title={TYPE_LABEL[artifact.type]}>
            <ArtifactIcon type={artifact.type} size={15} />
          </span>
          <input
            className="doc-title-input"
            value={title}
            aria-label={tr('Title')}
            onChange={(e) => {
              setTitle(e.target.value);
              if (e.target.value.trim()) queueSave({ title: e.target.value.trim() });
            }}
          />
          <span className="muted small doc-save-state">{status}</span>
          {modes && (
            <div className="segmented" role="tablist" aria-label={tr('View')}>
              <button role="tab" aria-selected={mode === 'view'} className={mode === 'view' ? 'active' : ''} onClick={() => setMode('view')}>
                {artifact.type === 'slides' ? <Presentation size={14} /> : artifact.type === 'markdown' || artifact.type === 'code' ? <BookOpen size={14} /> : <Eye size={14} />} {modes[0]}
              </button>
              <button role="tab" aria-selected={mode === 'edit'} className={mode === 'edit' ? 'active' : ''} onClick={() => setMode('edit')}>
                {artifact.type === 'markdown' || artifact.type === 'slides' ? <PenLine size={14} /> : <Code size={14} />} {modes[1]}
              </button>
            </div>
          )}
          {text && (
            <button className={`icon-btn${side === 'comments' ? ' on' : ''}`} title={tr('Comments')} aria-label={tr('Comments')} onClick={() => setSide(side === 'comments' ? null : 'comments')}>
              <MessageSquare size={17} />
              {openComments.length > 0 && <span className="icon-badge">{openComments.length}</span>}
            </button>
          )}
          {artifact.versions.length > 1 && (
            <button className={`icon-btn${side === 'versions' ? ' on' : ''}`} title={tr('Version history')} aria-label={tr('Version history')} onClick={() => setSide(side === 'versions' ? null : 'versions')}>
              <History size={17} />
            </button>
          )}
          <button className="icon-btn" title={tr('Download')} aria-label={tr('Download')} onClick={() => download(artifact, draft)}>
            <Download size={17} />
          </button>
          <button
            className="icon-btn"
            title={tr('Delete')}
            aria-label={tr('Delete artifact')}
            onClick={async () => {
              if (!(await confirm(tr('“{0}” and all its versions will be permanently deleted. Its chat is kept.', artifact.title), { title: tr('Delete {0}?', kind) }))) return;
              await api.deleteArtifact(artifact.id).catch((err) => toast(err.message));
              navigate({ page: 'artifacts' });
            }}
          >
            <Trash2 size={17} />
          </button>
          <button className="icon-btn" title={chatOpen ? tr('Hide chat') : tr('Show chat')} aria-label={tr('Toggle chat')} onClick={() => setChatOpen((o) => !o)}>
            {chatOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
          </button>
        </div>
        <div className="doc-body">
          <div className={`doc-paper-wrap${flash ? ' flash' : ''}${iframeDoc || (mode === 'edit' && artifact.type !== 'markdown') ? ' full' : ''}`} onMouseUp={captureSelection} onKeyUp={captureSelection}>
            {body}
          </div>
          {side && (
            <aside className="doc-side">
              {side === 'comments' ? (
                <CommentsPanel
                  open={openComments}
                  resolved={resolved}
                  botName={botName}
                  hint={selectable ? tr('Select text to comment on it, or ask {0} to review it.', botName) : tr('Switch to {0} and select text to comment on it.', modes?.[1])}
                  onReply={async (c, t) => apply(await api.updateComment(id, c.id, { reply: t }))}
                  onResolve={async (c, value) => apply(await api.updateComment(id, c.id, { resolved: value }))}
                  onDelete={async (c) => apply(await api.deleteComment(id, c.id))}
                  onAskAll={() => void ask(`Please address the open comments on the ${kind}: make the changes they ask for, then reply to and resolve each one.`)}
                  onAskOne={(c) => void ask(`Please address comment ${c.id} on “${c.quote.slice(0, 120)}”: ${c.text}`)}
                />
              ) : (
                <VersionsPanel
                  artifact={artifact}
                  onRestore={async (index) => {
                    if (!(await confirm(tr('The current version is kept in the history, so you can switch back.'), { title: tr('Restore this version?'), action: tr('Restore') }))) return;
                    try {
                      pending.current = {};
                      apply(await api.restoreVersion(id, index));
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
            botName={botName}
            onClose={() => setSelection(null)}
            onComment={(t) => {
              void addComment(quoteFor(selection.text), t);
              setSelection(null);
            }}
            onAsk={(t) => {
              void ask(`About this passage:\n\n> ${quoteFor(selection.text)}\n\n${t}`);
              setSelection(null);
            }}
          />
        )}
      </div>
      {chatOpen && (
        <aside className="doc-chat">
          <div className="doc-chat-head">
            <Sparkles size={15} className="muted" />
            <a className="grow ws-chat-title" href={href({ page: 'chat', id: artifact.chatId })} title={tr('Open the full chat')}>
              {artifact.chatTitle ?? tr('Work on it together')}
            </a>
            <button className="icon-btn sm" aria-label={tr('Hide chat')} onClick={() => setChatOpen(false)}>
              <X size={15} />
            </button>
          </div>
          <ChatView
            key={artifact.chatId}
            routeId={artifact.chatId}
            embedded
            focus={artifact.id}
            sendRef={sendRef}
            placeholder={tr('Ask {0} to change the {1}…', botName, kind)}
            onArtifact={(a) => {
              if (a.id !== artifact.id) return;
              setBusy(true);
              pending.current = {};
              apply(a);
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

function VersionsPanel({ artifact, onRestore }: { artifact: Artifact; onRestore(index: number): void }) {
  const [viewing, setViewing] = useState<number>();
  const shown = viewing !== undefined ? artifact.versions[viewing] : undefined;
  const latest = artifact.versions.length - 1;
  return (
    <>
      <div className="doc-side-head">
        <strong>{tr('Version history')}</strong>
      </div>
      {artifact.versions
        .map((v, i) => ({ v, i }))
        .reverse()
        .map(({ v, i }) => (
          <button key={i} className={`version-row${viewing === i ? ' on' : ''}`} onClick={() => setViewing(viewing === i ? undefined : i)}>
            <span className={`comment-who ${v.author ?? 'assistant'}`}>{v.author === 'user' ? tr('You') : tr('Bot')}</span>
            <span className="grow">
              {i === latest ? tr('Current') : tr('Version {0}', i + 1)}
              {v.note && !isMedia(artifact.type) ? ` · ${v.note}` : ''}
              <div className="muted small">{new Date(v.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div>
            </span>
          </button>
        ))}
      {shown && (
        <Modal
          title={tr('Version {0} · {1}', viewing! + 1, new Date(shown.createdAt).toLocaleString())}
          onClose={() => setViewing(undefined)}
          wide
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setViewing(undefined)}>
                {tr('Close')}
              </button>
              {viewing !== latest && (
                <button className="btn btn-primary" onClick={() => (setViewing(undefined), onRestore(viewing!))}>
                  <RotateCcw size={14} /> {tr('Restore this version')}
                </button>
              )}
            </>
          }
        >
          <div style={{ maxHeight: '60vh', overflow: 'auto' }}>
            {artifact.type === 'markdown' ? (
              <div className="doc-paper">
                <Markdown text={shown.content || '_(empty)_'} />
              </div>
            ) : artifact.type === 'slides' ? (
              <SlidesView content={shown.content} compact />
            ) : isMedia(artifact.type) ? (
              <MediaView type={artifact.type} url={shown.content} title={artifact.title} />
            ) : (
              <HighlightedCode code={shown.content} language={artifact.type === 'code' ? artifact.language : artifact.type === 'react' ? 'jsx' : artifact.type === 'svg' ? 'xml' : artifact.type} />
            )}
          </div>
        </Modal>
      )}
    </>
  );
}

/** The chat keeps a usable width, and leaves the document room for its toolbar and text. */
function clampChat(w: number, room = document.querySelector('.doc-layout')?.clientWidth ?? window.innerWidth): number {
  return Math.round(Math.max(300, Math.min(w, room - 420)));
}

function hash(t: string): string {
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (Math.imul(31, h) + t.charCodeAt(i)) | 0;
  return `${t.length}.${h >>> 0}`;
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
          <MessageSquarePlus size={14} />{' '}{tr('Comment or ask {0}', botName)}
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
        placeholder={tr('Make this punchier · Is this accurate? · Add an example…')}
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
          {tr('Add comment')}
        </button>
        <button className="btn btn-sm btn-primary" disabled={!text.trim()}>
          <Sparkles size={13} />{' '}{tr('Ask {0}', botName)}
        </button>
      </div>
    </form>
  );
}

function CommentsPanel({
  open,
  resolved,
  botName,
  hint,
  onReply,
  onResolve,
  onDelete,
  onAskAll,
  onAskOne,
}: {
  open: ArtifactComment[];
  resolved: ArtifactComment[];
  botName: string;
  hint: string;
  onReply(c: ArtifactComment, text: string): Promise<void>;
  onResolve(c: ArtifactComment, value: boolean): Promise<void>;
  onDelete(c: ArtifactComment): Promise<void>;
  onAskAll(): void;
  onAskOne(c: ArtifactComment): void;
}) {
  const [showResolved, setShowResolved] = useState(false);
  const list = useMemo(() => (showResolved ? [...open, ...resolved] : open), [open, resolved, showResolved]);
  return (
    <>
      <div className="doc-side-head">
        <strong>{tr('Comments')}</strong>
        {open.some((c) => c.author === 'user') && (
          <button className="btn btn-sm btn-primary" onClick={onAskAll} title={tr('Ask {0} to work through the open comments', botName)}>
            <Sparkles size={13} /> {tr('Address all')}
          </button>
        )}
      </div>
      {!open.length && <p className="muted small">{hint}</p>}
      {list.map((c) => (
        <CommentCard key={c.id} c={c} botName={botName} onReply={onReply} onResolve={onResolve} onDelete={onDelete} onAsk={onAskOne} />
      ))}
      {resolved.length > 0 && (
        <button className="link-btn small" onClick={() => setShowResolved((v) => !v)}>
          {showResolved ? tr('Hide') : tr('Show')}{' '}{tr('{0} resolved', resolved.length)}
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
  c: ArtifactComment;
  botName: string;
  onReply(c: ArtifactComment, text: string): Promise<void>;
  onResolve(c: ArtifactComment, value: boolean): Promise<void>;
  onDelete(c: ArtifactComment): Promise<void>;
  onAsk(c: ArtifactComment): void;
}) {
  const [reply, setReply] = useState('');
  const who = (a: 'user' | 'assistant') => (a === 'user' ? tr('You') : botName);
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
          <input className="input input-sm" placeholder={tr('Reply…')} value={reply} onChange={(e) => setReply(e.target.value)} />
        </form>
      )}
      <div className="comment-actions">
        {!c.resolved && c.author === 'user' && (
          <button className="btn btn-xs btn-ghost" onClick={() => onAsk(c)}>
            <Sparkles size={12} />{' '}{tr('Ask {0}', botName)}
          </button>
        )}
        <button className="btn btn-xs btn-ghost" onClick={() => void onResolve(c, !c.resolved)}>
          {c.resolved ? <RotateCcw size={12} /> : <Check size={12} />} {c.resolved ? tr('Reopen') : tr('Resolve')}
        </button>
        <button className="icon-btn sm" aria-label={tr('Delete comment')} onClick={() => void onDelete(c)}>
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}

