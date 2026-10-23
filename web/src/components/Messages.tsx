import {
  AlertTriangle,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleDot,
  FileText,
  FolderOpen,
  GitBranch,
  Globe,
  ImageIcon,
  Music,
  Square,
  Star,
  ThumbsDown,
  ThumbsUp,
  Video,
  Volume2,
  History,
  Loader2,
  MessageSquare,
  Paperclip,
  Pencil,
  Plug,
  WandSparkles,
  RefreshCw,
  Search,
  Sparkles,
  ShieldCheck,
  Terminal,
  Wrench,
  X,
  Zap,
  Code2,
} from 'lucide-react';
import { AskedCard } from './Questions';
import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import type { Artifact, Attachment, Bot, ChatMessage, ContentPart, Rating, RecalledMemory, RouteChoice, Todo } from '../api';
import { speaker, useSpeaking } from '../speech';
import { href } from '../router';
import { LOGO, modelLabel, useApp } from '../state';
import { ArtifactIcon, TYPE_LABEL } from './Artifacts';
import { CopyButton, Markdown } from './Markdown';
import { Diff, useAutoResize } from './ui';
import { SubagentsCard, TeamCard, TeamProgress } from './Team';
import { AutoMessage, LoopBadge, ReviewBox } from './Feedback';
import { clock, PlanCard, StatsLine, useChatActions, useElapsed } from './Work';

// ---------- Content helpers ----------

const ATTACHMENT_RE = /<attachment name="([^"]*)">\n([\s\S]*?)\n<\/attachment>(\n\n)?/g;

export function splitUserContent(content: ChatMessage['content']): { text: string; attachments: Attachment[] } {
  const parts: ContentPart[] = typeof content === 'string' ? [{ type: 'text', text: content }] : content ?? [];
  const attachments: Attachment[] = [];
  let text = '';
  for (const p of parts) {
    if (p.type === 'image_url') attachments.push({ name: 'image', content: p.image_url.url, kind: 'image' });
    else
      text += p.text.replace(ATTACHMENT_RE, (_m, name: string, body: string) => {
        attachments.push({ name, content: body, kind: 'text' });
        return '';
      });
  }
  return { text: text.trim(), attachments };
}

