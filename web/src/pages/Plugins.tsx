import { ChevronDown, ChevronRight, Download, Loader2, MoreHorizontal, Puzzle, RefreshCw, Store, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, MarketplaceInfo, PluginInfo } from '../api';
import { Empty, Menu, Modal, Toggle, useConfirm } from '../components/ui';
import { useApp } from '../state';
import { plural, tr } from '../i18n';

const SUGGESTED = [
  { source: 'anthropics/claude-plugins-official', label: tr('Claude plugin directory') },
  { source: 'anthropics/claude-code', label: tr('Claude Code plugins') },
  { source: 'anthropics/skills', label: tr('Anthropic skills') },
];

function summary(p: PluginInfo): string {
  const c = p.components;
  const parts = [
    c.skills && plural(c.skills, '1 skill', '{0} skills'),
    c.commands && plural(c.commands, '1 command', '{0} commands'),
    c.agents && plural(c.agents, '1 bot', '{0} bots'),
    c.mcpServers && plural(c.mcpServers, '1 connector', '{0} connectors'),
  ].filter(Boolean);
  return parts.join(' · ') || tr('Nothing Mitzi can use');
}

export function PluginsPage() {
  const { toast, refreshBots } = useApp();
  const [plugins, setPlugins] = useState<PluginInfo[]>();
  const [markets, setMarkets] = useState<MarketplaceInfo[]>([]);
  const [installing, setInstalling] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [confirmNode, confirm] = useConfirm();

  const load = useCallback(async () => {
    try {
      const [p, m] = await Promise.all([api.plugins(), api.marketplaces()]);
      setPlugins(p);
      setMarkets(m);
    } catch (err) {
      toast((err as Error).message);
    }
  }, [toast]);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    try {
      await fn();
      if (done) toast(done, 'info');
      await load();
      void refreshBots();
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-header">
          <div>
            <h1 className="page-title">{tr('Plugins')}</h1>
            <p className="page-subtitle">
              {tr('Bundles of skills, slash commands, bots and connectors. Mitzi installs Claude Code plugins and marketplaces as they are.')}
            </p>
          </div>
          <button className="btn btn-primary" onClick={() => setInstalling(true)}>
            <Download size={16} /> {tr('Install plugin')}
          </button>
        </div>

        <h2 className="section-title" style={{ marginTop: 0 }}>
          {tr('Installed')}
        </h2>
        {plugins && plugins.length === 0 ? (
          <Empty icon={<Puzzle size={22} />} title={tr('No plugins installed')}>
            {tr('Install one from a marketplace below, or from a git repository.')}
          </Empty>
        ) : (
          <div className="list">
            {(plugins ?? []).map((p) => (
              <div key={p.id} className="ext-row">
                <div className="ext-head">
                  <span className="ext-icon">🧩</span>
                  <div className="grow">
                    <div className="t">
                      {p.name}
                      {p.version && <span className="muted small">v{p.version}</span>}
                      {p.components.hooks && (
                        <span className="badge warn" title={tr('Hooks are Claude Code automations that Mitzi doesn\'t run')}>
                          {tr('hooks not supported')}
                        </span>
                      )}
                    </div>
                    <div className="s" title={p.description}>
                      {summary(p)}
                      {p.description ? ` — ${p.description}` : ''}
                    </div>
                  </div>
                  {busy === p.id && <Loader2 size={16} className="spin muted" />}
                  <Toggle label={tr('Enable {0}', p.name)} on={p.enabled} onChange={(v) => void run(p.id, () => api.setPluginEnabled(p.id, v))} />
                  <Menu
                    trigger={(_o, toggle) => (
                      <button className="icon-btn" onClick={toggle} aria-label={tr('{0} options', p.name)}>
                        <MoreHorizontal size={17} />
                      </button>
                    )}
                  >
                    {(close) => (
                      <>
                        <button onClick={() => (close(), void run(p.id, () => api.updatePlugin(p.id), tr('{0} updated', p.name)))}>
                          <RefreshCw size={15} /> {tr('Update')}
                        </button>
                        <hr />
                        <button
                          className="danger"
                          onClick={async () => {
                            close();
                            if (!(await confirm(tr('Uninstall {0}? Its skills, commands, bots and connectors are removed. Chats are kept.', p.name), { title: tr('Uninstall plugin?'), action: tr('Uninstall') }))) return;
                            void run(p.id, () => api.uninstallPlugin(p.id));
                          }}
                        >
                          <Trash2 size={15} /> {tr('Uninstall')}
                        </button>
                      </>
                    )}
                  </Menu>
                </div>
              </div>
            ))}
          </div>
        )}

        <h2 className="section-title">
          <Store size={17} /> {tr('Marketplaces')}
        </h2>
        <AddMarketplace existing={markets} onAdded={load} />
        {markets.map((m) => (
          <Marketplace
            key={m.id}
            market={m}
            busy={busy}
            onInstall={(name) => run(`${m.id}:${name}`, () => api.installFromMarketplace(m.id, name), tr('Installed {0}', name))}
            onRefresh={() => run(m.id, () => api.refreshMarketplace(m.id))}
            onRemove={() => run(m.id, () => api.removeMarketplace(m.id))}
          />
        ))}
      </div>
      {installing && (
        <InstallModal
          onClose={() => setInstalling(false)}
          onDone={(result) => {
            if (result.marketplace) toast(tr('That repository is a marketplace; added “{0}” below.', result.marketplace.name), 'info');
            else if (result.plugin) toast(tr('Installed {0}', result.plugin.name), 'info');
            void load();
            void refreshBots();
          }}
        />
      )}
      {confirmNode}
    </div>
  );
}

