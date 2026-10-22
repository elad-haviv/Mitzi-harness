import { ChevronDown, ChevronRight, ExternalLink, LogIn, MoreHorizontal, Pencil, Plug, Plus, RefreshCw, ShieldCheck, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ConnectorPreset, McpServerView, McpTransport, McpTrust } from '../api';
import { Empty, Menu, Modal, Toggle, useConfirm } from '../components/ui';
import { useApp } from '../state';

type Preset = ConnectorPreset & { installed: number };

const STATUS_LABEL: Record<McpServerView['status'], string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  error: 'Error',
  'needs-auth': 'Sign-in needed',
  disabled: 'Off',
};

const TRUST_LABEL: Record<McpTrust, string> = {
  ask: 'Ask before every tool call',
  readonly: 'Allow read-only tools, ask for the rest',
  allow: 'Always allow',
};

/** Opens the provider's sign-in page and waits for the connector to come online. */
async function signIn(id: string, toast: (m: string, t?: 'error' | 'info') => void, onDone: () => void) {
  // Open the window during the click so popup blockers allow it, then point it at the sign-in page.
  const popup = window.open('', 'mitzi-oauth', 'width=520,height=720');
  try {
    const { url } = await api.startMcpAuth(id);
    if (popup) popup.location.href = url;
    else window.open(url, '_blank');
  } catch (err) {
    popup?.close();
    toast((err as Error).message);
    return;
  }
  const started = Date.now();
  const timer = setInterval(async () => {
    const server = (await api.mcpServers().catch(() => [])).find((s) => s.id === id);
    if (server?.status === 'connected' || Date.now() - started > 180_000) {
      clearInterval(timer);
      if (server?.status === 'connected') toast(`Connected to ${server.name}`, 'info');
      onDone();
    }
  }, 1500);
}

