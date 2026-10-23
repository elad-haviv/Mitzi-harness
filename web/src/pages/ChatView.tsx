import {
  AlertTriangle,
  Brain,
  ChevronDown,
  ChevronRight,
  AudioLines,
  Download,
  CalendarClock,
  FolderOpen,
  GitBranch,
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
import { api, Artifact, Attachment, Chat, ChatMessage, DEFAULT_BOT_ID, RecalledMemory, RepoStatus, StreamEvent } from '../api';
import { ImportModal } from '../components/Import';
import { LiveMode } from '../components/LiveMode';
import { ProjectChip } from '../components/ProjectChip';
import { speaker } from '../speech';
import { ArtifactIcon, ArtifactView, TYPE_LABEL } from '../components/Artifacts';
import { Composer, ComposerHandle, ContextRing } from '../components/Composer';
import { ContextPanel } from '../components/ContextPanel';
import { Markdown } from '../components/Markdown';
import { AssistantTurn, Avatar, buildTurns, messageText, Reasoning, CompactDivider, MemoryRecall, PermissionCard, PermissionRequest, ToolBlock, UserTurn } from '../components/Messages';
import { Menu, useConfirm } from '../components/ui';
import { href, navigate } from '../router';
import { LOGO, relativeTime, useApp } from '../state';

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

export function ChatView({
  routeId,
  projectId,
  botId,
  embedded,
  focus,
  placeholder,
  onArtifact,
  onTurnDone,
  sendRef,
}: {
  routeId?: string;
  projectId?: string;
  botId?: string;
  /** Shown inside another page (a document's chat): no header or side panel. */
  embedded?: boolean;
  /** The artifact open beside an embedded chat; messages sent here are about it. */
  focus?: string;
  placeholder?: string;
  /** Told about artifacts the bot creates or changes. */
  onArtifact?(a: Artifact): void;
  onTurnDone?(): void;
  /** Lets the host page send messages into this chat. */
  sendRef?: { current?: (text: string) => void };
}) {
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
  const [liveMode, setLiveMode] = useState(false);
  const [importing, setImporting] = useState(false);
  const onArtifactRef = useRef(onArtifact);
  onArtifactRef.current = onArtifact;

  useEffect(() => {
    speaker.useServer = !!settings?.media.speechModel;
  }, [settings?.media.speechModel]);
  // Stop reading aloud when leaving the chat.
  useEffect(() => () => speaker.stop(), [routeId]);

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
        onArtifactRef.current?.(e.artifact);
        // Beside a workspace, the artifact is already on screen.
        if (!embedded) setPanel({ kind: 'artifact', id: e.artifact.id });
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

  /** Streams a turn; resolves to the reloaded chat. */
  const runStream = async (id: string, start: (handler: (e: StreamEvent) => void) => Promise<void>, user?: ChatMessage): Promise<Chat | undefined> => {
    let result: Chat | undefined;
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
        result = await reload(id);
        setLive(null);
        setContextVersion((v) => v + 1);
      }
      void refreshChats();
      onTurnDone?.();
    }
    return result;
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

  /** Sends a message; resolves to the answer's text. */
  const send = async (text: string, attachments: Attachment[], editIndex?: number): Promise<string | undefined> => {
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
        return undefined;
      }
    }
    if (editIndex !== undefined) setChat((c) => c && { ...c, messages: c.messages.slice(0, editIndex) });
    const chatIdNow = id;
    const after = await runStream(chatIdNow, (h) => api.send(chatIdNow, { content: text, attachments, editIndex, focus }, h), optimisticUser(text, attachments));
    if (!after) return undefined;
    const lastUser = after.messages.findLastIndex((m) => m.role === 'user');
    return after.messages
      .slice(lastUser + 1)
      .filter((m) => m.role === 'assistant')
      .map(messageText)
      .filter(Boolean)
      .join('\n\n');
  };

  if (sendRef) sendRef.current = (text: string) => void send(text, []);

  const branch = async (index: number) => {
    if (!chat) return;
    try {
      const created = await api.branch(chat.id, index);
      void refreshChats();
      toast('Branched into a new chat. The original is unchanged.', 'info');
      navigate({ page: 'chat', id: created.id });
    } catch (err) {
      toast((err as Error).message);
    }
  };

  const rate = async (index: number, value: 1 | -1 | 0, comment?: string) => {
    if (!chat) return;
    const id = chat.id;
    setChat((c) =>
      c && {
        ...c,
        messages: c.messages.map((m, i) => (i === index ? { ...m, rating: value ? { value, comment, ratedAt: new Date().toISOString() } : undefined } : m)),
      },
    );
    try {
      await api.rate(id, index, value, comment);
      // The lesson is distilled in the background; pick it up shortly.
      if (value) setTimeout(() => currentId.current === id && !live && void reload(id), 4000);
    } catch (err) {
      toast((err as Error).message);
    }
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

  const openArtifact = (a: Artifact, version?: number) => (embedded ? navigate({ page: 'artifact', id: a.id }) : setPanel({ kind: 'artifact', id: a.id, version }));
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
      leading={
        !embedded && (
          <ProjectChip
            projectId={chat?.projectId ?? projectId}
            onChange={(id) =>
              chat ? void updateChat({ projectId: id }) : navigate({ page: 'new', projectId: id ?? undefined, botId }, true)
            }
          />
        )
      }
      placeholder={placeholder ?? (customBot ? `Message ${customBot.name}…` : project ? `Message Mitzi in ${project.name}…` : undefined)}
      autoFocus
      extra={
        <>
          {chat && chat.messages.length > 0 && !embedded && (
            <ContextRing used={chat.lastPromptTokens} total={contextLength} active={panel?.kind === 'context'} onClick={() => setPanel(panel?.kind === 'context' ? null : { kind: 'context' })} />
          )}
          <button className="icon-btn" title="Live conversation: talk and listen hands-free" aria-label="Start live conversation" onClick={() => setLiveMode(true)} disabled={running}>
            <AudioLines size={18} />
          </button>
        </>
      }
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
  const showStarters = !(project && !customBot);
  const welcome = (
    <div className="welcome">
      <div className="welcome-inner">
        {customBot ? <div className="welcome-mark emoji">{customBot.emoji}</div> : <div className="welcome-mark">{LOGO}</div>}
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
              <Terminal size={12} /> Coding agent in {project.folder.split(/[\\/]/).slice(-2).join('/')}
            </span>
          )}
          {project?.folder && <RepoBadge projectId={project.id} />}
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
              Add an API key for OpenRouter or another provider to start chatting. <a href={href({ page: 'settings' })}>Open settings →</a>
            </span>
          </div>
        )}
        {composerNode}
        {showStarters && bot && <Starters botId={bot.id} onPick={(s) => composer.current?.setText(s)} />}
        {!app.chats.length && !project && (
          <button className="link-btn small import-nudge" onClick={() => setImporting(true)}>
            <Download size={13} /> Coming from ChatGPT, Claude or Gemini? Bring your memories and chats
          </button>
        )}
        {importing && <ImportModal onClose={() => setImporting(false)} onDone={() => void app.refreshChats()} />}
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
          {chat?.branchedFrom && (
            <div className="origin-banner">
              <GitBranch size={14} />
              <span>
                Branched from <a href={href({ page: 'chat', id: chat.branchedFrom.chatId })}>{chat.branchedFrom.title}</a>
              </span>
            </div>
          )}
          {chat?.imported && (
            <div className="origin-banner">
              <Download size={14} />
              <span>Imported from {chat.imported.source === 'chatgpt' ? 'ChatGPT' : 'Claude'}. You can continue it here.</span>
            </div>
          )}
          {chat?.taskId && (
            <div className="origin-banner">
              <CalendarClock size={14} />
              <span>
                Created by a <a href={href({ page: 'tasks' })}>scheduled task</a>
              </span>
            </div>
          )}
          {turns.map((t, i) => {
            if (t.kind === 'divider') return <CompactDivider key={`d${i}`} count={t.count} summary={chat?.summary} />;
            if (t.kind === 'user')
              return <UserTurn key={`u${t.index}`} message={t.message} disabled={running} onEdit={(text, att) => void send(text, att, t.index)} />;
            return (
              <AssistantTurn
                key={`a${t.index}`}
                id={`${chat?.id}:${t.index}`}
                messages={t.messages}
                memories={t.memories}
                results={results}
                artifacts={artifacts}
                bot={bot}
                activeArtifact={activeArtifact?.id}
                onOpenArtifact={openArtifact}
                onRegenerate={!running && i === lastAssistant ? () => void regenerate() : undefined}
                onBranch={!running && !embedded ? () => void branch(t.lastIndex) : undefined}
                onRate={chat ? (v, c) => void rate(t.lastIndex, v, c) : undefined}
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
        onOpenWorkspace={() => navigate({ page: 'artifact', id: activeArtifact.id })}
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

  const live_ = liveMode && (
    <LiveMode
      title={customBot?.name ?? 'Mitzi'}
      emoji={customBot?.emoji}
      onSend={(text) => send(text, [])}
      onInterrupt={stop}
      onClose={() => setLiveMode(false)}
    />
  );

  if (embedded) {
    return (
      <div className="chat-col embedded">
        {isEmpty ? (
          <div className="embedded-empty">
            <div className="muted small">Ask {customBot?.name ?? 'Mitzi'} to draft, rewrite, review or answer your comments. Changes appear on the left.</div>
            {composerNode}
          </div>
        ) : (
          conversation
        )}
        {live_}
        {confirmNode}
      </div>
    );
  }

  return (
    <div className="chat-layout">
      {live_}
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

/** Starters written from the bot's memories and recent chats (or its fixed ones until it knows you). */
function Starters({ botId, onPick }: { botId: string; onPick(text: string): void }) {
  const { bots } = useApp();
  const fixed = bots.find((b) => b.id === botId)?.starters ?? [];
  const [state, setState] = useState<{ starters: string[]; personalized: boolean } | 'loading'>('loading');
  const load = useCallback(
    (refresh = false) => {
      setState('loading');
      api.starters(botId, refresh).then(setState, () => setState({ starters: fixed, personalized: false }));
    },
    [botId], // eslint-disable-line react-hooks/exhaustive-deps
  );
  useEffect(() => load(), [load]);

  if (state === 'loading') {
    return (
      <div className="starters" aria-busy="true" aria-label="Loading suggestions">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="starter skeleton" />
        ))}
      </div>
    );
  }
  if (!state.starters.length) return null;
  return (
    <>
      <div className="starters">
        {state.starters.map((s) => (
          <button key={s} className="starter" onClick={() => onPick(s)}>
            {state.personalized ? <Sparkles size={15} /> : <Lightbulb size={15} />}
            <span>{s}</span>
          </button>
        ))}
      </div>
      {state.personalized && (
        <div className="starters-note">
          <Brain size={12} /> Suggested from your recent conversations
          <button className="link-btn" onClick={() => load(true)}>
            New ideas
          </button>
        </div>
      )}
    </>
  );
}

/** Branch and state of a project's git repository. */
function RepoBadge({ projectId }: { projectId: string }) {
  const [status, setStatus] = useState<RepoStatus | null>(null);
  useEffect(() => {
    api.repoStatus(projectId).then(setStatus, () => setStatus(null));
  }, [projectId]);
  if (!status?.branch) return null;
  const bits = [status.changed && `${status.changed} changed`, status.ahead && `${status.ahead} to push`, status.behind && `${status.behind} to pull`].filter(Boolean);
  return (
    <a className="badge" href={href({ page: 'project', id: projectId })} title={status.remote ?? 'Local repository'}>
      <GitBranch size={12} /> {status.branch}
      {bits.length ? ` · ${bits.join(' · ')}` : ''}
    </a>
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

