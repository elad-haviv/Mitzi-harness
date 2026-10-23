import { ArrowUpCircle, BarChart3, Wallet, Bot, Brain, CalendarClock, Check, ChevronDown, ChevronRight, FolderOpen, GitBranch, KeyRound, Layers, ListTree, MoreHorizontal, PanelLeftClose, Pencil, Pin, PinOff, Plug, Plus, Puzzle, Search, Settings, SquarePen, Trash2, WandSparkles, Workflow as WorkflowIcon, X } from 'lucide-react';
import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { api, ChatListItem } from '../api';
import { href, navigate, Route } from '../router';
import { LOGO, useApp } from '../state';
import { useConfirm } from './ui';

type GroupBy = 'date' | 'project' | 'bot' | 'model' | 'none';
const GROUP_OPTIONS: { id: GroupBy; label: string }[] = [
  { id: 'date', label: 'Date' },
  { id: 'project', label: 'Project' },
  { id: 'bot', label: 'Bot' },
  { id: 'model', label: 'Model' },
  { id: 'none', label: 'Don’t group' },
];

/** Sidebar preferences kept in this browser. */
function useStored<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = (v: T) => {
    setValue(v);
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch {
      // Not persisted.
    }
  };
  return [value, set];
}

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
  const { chats, projects, bots, models, settings, tasks, update, budget, refreshChats, toast } = useApp();
  const unseen = tasks.reduce((n, t) => n + t.runs.filter((r) => !r.seen && r.status !== 'running').length, 0);
  const [query, setQuery] = useState('');
  const [groupBy, setGroupBy] = useStored<GroupBy>('mitzi.chatGroupBy', 'date');
  const [collapsedGroups, setCollapsedGroups] = useStored<string[]>('mitzi.collapsedGroups', []);
  const [menu, setMenu] = useState<{ chat: ChatListItem; x: number; y: number }>();
  const [groupMenu, setGroupMenu] = useState(false);
  const [renaming, setRenaming] = useState<string>();
  const [confirmNode, confirm] = useConfirm();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? chats.filter((c) => c.title.toLowerCase().includes(q)) : chats;
  }, [chats, query]);

  const isDefaultBot = (c: ChatListItem) => !c.botId || !!bots.find((b) => b.id === c.botId)?.builtIn;
  const groups = useMemo(() => {
    // `start` is what a new chat started from the group gets: its project, bot or model.
    const out: { label: string; chats: ChatListItem[]; start?: { projectId?: string; botId?: string; model?: string } }[] = [];
    // By date, pinned chats get their own section; otherwise they lead their own group.
    const byDate = groupBy === 'date';
    const pinned = filtered.filter((c) => c.pinned);
    if (byDate && pinned.length) out.push({ label: 'Pinned', chats: pinned });
    const keyOf = (c: ChatListItem): string => {
      switch (groupBy) {
        case 'project':
          return projects.find((p) => p.id === c.projectId)?.name ?? 'No project';
        case 'bot': {
          const bot = bots.find((b) => b.id === c.botId) ?? bots.find((b) => b.builtIn);
          return bot ? `${bot.emoji} ${bot.name}` : 'Mitzi';
        }
        case 'model':
          return models.find((m) => m.id === c.model)?.name ?? c.model;
        case 'none':
          return 'Chats';
        default:
          return groupLabel(c.updatedAt);
      }
    };
    const startOf = (c: ChatListItem) =>
      groupBy === 'project'
        ? c.projectId && projects.some((p) => p.id === c.projectId)
          ? { projectId: c.projectId }
          : {}
        : groupBy === 'bot'
          ? { botId: c.botId }
          : groupBy === 'model'
            ? { model: c.model }
            : undefined;
    const rest: typeof out = [];
    for (const c of filtered.filter((c) => (byDate ? !c.pinned && c.messageCount > 0 : c.pinned || c.messageCount > 0))) {
      const label = keyOf(c);
      const g = rest.find((x) => x.label === label);
      if (g) g.chats.push(c);
      else rest.push({ label, chats: [c], start: startOf(c) });
    }
    // Chats without a project, and the default bot's chats, come first.
    if (groupBy === 'project') rest.sort((a, b) => Number(b.label === 'No project') - Number(a.label === 'No project'));
    if (groupBy === 'bot') rest.sort((a, b) => Number(!!b.chats.some(isDefaultBot)) - Number(!!a.chats.some(isDefaultBot)));
    if (!byDate) for (const g of rest) g.chats.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
    return [...out, ...rest];
  }, [filtered, groupBy, projects, bots, models]);

  const toggleGroup = (label: string) =>
    setCollapsedGroups(collapsedGroups.includes(label) ? collapsedGroups.filter((l) => l !== label) : [...collapsedGroups, label]);

  const openMenu = (chat: ChatListItem, x: number, y: number) => setMenu({ chat, x, y });
  const updateChat = async (id: string, patch: Parameters<typeof api.updateChat>[1]) => {
    try {
      await api.updateChat(id, patch);
    } catch (err) {
      toast((err as Error).message);
    }
    void refreshChats();
  };
  const deleteChat = async (chat: ChatListItem) => {
    if (!(await confirm(`“${chat.title}” and its artifacts will be permanently deleted.`, { title: 'Delete chat?' }))) return;
    try {
      await api.deleteChat(chat.id);
      if (route.page === 'chat' && route.id === chat.id) navigate(chat.projectId ? { page: 'project', id: chat.projectId } : { page: 'new' });
    } catch (err) {
      toast((err as Error).message);
    }
    void refreshChats();
  };

  const nav = [
    { route: { page: 'projects' } as Route, icon: <FolderOpen size={17} />, label: 'Projects', count: projects.length, match: ['projects', 'project'] },
    { route: { page: 'bots' } as Route, icon: <Bot size={17} />, label: 'Bots', count: bots.length, match: ['bots'] },
    { route: { page: 'artifacts' } as Route, icon: <Layers size={17} />, label: 'Artifacts', match: ['artifacts', 'artifact'] },
    { route: { page: 'tasks' } as Route, icon: <CalendarClock size={17} />, label: 'Scheduled', match: ['tasks'], badge: unseen },
    { route: { page: 'workflows' } as Route, icon: <WorkflowIcon size={17} />, label: 'Workflows', match: ['workflows', 'workflow'] },
    { route: { page: 'memory' } as Route, icon: <Brain size={17} />, label: 'Memory', match: ['memory'] },
    { route: { page: 'insights' } as Route, icon: <BarChart3 size={17} />, label: 'Insights', match: ['insights'] },
  ];
  const extend = [
    { route: { page: 'connectors' } as Route, icon: <Plug size={17} />, label: 'Connectors', match: ['connectors'] },
    { route: { page: 'skills' } as Route, icon: <WandSparkles size={17} />, label: 'Skills', match: ['skills'] },
    { route: { page: 'plugins' } as Route, icon: <Puzzle size={17} />, label: 'Plugins', match: ['plugins'] },
  ];

  return (
    <nav className={`sidebar${collapsed ? ' collapsed' : ''}`} aria-label="Main">
      <div className="sidebar-top">
        <a className="brand" href={href({ page: 'new' })}>
          <span className="brand-mark">{LOGO}</span> Mitzi
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
            {!!(n as { badge?: number }).badge && (
              <span className="badge-dot" title={`${(n as { badge?: number }).badge} new result(s)`}>
                {(n as { badge?: number }).badge}
              </span>
            )}
          </a>
        ))}
        <div className="nav-label">Extend</div>
        {extend.map((n) => (
          <a key={n.label} className={`nav-item${n.match.includes(route.page) ? ' active' : ''}`} href={href(n.route)}>
            {n.icon}
            {n.label}
          </a>
        ))}
        <div className="sidebar-search">
          <Search size={14} />
          <input
            placeholder="Search chats"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Enter searches inside chats, artifacts and memories too.
              if (e.key === 'Enter') window.dispatchEvent(new CustomEvent('mitzi:search', { detail: query }));
            }}
            aria-label="Search chats"
            title="Filter chat titles; press Enter to search inside everything"
          />
          <kbd title="Search everything" onClick={() => window.dispatchEvent(new CustomEvent('mitzi:search', { detail: query }))}>
            {/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K'}
          </kbd>
        </div>
      </div>
      <div className="chat-list-head">
        <span>Chats</span>
        <button className={`icon-btn sm${groupMenu ? ' on' : ''}`} onMouseDown={(e) => e.stopPropagation()} onClick={() => setGroupMenu((o) => !o)} title="Group chats" aria-label="Group chats" aria-expanded={groupMenu}>
          <ListTree size={14} />
        </button>
        {groupMenu && (
          <PopupMenu onClose={() => setGroupMenu(false)} className="group-menu">
            <div className="menu-label">Group by</div>
            {GROUP_OPTIONS.map((o) => (
              <button key={o.id} role="menuitemradio" aria-checked={groupBy === o.id} onClick={() => (setGroupBy(o.id), setGroupMenu(false))}>
                <span className="menu-check">{groupBy === o.id && <Check size={14} />}</span> {o.label}
              </button>
            ))}
          </PopupMenu>
        )}
      </div>
      <div className="chat-list">
        {groups.map((g) => {
          const collapsed = collapsedGroups.includes(g.label) && !query;
          return (
            <div key={g.label}>
              {(groupBy !== 'none' || g.label === 'Pinned' || groups.length > 1) && (
                <div className="chat-group-row">
                  <button className="chat-group-label" onClick={() => toggleGroup(g.label)} aria-expanded={!collapsed}>
                    {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                    <span className="grow">{g.label}</span>
                    {collapsed && <span className="count">{g.chats.length}</span>}
                  </button>
                  {g.start && (
                    <a className="icon-btn sm chat-group-new" href={href({ page: 'new', ...g.start })} title={`New chat in ${g.label}`} aria-label={`New chat in ${g.label}`}>
                      <Plus size={14} />
                    </a>
                  )}
                </div>
              )}
              {!collapsed &&
                g.chats.map((c) => {
                  const bot = c.botId ? bots.find((b) => b.id === c.botId) : undefined;
                  const active = route.page === 'chat' && route.id === c.id;
                  if (renaming === c.id) {
                    return (
                      <div key={c.id} className="chat-link active">
                        <input
                          className="chat-rename"
                          defaultValue={c.title}
                          autoFocus
                          onFocus={(e) => e.target.select()}
                          onBlur={(e) => {
                            setRenaming(undefined);
                            const title = e.target.value.trim();
                            if (title && title !== c.title) void updateChat(c.id, { title });
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                            if (e.key === 'Escape') setRenaming(undefined);
                          }}
                          aria-label="Chat name"
                        />
                      </div>
                    );
                  }
                  return (
                    <a
                      key={c.id}
                      className={`chat-link${active ? ' active' : ''}${menu?.chat.id === c.id ? ' menu-open' : ''}`}
                      href={href({ page: 'chat', id: c.id })}
                      title={c.title}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        openMenu(c, e.clientX, e.clientY);
                      }}
                    >
                      {bot && !bot.builtIn && groupBy !== 'bot' && <span className="emoji">{bot.emoji}</span>}
                      {c.pinned && g.label !== 'Pinned' && <Pin size={12} />}
                      {c.branchedFrom && <GitBranch size={12} className="muted" aria-label="Branch" />}
                      {c.taskId && <CalendarClock size={12} className="muted" aria-label="Scheduled task" />}
                      <span className="title">{c.title}</span>
                      {c.waiting ? <span className="tab-paw" title="Waiting for your approval" aria-label="Needs you">🐾</span> : c.running && <span className="live-dot" aria-label="Responding" />}
                      <button
                        className="chat-more"
                        aria-label={`Options for ${c.title}`}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          const r = e.currentTarget.getBoundingClientRect();
                          openMenu(c, r.left, r.bottom + 4);
                        }}
                      >
                        <MoreHorizontal size={15} />
                      </button>
                    </a>
                  );
                })}
            </div>
          );
        })}
        {query && !filtered.length && <div className="muted small" style={{ padding: '12px 10px' }}>No chats match “{query}”.</div>}
        {!query && !groups.length && <div className="muted small" style={{ padding: '12px 10px' }}>Your conversations will appear here.</div>}
      </div>
      {menu && (
        <PopupMenu onClose={() => setMenu(undefined)} at={{ x: menu.x, y: menu.y }}>
          <button onClick={() => (setMenu(undefined), setRenaming(menu.chat.id))}>
            <Pencil size={15} /> Rename
          </button>
          <button onClick={() => (setMenu(undefined), void updateChat(menu.chat.id, { pinned: !menu.chat.pinned }))}>
            {menu.chat.pinned ? <PinOff size={15} /> : <Pin size={15} />} {menu.chat.pinned ? 'Unpin' : 'Pin'}
          </button>
          {projects.filter((p) => p.id !== menu.chat.projectId).length > 0 && <hr />}
          {projects
            .filter((p) => p.id !== menu.chat.projectId)
            .slice(0, 6)
            .map((p) => (
              <button key={p.id} onClick={() => (setMenu(undefined), void updateChat(menu.chat.id, { projectId: p.id }))}>
                <FolderOpen size={15} /> Move to {p.name}
              </button>
            ))}
          {menu.chat.projectId && (
            <button onClick={() => (setMenu(undefined), void updateChat(menu.chat.id, { projectId: null }))}>
              <X size={15} /> Remove from project
            </button>
          )}
          <hr />
          <button className="danger" onClick={() => (setMenu(undefined), void deleteChat(menu.chat))}>
            <Trash2 size={15} /> Delete
          </button>
        </PopupMenu>
      )}
      {confirmNode}
      <div className="sidebar-bottom">
        {settings && !settings.hasApiKey && (
          <a className="key-warning" href={href({ page: 'settings', section: 'providers' })}>
            <KeyRound size={15} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>Add an API key for OpenRouter or another provider to start chatting</span>
          </a>
        )}
        {budget && budget.state !== 'ok' && (
          <a className={`budget-pill ${budget.state}`} href={href({ page: 'settings', section: 'budget' })}>
            <Wallet size={15} />
            {budget.state === 'over'
              ? `${budget.limit === 'daily' ? 'Daily' : 'Monthly'} budget reached${budget.hardStop ? ': paused' : ''}`
              : `${Math.round(((budget.limit === 'daily' ? budget.spentToday / budget.daily! : budget.spentMonth / budget.monthly!) || 0) * 100)}% of ${budget.limit === 'daily' ? 'today’s' : 'this month’s'} budget used`}
          </a>
        )}
        {update?.supported && update.behind > 0 && (
          <a className="update-pill" href={href({ page: 'settings', section: 'updates' })} title={`v${update.current.version} → v${update.latest?.version}`}>
            <ArrowUpCircle size={15} /> Update available
          </a>
        )}
        <a className={`nav-item${route.page === 'settings' ? ' active' : ''}`} href={href({ page: 'settings' })}>
          <Settings size={17} /> Settings
        </a>
      </div>
    </nav>
  );
}

/** A menu that floats above everything (the chat list scrolls, so it can't hold the menu itself). */
function PopupMenu({ at, onClose, className, children }: { at?: { x: number; y: number }; onClose(): void; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(at);
  useEffect(() => {
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);
  // Keep it on screen.
  useEffect(() => {
    if (!at || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({ x: Math.max(8, Math.min(at.x, window.innerWidth - r.width - 8)), y: Math.max(8, Math.min(at.y, window.innerHeight - r.height - 8)) });
  }, [at?.x, at?.y]);
  return (
    <div ref={ref} className={`menu${at ? ' menu-fixed' : ''}${className ? ` ${className}` : ''}`} role="menu" style={pos ? { left: pos.x, top: pos.y } : undefined}>
      {children}
    </div>
  );
}
