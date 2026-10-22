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
  Globe,
  History,
  Loader2,
  Paperclip,
  Pencil,
  RefreshCw,
  Search,
  ShieldCheck,
  Terminal,
  Wrench,
  X,
} from 'lucide-react';
import { ReactNode, useMemo, useRef, useState } from 'react';
import type { Artifact, Attachment, Bot, ChatMessage, ContentPart, RecalledMemory, Todo } from '../api';
import { href } from '../router';
import { modelLabel, useApp } from '../state';
import { ArtifactIcon, TYPE_LABEL } from './Artifacts';
import { CopyButton, Markdown } from './Markdown';
import { Diff, useAutoResize } from './ui';

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
  | { kind: 'assistant'; index: number; messages: ChatMessage[]; memories?: RecalledMemory[] }
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
    if (m.role === 'user') return void turns.push({ kind: 'user', index: i, message: m });
    if (m.role === 'assistant') {
      const last = turns.at(-1);
      if (last?.kind === 'assistant') last.messages.push(m);
      // An answer shows the memories recalled for the message it answers.
      else turns.push({ kind: 'assistant', index: i, messages: [m], memories: last?.kind === 'user' ? last.message.memories : undefined });
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
  const { text, attachments } = useMemo(() => splitUserContent(message.content), [message.content]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
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
      ) : (
        text && <div className="bubble">{text}</div>
      )}
      {!editing && (
        <div className="msg-actions">
          <CopyButton text={() => text} />
          {onEdit && !disabled && (
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
        </div>
      )}
    </div>
  );
}

// ---------- Assistant turn ----------

export function Avatar({ bot }: { bot?: Bot }) {
  return bot && !bot.builtIn ? <div className="avatar emoji">{bot.emoji}</div> : <div className="avatar">✻</div>;
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
  messages,
  memories,
  results,
  artifacts,
  bot,
  activeArtifact,
  onOpenArtifact,
  onRegenerate,
}: {
  messages: ChatMessage[];
  memories?: RecalledMemory[];
  results: Map<string, ToolResult>;
  artifacts: Artifact[];
  bot?: Bot;
  activeArtifact?: string;
  onOpenArtifact(a: Artifact, version: number): void;
  onRegenerate?(): void;
}) {
  const { models } = useApp();
  const text = messages.map(messageText).filter(Boolean).join('\n\n');
  const model = messages.find((m) => m.model)?.model;
  return (
    <div className="turn turn-assistant">
      <Avatar bot={bot} />
      <div className="assistant-body">
        {memories && memories.length > 0 && <MemoryRecall memories={memories} botId={bot?.id} />}
        {messages.map((m, i) => (
          <AssistantMessageBody key={i} message={m} results={results} artifacts={artifacts} activeArtifact={activeArtifact} onOpenArtifact={onOpenArtifact} />
        ))}
        <div className="msg-actions">
          {text && <CopyButton text={() => text} label="Copy response" />}
          {onRegenerate && (
            <button className="icon-btn sm" title="Regenerate" aria-label="Regenerate response" onClick={onRegenerate}>
              <RefreshCw size={14} />
            </button>
          )}
          {model && <span className="meta">{modelLabel(model, models)}</span>}
        </div>
      </div>
    </div>
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
    case 'Glob':
    case 'Grep':
      return <Search size={13} />;
    case 'LS':
      return <FolderOpen size={13} />;
    case 'WebFetch':
      return <Globe size={13} />;
    case 'Memory':
      return <Brain size={13} />;
    default:
      return <Wrench size={13} />;
  }
}

function toolSummary(name: string, args: any, fallback?: string): string {
  if (fallback) return fallback;
  return args.file_path ?? args.command ?? args.pattern ?? args.url ?? args.path ?? '';
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
}) {
  const [open, setOpen] = useState(false);

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

  if (name === 'TodoWrite' && Array.isArray(args.todos)) return <TodoCard todos={args.todos} />;

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

  const state = running && !result ? 'running' : result?.isError ? 'err' : 'ok';
  return (
    <div className="tool">
      <button className="tool-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="tool-icon">{toolIcon(name)}</span>
        <span className="tool-name">{name}</span>
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