/** When a message was sent: the time today, the date and time before. */
export function MessageTime({ ts }: { ts?: number }) {
  if (!ts) return null;
  const d = new Date(ts);
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const label =
    d.toDateString() === now.toDateString()
      ? time
      : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) })}, ${time}`;
  return (
    <time className="msg-time" dateTime={d.toISOString()} title={d.toLocaleString()}>
      {label}
    </time>
  );
}

export function messageText(m: ChatMessage): string {
  if (typeof m.content === 'string') return m.content;
  return (m.content ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('');
}

function parseArgs(raw: string): any {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

export function looksLikeError(output: string): boolean {
  return /^(Error:|Skipped:|Permission to use|The user declined|The user interrupted|Plan mode is active)/.test(output);
}

// ---------- Turn model ----------

export interface ToolResult {
  output: string;
  isError: boolean;
}

export type Turn =
  | { kind: 'user'; index: number; message: ChatMessage }
  | { kind: 'assistant'; index: number; lastIndex: number; messages: ChatMessage[]; memories?: RecalledMemory[] }
  | { kind: 'divider'; count: number };

export function buildTurns(messages: ChatMessage[], contextStart: number): { turns: Turn[]; results: Map<string, ToolResult> } {
  const turns: Turn[] = [];
  const results = new Map<string, ToolResult>();
  messages.forEach((m, i) => {
    if (i === contextStart && contextStart > 0) turns.push({ kind: 'divider', count: contextStart });
    if (m.role === 'tool') {
      const output = messageText(m);
      if (m.tool_call_id) results.set(m.tool_call_id, { output, isError: looksLikeError(output) });
      return;
    }
    // Screenshots sent to the model belong to the answer in progress; its tool calls show them.
    if (m.role === 'user' && m.auto === 'images') return;
    if (m.role === 'user') return void turns.push({ kind: 'user', index: i, message: m });
    if (m.role === 'assistant') {
      const last = turns.at(-1);
      if (last?.kind === 'assistant') {
        last.messages.push(m);
        last.lastIndex = i;
      }
      // An answer shows the memories recalled for the message it answers.
      else turns.push({ kind: 'assistant', index: i, lastIndex: i, messages: [m], memories: last?.kind === 'user' ? last.message.memories : undefined });
    }
  });
  if (contextStart > 0 && contextStart >= messages.length) turns.push({ kind: 'divider', count: contextStart });
  return { turns, results };
}

// ---------- User turn ----------

export function AttachmentChips({ attachments, onRemove }: { attachments: Attachment[]; onRemove?(i: number): void }) {
  const files = attachments.map((a, i) => ({ a, i })).filter((x) => x.a.kind === 'text');
  if (!files.length) return null;
  return (
    <div className="attachment-chips">
      {files.map(({ a, i }) => (
        <span key={i} className="chip" title={a.name}>
          <Paperclip size={13} />
          <span>{a.name}</span>
          {onRemove && (
            <button onClick={() => onRemove(i)} aria-label={`Remove ${a.name}`}>
              <X size={13} />
            </button>
          )}
        </span>
      ))}
    </div>
  );
}

export function UserTurn({
  message,
  onEdit,
  disabled,
}: {
  message: ChatMessage;
  onEdit?(text: string, attachments: Attachment[]): void;
  disabled?: boolean;
}) {
  if (message.auto) return <AutoMessage message={message} />;
  return <UserBubble message={message} onEdit={onEdit} disabled={disabled} />;
}

function UserBubble({ message, onEdit, disabled }: { message: ChatMessage; onEdit?(text: string, attachments: Attachment[]): void; disabled?: boolean }) {
  const { text, attachments } = useMemo(() => splitUserContent(message.content), [message.content]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const [showPrompt, setShowPrompt] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useAutoResize(ref, draft);
  const images = attachments.filter((a) => a.kind === 'image');

  return (
    <div className="turn turn-user">
      {images.length > 0 && (
        <div className="bubble-images">
          {images.map((img, i) => (
            <img key={i} src={img.content} alt="Attached" />
          ))}
        </div>
      )}
      <AttachmentChips attachments={attachments} />
      {editing ? (
        <div className="edit-box">
          <textarea
            ref={ref}
            className="textarea"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                setEditing(false);
                onEdit?.(draft, attachments);
              } else if (e.key === 'Escape') setEditing(false);
            }}
          />
          <div className="row">
            <button className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button
              className="btn btn-primary btn-sm"
              disabled={!draft.trim()}
              onClick={() => {
                setEditing(false);
                onEdit?.(draft, attachments);
              }}
            >
              Send
            </button>
          </div>
        </div>
      ) : message.command ? (
        <>
          <button className="command-chip" onClick={() => setShowPrompt((v) => !v)} title="Show the full prompt">
            {message.command} {showPrompt ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
          {showPrompt && <div className="bubble small">{text}</div>}
        </>
      ) : (
        text && (
          <div className="bubble" dir="auto">
            {text}
          </div>
        )
      )}
      {!editing && (
        <div className="msg-actions">
          <CopyButton text={() => text} />
          {onEdit && !disabled && !message.command && (
            <button
              className="icon-btn sm"
              title="Edit message"
              aria-label="Edit message"
              onClick={() => {
                setDraft(text);
                setEditing(true);
              }}
            >
              <Pencil size={14} />
            </button>
          )}
          <MessageTime ts={message.ts} />
        </div>
      )}
    </div>
  );
}

// ---------- Assistant turn ----------

export function Avatar({ bot }: { bot?: Bot }) {
  return bot && !bot.builtIn ? <div className="avatar emoji">{bot.emoji}</div> : <div className="avatar">{LOGO}</div>;
}

const MEMORY_TYPE_LABEL: Record<RecalledMemory['type'], string> = { world: 'Fact', experience: 'Experience', observation: 'Belief' };

/** Shows which memories were recalled for a message, and why. */
export function MemoryRecall({ memories, botId }: { memories: RecalledMemory[]; botId?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="recall">
      <button className="memory-chip" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Brain size={14} />
        <span>
          Recalled {memories.length} {memories.length === 1 ? 'memory' : 'memories'}
        </span>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
      {open && (
        <div className="recall-list">
          {memories.map((m) => (
            <div key={m.id} className="recall-item">
              <span className={`mem-type ${m.type}`}>{MEMORY_TYPE_LABEL[m.type]}</span>
              <span className="grow">{m.text}</span>
              {m.strategies && <span className="muted small">{m.strategies.join(' · ')}</span>}
            </div>
          ))}
          {botId && (
            <a className="small" href={href({ page: 'memory', botId })}>
              Open memory bank →
            </a>
          )}
        </div>
      )}
    </div>
  );
}

export function AssistantTurn({
  id,
  messages,
  memories,
  results,
  artifacts,
  bot,
  activeArtifact,
  onOpenArtifact,
  onRegenerate,
  onBranch,
  onRate,
  reviewIndex,
}: {
  /** Index of the turn's last message, when it can be reviewed in a feedback loop. */
  reviewIndex?: number;
  /** Stable id for read-aloud. */
  id: string;
  messages: ChatMessage[];
  memories?: RecalledMemory[];
  results: Map<string, ToolResult>;
  artifacts: Artifact[];
  bot?: Bot;
  activeArtifact?: string;
  onOpenArtifact(a: Artifact, version: number): void;
  onRegenerate?(): void;
  onBranch?(): void;
  onRate?(value: 1 | -1 | 0, comment?: string): void;
}) {
  const { models } = useApp();
  const text = messages.map(messageText).filter(Boolean).join('\n\n');
  const model = messages.find((m) => m.model)?.model;
  const rating = messages.at(-1)?.rating;
  const stats = messages.at(-1)?.stats;
  const route = messages.findLast((m) => m.route)?.route;
  const actions = useChatActions();
  const loopId = messages.at(-1)?.feedbackLoopId;
  const loop = loopId ? actions?.loops.find((l) => l.id === loopId) : undefined;
  const [reviewing, setReviewing] = useState(false);
  return (
    <div className="turn turn-assistant">
      <Avatar bot={bot} />
      <div className="assistant-body">
        {memories && memories.length > 0 && <MemoryRecall memories={memories} botId={bot?.id} />}
        {messages.map((m, i) => (
          <AssistantMessageBody key={i} message={m} results={results} artifacts={artifacts} activeArtifact={activeArtifact} onOpenArtifact={onOpenArtifact} />
        ))}
        <div className="msg-actions">
          <MessageTime ts={messages.at(-1)?.ts} />
          {text && <CopyButton text={() => text} label="Copy response" />}
          {text && <ReadAloudButton id={id} text={text} />}
          {onRate && <RateButtons rating={rating} onRate={onRate} />}
          {onBranch && (
            <button className="icon-btn sm" title="Branch from here: a new chat with the conversation up to this answer" aria-label="Branch from here" onClick={onBranch}>
              <GitBranch size={14} />
            </button>
          )}
          {onRegenerate && (
            <button className="icon-btn sm" title="Regenerate" aria-label="Regenerate response" onClick={onRegenerate}>
              <RefreshCw size={14} />
            </button>
          )}
          {reviewIndex !== undefined && actions && (
            <button
              className={`icon-btn sm review-btn${reviewing ? ' on' : ''}`}
              title="Rate this result and, if it isn’t right, have it redone with your directions"
              aria-label="Review this result"
              onClick={() => setReviewing((r) => !r)}
            >
              <Star size={14} /> <span>Review</span>
            </button>
          )}
          {route ? <RouteBadge route={route} /> : model && <span className="meta">{modelLabel(model, models)}</span>}
          {stats && <StatsLine stats={stats} />}
        </div>
        {loop && reviewIndex !== undefined && <LoopBadge loop={loop} index={reviewIndex} />}
        {reviewing && reviewIndex !== undefined && <ReviewBox index={reviewIndex} loop={loop} onDone={() => setReviewing(false)} />}
        {rating?.lesson && (
          <div className="lesson-note" title="Saved to this bot's lessons; you can remove it on the Bots page">
            <Brain size={13} /> Learned: {rating.lesson}
          </div>
        )}
      </div>
    </div>
  );
}

/** Which model Auto picked for an answer, and why. */
export function RouteBadge({ route }: { route: RouteChoice }) {
  const { models } = useApp();
  const name = modelLabel(route.model, models);
  return (
    <span className={`route-badge ${route.tier}`} title={`Auto picked ${name} (${route.model}): ${route.reason.toLowerCase()}`}>
      {route.tier === 'fast' ? <Zap size={11} /> : <Sparkles size={11} />}
      Auto · {name}
    </span>
  );
}

export function ReadAloudButton({ id, text }: { id: string; text: string }) {
  const speaking = useSpeaking(id);
  const { toast } = useApp();
  return (
    <button
      className={`icon-btn sm${speaking ? ' on' : ''}`}
      title={speaking ? 'Stop reading' : 'Read aloud'}
      aria-label={speaking ? 'Stop reading' : 'Read aloud'}
      onClick={() => (speaking ? speaker.stop() : void speaker.speak(id, text).catch((err) => toast(err.message)))}
    >
      {speaking ? <Square size={13} /> : <Volume2 size={14} />}
    </button>
  );
}

function RateButtons({ rating, onRate }: { rating?: Rating; onRate(value: 1 | -1 | 0, comment?: string): void }) {
  const [asking, setAsking] = useState<1 | -1 | null>(null);
  const [comment, setComment] = useState('');
  const wrap = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!asking) return;
    const onDown = (e: MouseEvent) => !wrap.current?.contains(e.target as Node) && setAsking(null);
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [asking]);
  const click = (v: 1 | -1) => {
    if (rating?.value === v) return onRate(0);
    onRate(v);
    setComment('');
    setAsking(v);
  };
  const submit = () => {
    if (asking && comment.trim()) onRate(asking, comment.trim());
    setAsking(null);
  };
  return (
    <span className="menu-wrap" ref={wrap}>
      <button className={`icon-btn sm${rating?.value === 1 ? ' on' : ''}`} title="Good response" aria-label="Good response" aria-pressed={rating?.value === 1} onClick={() => click(1)}>
        <ThumbsUp size={14} />
      </button>
      <button className={`icon-btn sm${rating?.value === -1 ? ' on' : ''}`} title="Bad response" aria-label="Bad response" aria-pressed={rating?.value === -1} onClick={() => click(-1)}>
        <ThumbsDown size={14} />
      </button>
      {asking && (
        <form
          className="rate-pop"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="small">{asking === 1 ? 'What did you like?' : 'What could be better?'} <span className="muted">(optional)</span></div>
          <textarea
            className="textarea"
            autoFocus
            rows={3}
            value={comment}
            placeholder={asking === 1 ? 'e.g. Great examples, just the right length' : 'e.g. Too long; skip the intro and show code'}
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              } else if (e.key === 'Escape') setAsking(null);
            }}
          />
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAsking(null)}>
              Skip
            </button>
            <button className="btn btn-primary btn-sm" disabled={!comment.trim()}>
              Send feedback
            </button>
          </div>
        </form>
      )}
    </span>
  );
}

const MEDIA_RE = /^MEDIA: (\/media\/[a-f0-9]{32}\.\w+) (\S+)$/gm;

export function mediaFrom(output?: string): { url: string; mime: string }[] {
  return output ? [...output.matchAll(MEDIA_RE)].map((m) => ({ url: m[1], mime: m[2] })) : [];
}

export function MediaPreview({ url, mime, caption }: { url: string; mime: string; caption?: string }) {
  return (
    <figure className="media-card">
      {mime.startsWith('image/') ? (
        <a href={url} target="_blank" rel="noreferrer">
          <img src={url} alt={caption ?? 'Generated image'} loading="lazy" />
        </a>
      ) : mime.startsWith('video/') ? (
        <video src={url} controls playsInline preload="metadata" />
      ) : (
        <audio src={url} controls preload="metadata" />
      )}
      {caption && (
        <figcaption>
          <span className="grow">{caption}</span>
          <a href={url} download className="small">
            Download
          </a>
        </figcaption>
      )}
    </figure>
  );
}

function AssistantMessageBody({
  message,
  results,
  artifacts,
  activeArtifact,
  onOpenArtifact,
}: {
  message: ChatMessage;
  results: Map<string, ToolResult>;
  artifacts: Artifact[];
  activeArtifact?: string;
  onOpenArtifact(a: Artifact, version: number): void;
}) {
  const text = messageText(message);
  return (
    <>
      {message.reasoning?.trim() && <Reasoning text={message.reasoning} />}
      {text && <Markdown text={text} />}
      {message.tool_calls?.map((call) => (
        <ToolBlock
          key={call.id}
          id={call.id}
          name={call.function.name}
          args={parseArgs(call.function.arguments)}
          result={results.get(call.id)}
          artifacts={artifacts}
          activeArtifact={activeArtifact}
          onOpenArtifact={onOpenArtifact}
        />
      ))}
    </>
  );
}

// ---------- Thinking ----------

/** The model's thinking, collapsed by default. While it streams, the latest line shows as a preview. */
export function Reasoning({ text, active }: { text: string; active?: boolean }) {
  const [open, setOpen] = useState(false);
  const started = useRef(Date.now());
  const seconds = useElapsed(started.current, !!active);
  const preview = active ? (text.trim().split('\n').filter(Boolean).at(-1) ?? '').replace(/[*_#`>]/g, '').slice(0, 120) : '';
  return (
    <div className="tool reasoning">
      <button className="tool-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="tool-icon">{active ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}</span>
        <span className="tool-name">{active ? <>Thinking… <span className="muted">{clock(seconds)}</span></> : 'Thought process'}</span>
        <span className="tool-summary">{!open && preview}</span>
        {open ? <ChevronDown size={14} className="muted" /> : <ChevronRight size={14} className="muted" />}
      </button>
      {open && (
        <div className="tool-body reasoning-body">
          <Markdown text={text} streaming={active} />
        </div>
      )}
    </div>
  );
}

