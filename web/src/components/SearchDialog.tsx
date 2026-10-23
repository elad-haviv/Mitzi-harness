// Search everything (Ctrl/⌘+K): chats down to the message, artifacts and memories.
import { Brain, CornerDownLeft, Layers, Loader2, MessagesSquare, Search, Sparkles, X } from 'lucide-react';
import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { api, SearchHit, SearchKind } from '../api';
import { navigate } from '../router';
import { relativeTime, useApp } from '../state';

const FILTERS: { id: SearchKind | 'all'; label: string; icon: ReactNode }[] = [
  { id: 'all', label: 'All', icon: <Search size={13} /> },
  { id: 'message', label: 'Chats', icon: <MessagesSquare size={13} /> },
  { id: 'artifact', label: 'Artifacts', icon: <Layers size={13} /> },
  { id: 'memory', label: 'Memories', icon: <Brain size={13} /> },
];

const SECTION: Record<SearchKind, string> = { message: 'Chats', artifact: 'Artifacts', memory: 'Memories' };

/** Text with its matches highlighted. */
function Marked({ text, marks }: { text: string; marks: [number, number][] }) {
  const parts: ReactNode[] = [];
  let at = 0;
  [...marks]
    .sort((a, b) => a[0] - b[0])
    .forEach(([s, e], i) => {
      if (s < at) return;
      if (s > at) parts.push(text.slice(at, s));
      parts.push(<mark key={i}>{text.slice(s, e)}</mark>);
      at = e;
    });
  parts.push(text.slice(at));
  return <>{parts}</>;
}

export function open(hit: SearchHit): void {
  if (hit.kind === 'memory') navigate({ page: 'memory', botId: hit.botId });
  else if (hit.kind === 'artifact' && hit.artifactId) navigate({ page: 'artifact', id: hit.artifactId });
  else if (hit.chatId) navigate({ page: 'chat', id: hit.chatId, message: hit.index });
}

export function SearchDialog({ initial = '', onClose }: { initial?: string; onClose(): void }) {
  const { chats, projects, toast } = useApp();
  const [q, setQ] = useState(initial);
  const [filter, setFilter] = useState<SearchKind | 'all'>('all');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [semantic, setSemantic] = useState(false);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  useEffect(() => {
    const query = q.trim();
    if (!query) {
      setHits([]);
      return;
    }
    const n = ++seq.current;
    setBusy(true);
    const t = setTimeout(() => {
      api
        .search(query, filter === 'all' ? undefined : [filter])
        .then((r) => {
          if (n !== seq.current) return;
          setHits(r.hits);
          setSemantic(r.semantic);
          setActive(0);
        })
        .catch((err) => toast(err.message))
        .finally(() => n === seq.current && setBusy(false));
    }, 180);
    return () => clearTimeout(t);
  }, [q, filter, toast]);

  // Sections in the order of their best result.
  const sections = useMemo(() => {
    const order: SearchKind[] = [];
    for (const h of hits) if (!order.includes(h.kind)) order.push(h.kind);
    return order.map((kind) => ({ kind, hits: hits.filter((h) => h.kind === kind) }));
  }, [hits]);
  const flat = sections.flatMap((s) => s.hits);

  const choose = (h: SearchHit | undefined) => {
    if (!h) return;
    onClose();
    open(h);
  };
  useEffect(() => {
    list.current?.querySelector('.search-hit.active')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const recent = chats.filter((c) => c.messageCount > 0).slice(0, 6);
  return (
    <div className="modal-backdrop search-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="search-dialog" role="dialog" aria-label="Search everything">
        <div className="search-input-row">
          {busy ? <Loader2 size={18} className="spin muted" /> : <Search size={18} className="muted" />}
          <input
            autoFocus
            value={q}
            placeholder="Search chats, artifacts and memories"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') (e.preventDefault(), setActive((a) => Math.min(flat.length - 1, a + 1)));
              else if (e.key === 'ArrowUp') (e.preventDefault(), setActive((a) => Math.max(0, a - 1)));
              else if (e.key === 'Enter') choose(flat[active]);
              else if (e.key === 'Escape') onClose();
            }}
            aria-label="Search"
            dir="auto"
          />
          <button className="icon-btn sm" onClick={onClose} aria-label="Close search">
            <X size={16} />
          </button>
        </div>
        <div className="search-filters">
          {FILTERS.map((f) => (
            <button key={f.id} className={`chip-btn${filter === f.id ? ' on' : ''}`} onClick={() => setFilter(f.id)}>
              {f.icon} {f.label}
            </button>
          ))}
          {semantic && (
            <span className="muted small search-semantic" title="Results also match by meaning, using your embedding model">
              <Sparkles size={12} /> by meaning too
            </span>
          )}
        </div>
        <div className="search-results" ref={list}>
          {!q.trim() && (
            <>
              <div className="search-section">Recent chats</div>
              {recent.map((c) => (
                <button key={c.id} className="search-hit" onClick={() => (onClose(), navigate({ page: 'chat', id: c.id }))}>
                  <MessagesSquare size={15} className="muted" />
                  <span className="search-hit-main">
                    <span className="search-hit-title">{c.title}</span>
                  </span>
                  <span className="muted small">{relativeTime(c.updatedAt)}</span>
                </button>
              ))}
            </>
          )}
          {q.trim() && !busy && !hits.length && <div className="search-empty muted">Nothing found for “{q.trim()}”.</div>}
          {sections.map((s) => (
            <div key={s.kind}>
              <div className="search-section">{SECTION[s.kind]}</div>
              {s.hits.map((h) => {
                const i = flat.indexOf(h);
                const project = h.projectId ? projects.find((p) => p.id === h.projectId) : undefined;
                return (
                  <button
                    key={`${h.kind}:${h.chatId ?? ''}:${h.artifactId ?? h.memoryId ?? h.index}`}
                    className={`search-hit${i === active ? ' active' : ''}`}
                    onMouseMove={() => setActive(i)}
                    onClick={() => choose(h)}
                  >
                    {h.kind === 'memory' ? <Brain size={15} className="muted" /> : h.kind === 'artifact' ? <Layers size={15} className="muted" /> : <MessagesSquare size={15} className="muted" />}
                    <span className="search-hit-main">
                      <span className="search-hit-title">
                        {h.title}
                        {project && <span className="muted"> · {project.name}</span>}
                      </span>
                      <span className="search-hit-snippet" dir="auto">
                        <Marked text={h.snippet} marks={h.marks} />
                      </span>
                    </span>
                    <span className="search-hit-meta muted small">
                      {relativeTime(h.ts)}
                      {!!h.more && <span>+{h.more} more</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div className="search-foot muted small">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> to move
          </span>
          <span>
            <kbd>
              <CornerDownLeft size={10} />
            </kbd>{' '}
            to open
          </span>
          <span>
            <kbd>Esc</kbd> to close
          </span>
        </div>
      </div>
    </div>
  );
}