export function ConnectorsPage() {
  const { toast } = useApp();
  const [servers, setServers] = useState<McpServerView[]>();
  const [presets, setPresets] = useState<Preset[]>([]);
  const [editing, setEditing] = useState<McpServerView | 'new'>();
  const [adding, setAdding] = useState<Preset>();
  const [open, setOpen] = useState<string>();
  const [confirmNode, confirm] = useConfirm();

  const load = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([api.mcpServers(), api.connectors()]);
      setServers(s);
      setPresets(p);
    } catch (err) {
      toast((err as Error).message);
    }
  }, [toast]);
  useEffect(() => {
    void load();
  }, [load]);
  // Keep polling while anything is starting up.
  useEffect(() => {
    if (!servers?.some((s) => s.status === 'connecting')) return;
    const t = setTimeout(load, 1500);
    return () => clearTimeout(t);
  }, [servers, load]);

  const update = async (id: string, patch: Record<string, unknown>) => {
    try {
      const next = await api.updateMcpServer(id, patch);
      setServers((list) => list?.map((s) => (s.id === id ? next : s)));
    } catch (err) {
      toast((err as Error).message);
    }
  };

  const presetFor = (s: McpServerView) => presets.find((p) => p.id === s.connectorId);
  const categories = useMemo(() => [...new Set(presets.map((p) => p.category))], [presets]);

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-header">
          <div>
            <h1 className="page-title">Connectors</h1>
            <p className="page-subtitle">Give Mitzi tools from your apps and services through MCP servers. Bots can use them in any chat.</p>
          </div>
          <button className="btn" onClick={() => setEditing('new')}>
            <Plus size={16} /> Add custom MCP server
          </button>
        </div>

        <h2 className="section-title" style={{ marginTop: 0 }}>
          Your connectors
        </h2>
        {servers && servers.length === 0 ? (
          <Empty icon={<Plug size={22} />} title="No connectors yet">
            Add one from the directory below, or connect any MCP server by its command or URL.
          </Empty>
        ) : (
          <div className="list">
            {(servers ?? []).map((s) => {
              const preset = presetFor(s);
              const expanded = open === s.id;
              const enabledTools = s.tools.filter((t) => t.enabled).length;
              return (
                <div key={s.id} className="ext-row">
                  <div className="ext-head">
                    <button className="icon-btn sm" onClick={() => setOpen(expanded ? undefined : s.id)} aria-label={expanded ? 'Collapse' : 'Expand'} aria-expanded={expanded}>
                      {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                    </button>
                    <span className="ext-icon">{preset?.emoji ?? (s.source === 'plugin' ? '🧩' : '🔌')}</span>
                    <div className="grow">
                      <div className="t">
                        {s.name}
                        <span className="row small" style={{ gap: 6, fontWeight: 400 }}>
                          <span className={`status-dot ${s.status}`} />
                          <span className="muted">{STATUS_LABEL[s.status]}</span>
                        </span>
                        {s.source === 'plugin' && <span className="badge">Plugin: {s.pluginId}</span>}
                      </div>
                      <div className="s" title={s.error}>
                        {s.status === 'connected'
                          ? `${enabledTools} of ${s.tools.length} tools on · ${TRUST_LABEL[s.trust].toLowerCase()}`
                          : s.error ?? (s.transport === 'stdio' ? `${s.command} ${(s.args ?? []).join(' ')}` : s.url)}
                      </div>
                    </div>
                    {s.status === 'needs-auth' && (
                      <button className="btn btn-primary btn-sm" onClick={() => void signIn(s.id, toast, load)}>
                        <LogIn size={14} /> Connect
                      </button>
                    )}
                    <Toggle label={`Enable ${s.name}`} on={s.enabled} onChange={(v) => void update(s.id, { enabled: v })} />
                    <Menu
                      trigger={(_o, toggle) => (
                        <button className="icon-btn" onClick={toggle} aria-label={`${s.name} options`}>
                          <MoreHorizontal size={17} />
                        </button>
                      )}
                    >
                      {(close) => (
                        <>
                          <button
                            onClick={async () => {
                              close();
                              setServers((l) => l?.map((x) => (x.id === s.id ? { ...x, status: 'connecting', error: undefined } : x)));
                              await api.reconnectMcpServer(s.id).catch((err) => toast(err.message));
                              void load();
                            }}
                          >
                            <RefreshCw size={15} /> Reconnect
                          </button>
                          {s.transport !== 'stdio' && (
                            <button onClick={() => (close(), void signIn(s.id, toast, load))}>
                              <LogIn size={15} /> {s.oauthConnected ? 'Sign in again' : 'Sign in with OAuth'}
                            </button>
                          )}
                          {s.oauthConnected && (
                            <button
                              onClick={async () => {
                                close();
                                await api.signOutMcp(s.id).catch((err) => toast(err.message));
                                void load();
                              }}
                            >
                              <X size={15} /> Sign out
                            </button>
                          )}
                          {s.source !== 'plugin' && (
                            <button onClick={() => (close(), setEditing(s))}>
                              <Pencil size={15} /> Edit
                            </button>
                          )}
                          {preset?.docsUrl && (
                            <button onClick={() => (close(), window.open(preset.docsUrl, '_blank', 'noopener'))}>
                              <ExternalLink size={15} /> Documentation
                            </button>
                          )}
                          {s.source !== 'plugin' && (
                            <>
                              <hr />
                              <button
                                className="danger"
                                onClick={async () => {
                                  close();
                                  if (!(await confirm(`Remove “${s.name}”? Bots will no longer be able to use its tools.`, { title: 'Remove connector?', action: 'Remove' }))) return;
                                  await api.deleteMcpServer(s.id).catch((err) => toast(err.message));
                                  void load();
                                }}
                              >
                                <Trash2 size={15} /> Remove
                              </button>
                            </>
                          )}
                        </>
                      )}
                    </Menu>
                  </div>
                  {expanded && (
                    <div className="ext-body">
                      {s.error && s.status !== 'connected' && <div className="error-box small">{s.error}</div>}
                      <label className="row small" style={{ gap: 8 }}>
                        <ShieldCheck size={15} className="muted" />
                        <select className="select" style={{ maxWidth: 340, padding: '5px 8px' }} value={s.trust} onChange={(e) => void update(s.id, { trust: e.target.value })}>
                          {(Object.keys(TRUST_LABEL) as McpTrust[]).map((t) => (
                            <option key={t} value={t}>
                              {TRUST_LABEL[t]}
                            </option>
                          ))}
                        </select>
                      </label>
                      {s.tools.length > 0 ? (
                        <>
                          <div className="muted small">Tools: click one to turn it off or on.</div>
                          <div className="tool-chip-list">
                            {s.tools.map((t) => (
                              <button
                                key={t.name}
                                className={`tool-chip${t.enabled ? '' : ' off'}`}
                                title={`${t.description ?? ''}${t.readOnly ? '\n(read-only)' : ''}`}
                                onClick={() =>
                                  void update(s.id, {
                                    disabledTools: t.enabled ? [...s.disabledTools, t.name] : s.disabledTools.filter((n) => n !== t.name),
                                  })
                                }
                              >
                                {t.name}
                                {t.readOnly && <span className="muted">ro</span>}
                              </button>
                            ))}
                          </div>
                        </>
                      ) : (
                        <div className="muted small">{s.status === 'connected' ? 'This server has no tools.' : 'Tools appear once it connects.'}</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <h2 className="section-title">Directory</h2>
        {categories.map((cat) => (
          <div key={cat} style={{ marginBottom: 18 }}>
            <div className="muted small" style={{ marginBottom: 8, fontWeight: 600 }}>
              {cat}
            </div>
            <div className="preset-grid">
              {presets
                .filter((p) => p.category === cat)
                .map((p) => (
                  <button key={p.id} className="preset" onClick={() => setAdding(p)}>
                    <span className="ext-icon">{p.emoji}</span>
                    <span style={{ minWidth: 0 }}>
                      <span className="t">
                        {p.name} {p.installed > 0 && <span className="badge ok">Added</span>}
                      </span>
                      <span className="s" style={{ display: 'block' }}>
                        {p.description}
                      </span>
                      <span className="s" style={{ display: 'block', marginTop: 4 }}>
                        {p.oauth ? 'Sign in with your account' : p.requires ? `Runs locally · needs ${p.requires}` : p.fields.some((f) => f.required) ? 'Needs an API key' : 'No account needed'}
                      </span>
                    </span>
                  </button>
                ))}
            </div>
          </div>
        ))}
      </div>
      {editing && <ServerEditor server={editing === 'new' ? undefined : editing} onClose={() => setEditing(undefined)} onSaved={() => void load()} />}
      {adding && (
        <PresetModal
          preset={adding}
          onClose={() => setAdding(undefined)}
          onAdded={(server) => {
            void load();
            if (adding.oauth) void signIn(server.id, toast, load);
          }}
        />
      )}
      {confirmNode}
    </div>
  );
}

function PresetModal({ preset, onClose, onAdded }: { preset: Preset; onClose(): void; onAdded(s: McpServerView): void }) {
  const { toast } = useApp();
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try {
      onAdded(await api.addConnector(preset.id, values));
      onClose();
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Add ${preset.name}`}
      onClose={onClose}
      footer={
        <>
          {preset.docsUrl && (
            <a className="btn btn-ghost" href={preset.docsUrl} target="_blank" rel="noreferrer" style={{ marginRight: 'auto' }}>
              <ExternalLink size={14} /> Docs
            </a>
          )}
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || preset.fields.some((f) => f.required && !values[f.key]?.trim())} onClick={add}>
            {preset.oauth ? (
              <>
                <LogIn size={15} /> Add and sign in
              </>
            ) : (
              'Add connector'
            )}
          </button>
        </>
      }
    >
      <div className="row" style={{ gap: 12, marginBottom: 16, alignItems: 'flex-start' }}>
        <span className="ext-icon">{preset.emoji}</span>
        <p className="muted" style={{ margin: 0 }}>
          {preset.description}
        </p>
      </div>
      {preset.requires && (
        <div className="warning-note" style={{ marginBottom: 14 }}>
          This connector runs on your computer and needs {preset.requires} installed.
        </div>
      )}
      {preset.oauth && <p className="small muted">You’ll be sent to {preset.name} to sign in and approve access. Mitzi stores the sign-in on this computer only.</p>}
      {preset.fields.map((f) => (
        <label key={f.key} className="field">
          <span className="field-label">
            {f.label}
            {f.required ? '' : ' (optional)'}
          </span>
          {f.kind === 'args' && !f.key.startsWith('-') ? (
            <textarea className="textarea mono" rows={3} style={{ minHeight: 0 }} placeholder={f.placeholder} value={values[f.key] ?? ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
          ) : (
            <input
              className="input mono"
              type={f.secret ? 'password' : 'text'}
              autoComplete="off"
              placeholder={f.placeholder}
              value={values[f.key] ?? ''}
              onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
            />
          )}
          {f.help && <span className="field-hint">{f.help}</span>}
        </label>
      ))}
    </Modal>
  );
}

function KeyValueEditor({ value, onChange, keyPlaceholder, valuePlaceholder }: { value: [string, string][]; onChange(v: [string, string][]): void; keyPlaceholder: string; valuePlaceholder: string }) {
  return (
    <div>
      {value.map(([k, v], i) => (
        <div key={i} className="kv-row">
          <input className="input mono" placeholder={keyPlaceholder} value={k} onChange={(e) => onChange(value.map((p, j) => (j === i ? [e.target.value, p[1]] : p)))} />
          <input className="input mono" placeholder={valuePlaceholder} value={v} onChange={(e) => onChange(value.map((p, j) => (j === i ? [p[0], e.target.value] : p)))} />
          <button type="button" className="icon-btn" aria-label="Remove" onClick={() => onChange(value.filter((_, j) => j !== i))}>
            <X size={15} />
          </button>
        </div>
      ))}
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange([...value, ['', '']])}>
        <Plus size={14} /> Add
      </button>
    </div>
  );
}

function ServerEditor({ server, onClose, onSaved }: { server?: McpServerView; onClose(): void; onSaved(): void }) {
  const { toast } = useApp();
  const [name, setName] = useState(server?.name ?? '');
  const [transport, setTransport] = useState<McpTransport>(server?.transport ?? 'stdio');
  const [command, setCommand] = useState(server?.command ?? '');
  const [args, setArgs] = useState((server?.args ?? []).map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' '));
  const [env, setEnv] = useState<[string, string][]>(Object.entries(server?.env ?? {}));
  const [url, setUrl] = useState(server?.url ?? '');
  const [headers, setHeaders] = useState<[string, string][]>(Object.entries(server?.headers ?? {}));
  const [trust, setTrust] = useState<McpTrust>(server?.trust ?? 'ask');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    const body = {
      name,
      transport,
      command,
      args,
      env: Object.fromEntries(env.filter(([k]) => k.trim())),
      url,
      headers: Object.fromEntries(headers.filter(([k]) => k.trim())),
      trust,
    };
    try {
      if (server) await api.updateMcpServer(server.id, body);
      else await api.addMcpServer(body);
      onSaved();
      onClose();
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={server ? `Edit ${server.name}` : 'Add an MCP server'}
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || !name.trim()} onClick={save}>
            {server ? 'Save' : 'Add server'}
          </button>
        </>
      }
    >
      <label className="field">
        <span className="field-label">Name</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Company wiki" autoFocus />
        <span className="field-hint">Used in tool names, e.g. mcp__company_wiki__search.</span>
      </label>
      {!server && (
        <div className="field">
          <span className="field-label">Connection</span>
          <div className="segmented" style={{ alignSelf: 'flex-start' }}>
            {(
              [
                ['stdio', 'Local command'],
                ['http', 'Remote (HTTP)'],
                ['sse', 'Remote (SSE, legacy)'],
              ] as [McpTransport, string][]
            ).map(([t, label]) => (
              <button key={t} type="button" className={transport === t ? 'active' : ''} onClick={() => setTransport(t)}>
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
      {transport === 'stdio' ? (
        <>
          <label className="field">
            <span className="field-label">Command</span>
            <input className="input mono" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" />
          </label>
          <label className="field">
            <span className="field-label">Arguments</span>
            <input className="input mono" value={args} onChange={(e) => setArgs(e.target.value)} placeholder="-y @modelcontextprotocol/server-filesystem ~/Documents" />
          </label>
          <div className="field">
            <span className="field-label">Environment variables</span>
            <KeyValueEditor value={env} onChange={setEnv} keyPlaceholder="API_KEY" valuePlaceholder="value" />
          </div>
          <div className="warning-note">This runs a program on your computer with your permissions. Only add servers you trust.</div>
        </>
      ) : (
        <>
          <label className="field">
            <span className="field-label">Server URL</span>
            <input className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" />
            <span className="field-hint">If the server uses OAuth, you’ll be able to sign in after adding it.</span>
          </label>
          <div className="field">
            <span className="field-label">Headers</span>
            <KeyValueEditor value={headers} onChange={setHeaders} keyPlaceholder="Authorization" valuePlaceholder="Bearer …" />
          </div>
        </>
      )}
      <label className="field" style={{ marginTop: 14, marginBottom: 0 }}>
        <span className="field-label">Tool permissions</span>
        <select className="select" value={trust} onChange={(e) => setTrust(e.target.value as McpTrust)}>
          {(Object.keys(TRUST_LABEL) as McpTrust[]).map((t) => (
            <option key={t} value={t}>
              {TRUST_LABEL[t]}
            </option>
          ))}
        </select>
      </label>
    </Modal>
  );
}