// ---------- Tools ----------

function toolIcon(name: string): ReactNode {
  switch (name) {
    case 'Read':
      return <FileText size={13} />;
    case 'Write':
    case 'Edit':
      return <Pencil size={13} />;
    case 'Bash':
      return <Terminal size={13} />;
    case 'Python':
      return <Code2 size={13} />;
    case 'Glob':
    case 'Grep':
      return <Search size={13} />;
    case 'LS':
      return <FolderOpen size={13} />;
    case 'WebFetch':
    case 'Browser':
      return <Globe size={13} />;
    case 'Workflow':
      return <Sparkles size={13} />;
    case 'Memory':
      return <Brain size={13} />;
    case 'Skill':
      return <WandSparkles size={13} />;
    case 'GenerateImage':
      return <ImageIcon size={13} />;
    case 'GenerateVideo':
      return <Video size={13} />;
    case 'GenerateSpeech':
    case 'GenerateSound':
    case 'GenerateMusic':
      return <Music size={13} />;
    case 'ArtifactComment':
      return <MessageSquare size={13} />;
    default:
      return name.startsWith('mcp__') ? <Plug size={13} /> : <Wrench size={13} />;
  }
}

/** "mcp__notion__search" → "notion · search". */
function displayName(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? `${m[1].replace(/_/g, ' ')} · ${m[2]}` : name;
}

