import { Bot, Brain, FolderOpen, KeyRound, Layers, PanelLeftClose, Pin, Search, Settings, SquarePen } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ChatListItem } from '../api';
import { href, Route } from '../router';
import { useApp } from '../state';

function groupLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = (today.getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86_400_000;
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return 'Previous 7 days';
  if (diff < 30) return 'Previous 30 days';
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

export function Sidebar({ route, collapsed, onCollapse }: { route: Route; collapsed: boolean; onCollapse(): void }) {
  const { chats, projects, bots, settings } = useApp();
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? chats.filter((c) => c.title.toLowerCase().includes(q)) : chats;
  }, [chats, query]);

  const groups = useMemo(() => {
    const out: { label: string; chats: ChatListItem[] }[] = [];
    const pinned = filtered.filter((c) => c.pinned);
    if (pinned.length) out.push({ label: 'Pinned', chats: pinned });
    for (const c of filtered.filter((c) => !c.pinned && c.messageCount > 0)) {
      const label = groupLabel(c.updatedAt);
      const g = out.find((x) => x.label === label);
      if (g) g.chats.push(c);
      else out.push({ label, chats: [c] });
    }
    return out;
  }, [filtered]);

  const nav = [
    { route: { page: 'projects' } as Route, icon: <FolderOpen size={17} />, label: 'Projects', count: projects.length, match: ['projects', 'project'] },
    { route: { page: 'bots' } as Route, icon: <Bot size={17} />, label: 'Bots', count: bots.length, match: ['bots'] },
    { route: { page: 'artifacts' } as Route, icon: <Layers size={17} />, label: 'Artifacts', match: ['artifacts', 'artifact'] },
    { route: { page: 'memory' } as Route, icon: <Brain size={17} />, label: 'Memory', match: ['memory'] },
  ];

  return (
    <nav className={`sidebar${collapsed ? ' collapsed' : ''}`} aria-label="Main">
      <div className="sidebar-top">
        <a className="brand" href={href({ page: 'new' })}>
          <span className="brand-mark">✻</span> Mitzi
        </a>
        <button className="icon-btn" onClick={onCollapse} aria-label="Collapse sidebar" title="Collapse sidebar">
          <PanelLeftClose size={18} />
        </button>
      </div>
      <div className="sidebar-section">
        <a className="btn new-chat-btn" href={href({ page: 'new' })}>
          <SquarePen size={16} /> New chat
        </a>
        {nav.map((n) => (
          <a key={n.label} className={`nav-item${n.match.includes(route.page) ? ' active' : ''}`} href={href(n.route)}>
            {n.icon}
            {n.label}
            {!!n.count && <span className="count">{n.count}</span>}
          </a>
        ))}
        <div className="sidebar-search">
          <Search size={14} />
          <input placeholder="Search chats" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search chats" />
        </div>
      </div>
      <div className="chat-list">
        {groups.map((g) => (
          <div key={g.label}>
            <div className="chat-group-label">{g.label}</div>
            {g.chats.map((c) => {
              const bot = c.botId ? bots.find((b) => b.id === c.botId) : undefined;
              const active = route.page === 'chat' && route.id === c.id;
              return (
                <a key={c.id} className={`chat-link${active ? ' active' : ''}`} href={href({ page: 'chat', id: c.id })} title={c.title}>
                  {bot && <span className="emoji">{bot.emoji}</span>}
                  {c.pinned && g.label !== 'Pinned' && <Pin size={12} />}
                  <span className="title">{c.title}</span>
                  {c.running && <span className="live-dot" aria-label="Responding" />}
                </a>
              );
            })}
          </div>
        ))}
        {query && !filtered.length && <div className="muted small" style={{ padding: '12px 10px' }}>No chats match “{query}”.</div>}
        {!query && !groups.length && <div className="muted small" style={{ padding: '12px 10px' }}>Your conversations will appear here.</div>}
      </div>
      <div className="sidebar-bottom">
        {settings && !settings.hasApiKey && (
          <a className="key-warning" href={href({ page: 'settings' })}>
            <KeyRound size={15} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>Add your OpenRouter API key to start chatting</span>
          </a>
        )}
        <a className={`nav-item${route.page === 'settings' ? ' active' : ''}`} href={href({ page: 'settings' })}>
          <Settings size={17} /> Settings
        </a>
      </div>
    </nav>
  );
}
