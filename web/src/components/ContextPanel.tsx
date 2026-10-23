import { Gauge, History, Loader2, Maximize2, Scissors, Undo2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ContextBreakdown, ContextSection } from '../api';
import { href } from '../router';
import { formatTokens, useApp } from '../state';
import { ContextRing } from './Composer';
import { tr } from '../i18n';

const KIND_COLOR: Record<ContextSection['kind'], string> = {
  system: 'var(--c-system)',
  project: 'var(--c-project)',
  memory: 'var(--c-memory)',
  summary: 'var(--c-summary)',
  history: 'var(--c-history)',
  tools: 'var(--c-tools)',
};

export function ContextPanel({ chatId, refreshKey, onClose, onChanged, bare }: { chatId: string; refreshKey: unknown; onClose(): void; onChanged(): void; bare?: boolean }) {
  const { toast } = useApp();
  const [data, setData] = useState<ContextBreakdown>();
  const [busy, setBusy] = useState<'compact' | 'restore'>();

  const load = useCallback(() => {
    api.context(chatId).then(setData, (err) => toast(err.message));
  }, [chatId, toast]);
  useEffect(load, [load, refreshKey]);

  const window = data?.contextLength ?? 128_000;
  const used = data ? Math.max(data.lastPromptTokens, data.estimatedTokens) : 0;
  const total = data?.sections.reduce((n, s) => n + s.tokens, 0) || 1;

  const compact = async () => {
    setBusy('compact');
    try {
      const res = await api.compact(chatId);
      if (!res.compacted) toast(tr('Nothing to compact yet: the recent turns are always kept.'), 'info');
      onChanged();
      load();
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  const restore = async () => {
    setBusy('restore');
    try {
      await api.uncompact(chatId);
      onChanged();
      load();
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <>
      {!bare && (
        <div className="panel-head">
          <Gauge size={18} className="muted" />
          <div className="panel-title">{tr('Context window')}</div>
          <button className="icon-btn sm" onClick={onClose} aria-label={tr('Close')}>
            <X size={15} />
          </button>
        </div>
      )}
      <div className="panel-body">
        {!data ? (
          <div className="context-panel muted">
            <Loader2 className="spin" size={18} />
          </div>
        ) : (
          <div className="context-panel">
            <div>
              <div className="ctx-big">
                <strong>{formatTokens(used)}</strong>
                <span className="muted">{tr('of {0} tokens', formatTokens(window))}</span>
              </div>
              <div className="muted small">
                {data.lastPromptTokens
                  ? tr('Last request used {0} tokens (reported by the provider).', data.lastPromptTokens.toLocaleString())
                  : tr('Estimated: no request has been made with the current context yet.')}
              </div>
            </div>

            <div>
              <div className="ctx-bar" aria-hidden>
                {data.sections.map((s, i) => (
                  <div key={i} style={{ width: `${(s.tokens / Math.max(window, total)) * 100}%`, background: KIND_COLOR[s.kind] }} title={`${s.label}: ${s.tokens}`} />
                ))}
                {data.autoCompactAt && <div className="marker" style={{ left: `${Math.min(99, (data.autoCompactAt / window) * 100)}%` }} title={tr('Auto-compaction threshold')} />}
              </div>
              {data.autoCompactAt && (
                <div className="muted small" style={{ marginTop: 6 }}>
                  {tr('Auto-compacts at {0} (', formatTokens(data.autoCompactAt))}<a href={href({ page: 'settings', section: 'general' })}>{tr('change')}</a>)
                </div>
              )}
            </div>

            <div className="ctx-rows">
              {data.sections.map((s, i) => (
                <div className="ctx-row" key={i}>
                  <span className="dot" style={{ background: KIND_COLOR[s.kind] }} />
                  <span>{s.label}</span>
                  <span className="n">~{formatTokens(s.tokens)}</span>
                </div>
              ))}
            </div>

            <div className="card" style={{ padding: 14 }}>
              <div className="card-title">
                <Scissors size={15} /> {tr('Compaction')}
              </div>
              <p className="muted small" style={{ margin: '4px 0 12px' }}>
                {tr('Compacting asks the model to summarize older messages, so the conversation keeps going without hitting the limit. You still see the full history here; only the model sees the summary.')}
              </p>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <button className="btn btn-sm" onClick={compact} disabled={!!busy}>
                  {busy === 'compact' ? <Loader2 size={14} className="spin" /> : <Scissors size={14} />} {tr('Compact now')}
                </button>
                {data.compactedMessages > 0 && (
                  <button className="btn btn-sm btn-ghost" onClick={restore} disabled={!!busy}>
                    {busy === 'restore' ? <Loader2 size={14} className="spin" /> : <Undo2 size={14} />} {tr('Restore full history')}
                  </button>
                )}
              </div>
            </div>

            {data.summary && (
              <div>
                <div className="card-title" style={{ marginBottom: 8 }}>
                  <History size={15} />{' '}{tr('Summary of {0} earlier messages', data.compactedMessages)}
                </div>
                <div className="summary-box">{data.summary}</div>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

/**
 * The context meter in the message box. Clicking it opens a summary; "Show details" opens the full
 * breakdown in the side panel.
 */
export function ContextButton({ chatId, used, total, refreshKey, onDetails }: { chatId: string; used: number; total?: number; refreshKey: unknown; onDetails(): void }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<ContextBreakdown>();
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    api.context(chatId).then(setData, () => {});
    const onDown = (e: MouseEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, chatId, refreshKey]);
  const window = data?.contextLength ?? total ?? 128_000;
  // The same number as the meter: what the provider reported, or an estimate before the first request.
  const now = used || data?.estimatedTokens || 0;
  const pct = Math.min(100, Math.round((now / window) * 100));
  // The biggest parts, merged by kind.
  const byKind = new Map<ContextSection['kind'], number>();
  for (const s of data?.sections ?? []) byKind.set(s.kind, (byKind.get(s.kind) ?? 0) + s.tokens);
  const KIND_LABEL: Record<ContextSection['kind'], string> = { system: tr('Instructions'), project: tr('Project & tasks'), memory: tr('Memory'), summary: tr('Summary'), history: tr('Conversation'), tools: tr('Tools') };
  return (
    <div className="ctx-pop-wrap" ref={wrap}>
      <ContextRing used={used} total={total} active={open} onClick={() => setOpen((o) => !o)} />
      {open && (
        <div className="ctx-pop" role="dialog" aria-label={tr('Context window')}>
          <div className="ctx-pop-title">
            <strong>{pct}%</strong> {tr('of the context window')}
          </div>
          <div className="muted small">
            {tr('{0} of {1} tokens', formatTokens(now), formatTokens(window))}{data?.autoCompactAt ? tr(' · compacts at {0}', formatTokens(data.autoCompactAt)) : ''}
          </div>
          <div className="ctx-bar" aria-hidden style={{ margin: '10px 0 8px' }}>
            {[...byKind].map(([k, n]) => (
              <div key={k} style={{ width: `${(n / window) * 100}%`, background: KIND_COLOR[k] }} />
            ))}
          </div>
          {!data && <Loader2 size={14} className="spin muted" />}
          <div className="ctx-pop-rows">
            {[...byKind]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 4)
              .map(([k, n]) => (
                <div key={k} className="ctx-row">
                  <span className="dot" style={{ background: KIND_COLOR[k] }} />
                  <span>{KIND_LABEL[k]}</span>
                  <span className="n">~{formatTokens(n)}</span>
                </div>
              ))}
          </div>
          {!!data?.compactedMessages && <div className="muted small">{tr('{0} earlier messages are summarized.', data.compactedMessages)}</div>}
          <button
            className="btn btn-sm ctx-pop-more"
            onClick={() => {
              setOpen(false);
              onDetails();
            }}
          >
            <Maximize2 size={13} /> {tr('Show details')}
          </button>
        </div>
      )}
    </div>
  );
}