function toolSummary(name: string, args: any, fallback?: string): string {
  if (fallback) return fallback;
  if (name === 'ArtifactComment') return `${args.action ?? ''}${args.text ? `: ${args.text}` : ''}`;
  if (name === 'Browser') return args.action === 'open' ? `open ${args.url ?? ''}` : args.ref !== undefined ? `${args.action} element ${args.ref}${args.text ? `: “${args.text}”` : ''}` : String(args.action ?? '');
  if (name === 'Workflow') return `${args.workflow ?? ''}${args.input ? `: ${args.input}` : ''}`;
  return args.file_path ?? args.command ?? args.pattern ?? args.url ?? args.path ?? args.prompt ?? args.text ?? '';
}

function ToolInput({ name, args }: { name: string; args: any }) {
  if (name === 'Edit' && typeof args.old_string === 'string') {
    const diff = [...String(args.old_string).split('\n').map((l) => `- ${l}`), ...String(args.new_string ?? '').split('\n').map((l) => `+ ${l}`)].join('\n');
    return <Diff text={diff} />;
  }
  if (name === 'Write' && typeof args.content === 'string') {
    const lines = args.content.split('\n');
    return <Diff text={lines.slice(0, 60).map((l: string) => `+ ${l}`).join('\n') + (lines.length > 60 ? `\n… ${lines.length - 60} more lines` : '')} />;
  }
  if (name === 'Bash') return <pre>$ {args.command}</pre>;
  if (name === 'Python' && typeof args.code === 'string') return <Markdown text={`\`\`\`python\n${args.code}\n\`\`\``} />;
  return <pre>{JSON.stringify(args, null, 2)}</pre>;
}

