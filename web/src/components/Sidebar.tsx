import { Archive, ArrowUpCircle, BarChart3, Wallet, Bot, Brain, CalendarClock, Check, ChevronDown, ChevronRight, ChevronUp, FolderOpen, GitBranch, KeyRound, Layers, ListTree, MoreHorizontal, PanelLeftClose, Pencil, Pin, PinOff, Plug, Plus, Puzzle, Search, Settings, SquarePen, Trash2, WandSparkles, Workflow as WorkflowIcon, X } from 'lucide-react';
import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { api, ChatListItem } from '../api';
import { href, navigate, Route } from '../router';
import { LOGO, useApp } from '../state';
import { useConfirm } from './ui';
import { budgetName } from '../pages/Insights';
import { tr } from '../i18n';

type GroupBy = 'date' | 'project' | 'bot' | 'model' | 'none';
const GROUP_OPTIONS: { id: GroupBy; label: string }[] = [
  { id: 'date', label: tr('Date') },
  { id: 'project', label: tr('Project') },
  { id: 'bot', label: tr('Bot') },
  { id: 'model', label: tr('Model') },
  { id: 'none', label: tr('Don’t group') },
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
  if (diff <= 0) return tr('Today');
  if (diff === 1) return tr('Yesterday');
  if (diff < 7) return tr('Previous 7 days');
  if (diff < 30) return tr('Previous 30 days');
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

export function Sidebar({ route, collapsed, onCollapse }: { route: Route; collapsed: boolean; onCollapse(): void }) {
  const { chats, projects, bots, models, settings, tasks, update, budget, refreshChats, toast } = useApp();
  const unseen = tasks.reduce((n, t) => n + t.runs.filter((r) => !r.seen && r.status !== 'running').length, 0);
  // Workflow runs paused at an approval step (they may have been started by a trigger or a schedule).
  const [approvals, setApprovals] = useState(0);
  useEffect(() => {
    const check = () => document.visibilityState === 'visible' && api.workflows().then((list) => setApprovals(list.filter((w) => w.runs[0]?.status === 'waiting').length), () => {});
    check();
    const timer = setInterval(check, 20_000);
    return () => clearInterval(timer);
  }, [route.page]);
  const [query, setQuery] = useState('');
  const [groupBy, setGroupBy] = useStored<GroupBy>('mitzi.chatGroupBy', 'date');
  const [collapsedGroups, setCollapsedGroups] = useStored<string[]>('mitzi.collapsedGroups', []);
  const [menu, setMenu] = useState<{ chat: ChatListItem; x: number; y: number }>();
  const [groupMenu, setGroupMenu] = useState(false);
  const [renaming, setRenaming] = useState<string>();
  const [confirmNode, confirm] = useConfirm();
  const [showMore, setShowMore] = useStored('mitzi.navMore', false);
  const [showExtend, setShowExtend] = useStored('mitzi.navExtend', false);

  // Archived chats, and the chats of archived projects, are put away (they're on the Archived page).
  const archivedProjectIds = useMemo(() => new Set(projects.filter((p) => p.archivedAt).map((p) => p.id)), [projects]);
  const isArchived = (c: ChatListItem) => !!c.archivedAt || (!!c.projectId && archivedProjectIds.has(c.projectId));
  const archivedCount = chats.filter((c) => c.archivedAt).length + archivedProjectIds.size;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const live = chats.filter((c) => !isArchived(c));
    return q ? live.filter((c) => c.title.toLowerCase().includes(q)) : live;
  }, [chats, query, archivedProjectIds]); // eslint-disable-line react-hooks/exhaustive-deps

  const isDefaultBot = (c: ChatListItem) => !c.botId || !!bots.find((b) => b.id === c.botId)?.builtIn;
  const groups = useMemo(() => {
    // `start` is what a new chat started from the group gets: its project, bot or model.
    const out: { label: string; chats: ChatListItem[]; start?: { projectId?: string; botId?: string; model?: string } }[] = [];
    // By date, pinned chats get their own section; otherwise they lead their own group.
    const byDate = groupBy === 'date';
    const pinned = filtered.filter((c) => c.pinned);
    if (byDate && pinned.length) out.push({ label: tr('Pinned'), chats: pinned });
    const keyOf = (c: ChatListItem): string => {
      switch (groupBy) {
        case 'project':
          return projects.find((p) => p.id === c.projectId)?.name ?? tr('No project');
        case 'bot': {
          const bot = bots.find((b) => b.id === c.botId) ?? bots.find((b) => b.builtIn);
          return bot ? `${bot.emoji} ${bot.name}` : tr('Mitzi');
        }
        case 'model':
          return models.find((m) => m.id === c.model)?.name ?? c.model;
        case 'none':
          return tr('Chats');
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
    if (!(await confirm(tr('“{0}” and its artifacts will be permanently deleted.', chat.title), { title: tr('Delete chat?') }))) return;
    try {
      await api.deleteChat(chat.id);
      if (route.page === 'chat' && route.id === chat.id) navigate(chat.projectId ? { page: 'project', id: chat.projectId } : { page: 'new' });
    } catch (err) {
      toast((err as Error).message);
    }
    void refreshChats();
  };

  const nav = [
    { route: { page: 'projects' } as Route, icon: <FolderOpen size={17} />, label: tr('Projects'), count: projects.filter((p) => !p.archivedAt).length, match: ['projects', 'project'] },
    { route: { page: 'bots' } as Route, icon: <Bot size={17} />, label: tr('Bots'), count: bots.length, match: ['bots'] },
    { route: { page: 'artifacts' } as Route, icon: <Layers size={17} />, label: tr('Library'), match: ['artifacts', 'artifact'] },
  ];
  // Used less often: shown when the menu is expanded, or while one of them is open.
  const more = [
    { route: { page: 'tasks' } as Route, icon: <CalendarClock size={17} />, label: tr('Scheduled'), match: ['tasks'], badge: unseen },
    { route: { page: 'workflows' } as Route, icon: <WorkflowIcon size={17} />, label: tr('Workflows'), match: ['workflows', 'workflow'], badge: approvals },
    { route: { page: 'memory' } as Route, icon: <Brain size={17} />, label: tr('Memory'), match: ['memory'] },
    { route: { page: 'insights' } as Route, icon: <BarChart3 size={17} />, label: tr('Insights'), match: ['insights'] },
  ];
  const extend = [
    { route: { page: 'connectors' } as Route, icon: <Plug size={17} />, label: tr('Connectors'), match: ['connectors'] },
    { route: { page: 'skills' } as Route, icon: <WandSparkles size={17} />, label: tr('Skills'), match: ['skills'] },
    { route: { page: 'plugins' } as Route, icon: <Puzzle size={17} />, label: tr('Plugins'), match: ['plugins'] },
  ];

  return (
    <nav className={`sidebar${collapsed ? ' collapsed' : ''}`} aria-label={tr('Main')}>
      <div className="sidebar-top">
        <a className="brand" href={href({ page: 'new' })}>
          <span className="brand-mark">{LOGO}</span> {tr('Mitzi')}
        </a>
        <button className="icon-btn" onClick={onCollapse} aria-label={tr('Collapse sidebar')} title={tr('Collapse sidebar')}>
          <PanelLeftClose size={18} />
        </button>
      </div>
      <div className="sidebar-section">
        <div className="sidebar-search">
          <Search size={14} />
          <input
            placeholder={tr('Search chats')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Enter searches inside chats, artifacts and memories too.
              if (e.key === 'Enter') window.dispatchEvent(new CustomEvent('mitzi:search', { detail: query }));
            }}
            aria-label={tr('Search chats')}
            title={tr('Filter chat titles; press Enter to search inside everything')}
          />
          <kbd title="Search everything" onClick={() => window.dispatchEvent(new CustomEvent('mitzi:search', { detail: query }))}>
            {/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K'}
          </kbd>
        </div>
        <a className={`nav-item${route.page === 'new' ? ' active' : ''}`} href={href({ page: 'new' })}>
          <SquarePen size={17} />
          {tr('New chat')}
        </a>
        {nav.map((n) => (
          <NavItem key={n.label} item={n} active={n.match.includes(route.page)} />
        ))}
        {more.map((n) => (showMore || n.match.includes(route.page) ? <NavItem key={n.label} item={n} active={n.match.includes(route.page)} /> : null))}
        <button className="nav-more" onClick={() => setShowMore(!showMore)} aria-expanded={showMore} title={showMore ? tr('Show fewer') : tr('Show more: Scheduled, Workflows, Memory, Insights')}>
          <span className="nav-more-line" />
          {showMore ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          {!showMore && unseen + approvals > 0 && <span className="badge-dot" title={tr('{0} new result(s)', unseen + approvals)}>{unseen + approvals}</span>}
          <span className="nav-more-line" />
        </button>
        <button className="nav-label nav-label-toggle" onClick={() => setShowExtend(!showExtend)} aria-expanded={showExtend}>
          {showExtend ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {tr('Extend')}
        </button>
        {extend.map((n) => (showExtend || n.match.includes(route.page) ? <NavItem key={n.label} item={n} active={n.match.includes(route.page)} /> : null))}
      </div>
      <div className="chat-list-head">
        <span>{tr('Chats')}</span>
        <button className={`icon-btn sm${groupMenu ? ' on' : ''}`} onMouseDown={(e) => e.stopPropagation()} onClick={() => setGroupMenu((o) => !o)} title={tr('Group chats')} aria-label={tr('Group chats')} aria-expanded={groupMenu}>
          <ListTree size={14} />
        </button>
        {groupMenu && (
          <PopupMenu onClose={() => setGroupMenu(false)} className="group-menu">
            <div className="menu-label">{tr('Group by')}</div>
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
                    <a className="icon-btn sm chat-group-new" href={href({ page: 'new', ...g.start })} title={tr('New chat in {0}', g.label)} aria-label={tr('New chat in {0}', g.label)}>
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
                          aria-label={tr('Chat name')}
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
                      {c.branchedFrom && <GitBranch size={12} className="muted" aria-label={tr('Branch')} />}
                      {c.taskId && <CalendarClock size={12} className="muted" aria-label={tr('Scheduled task')} />}
                      <span className="title">{c.title}</span>
                      {c.waiting ? <span className="tab-paw" title={tr('Waiting for your approval')} aria-label={tr('Needs you')}>🐾</span> : c.running && <span className="live-dot" aria-label={tr('Responding')} />}
                      <button
                        className="chat-more"
                        aria-label={tr('Options for {0}', c.title)}
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
        {query && !filtered.length && <div className="muted small" style={{ padding: '12px 10px' }}>{tr('No chats match “{0}”.', query)}</div>}
        {!query && !groups.length && <div className="muted small" style={{ padding: '12px 10px' }}>{tr('Your conversations will appear here.')}</div>}
        {archivedCount > 0 && (
          <a className={`archived-link${route.page === 'archived' ? ' active' : ''}`} href={href({ page: 'archived' })}>
            <Archive size={13} /> {tr('Archived ({0})', archivedCount)}
          </a>
        )}
      </div>
      {menu && (
        <PopupMenu onClose={() => setMenu(undefined)} at={{ x: menu.x, y: menu.y }}>
          <button onClick={() => (setMenu(undefined), setRenaming(menu.chat.id))}>
            <Pencil size={15} /> {tr('Rename')}
          </button>
          <button onClick={() => (setMenu(undefined), void updateChat(menu.chat.id, { pinned: !menu.chat.pinned }))}>
            {menu.chat.pinned ? <PinOff size={15} /> : <Pin size={15} />} {menu.chat.pinned ? tr('Unpin') : tr('Pin')}
          </button>
          {projects.filter((p) => p.id !== menu.chat.projectId && !p.archivedAt).length > 0 && <hr />}
          {projects
            .filter((p) => p.id !== menu.chat.projectId && !p.archivedAt)
            .slice(0, 6)
            .map((p) => (
              <button key={p.id} onClick={() => (setMenu(undefined), void updateChat(menu.chat.id, { projectId: p.id }))}>
                <FolderOpen size={15} />{' '}{tr('Move to {0}', p.name)}
              </button>
            ))}
          {menu.chat.projectId && (
            <button onClick={() => (setMenu(undefined), void updateChat(menu.chat.id, { projectId: null }))}>
              <X size={15} /> {tr('Remove from project')}
            </button>
          )}
          <hr />
          <button
            onClick={() => {
              setMenu(undefined);
              void updateChat(menu.chat.id, { archived: true });
              toast(tr('Archived “{0}”. Find it under Archived.', menu.chat.title), 'info');
              if (route.page === 'chat' && route.id === menu.chat.id) navigate({ page: 'new' });
            }}
          >
            <Archive size={15} /> {tr('Archive')}
          </button>
          <button className="danger" onClick={() => (setMenu(undefined), void deleteChat(menu.chat))}>
            <Trash2 size={15} /> {tr('Delete')}
          </button>
        </PopupMenu>
      )}
      {confirmNode}
      <div className="sidebar-bottom">
        {settings && !settings.hasApiKey && (
          <a className="key-warning" href={href({ page: 'settings', section: 'providers' })}>
            <KeyRound size={15} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{tr('Add an API key for OpenRouter or another provider to start chatting')}</span>
          </a>
        )}
        {budget && budget.state !== 'ok' && budget.limit && (
          <a className={`budget-pill ${budget.freeMode ? 'free' : budget.state}`} href={href({ page: 'settings', section: 'budget' })}>
            <Wallet size={15} />
            {budget.freeMode
              ? tr('Budget reached: using the free model')
              : budget.state === 'over'
                ? budget.hardStop
                  ? tr('Your {0} is reached: paused', budgetName(budget.limit))
                  : tr('Your {0} is reached', budgetName(budget.limit))
                : tr('{0}% of your {1} used', Math.round((budget.limit.spent / budget.limit.amount) * 100), budgetName(budget.limit))}
          </a>
        )}
        {update?.supported && update.behind > 0 && (
          <a className="update-pill" href={href({ page: 'settings', section: 'updates' })} title={tr('v{0} → v{1}', update.current.version, update.latest?.version)}>
            <ArrowUpCircle size={15} /> {tr('Update available')}
          </a>
        )}
        <a className={`nav-item${route.page === 'settings' ? ' active' : ''}`} href={href({ page: 'settings' })}>
          <Settings size={17} /> {tr('Settings')}
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

function NavItem({ item, active }: { item: { route: Route; icon: ReactNode; label: string; count?: number; badge?: number }; active: boolean }) {
  return (
    <a className={`nav-item${active ? ' active' : ''}`} href={href(item.route)}>
      {item.icon}
      {item.label}
      {!!item.count && <span className="count">{item.count}</span>}
      {!!item.badge && (
        <span className="badge-dot" title={tr('{0} new result(s)', item.badge)}>
          {item.badge}
        </span>
      )}
    </a>
  );
}
