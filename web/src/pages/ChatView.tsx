import {
  AlertTriangle,
  Brain,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  KeyRound,
  Layers,
  Lightbulb,
  Loader2,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Sparkles,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, Artifact, Attachment, Chat, ChatMessage, DEFAULT_BOT_ID, RecalledMemory, StreamEvent } from '../api';
import { ArtifactIcon, ArtifactView, TYPE_LABEL } from '../components/Artifacts';
import { Composer, ComposerHandle, ContextRing } from '../components/Composer';
import { ContextPanel } from '../components/ContextPanel';
import { Markdown } from '../components/Markdown';
import { AssistantTurn, Avatar, buildTurns, CompactDivider, MemoryRecall, PermissionCard, PermissionRequest, ToolBlock, UserTurn } from '../components/Messages';
import { Menu, useConfirm } from '../components/ui';
import { href, navigate } from '../router';
import { relativeTime, useApp } from '../state';

type LiveBlock =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool'; id: string; name: string; summary: string; args: any; result?: { output: string; isError: boolean } }
  | { kind: 'permission'; req: PermissionRequest };

interface Live {
  user?: ChatMessage;
  memories?: RecalledMemory[];
  blocks: LiveBlock[];
  status?: string;
}

type Panel = { kind: 'artifact'; id: string; version?: number } | { kind: 'context' } | { kind: 'artifacts' } | null;