export function ToolBlock({
  id,
  name,
  args,
  summary,
  result,
  running,
  artifacts,
  activeArtifact,
  onOpenArtifact,
  team,
}: {
  id: string;
  name: string;
  args: any;
  summary?: string;
  result?: ToolResult;
  running?: boolean;
  artifacts: Artifact[];
  activeArtifact?: string;
  onOpenArtifact(a: Artifact, version: number): void;
  /** Live progress of the bots a Delegate call handed work to. */
  team?: TeamProgress;
}) {
  const [open, setOpen] = useState(false);

  if (name === 'Delegate' && Array.isArray(args?.assignments)) return <TeamCard args={args} result={result} running={running} progress={team} />;
  // While it waits, the question card below the answer is what shows.
  if (name === 'AskUser') return result ? <AskedCard args={args} output={result.output} isError={result.isError} /> : null;
  if (name === 'Subagents' && Array.isArray(args?.tasks)) return <SubagentsCard args={args} result={result} running={running} progress={team} />;

  if (name === 'Artifact') {
    const artifact = artifacts.find((a) => a.versions.some((v) => v.callId === id));
    const version = artifact ? artifact.versions.findIndex((v) => v.callId === id) : -1;
    if (artifact) {
      return (
        <button className={`artifact-card${activeArtifact === artifact.id ? ' active' : ''}`} onClick={() => onOpenArtifact(artifact, version)}>
          <span className="artifact-icon">
            <ArtifactIcon type={artifact.type} />
          </span>
          <span style={{ minWidth: 0, flex: 1 }}>
            <div className="t">{artifact.title}</div>
            <div className="s">
              {TYPE_LABEL[artifact.type]} · {version === 0 ? 'Created' : `Updated to v${version + 1}`} · Click to open
            </div>
          </span>
        </button>
      );
    }
    if (running || !result || result.isError) {
      return (
        <div className="artifact-card" style={{ cursor: 'default' }}>
          <span className="artifact-icon">{running ? <Loader2 size={18} className="spin" /> : <AlertTriangle size={18} />}</span>
          <span style={{ minWidth: 0, flex: 1 }}>
            <div className="t">{args.title ?? 'Artifact'}</div>
            <div className="s">{running ? 'Writing…' : result?.output ?? 'Interrupted'}</div>
          </span>
        </div>
      );
    }
  }

  if (name === 'TodoWrite' && Array.isArray(args.todos)) return <TodoChip todos={args.todos} />;
  if (name === 'SubmitPlan' && typeof args?.plan === 'string') return <PlanCard args={args} result={result} running={running} />;

  if (name === 'Skill' && !result?.isError) {
    return (
      <div className="memory-chip" style={{ background: 'var(--accent-soft)' }}>
        <WandSparkles size={14} color="var(--accent)" />
        <span>
          <strong>{args.file ? 'Read skill file' : 'Using skill'}</strong>: {args.name}
          {args.file ? ` / ${args.file}` : ''}
        </span>
      </div>
    );
  }

  if (name === 'Memory' && (args.action === 'remember' || args.action === 'forget') && !result?.isError) {
    return (
      <div className="memory-chip">
        <Brain size={14} />
        <span>
          <strong>{args.action === 'forget' ? 'Forgot a memory' : 'Saved to memory'}</strong>
          {args.content ? `: ${args.content}` : ''}
        </span>
      </div>
    );
  }

  const media = result && !result.isError ? mediaFrom(result.output) : [];
  if (media.length) {
    return (
      <>
        {media.map((m) => (
          <MediaPreview key={m.url} url={m.url} mime={m.mime} caption={args.prompt ?? args.text} />
        ))}
      </>
    );
  }
  if (/^Generate(Image|Video|Speech|Sound|Music)$/.test(name) && running && !result) {
    return (
      <div className="media-card pending">
        <Loader2 size={18} className="spin" />
        <span>
          {name === 'GenerateVideo' ? 'Generating video (this can take a few minutes)…' : `Generating ${name.slice(8).toLowerCase()}…`}
          <div className="muted small">{args.prompt ?? args.text}</div>
        </span>
      </div>
    );
  }

  const state = running && !result ? 'running' : result?.isError ? 'err' : 'ok';
  // Charts and images a Python run made show under it.
  const made = name === 'Python' ? artifacts.filter((a) => a.type === 'image' && a.versions.some((v) => v.callId === id)) : [];
  return (
    <>
    <div className="tool">
      <button className="tool-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="tool-icon">{toolIcon(name)}</span>
        <span className="tool-name">{displayName(name)}</span>
        <span className="tool-summary">{toolSummary(name, args, summary)}</span>
        <span className={`tool-state ${state}`}>
          {state === 'running' ? <Loader2 size={14} className="spin" /> : state === 'err' ? <AlertTriangle size={14} /> : <Check size={14} />}
        </span>
        {open ? <ChevronDown size={14} className="muted" /> : <ChevronRight size={14} className="muted" />}
      </button>
      {open && (
        <div className="tool-body">
          <div className="label">Input</div>
          <ToolInput name={name} args={args} />
          {result && (
            <>
              <div className="label">Output</div>
              <pre style={result.isError ? { color: 'var(--danger)' } : undefined}>{result.output}</pre>
            </>
          )}
        </div>
      )}
    </div>
    {made.length > 0 && (
      <div className="tool-images">
        {made.map((a) => (
          <button key={a.id} className="tool-image" title={a.title} onClick={() => onOpenArtifact(a, a.versions.findIndex((v) => v.callId === id))}>
            <img src={a.versions.find((v) => v.callId === id)?.content} alt={a.title} />
          </button>
        ))}
      </div>
    )}
    </>
  );
}

