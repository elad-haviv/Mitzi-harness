import { Brain, Check, Download, Loader2, MessageCircleQuestion, Pencil, Plus, Search, Settings2, Sparkles, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, BankSummary, DEFAULT_BOT_ID, MemoryType, MemoryUnit, RecalledMemory, ReflectResult } from '../api';
import { ImportModal } from '../components/Import';
import { Markdown } from '../components/Markdown';
import { Empty, Toggle, useConfirm } from '../components/ui';
import { href, navigate } from '../router';
import { LOGO, relativeTime, useApp } from '../state';
import { plural, tr } from '../i18n';

const TYPE_LABEL: Record<MemoryType, string> = { observation: tr('Belief'), world: tr('Fact'), experience: tr('Experience') };
const TYPE_HINT: Record<MemoryType, string> = {
  observation: tr('Consolidated from several facts and refined as new evidence arrives'),
  world: tr('Facts about you, people, places and projects'),
  experience: tr('Things the bot did or learned in conversations with you'),
};
const PAGE = 50;

function total(b: BankSummary): number {
  return b.stats ? b.stats.world + b.stats.experience + b.stats.observation : 0;
}

export function MemoryPage({ botId }: { botId?: string }) {
  const { settings, refreshSettings, bots, toast } = useApp();
  const [banks, setBanks] = useState<BankSummary[]>();
  const [importing, setImporting] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const selectedId = botId ?? DEFAULT_BOT_ID;
  const bot = bots.find((b) => b.id === selectedId);

  const loadBanks = useCallback(() => api.banks().then(setBanks, (err) => toast(err.message)), [toast]);
  useEffect(() => {
    void loadBanks();
  }, [loadBanks]);
  const bank = banks?.find((b) => b.bot.id === selectedId);

  // Refresh counts while the bank is still learning from recent conversations.
  useEffect(() => {
    if (!bank?.stats?.pending) return;
    const t = setTimeout(loadBanks, 1500);
    return () => clearTimeout(t);
  }, [bank?.stats?.pending, loadBanks]);

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-header">
          <div>
            <h1 className="page-title">{tr('Memory')}</h1>
            <p className="page-subtitle">
              {tr('Every bot has its own memory bank. It learns from your conversations, consolidates what it learns into beliefs, and recalls what\'s relevant to each new message.')}
            </p>
          </div>
          <button className="btn" onClick={() => setImporting(true)} title={tr('Bring memories and chats over from ChatGPT, Claude, Gemini and others')}>
            <Download size={15} /> {tr('Import from other AIs')}
          </button>
          {importing && (
            <ImportModal
              onClose={() => setImporting(false)}
              onDone={() => {
                void loadBanks();
                setRefreshKey((k) => k + 1);
              }}
            />
          )}
          {settings && (
            <label className="row small">
              {settings.memoryEnabled ? tr('Memory on') : tr('Memory off')}
              <Toggle
                label={tr('Memory enabled')}
                on={settings.memoryEnabled}
                onChange={(v) =>
                  api
                    .updateSettings({ memoryEnabled: v })
                    .then(refreshSettings)
                    .catch((err) => toast(err.message))
                }
              />
            </label>
          )}
        </div>

        {settings?.memoryBackend === 'hindsight' && (
          <div className="card small" style={{ marginBottom: 18, padding: '10px 14px' }}>
            {tr('Memories are stored on your Hindsight server at')}{' '}<code>{settings.hindsightUrl}</code>. <a href={href({ page: 'settings', section: 'memory' })}>{tr('Change')}</a>
          </div>
        )}

        <div className="memory-layout">
          <div className="bank-list" role="tablist" aria-label={tr('Memory banks')}>
            {(banks ?? []).map((b) => (
              <button
                key={b.bot.id}
                role="tab"
                aria-selected={b.bot.id === selectedId}
                className={`bank-item${b.bot.id === selectedId ? ' active' : ''}`}
                onClick={() => navigate({ page: 'memory', botId: b.bot.id }, true)}
              >
                <span className={`bank-emoji${b.bot.builtIn ? ' builtin' : ''}`}>{b.bot.builtIn ? LOGO : b.bot.emoji}</span>
                <span className="grow">
                  <span className="t">{b.bot.name}</span>
                  <span className="s">{!b.enabled ? tr('Memory off') : b.error ? tr('Unavailable') : tr('{0} memories', total(b))}</span>
                </span>
                {!!b.stats?.pending && <Loader2 size={14} className="spin muted" aria-label={tr('Learning')} />}
              </button>
            ))}
          </div>

          {bank && bot ? (
            <BankDetail key={`${bank.bot.id}-${refreshKey}`} bank={bank} onChanged={loadBanks} />
          ) : (
            <div className="muted">{banks ? tr('Bot not found.') : tr('Loading…')}</div>
          )}
        </div>
      </div>
    </div>
  );
}

