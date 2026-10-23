import { ChevronDown, Eye } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ModelInfo } from '../api';
import { formatTokens, modelLabel, useApp } from '../state';

const FEATURED = [
  'anthropic/claude-sonnet-4.5',
  'anthropic/claude-opus-4.1',
  'openai/gpt-5',
  'openai/gpt-5-mini',
  'google/gemini-2.5-pro',
  'google/gemini-2.5-flash',
  'deepseek/deepseek-chat-v3.1',
  'x-ai/grok-4',
  'qwen/qwen3-coder',
  'moonshotai/kimi-k2',
];

function price(m: ModelInfo): string | undefined {
  if (m.promptPrice === undefined) return undefined;
  if (m.promptPrice === 0 && m.completionPrice === 0) return 'free';
  return `$${fmt(m.promptPrice)} / $${fmt(m.completionPrice ?? 0)} per M`;
}

function fmt(n: number): string {
  return n >= 10 ? n.toFixed(0) : n >= 1 ? n.toFixed(2).replace(/\.?0+$/, '') : n.toFixed(3).replace(/\.?0+$/, '');
}

export function ModelPicker({
  value,
  onChange,
  variant = 'pill',
  direction = 'up',
  allowEmpty,
}: {
  value: string;
  onChange(id: string): void;
  variant?: 'pill' | 'input';
  direction?: 'up' | 'down';
  /** Shows a "Default" choice that maps to an empty value. */
  allowEmpty?: string;
}) {
  const { models, modelsError } = useApp();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [focus, setFocus] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setFocus(0);
    const onDown = (e: MouseEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = (m: ModelInfo) => !q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q);
    const featured = FEATURED.map((id) => models.find((m) => m.id === id)).filter((m): m is ModelInfo => !!m && matches(m));
    const rest = models.filter((m) => !FEATURED.includes(m.id) && matches(m)).sort((a, b) => a.name.localeCompare(b.name));
    const out: { section?: string; model?: ModelInfo; custom?: string; empty?: boolean }[] = [];
    if (allowEmpty && !q) out.push({ empty: true });
    if (/[/:]/.test(q) && !models.some((m) => m.id === q)) out.push({ custom: query.trim() });
    if (featured.length) out.push({ section: 'Popular on OpenRouter' }, ...featured.map((model) => ({ model })));
    // Directly connected providers first, then OpenRouter's catalog.
    const groups = new Map<string, ModelInfo[]>();
    for (const m of rest) {
      const p = m.provider ?? 'OpenRouter';
      groups.set(p, [...(groups.get(p) ?? []), m]);
    }
    const order = [...groups.keys()].sort((a, b) => Number(a === 'OpenRouter') - Number(b === 'OpenRouter') || a.localeCompare(b));
    for (const p of order) {
      const list = groups.get(p)!;
      out.push({ section: order.length > 1 ? `${p} · ${list.length}` : q ? 'Matches' : 'All models' }, ...list.slice(0, 300).map((model) => ({ model })));
    }
    return out;
  }, [models, query, allowEmpty]);

  const selectable = items.filter((i) => !i.section);
  const choose = (i: (typeof items)[number]) => {
    if (i.empty) onChange('');
    else if (i.custom) onChange(i.custom);
    else if (i.model) onChange(i.model.id);
    setOpen(false);
  };

  useEffect(() => {
    listRef.current?.querySelector('.focused')?.scrollIntoView({ block: 'nearest' });
  }, [focus]);

  const label = value ? modelLabel(value, models) : allowEmpty ?? 'Choose a model';
  return (
    <div className="menu-wrap" ref={wrap}>
      {variant === 'pill' ? (
        <button type="button" className="pill-btn" onClick={() => setOpen((o) => !o)} title={value}>
          <span>{label}</span>
          <ChevronDown size={14} />
        </button>
      ) : (
        <button type="button" className="input" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', textAlign: 'left' }} onClick={() => setOpen((o) => !o)}>
          <span>
            {label} {value && <span className="muted small">· {value}</span>}
          </span>
          <ChevronDown size={16} className="muted" />
        </button>
      )}
      {open && (
        <div className="picker" style={direction === 'up' ? { bottom: 'calc(100% + 6px)', left: 0 } : { top: 'calc(100% + 6px)', left: 0 }}>
          <div className="picker-search">
            <input
              autoFocus
              placeholder="Search models, or type an id (vendor/model or provider:model)"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setFocus(0);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setFocus((f) => Math.min(f + 1, selectable.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setFocus((f) => Math.max(f - 1, 0));
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  if (selectable[focus]) choose(selectable[focus]);
                } else if (e.key === 'Escape') setOpen(false);
              }}
            />
          </div>
          <div className="picker-list" ref={listRef}>
            {modelsError && !models.length && <div className="picker-section" style={{ textTransform: 'none' }}>{modelsError} Type a model id to use it.</div>}
            {items.map((item, idx) => {
              if (item.section) return <div key={`s${idx}`} className="picker-section">{item.section}</div>;
              const index = selectable.indexOf(item);
              const cls = `picker-item${index === focus ? ' focused' : ''}`;
              if (item.empty)
                return (
                  <button key="empty" className={`${cls}${!value ? ' selected' : ''}`} onMouseEnter={() => setFocus(index)} onClick={() => choose(item)}>
                    <span className="picker-name">{allowEmpty}</span>
                  </button>
                );
              if (item.custom)
                return (
                  <button key="custom" className={cls} onMouseEnter={() => setFocus(index)} onClick={() => choose(item)}>
                    <span className="picker-name">Use “{item.custom}”</span>
                    <span className="picker-meta">{item.custom.includes(':') && !item.custom.includes('/') ? 'Model id for a connected provider' : 'Custom OpenRouter model id'}</span>
                  </button>
                );
              const m = item.model!;
              return (
                <button key={`${idx}-${m.id}`} className={`${cls}${m.id === value ? ' selected' : ''}`} onMouseEnter={() => setFocus(index)} onClick={() => choose(item)}>
                  <span className="picker-name">
                    {m.name.replace(/^[^:]+:\s*/, '')}
                    {m.vision && <Eye size={12} className="muted" aria-label="Vision" />}
                    {!m.tools && <span className="badge warn" style={{ padding: '0 6px', fontSize: 10.5 }}>no tools</span>}
                  </span>
                  <span className="picker-meta">
                    <span>{m.id}</span>
                    {m.contextLength && <span>{formatTokens(m.contextLength)} context</span>}
                    {price(m) && <span>{price(m)}</span>}
                  </span>
                </button>
              );
            })}
            {!items.length && <div className="picker-section" style={{ textTransform: 'none' }}>No models match.</div>}
          </div>
        </div>
      )}
    </div>
  );
}

