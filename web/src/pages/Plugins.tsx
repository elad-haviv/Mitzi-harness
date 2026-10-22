import { ChevronDown, ChevronRight, Download, Loader2, MoreHorizontal, Puzzle, RefreshCw, Store, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, MarketplaceInfo, PluginInfo } from '../api';
import { Empty, Menu, Modal, Toggle, useConfirm } from '../components/ui';
import { useApp } from '../state';

const SUGGESTED = [
  { source: 'anthropics/claude-plugins-official', label: 'Claude plugin directory' },
  { source: 'anthropics/claude-code', label: 'Claude Code plugins' },
  { source: 'anthropics/skills', label: 'Anthropic skills' },
];

function summary(p: PluginInfo): string {
  const c = p.components;
  const parts = [
    c.skills && `${c.skills} skill${c.skills === 1 ? '' : 's'}`,
    c.commands && `${c.commands} command${c.commands === 1 ? '' : 's'}`,
    c.agents && `${c.agents} bot${c.agents === 1 ? '' : 's'}`,
    c.mcpServers && `${c.mcpServers} connector${c.mcpServers === 1 ? '' : 's'}`,
  ].filter(Boolean);
  return parts.join(' · ') || 'Nothing Mitzi can use';
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
            <h1 className="page-title">Plugins</h1>
            <p className="page-subtitle">
              Bundles of skills, slash commands, bots and connectors. Mitzi installs Claude Code plugins and marketplaces as they are.
            </p>
          </div>
          <button className="btn btn-primary" onClick={() => setInstalling(true)}>
            <Download size={16} /> Install plugin
          </button>
        </div>

        <h2 className="section-title" style={{ marginTop: 0 }}>
          Installed
        </h2>
        {plugins && plugins.length === 0 ? (
          <Empty icon={<Puzzle size={22} />} title="No plugins installed">
            Install one from a marketplace below, or from a git repository.
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
                        <span className="badge warn" title="Hooks are Claude Code automations that Mitzi doesn't run">
                          hooks not supported
                        </span>
                      )}
                    </div>
                    <div className="s" title={p.description}>
                      {summary(p)}
                      {p.description ? ` — ${p.description}` : ''}
                    </div>
                  </div>
                  {busy === p.id && <Loader2 size={16} className="spin muted" />}
                  <Toggle label={`Enable ${p.name}`} on={p.enabled} onChange={(v) => void run(p.id, () => api.setPluginEnabled(p.id, v))} />
                  <Menu
                    trigger={(_o, toggle) => (
                      <button className="icon-btn" onClick={toggle} aria-label={`${p.name} options`}>
                        <MoreHorizontal size={17} />
                      </button>
                    )}
                  >
                    {(close) => (
                      <>
                        <button onClick={() => (close(), void run(p.id, () => api.updatePlugin(p.id), `${p.name} updated`))}>
                          <RefreshCw size={15} /> Update
                        </button>
                        <hr />
                        <button
                          className="danger"
                          onClick={async () => {
                            close();
                            if (!(await confirm(`Uninstall ${p.name}? Its skills, commands, bots and connectors are removed. Chats are kept.`, { title: 'Uninstall plugin?', action: 'Uninstall' }))) return;
                            void run(p.id, () => api.uninstallPlugin(p.id));
                          }}
                        >
                          <Trash2 size={15} /> Uninstall
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
          <Store size={17} /> Marketplaces
        </h2>
        <AddMarketplace existing={markets} onAdded={load} />
        {markets.map((m) => (
          <Marketplace
            key={m.id}
            market={m}
            busy={busy}
            onInstall={(name) => run(`${m.id}:${name}`, () => api.installFromMarketplace(m.id, name), `Installed ${name}`)}
            onRefresh={() => run(m.id, () => api.refreshMarketplace(m.id))}
            onRemove={() => run(m.id, () => api.removeMarketplace(m.id))}
          />
        ))}
      </div>
      {installing && (
        <InstallModal
          onClose={() => setInstalling(false)}
          onDone={(result) => {
            if (result.marketplace) toast(`That repository is a marketplace; added “${result.marketplace.name}” below.`, 'info');
            else if (result.plugin) toast(`Installed ${result.plugin.name}`, 'info');
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
        <input className="input mono" placeholder="owner/repo, a git URL, or a folder" value={source} onChange={(e) => setSource(e.target.value)} />
        <button className="btn" disabled={!source.trim() || !!busy}>
          {busy === source.trim() && busy ? <Loader2 size={15} className="spin" /> : null} Add marketplace
        </button>
      </form>
      {suggestions.length > 0 && (
        <div className="row small" style={{ marginTop: 10, flexWrap: 'wrap', gap: 6 }}>
          <span className="muted">Suggested:</span>
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
        <button className="icon-btn sm" onClick={() => setOpen((o) => !o)} aria-label={open ? 'Collapse' : 'Expand'}>
          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </button>
        <div className="grow">
          <div className="t">{market.name}</div>
          <div className="s">
            {market.plugins.length} plugins · {market.source}
            {market.description ? ` — ${market.description}` : ''}
          </div>
        </div>
        {busy === market.id && <Loader2 size={16} className="spin muted" />}
        <button className="icon-btn sm" title="Refresh" aria-label="Refresh marketplace" onClick={onRefresh}>
          <RefreshCw size={14} />
        </button>
        <button className="icon-btn sm" title="Remove" aria-label="Remove marketplace" onClick={onRemove}>
          <Trash2 size={14} />
        </button>
      </div>
      {open && (
        <div style={{ padding: '10px 16px 14px' }}>
          {market.plugins.length > 8 && (
            <input className="input" placeholder={`Search ${market.plugins.length} plugins`} value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 10 }} />
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
                <span className="badge ok">Installed</span>
              ) : (
                <button className="btn btn-sm" disabled={!!busy} onClick={() => onInstall(p.name)}>
                  {busy === `${market.id}:${p.name}` ? <Loader2 size={14} className="spin" /> : <Download size={14} />} Install
                </button>
              )}
            </div>
          ))}
          {shown.length > limit && (
            <button className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={() => setLimit((l) => l + 50)}>
              Show more ({shown.length - limit})
            </button>
          )}
          {!shown.length && <div className="muted small">No plugins match.</div>}
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
      title="Install a plugin"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || !source.trim()} onClick={install}>
            {busy ? <Loader2 size={15} className="spin" /> : <Download size={15} />} Install
          </button>
        </>
      }
    >
      <label className="field">
        <span className="field-label">Source</span>
        <input
          className="input mono"
          autoFocus
          value={source}
          onChange={(e) => setSource(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && source.trim() && !busy && void install()}
          placeholder="owner/repo, https://github.com/…, or ~/path/to/plugin"
        />
        <span className="field-hint">A folder or repository with .claude-plugin/plugin.json. Marketplace repositories are added as marketplaces.</span>
      </label>
      <div className="warning-note">Plugins can run programs on your computer through their connectors and command snippets. Only install plugins you trust.</div>
    </Modal>
  );
}
