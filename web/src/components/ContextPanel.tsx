import { Gauge, History, Loader2, Scissors, Undo2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, ContextBreakdown, ContextSection } from '../api';
import { href } from '../router';
import { formatTokens, useApp } from '../state';

const KIND_COLOR: Record<ContextSection['kind'], string> = {
  system: 'var(--c-system)',
  project: 'var(--c-project)',
  memory: 'var(--c-memory)',
  summary: 'var(--c-summary)',
  history: 'var(--c-history)',
  tools: 'var(--c-tools)',
};

export function ContextPanel({ chatId, refreshKey, onClose, onChanged }: { chatId: string; refreshKey: unknown; onClose(): void; onChanged(): void }) {
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
      if (!res.compacted) toast('Nothing to compact yet: the recent turns are always kept.', 'info');
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
      <div className="panel-head">
        <Gauge size={18} className="muted" />
        <div className="panel-title">Context window</div>
        <button className="icon-btn sm" onClick={onClose} aria-label="Close">
          <X size={15} />
        </button>
      </div>
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
                <span className="muted">of {formatTokens(window)} tokens</span>
              </div>
              <div className="muted small">
                {data.lastPromptTokens
                  ? `Last request used ${data.lastPromptTokens.toLocaleString()} tokens (reported by the provider).`
                  : 'Estimated: no request has been made with the current context yet.'}
              </div>
            </div>

            <div>
              <div className="ctx-bar" aria-hidden>
                {data.sections.map((s, i) => (
                  <div key={i} style={{ width: `${(s.tokens / Math.max(window, total)) * 100}%`, background: KIND_COLOR[s.kind] }} title={`${s.label}: ${s.tokens}`} />
                ))}
                {data.autoCompactAt && <div className="marker" style={{ left: `${Math.min(99, (data.autoCompactAt / window) * 100)}%` }} title="Auto-compaction threshold" />}
              </div>
              {data.autoCompactAt && (
                <div className="muted small" style={{ marginTop: 6 }}>
                  Auto-compacts at {formatTokens(data.autoCompactAt)} (<a href={href({ page: 'settings' })}>change</a>)
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
                <Scissors size={15} /> Compaction
              </div>
              <p className="muted small" style={{ margin: '4px 0 12px' }}>
                Compacting asks the model to summarize older messages, so the conversation keeps going without hitting the limit. You still see the full history here; only
                the model sees the summary.
              </p>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <button className="btn btn-sm" onClick={compact} disabled={!!busy}>
                  {busy === 'compact' ? <Loader2 size={14} className="spin" /> : <Scissors size={14} />} Compact now
                </button>
                {data.compactedMessages > 0 && (
                  <button className="btn btn-sm btn-ghost" onClick={restore} disabled={!!busy}>
                    {busy === 'restore' ? <Loader2 size={14} className="spin" /> : <Undo2 size={14} />} Restore full history
                  </button>
                )}
              </div>
            </div>

            {data.summary && (
              <div>
                <div className="card-title" style={{ marginBottom: 8 }}>
                  <History size={15} /> Summary of {data.compactedMessages} earlier messages
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