function BankDetail({ bank, onChanged }: { bank: BankSummary; onChanged(): void }) {
  const { bots, toast } = useApp();
  const bot = bots.find((b) => b.id === bank.bot.id)!;
  const [tab, setTab] = useState<'browse' | 'search' | 'ask'>('browse');
  const [confirmNode, confirm] = useConfirm();
  const s = bank.stats;
  const d = bot.memory.disposition;

  return (
    <div className="bank-detail">
      <div className="card bank-head">
        <div className="row" style={{ alignItems: 'flex-start', gap: 14 }}>
          <span className={`bank-emoji lg${bot.builtIn ? ' builtin' : ''}`}>{bot.builtIn ? LOGO : bot.emoji}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 className="bank-title">{bot.name}{tr('\'s memory bank')}</h2>
            <p className="muted small" style={{ margin: '2px 0 0' }}>
              {bot.memory.mission || tr('No mission set: it remembers whatever seems useful later.')}
            </p>
          </div>
          <a className="btn btn-sm" href={href({ page: 'bots' })} title={tr('Edit mission and disposition on the Bots page')}>
            <Settings2 size={14} /> {tr('Configure')}
          </a>
          <button
            className="btn btn-sm btn-ghost btn-danger"
            onClick={async () => {
              if (!(await confirm(tr('Erase everything {0} remembers? This can\'t be undone.', bot.name), { title: tr('Clear memory bank?'), action: 'Clear bank' }))) return;
              await api.clearBank(bot.id).catch((err) => toast(err.message));
              onChanged();
            }}
          >
            <Trash2 size={14} /> {tr('Clear')}
          </button>
        </div>
        {!bank.enabled && (
          <div className="key-warning" style={{ marginTop: 12 }}>
            {tr('Memory is turned off for this bot. Turn it on in the bot\'s settings to recall and learn.')}
          </div>
        )}
        {bank.error && (
          <div className="error-box" style={{ marginTop: 12 }}>
            {bank.error}
          </div>
        )}
        <div className="bank-stats">
          <Stat n={s?.observation} label={tr('Beliefs')} kind="observation" />
          <Stat n={s?.world} label={tr('Facts')} kind="world" />
          <Stat n={s?.experience} label={tr('Experiences')} kind="experience" />
          <Stat n={s?.entities} label={tr('Entities')} />
          <div className="traits">
            <Trait label={tr('Skepticism')} low={tr('Trusting')} high={tr('Skeptical')} v={d.skepticism} />
            <Trait label={tr('Literalism')} low={tr('Flexible')} high={tr('Literal')} v={d.literalism} />
            <Trait label={tr('Empathy')} low={tr('Detached')} high={tr('Empathetic')} v={d.empathy} />
          </div>
        </div>
        <div className="muted small" style={{ marginTop: 10 }}>
          {s?.pending ? (
            <span className="row" style={{ gap: 6 }}>
              <Loader2 size={13} className="spin" /> {tr('Learning from a recent conversation…')}
            </span>
          ) : s?.lastRetainAt ? (
            tr('Last learned {0} · {1}', relativeTime(s.lastRetainAt), bot.memory.autoRetain ? 'learns from every conversation' : 'automatic learning is off')
          ) : bot.memory.autoRetain ? (
            tr('Learns from every conversation with this bot.')
          ) : (
            tr('Automatic learning is off; it only remembers what you add.')
          )}
        </div>
      </div>

      <div className="segmented" style={{ margin: '18px 0 14px' }}>
        <button className={tab === 'browse' ? 'active' : ''} onClick={() => setTab('browse')}>
          <Brain size={13} /> {tr('Browse')}
        </button>
        <button className={tab === 'search' ? 'active' : ''} onClick={() => setTab('search')}>
          <Search size={13} /> {tr('Recall')}
        </button>
        <button className={tab === 'ask' ? 'active' : ''} onClick={() => setTab('ask')}>
          <MessageCircleQuestion size={13} /> {tr('Reflect')}
        </button>
      </div>

      {tab === 'browse' && <Browse botId={bot.id} name={bot.name} refreshKey={s} onChanged={onChanged} />}
      {tab === 'search' && <RecallTab botId={bot.id} />}
      {tab === 'ask' && <ReflectTab botId={bot.id} name={bot.name} />}
      {confirmNode}
    </div>
  );
}

