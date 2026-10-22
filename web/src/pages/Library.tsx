import { Brain, Check, Eye, EyeOff, FolderOpen, KeyRound, Layers, Monitor, Moon, Pencil, Plus, Sun, Trash2, X } from 'lucide-react';
import { ReactNode, useEffect, useMemo, useState } from 'react';
import { api, Artifact, ArtifactListItem, ArtifactType, Memory } from '../api';
import { ArtifactIcon, ArtifactView, TYPE_LABEL } from '../components/Artifacts';
import { ModelPicker } from '../components/ModelPicker';
import { Empty, Toggle, useConfirm } from '../components/ui';
import { href, navigate } from '../router';
import { relativeTime, Theme, useApp } from '../state';

// ---------- Artifacts ----------

export function ArtifactsPage() {
  const { toast } = useApp();
  const [items, setItems] = useState<ArtifactListItem[]>();
  const [filter, setFilter] = useState<ArtifactType | 'all'>('all');
  const [confirmNode, confirm] = useConfirm();
  useEffect(() => {
    api.artifacts().then(setItems, (err) => toast(err.message));
  }, [toast]);

  const types = useMemo(() => [...new Set((items ?? []).map((a) => a.type))], [items]);
  const shown = (items ?? []).filter((a) => filter === 'all' || a.type === filter);

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-header">
          <div>
            <h1 className="page-title">Artifacts</h1>
            <p className="page-subtitle">Documents, code, web pages, components and diagrams created in your chats.</p>
          </div>
          {types.length > 1 && (
            <div className="segmented">
              <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>
                All
              </button>
              {types.map((t) => (
                <button key={t} className={filter === t ? 'active' : ''} onClick={() => setFilter(t)}>
                  <ArtifactIcon type={t} size={13} /> {TYPE_LABEL[t]}
                </button>
              ))}
            </div>
          )}
        </div>
        {items && items.length === 0 ? (
          <Empty icon={<Layers size={22} />} title="No artifacts yet">
            Ask for something substantial, like “make an interactive budget calculator” or “draft a project proposal”, and it will appear here.
          </Empty>
        ) : (
          <div className="grid">
            {shown.map((a) => (
              <a key={a.id} className="tile" href={href({ page: 'artifact', id: a.id })}>
                <div className="tile-actions">
                  <button
                    className="icon-btn sm"
                    aria-label={`Delete ${a.title}`}
                    onClick={async (e) => {
                      e.preventDefault();
                      if (!(await confirm(`Delete “${a.title}” and all its versions?`, { title: 'Delete artifact?' }))) return;
                      await api.deleteArtifact(a.id).catch((err) => toast(err.message));
                      setItems((list) => list?.filter((x) => x.id !== a.id));
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <div className="artifact-icon">
                  <ArtifactIcon type={a.type} />
                </div>
                <div className="tile-title">{a.title}</div>
                <div className="tile-desc">{a.chatTitle ? `From “${a.chatTitle}”` : 'Chat deleted'}</div>
                <div className="tile-foot">
                  <span className="badge">{TYPE_LABEL[a.type]}</span>
                  {a.versions.length > 1 && <span>v{a.versions.length}</span>}
                  <span style={{ marginLeft: 'auto' }}>{relativeTime(a.updatedAt)}</span>
                </div>
              </a>
            ))}
          </div>
        )}
      </div>
      {confirmNode}
    </div>
  );
}

export function ArtifactPage({ id }: { id: string }) {
  const { toast } = useApp();
  const [artifact, setArtifact] = useState<Artifact>();
  useEffect(() => {
    api.artifact(id).then(setArtifact, (err) => {
      toast(err.message);
      navigate({ page: 'artifacts' }, true);
    });
  }, [id, toast]);
  if (!artifact) return <div className="page muted">Loading…</div>;
  return (
    <div className="chat-layout">
      <aside className="side-panel full">
        <ArtifactView artifact={artifact} onClose={() => history.back()} showChatLink />
      </aside>
    </div>
  );
}

// ---------- Memory ----------

export function MemoryPage() {
  const { settings, refreshSettings, projects, toast } = useApp();
  const [memories, setMemories] = useState<Memory[]>();
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<{ id: string; text: string }>();
  const [confirmNode, confirm] = useConfirm();
  const load = () => api.memories().then(setMemories, (err) => toast(err.message));
  useEffect(() => {
    void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(() => {
    const list = memories ?? [];
    const out: { label: string; projectId?: string; items: Memory[] }[] = [{ label: 'Everywhere', items: list.filter((m) => !m.projectId) }];
    for (const p of projects) {
      const items = list.filter((m) => m.projectId === p.id);
      if (items.length) out.push({ label: p.name, projectId: p.id, items });
    }
    return out;
  }, [memories, projects]);

  const add = async () => {
    if (!draft.trim()) return;
    try {
      await api.addMemory(draft.trim());
      setDraft('');
      void load();
    } catch (err) {
      toast((err as Error).message);
    }
  };

  return (
    <div className="page">
      <div className="page-narrow">
        <div className="page-header">
          <div>
            <h1 className="page-title">Memory</h1>
            <p className="page-subtitle">Things Mitzi remembers about you across conversations. They're added to each chat's context.</p>
          </div>
          {settings && (
            <label className="row small">
              {settings.memoryEnabled ? 'On' : 'Off'}
              <Toggle
                label="Memory enabled"
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

        <form
          className="row"
          style={{ marginBottom: 24 }}
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <input className="input" placeholder="Add a memory, e.g. “I prefer TypeScript and concise answers”" value={draft} onChange={(e) => setDraft(e.target.value)} />
          <button className="btn btn-primary" disabled={!draft.trim()}>
            <Plus size={16} /> Add
          </button>
        </form>

        {memories && memories.length === 0 ? (
          <Empty icon={<Brain size={22} />} title="Nothing remembered yet">
            Tell Mitzi “remember that…” in any chat, or add memories here. Mitzi also saves things that clearly matter later, like your preferences.
          </Empty>
        ) : (
          groups
            .filter((g) => g.items.length)
            .map((g) => (
              <div key={g.label} style={{ marginBottom: 24 }}>
                <h2 className="card-title" style={{ marginBottom: 10 }}>
                  {g.projectId ? <FolderOpen size={15} /> : <Brain size={15} />} {g.label}
                </h2>
                <div className="list">
                  {g.items.map((m) => (
                    <div key={m.id} className="memory-row">
                      <div className="content">
                        {editing?.id === m.id ? (
                          <form
                            className="row"
                            onSubmit={async (e) => {
                              e.preventDefault();
                              await api.updateMemory(m.id, editing.text).catch((err) => toast(err.message));
                              setEditing(undefined);
                              void load();
                            }}
                          >
                            <input className="input" autoFocus value={editing.text} onChange={(e) => setEditing({ id: m.id, text: e.target.value })} />
                            <button className="icon-btn" aria-label="Save">
                              <Check size={16} />
                            </button>
                            <button type="button" className="icon-btn" aria-label="Cancel" onClick={() => setEditing(undefined)}>
                              <X size={16} />
                            </button>
                          </form>
                        ) : (
                          <>
                            {m.content}
                            <div className="meta">
                              {m.source === 'assistant' ? 'Saved by Mitzi' : 'Added by you'} · {relativeTime(m.createdAt)}
                            </div>
                          </>
                        )}
                      </div>
                      {editing?.id !== m.id && (
                        <div className="actions">
                          <button className="icon-btn sm" aria-label="Edit memory" onClick={() => setEditing({ id: m.id, text: m.content })}>
                            <Pencil size={14} />
                          </button>
                          <button
                            className="icon-btn sm"
                            aria-label="Delete memory"
                            onClick={async () => {
                              if (!(await confirm(`Forget “${m.content}”?`, { title: 'Delete memory?', action: 'Forget' }))) return;
                              await api.deleteMemory(m.id).catch((err) => toast(err.message));
                              void load();
                            }}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))
        )}
      </div>
      {confirmNode}
    </div>
  );
}

// ---------- Settings ----------

export function SettingsPage() {
  const { settings, refreshSettings, refreshModels, theme, setTheme, toast } = useApp();
  const [key, setKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);

  if (!settings) return <div className="page muted">Loading…</div>;

  const save = async (patch: Parameters<typeof api.updateSettings>[0], message?: string) => {
    setSaving(true);
    try {
      await api.updateSettings(patch);
      await refreshSettings();
      if (message) toast(message, 'info');
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page">
      <div className="page-narrow">
        <div className="page-header">
          <div>
            <h1 className="page-title">Settings</h1>
            <p className="page-subtitle">Settings are stored in ~/.mitzi and shared with the mitzi command-line tool.</p>
          </div>
        </div>

        <section className="settings-section card">
          <h2 className="row" style={{ gap: 8 }}>
            <KeyRound size={17} /> OpenRouter API key
          </h2>
          {settings.apiKeySource === 'env' ? (
            <p className="muted small" style={{ margin: 0 }}>
              Using <code>OPENROUTER_API_KEY</code> from the environment. Unset it to manage the key here.
            </p>
          ) : (
            <>
              <p className="muted small" style={{ marginTop: 0 }}>
                {settings.hasApiKey ? (
                  <span className="badge ok">
                    <Check size={12} /> Key saved
                  </span>
                ) : (
                  <>
                    Get a key at{' '}
                    <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">
                      openrouter.ai/keys
                    </a>
                    . One key gives you access to hundreds of models.
                  </>
                )}
              </p>
              <form
                className="row"
                onSubmit={async (e) => {
                  e.preventDefault();
                  await save({ apiKey: key }, 'API key saved');
                  setKey('');
                  void refreshModels();
                }}
              >
                <div style={{ position: 'relative', flex: 1 }}>
                  <input
                    className="input mono"
                    type={showKey ? 'text' : 'password'}
                    placeholder={settings.hasApiKey ? 'Enter a new key to replace it' : 'sk-or-v1-…'}
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button type="button" className="icon-btn sm" style={{ position: 'absolute', right: 6, top: 6 }} onClick={() => setShowKey((s) => !s)} aria-label={showKey ? 'Hide key' : 'Show key'}>
                    {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
                <button className="btn btn-primary" disabled={!key.trim() || saving}>
                  Save key
                </button>
                {settings.hasApiKey && (
                  <button type="button" className="btn btn-ghost btn-danger" onClick={() => save({ apiKey: '' }, 'API key removed')}>
                    Remove
                  </button>
                )}
              </form>
            </>
          )}
        </section>

        <section className="settings-section card">
          <h2>Models</h2>
          <div className="field">
            <span className="field-label">Default model</span>
            <ModelPicker value={settings.defaultModel} onChange={(m) => void save({ defaultModel: m })} variant="input" direction="down" />
            <span className="field-hint">Used for new chats. You can switch models any time from the chat box.</span>
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <span className="field-label">Fast model</span>
            <ModelPicker value={settings.smallModel ?? ''} onChange={(m) => void save({ smallModel: m })} variant="input" direction="down" allowEmpty="Same as the chat's model" />
            <span className="field-hint">A cheaper model for chat titles and context compaction.</span>
          </div>
        </section>

        <section className="settings-section card">
          <h2>Context management</h2>
          <div className="field">
            <span className="field-label">Auto-compact when the context window is</span>
            <div className="range-row">
              <input
                type="range"
                min={0}
                max={95}
                step={5}
                defaultValue={settings.autoCompactPercent}
                onPointerUp={(e) => void save({ autoCompactPercent: Number((e.target as HTMLInputElement).value) })}
                onKeyUp={(e) => void save({ autoCompactPercent: Number((e.target as HTMLInputElement).value) })}
                aria-label="Auto-compact threshold"
              />
              <span className="val">{settings.autoCompactPercent === 0 ? 'Off' : `${settings.autoCompactPercent}% full`}</span>
            </div>
            <span className="field-hint">Older messages are summarized automatically so long conversations never hit the model's limit.</span>
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <span className="field-label">Recent turns kept word-for-word</span>
            <select className="select" style={{ maxWidth: 200 }} value={settings.keepRecentTurns} onChange={(e) => void save({ keepRecentTurns: Number(e.target.value) })}>
              {[0, 1, 2, 3, 4, 6, 8].map((n) => (
                <option key={n} value={n}>
                  {n === 0 ? 'None (summarize all)' : `Last ${n} turn${n === 1 ? '' : 's'}`}
                </option>
              ))}
            </select>
          </div>
        </section>

        <section className="settings-section card">
          <h2>Appearance</h2>
          <div className="segmented">
            {(
              [
                ['system', <Monitor size={14} key="s" />, 'System'],
                ['light', <Sun size={14} key="l" />, 'Light'],
                ['dark', <Moon size={14} key="d" />, 'Dark'],
              ] as [Theme, ReactNode, string][]
            ).map(([t, icon, label]) => (
              <button key={t} className={theme === t ? 'active' : ''} onClick={() => setTheme(t)}>
                {icon} {label}
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