/** A task-list update in the conversation: one line, expandable to the list (the side panel keeps the live list). */
function TodoChip({ todos }: { todos: Todo[] }) {
  const [open, setOpen] = useState(false);
  const done = todos.filter((t) => t.status === 'completed').length;
  const current = todos.find((t) => t.status === 'in_progress');
  return (
    <div className="todo-chip-wrap">
      <button className="todo-chip" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <CircleCheck size={14} />
        <span>
          Task list · {done} of {todos.length} done{current ? <> · now: <strong>{current.content}</strong></> : done === todos.length ? ' · all done' : ''}
        </span>
        {open ? <ChevronDown size={14} className="muted" /> : <ChevronRight size={14} className="muted" />}
      </button>
      {open && <TodoCard todos={todos} />}
    </div>
  );
}

export function TodoCard({ todos }: { todos: Todo[] }) {
  return (
    <div className="todo-card">
      {todos.map((t, i) => (
        <div key={i} className={`todo ${t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'active' : ''}`}>
          {t.status === 'completed' ? (
            <CircleCheck size={16} color="var(--ok)" />
          ) : t.status === 'in_progress' ? (
            <CircleDot size={16} color="var(--accent)" />
          ) : (
            <Circle size={16} className="muted" />
          )}
          <span>{t.content}</span>
        </div>
      ))}
    </div>
  );
}

