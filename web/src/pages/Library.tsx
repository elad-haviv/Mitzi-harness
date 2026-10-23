import { Brain, Check, Layers, Monitor, Moon, Sun, Trash2 } from 'lucide-react';
import { ReactNode, useEffect, useMemo, useState } from 'react';
import { api, Artifact, ArtifactListItem, ArtifactType } from '../api';
import { ArtifactIcon, ArtifactView, TYPE_LABEL } from '../components/Artifacts';
import { ModelPicker } from '../components/ModelPicker';
import { Empty, Toggle, useConfirm } from '../components/ui';
import { href, navigate } from '../router';
import { relativeTime, Theme, useApp } from '../state';
import { MediaSettingsSection, ProvidersSection } from './ProviderSettings';

// ---------- Settings ----------

export function SettingsPage() {
  const { settings, refreshSettings, theme, setTheme, toast } = useApp();
  const [, setSaving] = useState(false);

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

        <ProvidersSection />

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

        <MediaSettingsSection />

        <MemorySettings />

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

function MemorySettings() {
  const { settings, refreshSettings, toast } = useApp();
  const [url, setUrl] = useState(settings?.hindsightUrl ?? '');
  const [key, setKey] = useState('');
  const [embedding, setEmbedding] = useState(settings?.embeddingModel ?? '');
  const [testing, setTesting] = useState<'idle' | 'busy' | 'ok'>('idle');
  if (!settings) return null;

  const save = async (patch: Parameters<typeof api.updateSettings>[0], message?: string) => {
    try {
      await api.updateSettings(patch);
      await refreshSettings();
      if (message) toast(message, 'info');
    } catch (err) {
      toast((err as Error).message);
    }
  };

  return (
    <section className="settings-section card">
      <h2 className="row" style={{ gap: 8 }}>
        <Brain size={17} /> Memory
      </h2>
      <div className="field">
        <span className="field-label">Memory engine</span>
        <div className="segmented" style={{ alignSelf: 'flex-start' }}>
          <button className={settings.memoryBackend === 'builtin' ? 'active' : ''} onClick={() => save({ memoryBackend: 'builtin' })}>
            Built-in
          </button>
          <button className={settings.memoryBackend === 'hindsight' ? 'active' : ''} onClick={() => save({ memoryBackend: 'hindsight' })}>
            Hindsight server
          </button>
        </div>
        <span className="field-hint">
          {settings.memoryBackend === 'builtin'
            ? 'Banks are stored in ~/.mitzi/data/banks and use your fast model to extract and consolidate memories.'
            : 'Banks live on a Hindsight server, which runs its own extraction, embeddings and reranking.'}
        </span>
      </div>

      {settings.memoryBackend === 'builtin' ? (
        <form
          className="field"
          onSubmit={(e) => {
            e.preventDefault();
            void save({ embeddingModel: embedding.trim() }, embedding.trim() ? 'Semantic recall enabled' : 'Semantic recall disabled');
          }}
        >
          <span className="field-label">Embedding model (optional)</span>
          <div className="row">
            <input className="input mono" placeholder="e.g. openai/text-embedding-3-small" value={embedding} onChange={(e) => setEmbedding(e.target.value)} />
            <button className="btn" disabled={embedding.trim() === settings.embeddingModel}>
              Save
            </button>
          </div>
          <span className="field-hint">
            Adds semantic search to recall, using an OpenAI-compatible embeddings endpoint on your API provider. Leave empty to recall with keywords,
            entities and time only.
          </span>
        </form>
      ) : (
        <>
          <div className="field">
            <span className="field-label">Server URL</span>
            <div className="row">
              <input className="input mono" placeholder="http://localhost:8888" value={url} onChange={(e) => setUrl(e.target.value)} />
              <button className="btn" disabled={url.trim() === settings.hindsightUrl} onClick={() => save({ hindsightUrl: url.trim() }, 'Hindsight server saved')}>
                Save
              </button>
            </div>
            <span className="field-hint">
              Run one with <code>docker run -p 8888:8888 -p 9999:9999 -e HINDSIGHT_API_LLM_API_KEY=… ghcr.io/vectorize-io/hindsight:latest</code>. See{' '}
              <a href="https://github.com/vectorize-io/hindsight" target="_blank" rel="noreferrer">
                github.com/vectorize-io/hindsight
              </a>
              .
            </span>
          </div>
          <div className="field">
            <span className="field-label">API key (if your server needs one)</span>
            <div className="row">
              <input
                className="input mono"
                type="password"
                autoComplete="off"
                placeholder={settings.hasHindsightKey ? 'Saved; enter a new key to replace it' : 'Optional'}
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
              <button
                className="btn"
                disabled={!key.trim()}
                onClick={async () => {
                  await save({ hindsightApiKey: key.trim() }, 'Hindsight key saved');
                  setKey('');
                }}
              >
                Save
              </button>
            </div>
          </div>
          <div className="row">
            <button
              className="btn btn-sm"
              disabled={testing === 'busy' || !(url.trim() || settings.hindsightUrl)}
              onClick={async () => {
                setTesting('busy');
                try {
                  await api.testHindsight(url.trim() || settings.hindsightUrl, key.trim() || undefined);
                  setTesting('ok');
                } catch (err) {
                  setTesting('idle');
                  toast((err as Error).message);
                }
              }}
            >
              {testing === 'ok' ? <Check size={14} /> : null} {testing === 'busy' ? 'Testing…' : testing === 'ok' ? 'Connected' : 'Test connection'}
            </button>
          </div>
        </>
      )}

      <div className="field" style={{ marginTop: 18, marginBottom: 0 }}>
        <span className="field-label">Memories recalled per message</span>
        <select className="select" style={{ maxWidth: 260 }} value={settings.recallTokens} onChange={(e) => void save({ recallTokens: Number(e.target.value) })}>
          {[600, 1200, 2000, 4000].map((n) => (
            <option key={n} value={n}>
              Up to ~{n.toLocaleString()} tokens{n === 1200 ? ' (default)' : ''}
            </option>
          ))}
        </select>
      </div>
    </section>
  );
}