function Stat({ n, label, kind }: { n?: number; label: string; kind?: MemoryType }) {
  return (
    <div className="stat" title={kind ? TYPE_HINT[kind] : tr('People, places and things mentioned in memories')}>
      <strong>{n ?? '–'}</strong>
      <span className={kind ? `mem-type ${kind}` : 'muted small'}>{label}</span>
    </div>
  );
}

function Trait({ label, low, high, v }: { label: string; low: string; high: string; v: number }) {
  return (
    <div className="trait" title={`${label}: ${v}/5 (${v <= 2 ? low : v >= 4 ? high : 'balanced'})`}>
      <span className="muted small">{label}</span>
      <span className="pips" aria-label={tr('{0} of 5', v)}>
        {[1, 2, 3, 4, 5].map((i) => (
          <i key={i} className={i <= v ? 'on' : ''} />
        ))}
      </span>
    </div>
  );
}

function Browse({ botId, name, refreshKey, onChanged }: { botId: string; name: string; refreshKey: unknown; onChanged(): void }) {
  const { toast } = useApp();
  const [type, setType] = useState<MemoryType | undefined>();
  const [q, setQ] = useState('');
  const [items, setItems] = useState<MemoryUnit[]>();
  const [totalCount, setTotal] = useState(0);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<{ id: string; text: string }>();
  const [confirmNode, confirm] = useConfirm();

  const load = useCallback(
    async (offset = 0) => {
      try {
        const res = await api.bankMemories(botId, { type, q: q.trim() || undefined, limit: PAGE, offset });
        setItems((prev) => (offset ? [...(prev ?? []), ...res.items] : res.items));
        setTotal(res.total);
      } catch (err) {
        toast((err as Error).message);
      }
    },
    [botId, type, q, toast],
  );
  useEffect(() => {
    const t = setTimeout(() => void load(), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q, refreshKey]);

  const byId = useMemo(() => new Map((items ?? []).map((m) => [m.id, m])), [items]);

  return (
    <>
      <form
        className="row"
        style={{ marginBottom: 14 }}
        onSubmit={async (e) => {
          e.preventDefault();
          if (!draft.trim()) return;
          try {
            await api.remember(botId, draft.trim());
            setDraft('');
            void load();
            onChanged();
          } catch (err) {
            toast((err as Error).message);
          }
        }}
      >
        <input className="input" placeholder={tr('Teach {0} something, e.g. “I’m vegetarian and allergic to nuts”', name)} value={draft} onChange={(e) => setDraft(e.target.value)} />
        <button className="btn btn-primary" disabled={!draft.trim()}>
          <Plus size={16} /> {tr('Remember')}
        </button>
      </form>

      <div className="row" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        <div className="segmented">
          <button className={!type ? 'active' : ''} onClick={() => setType(undefined)}>
            {tr('All')}
          </button>
          {(['observation', 'world', 'experience'] as MemoryType[]).map((t) => (
            <button key={t} className={type === t ? 'active' : ''} onClick={() => setType(t)} title={TYPE_HINT[t]}>
              {TYPE_LABEL[t]}s
            </button>
          ))}
        </div>
        <div className="sidebar-search" style={{ flex: 1, minWidth: 180, margin: 0 }}>
          <Search size={14} />
          <input placeholder={tr('Filter by text or entity')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={tr('Filter memories')} />
        </div>
      </div>

      {items && items.length === 0 ? (
        <Empty icon={<Brain size={22} />} title={q || type ? tr('No matching memories') : tr('Nothing remembered yet')}>
          {q || type ? tr('Try a different filter.') : tr('Chat with {0} and it will learn as you go, or teach it something above.', name)}
        </Empty>
      ) : (
        <div className="list">
          {(items ?? []).map((m) => (
            <div key={m.id} className="memory-row">
              <span className={`mem-type ${m.type}`} title={TYPE_HINT[m.type]}>
                {TYPE_LABEL[m.type]}
              </span>
              <div className="content">
                {editing?.id === m.id ? (
                  <form
                    className="row"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      await api.updateMemory(botId, m.id, editing.text).catch((err) => toast(err.message));
                      setEditing(undefined);
                      void load();
                    }}
                  >
                    <input className="input" autoFocus value={editing.text} onChange={(e) => setEditing({ id: m.id, text: e.target.value })} />
                    <button className="icon-btn" aria-label={tr('Save')}>
                      <Check size={16} />
                    </button>
                    <button type="button" className="icon-btn" aria-label={tr('Cancel')} onClick={() => setEditing(undefined)}>
                      <X size={16} />
                    </button>
                  </form>
                ) : (
                  <>
                    {m.text}
                    <div className="meta">
                      {m.occurredAt && <span>{tr('Happened')}{' '}{new Date(m.occurredAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>}
                      <span>
                        {m.type === 'observation' ? tr('Updated') : m.source === 'user' ? tr('Added by you') : tr('Learned')} {relativeTime(m.updatedAt ?? m.mentionedAt)}
                      </span>
                      {m.type === 'observation' && m.evidence && (
                        <span title={m.evidence.map((id) => byId.get(id)?.text ?? id).join('\n')}>
                          <Sparkles size={11} /> {plural(m.evidence.length, '1 supporting fact', '{0} supporting facts')}
                          {m.confidence !== undefined && tr(' · {0}% confident', Math.round(m.confidence * 100))}
                        </span>
                      )}
                      {m.entities.slice(0, 5).map((e) => (
                        <button key={e} className="entity" onClick={() => setQ(e)} title={tr('Show memories about {0}', e)}>
                          {e}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
              {editing?.id !== m.id && (
                <div className="actions">
                  <button className="icon-btn sm" aria-label={tr('Edit memory')} onClick={() => setEditing({ id: m.id, text: m.text })}>
                    <Pencil size={14} />
                  </button>
                  <button
                    className="icon-btn sm"
                    aria-label={tr('Forget memory')}
                    onClick={async () => {
                      if (!(await confirm(tr('Forget “{0}”?', m.text), { title: tr('Forget this memory?'), action: tr('Forget') }))) return;
                      await api.forget(botId, m.id).catch((err) => toast(err.message));
                      void load();
                      onChanged();
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {items && items.length < totalCount && (
        <button className="btn btn-ghost" style={{ marginTop: 12 }} onClick={() => void load(items.length)}>
          {tr('Show more (')}{totalCount - items.length} {tr('left)')}
        </button>
      )}
      {confirmNode}
    </>
  );
}

function RecallTab({ botId }: { botId: string }) {
  const { toast } = useApp();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<RecalledMemory[]>();
  const [busy, setBusy] = useState(false);
  return (
    <>
      <p className="muted small" style={{ marginTop: 0 }}>
        {tr('See what gets recalled for a message. Recall combines keyword search, the entity graph, time expressions like “last week” and, if you set an embedding model, semantic similarity, then merges the rankings.')}
      </p>
      <form
        className="row"
        style={{ marginBottom: 14 }}
        onSubmit={async (e) => {
          e.preventDefault();
          if (!q.trim()) return;
          setBusy(true);
          try {
            setResults(await api.recall(botId, q.trim()));
          } catch (err) {
            toast((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <input className="input" autoFocus placeholder={tr('e.g. What did I say about my sister last month?')} value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn btn-primary" disabled={!q.trim() || busy}>
          {busy ? <Loader2 size={16} className="spin" /> : <Search size={16} />} {tr('Recall')}
        </button>
      </form>
      {results &&
        (results.length ? (
          <div className="list">
            {results.map((m, i) => (
              <div key={m.id} className="memory-row">
                <span className="rank">{i + 1}</span>
                <span className={`mem-type ${m.type}`}>{TYPE_LABEL[m.type]}</span>
                <div className="content">
                  {m.text}
                  <div className="meta">
                    {(m.strategies ?? []).map((s) => (
                      <span key={s} className="strategy">
                        {s}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty" style={{ padding: 28 }}>
            {tr('Nothing relevant recalled.')}
          </div>
        ))}
    </>
  );
}

function ReflectTab({ botId, name }: { botId: string; name: string }) {
  const { toast } = useApp();
  const [q, setQ] = useState('');
  const [result, setResult] = useState<ReflectResult>();
  const [busy, setBusy] = useState(false);
  return (
    <>
      <p className="muted small" style={{ marginTop: 0 }}>
        {tr('Ask')}{' '}{name} {tr('a question about everything it remembers. Reflection reasons over many memories at once, shaped by the bank\'s disposition.')}
      </p>
      <form
        className="row"
        style={{ marginBottom: 14 }}
        onSubmit={async (e) => {
          e.preventDefault();
          if (!q.trim()) return;
          setBusy(true);
          setResult(undefined);
          try {
            setResult(await api.reflect(botId, q.trim()));
          } catch (err) {
            toast((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <input className="input" autoFocus placeholder={tr('e.g. What do you know about my goals this year?')} value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn btn-primary" disabled={!q.trim() || busy}>
          {busy ? <Loader2 size={16} className="spin" /> : <Sparkles size={16} />} {tr('Reflect')}
        </button>
      </form>
      {result && (
        <div className="card">
          <Markdown text={result.text} />
          {result.basedOn.length > 0 && <p className="muted small" style={{ margin: '12px 0 0' }}>{tr('Based on')}{' '}{result.basedOn.length} memories.</p>}
        </div>
      )}
    </>
  );
}