// ---------- Permission prompt ----------

export interface PermissionRequest {
  requestId: string;
  tool: string;
  summary: string;
  preview?: string;
  alwaysRule: string;
  /** Why it asks, when only risky actions need approval. */
  why?: string;
}

export function PermissionCard({ req, onAnswer }: { req: PermissionRequest; onAnswer(answer: 'yes' | 'always' | 'no' | 'feedback', feedback?: string): void }) {
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const answer = (a: 'yes' | 'always' | 'no' | 'feedback', fb?: string) => {
    setBusy(true);
    onAnswer(a, fb);
  };
  return (
    <div className="permission" role="alertdialog" aria-label={`Allow ${req.tool}?`}>
      <div className="permission-head">
        <ShieldCheck size={18} />
        <span>
          <strong>Allow {req.tool}?</strong> <code>{req.summary}</code>
          {req.why && <span className="permission-why">🐈 Asking because it {req.why}</span>}
        </span>
      </div>
      {req.preview && (
        <div style={{ maxHeight: 300, overflow: 'auto' }}>
          <Diff text={req.preview} />
        </div>
      )}
      <div className="permission-actions">
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => answer('yes')} autoFocus>
          Allow once
        </button>
        <button className="btn btn-sm" disabled={busy} onClick={() => answer('always')} title="For the rest of this chat">
          Always allow <code style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{req.alwaysRule}</code>
        </button>
        <button className="btn btn-ghost btn-sm btn-danger" disabled={busy} onClick={() => answer('no')}>
          Deny
        </button>
        <form
          style={{ display: 'flex', gap: 6, flex: 1, minWidth: 200 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (feedback.trim()) answer('feedback', feedback.trim());
          }}
        >
          <input className="input" placeholder="Or tell it what to do instead…" value={feedback} onChange={(e) => setFeedback(e.target.value)} disabled={busy} />
        </form>
      </div>
    </div>
  );
}

export function CompactDivider({ count, summary }: { count: number; summary?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="compact-divider">
        <button onClick={() => setOpen((o) => !o)}>
          <History size={13} /> {count} earlier message{count === 1 ? '' : 's'} summarized for the model {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
      </div>
      {open && summary && (
        <div className="summary-box" style={{ marginTop: -16, marginBottom: 28 }}>
          {summary}
        </div>
      )}
    </>
  );
}