function AddMarketplace({ existing, onAdded }: { existing: MarketplaceInfo[]; onAdded(): void }) {
  const { toast } = useApp();
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState<string>();
  const add = async (s: string) => {
    setBusy(s);
    try {
      await api.addMarketplace(s);
      setSource('');
      onAdded();
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  const suggestions = SUGGESTED.filter((x) => !existing.some((m) => m.source === x.source));
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (source.trim()) void add(source.trim());
        }}
      >
        <input className="input mono" placeholder={tr('owner/repo, a git URL, or a folder')} value={source} onChange={(e) => setSource(e.target.value)} />
        <button className="btn" disabled={!source.trim() || !!busy}>
          {busy === source.trim() && busy ? <Loader2 size={15} className="spin" /> : null} {tr('Add marketplace')}
        </button>
      </form>
      {suggestions.length > 0 && (
        <div className="row small" style={{ marginTop: 10, flexWrap: 'wrap', gap: 6 }}>
          <span className="muted">{tr('Suggested:')}</span>
          {suggestions.map((s) => (
            <button key={s.source} className="badge" style={{ cursor: 'pointer' }} disabled={!!busy} onClick={() => void add(s.source)} title={s.source}>
              {busy === s.source ? <Loader2 size={11} className="spin" /> : '+'} {s.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Marketplace({
  market,
  busy,
  onInstall,
  onRefresh,
  onRemove,
}: {
  market: MarketplaceInfo;
  busy?: string;
  onInstall(name: string): void;
  onRefresh(): void;
  onRemove(): void;
}) {
  const [open, setOpen] = useState(market.plugins.length <= 20);
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(30);
  const query = q.trim().toLowerCase();
  const shown = market.plugins.filter((p) => !query || `${p.name} ${p.description ?? ''} ${p.category ?? ''}`.toLowerCase().includes(query));
  return (
    <div className="list" style={{ marginBottom: 14 }}>
      <div className="ext-head" style={{ borderBottom: open ? '1px solid var(--border)' : 0 }}>
        <button className="icon-btn sm" onClick={() => setOpen((o) => !o)} aria-label={open ? tr('Collapse') : tr('Expand')}>
          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </button>
        <div className="grow">
          <div className="t">{market.name}</div>
          <div className="s">
            {tr('{0} plugins · {1}', market.plugins.length, market.source)}
            {market.description ? ` — ${market.description}` : ''}
          </div>
        </div>
        {busy === market.id && <Loader2 size={16} className="spin muted" />}
        <button className="icon-btn sm" title={tr('Refresh')} aria-label={tr('Refresh marketplace')} onClick={onRefresh}>
          <RefreshCw size={14} />
        </button>
        <button className="icon-btn sm" title={tr('Remove')} aria-label={tr('Remove marketplace')} onClick={onRemove}>
          <Trash2 size={14} />
        </button>
      </div>
      {open && (
        <div style={{ padding: '10px 16px 14px' }}>
          {market.plugins.length > 8 && (
            <input className="input" placeholder={tr('Search {0} plugins', market.plugins.length)} value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 10 }} />
          )}
          {shown.slice(0, limit).map((p) => (
            <div key={p.name} className="file-row" style={{ alignItems: 'flex-start', gap: 12 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 560 }}>
                  {p.name} {p.category && <span className="badge" style={{ marginLeft: 6 }}>{p.category}</span>}
                </div>
                {p.description && (
                  <div className="muted small" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                    {p.description}
                  </div>
                )}
              </div>
              {p.installed ? (
                <span className="badge ok">{tr('Installed')}</span>
              ) : (
                <button className="btn btn-sm" disabled={!!busy} onClick={() => onInstall(p.name)}>
                  {busy === `${market.id}:${p.name}` ? <Loader2 size={14} className="spin" /> : <Download size={14} />} {tr('Install')}
                </button>
              )}
            </div>
          ))}
          {shown.length > limit && (
            <button className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={() => setLimit((l) => l + 50)}>
              {tr('Show more ({0})', shown.length - limit)}
            </button>
          )}
          {!shown.length && <div className="muted small">{tr('No plugins match.')}</div>}
        </div>
      )}
    </div>
  );
}

function InstallModal({ onClose, onDone }: { onClose(): void; onDone(r: { plugin?: PluginInfo; marketplace?: MarketplaceInfo }): void }) {
  const { toast } = useApp();
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  const install = async () => {
    setBusy(true);
    try {
      onDone(await api.installPlugin(source.trim()));
      onClose();
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={tr('Install a plugin')}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            {tr('Cancel')}
          </button>
          <button className="btn btn-primary" disabled={busy || !source.trim()} onClick={install}>
            {busy ? <Loader2 size={15} className="spin" /> : <Download size={15} />} {tr('Install')}
          </button>
        </>
      }
    >
      <label className="field">
        <span className="field-label">{tr('Source')}</span>
        <input
          className="input mono"
          autoFocus
          value={source}
          onChange={(e) => setSource(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && source.trim() && !busy && void install()}
          placeholder={tr('owner/repo, https://github.com/…, or ~/path/to/plugin')}
        />
        <span className="field-hint">{tr('A folder or repository with .claude-plugin/plugin.json. Marketplace repositories are added as marketplaces.')}</span>
      </label>
      <div className="warning-note">{tr('Plugins can run programs on your computer through their connectors and command snippets. Only install plugins you trust.')}</div>
    </Modal>
  );
}
