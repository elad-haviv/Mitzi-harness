// Tabs for the chats you have open, so several can work at once: each shows whether it is responding,
// waiting for you, or done, and runs keep going while you're in another tab.
import { Loader2, Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { href, navigate, Route } from '../router';
import { useApp } from '../state';

const KEY = 'mitzi.tabs';
const MAX_TABS = 10;

function load(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function save(ids: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(ids));
  } catch {
    // Not persisted; fine.
  }
}

export function ChatTabs({ route }: { route: Route }) {
  const { chats } = useApp();
  const [tabs, setTabs] = useState<string[]>(load);
  const active = route.page === 'chat' ? route.id : undefined;

  // Opening a chat opens its tab (the oldest unused tab makes room).
  useEffect(() => {
    if (!active) return;
    setTabs((t) => {
      if (t.includes(active)) return t;
      const next = [...t, active].slice(-MAX_TABS);
      save(next);
      return next;
    });
  }, [active]);

  // Deleted chats lose their tabs.
  const open = tabs.filter((id) => chats.some((c) => c.id === id));
  useEffect(() => {
    if (chats.length && open.length !== tabs.length) {
      setTabs(open);
      save(open);
    }
  }, [chats]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = (id: string) => {
    const i = open.indexOf(id);
    const next = open.filter((x) => x !== id);
    setTabs(next);
    save(next);
    if (id === active) navigate(next.length ? { page: 'chat', id: next[Math.min(i, next.length - 1)] } : { page: 'new' });
  };

  if (open.length < 2 || (route.page !== 'chat' && route.page !== 'new')) return null;
  return (
    <div className="chat-tabs" role="tablist" aria-label="Open chats">
      {open.map((id) => {
        const c = chats.find((x) => x.id === id)!;
        const state = c.waiting ? 'waiting' : c.running ? 'running' : '';
        return (
          <a
            key={id}
            role="tab"
            aria-selected={id === active}
            className={`chat-tab${id === active ? ' active' : ''}${state ? ` ${state}` : ''}`}
            href={href({ page: 'chat', id })}
            title={`${c.title}${c.waiting ? ' · waiting for your approval' : c.running ? ' · working' : ''}`}
            onAuxClick={(e) => e.button === 1 && (e.preventDefault(), close(id))}
          >
            {c.waiting ? <span className="tab-paw" aria-label="Needs you">🐾</span> : c.running ? <Loader2 size={12} className="spin" aria-label="Working" /> : null}
            <span className="chat-tab-title">{c.title}</span>
            <button
              className="chat-tab-close"
              aria-label={`Close ${c.title}`}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                close(id);
              }}
            >
              <X size={12} />
            </button>
          </a>
        );
      })}
      <a className="chat-tab-new" href={href({ page: 'new' })} title="New chat" aria-label="New chat">
        <Plus size={14} />
      </a>
    </div>
  );
}