function greeting(): string {
  const h = new Date().getHours();
  return h < 5 ? 'Up late?' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function loadPanelWidth(): number {
  try {
    return Number(localStorage.getItem('mitzi.panelWidth')) || 560;
  } catch {
    return 560;
  }
}

export function ChatView({ routeId, projectId, botId }: { routeId?: string; projectId?: string; botId?: string }) {
  const app = useApp();
  const { toast, refreshChats, settings, projects, bots, models } = app;
  const [chatId, setChatId] = useState(routeId);
  const [chat, setChat] = useState<Chat>();
  const [loading, setLoading] = useState(!!routeId);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [live, setLive] = useState<Live | null>(null);
  const [lastError, setLastError] = useState<string>();
  const [panel, setPanel] = useState<Panel>(null);
  const [panelWidth, setPanelWidth] = useState(loadPanelWidth);
  const [expanded, setExpanded] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [contextVersion, setContextVersion] = useState(0);
  const [confirmNode, confirm] = useConfirm();

  // Settings for a chat that doesn't exist yet.
  const draftBot = bots.find((b) => b.id === (botId ?? DEFAULT_BOT_ID));
  const [draftModel, setDraftModel] = useState('');
  const [draftWeb, setDraftWeb] = useState(false);

  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const composer = useRef<ComposerHandle>(null);
  const currentId = useRef(chatId);
  currentId.current = chatId;
  // True when the open chat is still answering a request this page isn't streaming (e.g. after navigating back).
  const [background, setBackground] = useState(false);
  const running = !!live || background;

  // Follow route changes, except when we navigated to a chat we just created.
  useEffect(() => {
    if (routeId === chatId) return;
    setChatId(routeId);
    setChat(undefined);
    setArtifacts([]);
    setLive(null);
    setBackground(false);
    setLastError(undefined);
    setPanel(null);
    setExpanded(false);
    setLoading(!!routeId);
  }, [routeId, chatId]);

  useEffect(() => {
    setDraftModel(draftBot?.model ?? settings?.defaultModel ?? '');
  }, [draftBot?.model, settings?.defaultModel, botId]);

  const reload = useCallback(
    async (id: string) => {
      try {
        const [c, a] = await Promise.all([api.chat(id), api.artifacts({ chatId: id })]);
        if (currentId.current !== id) return;
        setChat(c);
        setArtifacts(a);
        return c;
      } catch (err) {
        toast((err as Error).message);
        if ((err as { status?: number }).status === 404) navigate({ page: 'new' }, true);
      } finally {
        setLoading(false);
      }
    },
    [toast],
  );

  useEffect(() => {
    if (chatId && chat?.id !== chatId) void reload(chatId).then((c) => c?.running && !live && setBackground(true));
  }, [chatId, chat?.id, reload]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll a chat that is responding elsewhere until it finishes.
  useEffect(() => {
    if (!background || !chatId) return;
    const timer = setInterval(async () => {
      const c = await reload(chatId);
      if (c && !c.running) {
        setBackground(false);
        void refreshChats();
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [background, chatId, reload, refreshChats]);

  // Keep the newest content in view while the user is at the bottom.
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  useEffect(() => {
    stick.current = true;
  }, [chatId]);

  const project = projects.find((p) => p.id === (chat?.projectId ?? projectId));
  const bot = bots.find((b) => b.id === (chat?.botId ?? botId ?? DEFAULT_BOT_ID));
  // The default bot is just "Mitzi"; custom bots get their own name and badge.
  const customBot = bot && !bot.builtIn ? bot : undefined;
  const model = chat?.model ?? draftModel;
  const webSearch = chat?.webSearch ?? draftWeb;
  const contextLength = models.find((m) => m.id === model)?.contextLength;

  const onEvent = useCallback((e: StreamEvent) => {
    switch (e.type) {
      case 'text':
      case 'reasoning':
        setLive((l) => {
          if (!l) return l;
          const blocks = [...l.blocks];
          const last = blocks.at(-1);
          if (last?.kind === e.type) blocks[blocks.length - 1] = { ...last, text: last.text + e.text };
          else blocks.push({ kind: e.type, text: e.text });
          return { ...l, blocks, status: undefined };
        });
        break;
      case 'tool_call':
        setLive((l) => l && { ...l, status: undefined, blocks: [...l.blocks, { kind: 'tool', id: e.id, name: e.name, summary: e.summary, args: e.args }] });
        break;
      case 'tool_result':
        setLive(
          (l) =>
            l && {
              ...l,
              blocks: l.blocks.map((b) => (b.kind === 'tool' && b.id === e.id ? { ...b, result: { output: e.output, isError: e.isError } } : b)),
            },
        );
        break;
      case 'permission':
        setLive((l) => l && { ...l, blocks: [...l.blocks, { kind: 'permission', req: e }] });
        break;
      case 'permission_resolved':
        setLive((l) => l && { ...l, blocks: l.blocks.filter((b) => !(b.kind === 'permission' && b.req.requestId === e.requestId)) });
        break;
      case 'artifact':
        setArtifacts((list) => [e.artifact, ...list.filter((a) => a.id !== e.artifact.id)]);
        setPanel({ kind: 'artifact', id: e.artifact.id });
        break;
      case 'status':
        setLive((l) => l && { ...l, status: e.message });
        break;
      case 'recall':
        setLive((l) => l && { ...l, memories: e.memories });
        break;
      case 'warn':
        toast(e.message, 'info');
        break;
      case 'error':
        setLastError(e.message);
        break;
      case 'chat':
        setChat((c) => (c && c.id === e.chat.id ? { ...c, title: e.chat.title } : c));
        void refreshChats();
        break;
    }
  }, [toast, refreshChats]);

  const runStream = async (id: string, start: (handler: (e: StreamEvent) => void) => Promise<void>, user?: ChatMessage) => {
    setLastError(undefined);
    stick.current = true;
    setLive({ user, blocks: [] });
    // Events keep arriving if the user switches chats mid-stream; only the open chat should see them.
    const handler = (e: StreamEvent) => currentId.current === id && onEvent(e);
    try {
      await start(handler);
    } catch (err) {
      if (currentId.current === id) setLastError((err as Error).message);
    } finally {
      if (currentId.current === id) {
        await reload(id);
        setLive(null);
        setContextVersion((v) => v + 1);
      }
      void refreshChats();
    }
  };

  const optimisticUser = (text: string, attachments: Attachment[]): ChatMessage => {
    const files = attachments.filter((a) => a.kind === 'text').map((a) => `<attachment name="${a.name}">\n${a.content}\n</attachment>`);
    const body = [...files, text].filter(Boolean).join('\n\n');
    const images = attachments.filter((a) => a.kind === 'image');
    return {
      role: 'user',
      content: images.length ? [{ type: 'text', text: body }, ...images.map((a) => ({ type: 'image_url' as const, image_url: { url: a.content } }))] : body,
    };
  };

  const send = async (text: string, attachments: Attachment[], editIndex?: number) => {
    let id = chatId;
    if (!id) {
      try {
        const created = await api.createChat({ projectId, botId, model: draftModel || undefined });
        if (draftWeb) await api.updateChat(created.id, { webSearch: true });
        const fresh = { ...created, webSearch: draftWeb };
        setChat(fresh);
        setChatId(fresh.id);
        id = fresh.id;
        navigate({ page: 'chat', id }, true);
      } catch (err) {
        toast((err as Error).message);
        return;
      }
    }
    if (editIndex !== undefined) setChat((c) => c && { ...c, messages: c.messages.slice(0, editIndex) });
    const chatIdNow = id;
    await runStream(chatIdNow, (h) => api.send(chatIdNow, { content: text, attachments, editIndex }, h), optimisticUser(text, attachments));
  };

  const regenerate = async () => {
    if (!chat) return;
    const lastUser = chat.messages.findLastIndex((m) => m.role === 'user');
    setChat({ ...chat, messages: chat.messages.slice(0, lastUser + 1) });
    await runStream(chat.id, (h) => api.regenerate(chat.id, h));
  };

  const stop = () => chatId && void api.stop(chatId).then(() => background && setBackground(false));

  const answerPermission = (requestId: string, answer: 'yes' | 'always' | 'no' | 'feedback', feedback?: string) => {
    if (chatId) api.answerPermission(chatId, requestId, answer, feedback).catch((err) => toast(err.message));
  };

  const updateChat = async (patch: Parameters<typeof api.updateChat>[1]) => {
    if (!chat) return;
    setChat({ ...chat, ...(patch as Partial<Chat>) });
    try {
      await api.updateChat(chat.id, patch);
      void refreshChats();
    } catch (err) {
      toast((err as Error).message);
    }
  };

  const deleteChat = async () => {
    if (!chat || !(await confirm(`“${chat.title}” and its artifacts will be permanently deleted.`, { title: 'Delete chat?' }))) return;
    await api.deleteChat(chat.id).catch((err) => toast(err.message));
    void refreshChats();
    navigate(chat.projectId ? { page: 'project', id: chat.projectId } : { page: 'new' });
  };

  const openArtifact = (a: Artifact, version?: number) => setPanel({ kind: 'artifact', id: a.id, version });
  const { turns, results } = useMemo(() => buildTurns(chat?.messages ?? [], chat?.contextStart ?? 0), [chat?.messages, chat?.contextStart]);
  const lastAssistant = turns.findLastIndex((t) => t.kind === 'assistant');
  const activeArtifact = panel?.kind === 'artifact' ? artifacts.find((a) => a.id === panel.id) : undefined;
  const isEmpty = !loading && !running && !(chat?.messages.length);

  const composerNode = (
    <Composer
      ref={composer}
      onSend={(t, a) => void send(t, a)}
      running={running}
      onStop={stop}
      model={model}
      onModelChange={(m) => (chat ? void updateChat({ model: m }) : setDraftModel(m))}
      webSearch={webSearch}
      onWebSearchChange={(on) => (chat ? void updateChat({ webSearch: on }) : setDraftWeb(on))}
      placeholder={customBot ? `Message ${customBot.name}…` : project ? `Message Mitzi in ${project.name}…` : undefined}
      autoFocus
      extra={chat && chat.messages.length > 0 && (
        <ContextRing used={chat.lastPromptTokens} total={contextLength} active={panel?.kind === 'context'} onClick={() => setPanel(panel?.kind === 'context' ? null : { kind: 'context' })} />
      )}
    />
  );

  // ---------- Header ----------
  const header = (
    <div className={`chat-header${scrolled ? ' scrolled' : ''}`}>
      {chat && !isEmpty ? (
        renaming ? (
          <input
            className="input chat-title-input"
            defaultValue={chat.title}
            autoFocus
            onBlur={(e) => {
              setRenaming(false);
              if (e.target.value.trim() && e.target.value !== chat.title) void updateChat({ title: e.target.value.trim() });
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setRenaming(false);
            }}
          />
        ) : (
          <button className="chat-title-btn" onClick={() => setRenaming(true)} title="Rename">
            {chat.title}
          </button>
        )
      ) : (
        <span />
      )}
      {project && !isEmpty && (
        <a className="badge" href={href({ page: 'project', id: project.id })}>
          <FolderOpen size={12} /> {project.name}
        </a>
      )}
      {customBot && !isEmpty && (
        <span className="badge">
          {customBot.emoji} {customBot.name}
        </span>
      )}
      <div className="header-spacer" />
      {artifacts.length > 0 && (
        <button className={`pill-btn${panel?.kind === 'artifacts' ? ' on' : ''}`} onClick={() => setPanel(panel?.kind === 'artifacts' ? null : { kind: 'artifacts' })}>
          <Layers size={15} />
          <span>
            {artifacts.length} artifact{artifacts.length === 1 ? '' : 's'}
          </span>
        </button>
      )}
      {chat && !isEmpty && (
        <Menu
          trigger={(_open, toggle) => (
            <button className="icon-btn" onClick={toggle} aria-label="Chat options">
              <MoreHorizontal size={18} />
            </button>
          )}
        >
          {(close) => (
            <>
              <button onClick={() => (close(), void updateChat({ pinned: !chat.pinned }))}>
                {chat.pinned ? <PinOff size={15} /> : <Pin size={15} />} {chat.pinned ? 'Unpin' : 'Pin'}
              </button>
              <button onClick={() => (close(), setRenaming(true))}>
                <Pencil size={15} /> Rename
              </button>
              {projects.length > 0 && <hr />}
              {projects
                .filter((p) => p.id !== chat.projectId)
                .slice(0, 6)
                .map((p) => (
                  <button key={p.id} onClick={() => (close(), void updateChat({ projectId: p.id }))}>
                    <FolderOpen size={15} /> Move to {p.name}
                  </button>
                ))}
              {chat.projectId && (
                <button onClick={() => (close(), void updateChat({ projectId: null }))}>
                  <X size={15} /> Remove from project
                </button>
              )}
              <hr />
              <button className="danger" onClick={() => (close(), void deleteChat())}>
                <Trash2 size={15} /> Delete chat
              </button>
            </>
          )}
        </Menu>
      )}
    </div>
  );

  // ---------- Welcome ----------
  const starters = project && !customBot ? [] : bot?.starters ?? [];
  const welcome = (
    <div className="welcome">
      <div className="welcome-inner">
        {customBot ? <div className="welcome-mark emoji">{customBot.emoji}</div> : <div className="welcome-mark">✻</div>}
        <h1 className="welcome-title">{customBot ? customBot.name : project ? project.name : `${greeting()}`}</h1>
        <p className="welcome-sub">
          {customBot ? customBot.description || 'How can I help?' : project ? project.description || 'Start a new chat in this project.' : 'How can I help you today?'}
        </p>
        <div className="context-chips">
          {project && (
            <a className="badge accent" href={href({ page: 'project', id: project.id })}>
              <FolderOpen size={12} /> {project.name}
              {project.files.length > 0 && ` · ${project.files.length} file${project.files.length === 1 ? '' : 's'}`}
            </a>
          )}
          {project?.folder && (
            <span className="badge ok" title={project.folder}>
              <Terminal size={12} /> Coding agent in {project.folder.split('/').slice(-2).join('/')}
            </span>
          )}
          {settings?.memoryEnabled && bot?.tools.memory && (
            <a className="badge" href={href({ page: 'memory', botId: bot.id })} title={`${bot.name}'s memory bank`}>
              <Brain size={12} /> Memory on
            </a>
          )}
        </div>
        {settings && !settings.hasApiKey && (
          <div className="error-box" style={{ marginBottom: 16, background: 'var(--warn-soft)', color: 'var(--warn)' }}>
            <KeyRound size={18} />
            <span style={{ flex: 1 }}>
              Add your OpenRouter API key to start chatting. <a href={href({ page: 'settings' })}>Open settings →</a>
            </span>
          </div>
        )}
        {composerNode}
        {starters.length > 0 && (
          <div className="starters">
            {starters.map((s) => (
              <button key={s} className="starter" onClick={() => composer.current?.setText(s)}>
                <Lightbulb size={15} />
                <span>{s}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  // ---------- Conversation ----------
  const liveTurn = live && (
    <>
      {live.user && <UserTurn message={live.user} />}
      <div className="turn turn-assistant">
        <Avatar bot={bot} />
        <div className="assistant-body">
          {live.memories && live.memories.length > 0 && <MemoryRecall memories={live.memories} botId={bot?.id} />}
          {live.blocks.map((b, i) => {
            if (b.kind === 'text') return <Markdown key={i} text={b.text} streaming={i === live.blocks.length - 1} />;
            if (b.kind === 'reasoning') return <Reasoning key={i} text={b.text} active={i === live.blocks.length - 1} />;
            if (b.kind === 'permission') return <PermissionCard key={b.req.requestId} req={b.req} onAnswer={(a, fb) => answerPermission(b.req.requestId, a, fb)} />;
            return (
              <ToolBlock
                key={b.id}
                id={b.id}
                name={b.name}
                args={b.args}
                summary={b.summary}
                result={b.result}
                running
                artifacts={artifacts}
                activeArtifact={activeArtifact?.id}
                onOpenArtifact={openArtifact}
              />
            );
          })}
          {(live.blocks.length === 0 || live.status || live.blocks.at(-1)?.kind === 'tool') && !live.blocks.some((b) => b.kind === 'permission') && (
            <div className="status-line">
              <span className="thinking-dots" aria-label="Thinking">
                <span />
                <span />
                <span />
              </span>
              {live.status}
            </div>
          )}
        </div>
      </div>
    </>
  );

  const conversation = (
    <>
      <div
        className="messages"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          setScrolled(el.scrollTop > 4);
        }}
      >
        <div className="messages-inner">
          {loading && (
            <div className="status-line" style={{ justifyContent: 'center', padding: 40 }}>
              <Loader2 className="spin" size={18} /> Loading conversation…
            </div>
          )}
          {turns.map((t, i) => {
            if (t.kind === 'divider') return <CompactDivider key={`d${i}`} count={t.count} summary={chat?.summary} />;
            if (t.kind === 'user')
              return <UserTurn key={`u${t.index}`} message={t.message} disabled={running} onEdit={(text, att) => void send(text, att, t.index)} />;
            return (
              <AssistantTurn
                key={`a${t.index}`}
                messages={t.messages}
                memories={t.memories}
                results={results}
                artifacts={artifacts}
                bot={bot}
                activeArtifact={activeArtifact?.id}
                onOpenArtifact={openArtifact}
                onRegenerate={!running && i === lastAssistant ? () => void regenerate() : undefined}
              />
            );
          })}
          {liveTurn}
          {background && !live && (
            <div className="turn turn-assistant">
              <Avatar bot={bot} />
              <div className="status-line">
                <span className="thinking-dots" aria-label="Responding">
                  <span />
                  <span />
                  <span />
                </span>
                Still responding…
              </div>
            </div>
          )}
          {lastError && !running && (
            <div className="turn">
              <div className="error-box">
                <AlertTriangle size={18} style={{ flexShrink: 0, marginTop: 1 }} />
                <span style={{ flex: 1 }}>{lastError}</span>
                {chat?.messages.length ? (
                  <button className="btn btn-sm" onClick={() => void regenerate()}>
                    Retry
                  </button>
                ) : null}
              </div>
            </div>
          )}
        </div>
      </div>
      {composerNode}
    </>
  );

  // ---------- Side panel ----------
  let panelNode: ReactNode = null;
  if (panel?.kind === 'artifact' && activeArtifact) {
    panelNode = (
      <ArtifactView
        artifact={activeArtifact}
        version={panel.version}
        onClose={() => {
          setPanel(null);
          setExpanded(false);
        }}
        expanded={expanded}
        onToggleExpand={() => setExpanded((x) => !x)}
      />
    );
  } else if (panel?.kind === 'context' && chat) {
    panelNode = <ContextPanel chatId={chat.id} refreshKey={contextVersion} onClose={() => setPanel(null)} onChanged={() => void reload(chat.id)} />;
  } else if (panel?.kind === 'artifacts') {
    panelNode = (
      <>
        <div className="panel-head">
          <Layers size={18} className="muted" />
          <div className="panel-title">Artifacts in this chat</div>
          <button className="icon-btn sm" onClick={() => setPanel(null)} aria-label="Close">
            <X size={15} />
          </button>
        </div>
        <div className="panel-body artifact-list-panel">
          {artifacts.map((a) => (
            <button key={a.id} className="artifact-card" style={{ maxWidth: 'none' }} onClick={() => openArtifact(a)}>
              <span className="artifact-icon">
                <ArtifactIcon type={a.type} />
              </span>
              <span style={{ minWidth: 0, flex: 1 }}>
                <div className="t">{a.title}</div>
                <div className="s">
                  {TYPE_LABEL[a.type]} · v{a.versions.length} · {relativeTime(a.updatedAt)}
                </div>
              </span>
            </button>
          ))}
        </div>
      </>
    );
  }

  return (
    <div className="chat-layout">
      {!expanded && (
        <div className="chat-col">
          {header}
          {isEmpty ? welcome : conversation}
        </div>
      )}
      {panelNode && (
        <aside className={`side-panel${expanded ? ' full' : ''}`} style={expanded ? undefined : { width: panelWidth }}>
          {!expanded && <ResizeHandle width={panelWidth} onChange={setPanelWidth} />}
          {panelNode}
        </aside>
      )}
      {confirmNode}
    </div>
  );
}

function Reasoning({ text, active }: { text: string; active: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="tool" style={{ background: 'transparent' }}>
      <button className="tool-head" onClick={() => setOpen((o) => !o)}>
        <span className="tool-icon">{active ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}</span>
        <span className="tool-name">{active ? 'Thinking…' : 'Thought process'}</span>
        <span className="tool-summary" />
        {open ? <ChevronDown size={14} className="muted" /> : <ChevronRight size={14} className="muted" />}
      </button>
      {open && (
        <div className="tool-body">
          <pre style={{ fontFamily: 'var(--font)', fontStyle: 'italic' }}>{text}</pre>
        </div>
      )}
    </div>
  );
}

function ResizeHandle({ width, onChange }: { width: number; onChange(w: number): void }) {
  const [dragging, setDragging] = useState(false);
  return (
    <div
      className={`resize-handle${dragging ? ' dragging' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      onPointerDown={(e) => {
        e.preventDefault();
        const startX = e.clientX;
        const startW = width;
        setDragging(true);
        const move = (ev: PointerEvent) => onChange(Math.min(Math.max(startW + (startX - ev.clientX), 340), window.innerWidth - 420));
        const up = () => {
          setDragging(false);
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          try {
            localStorage.setItem('mitzi.panelWidth', String(Math.round((document.querySelector('.side-panel') as HTMLElement)?.offsetWidth ?? startW)));
          } catch {
            // Not persisted.
          }
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      }}
    />
  );
}

