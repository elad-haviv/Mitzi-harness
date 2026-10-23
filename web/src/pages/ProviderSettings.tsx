import { AlertTriangle, Check, ExternalLink, KeyRound, Loader2, Mic, Plus, RefreshCw, Trash2, Volume2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { languageName, LANGUAGES } from '../languages';
import { api, MediaModels, MediaSettings, ModelInfo, ProviderKind, ProviderPresetView, ProviderView } from '../api';
import { ModelPicker } from '../components/ModelPicker';
import { Modal, Toggle } from '../components/ui';
import { browserVoices, loadVoicePrefs, saveVoicePrefs, speaker } from '../speech';
import { useApp } from '../state';

// ---------- Providers ----------

export function ProvidersSection() {
  const { toast, refreshModels, refreshSettings } = useApp();
  const [providers, setProviders] = useState<ProviderView[]>();
  const [presets, setPresets] = useState<ProviderPresetView[]>([]);
  const [adding, setAdding] = useState<ProviderPresetView | 'pick' | null>(null);
  const [editing, setEditing] = useState<ProviderView | null>(null);
  const [testing, setTesting] = useState<Record<string, 'busy' | string>>({});

  const load = useCallback(async () => {
    try {
      const r = await api.providers();
      setProviders(r.providers);
      setPresets(r.presets);
    } catch (err) {
      toast((err as Error).message);
    }
  }, [toast]);
  useEffect(() => void load(), [load]);

  const changed = async (list: ProviderView[]) => {
    setProviders(list);
    await Promise.all([refreshModels(), refreshSettings()]);
    // Model counts and errors are filled in by listing models.
    void load();
  };

  const test = async (p: ProviderView) => {
    setTesting((t) => ({ ...t, [p.id]: 'busy' }));
    try {
      const r = await api.testProvider(p.id);
      setTesting((t) => ({ ...t, [p.id]: p.kind === 'elevenlabs' ? 'Key saved' : `${r.count} model${r.count === 1 ? '' : 's'}` }));
      void refreshModels();
      void load();
    } catch (err) {
      setTesting((t) => ({ ...t, [p.id]: '' }));
      toast((err as Error).message);
    }
  };

  const configured = providers?.filter((p) => p.hasKey || p.kind === 'ollama' || p.kind === 'lmstudio' || p.kind === 'custom') ?? [];
  const preset = (kind: ProviderKind) => presets.find((x) => x.kind === kind);

  return (
    <section className="settings-section card">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 12 }}>
        <p className="muted small" style={{ margin: 0 }}>
          Connect OpenRouter for hundreds of models with one key, and add providers directly to use their models with your own keys. Their models appear in
          the model picker as <code>provider:model</code>.
        </p>
        <button className="btn btn-sm" style={{ flexShrink: 0 }} onClick={() => setAdding('pick')}>
          <Plus size={14} /> Add provider
        </button>
      </div>
      {!providers ? (
        <div className="muted small">Loading…</div>
      ) : (
        <div className="provider-list">
          {configured.length === 0 && (
            <div className="provider-row empty">
              <span className="grow">No provider yet. Add OpenRouter (recommended) or another provider to start chatting.</span>
              <button className="btn btn-primary btn-sm" onClick={() => setAdding(preset('openrouter') ?? 'pick')}>
                Add OpenRouter
              </button>
            </div>
          )}
          {configured.map((p) => (
            <div key={p.id} className={`provider-row${p.enabled ? '' : ' off'}`}>
              <div className="provider-logo">{p.name.slice(0, 1)}</div>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row" style={{ gap: 6 }}>
                  <strong>{p.name}</strong>
                  {p.kind !== 'openrouter' && <code className="muted small">{p.id}:</code>}
                  {p.keySource === 'env' && <span className="badge">from environment</span>}
                </div>
                <div className="small muted">
                  {p.error ? (
                    <span style={{ color: 'var(--danger)' }}>
                      <AlertTriangle size={12} /> {p.error}
                    </span>
                  ) : preset(p.kind)?.chat === false ? (
                    'Voice, sound effects and music'
                  ) : p.modelCount !== undefined ? (
                    `${p.modelCount} model${p.modelCount === 1 ? '' : 's'}`
                  ) : (
                    p.baseUrl ?? preset(p.kind)?.baseUrl
                  )}
                </div>
              </div>
              <button className="btn btn-sm btn-ghost" onClick={() => void test(p)} disabled={testing[p.id] === 'busy' || !p.enabled}>
                {testing[p.id] === 'busy' ? <Loader2 size={13} className="spin" /> : testing[p.id] ? <Check size={13} /> : <RefreshCw size={13} />}
                {testing[p.id] && testing[p.id] !== 'busy' ? testing[p.id] : 'Test'}
              </button>
              <button className="btn btn-sm btn-ghost" onClick={() => setEditing(p)}>
                Key
              </button>
              {p.kind !== 'openrouter' && <Toggle on={p.enabled} label={`${p.enabled ? 'Disable' : 'Enable'} ${p.name}`} onChange={(on) => void api.updateProvider(p.id, { enabled: on }).then(changed, (e) => toast(e.message))} />}
              {p.keySource !== 'env' && (
                <button
                  className="icon-btn sm"
                  aria-label={`Remove ${p.name}`}
                  title="Remove"
                  onClick={() => void api.removeProvider(p.id).then(changed, (e) => toast(e.message))}
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {adding === 'pick' && (
        <Modal title="Add a provider" onClose={() => setAdding(null)}>
          <div className="preset-grid">
            {presets.map((p) => (
              <button key={p.kind} className="preset-card" onClick={() => setAdding(p)}>
                <div className="provider-logo">{p.name.slice(0, 1)}</div>
                <div>
                  <div className="t">{p.name}</div>
                  <div className="s">{p.kind === 'openrouter' ? 'Hundreds of models, one key' : p.chat ? (p.keyless ? 'Local models, no key' : 'Chat models') : 'Voice, sounds, music'}</div>
                </div>
              </button>
            ))}
          </div>
        </Modal>
      )}
      {adding && adding !== 'pick' && (
        <KeyModal
          preset={adding}
          onClose={() => setAdding(null)}
          onSave={async (apiKey, baseUrl) => {
            const list = await api.addProvider({ kind: adding.kind, apiKey, baseUrl });
            setAdding(null);
            await changed(list);
            const added = list.find((x) => x.kind === adding.kind);
            if (added && preset(added.kind)?.chat !== false) void test(added);
          }}
        />
      )}
      {editing && (
        <KeyModal
          preset={preset(editing.kind) ?? { kind: editing.kind, name: editing.name, baseUrl: '', keyless: false, chat: true }}
          existing={editing}
          onClose={() => setEditing(null)}
          onSave={async (apiKey, baseUrl) => {
            const body: { apiKey?: string; baseUrl?: string } = {};
            if (apiKey) body.apiKey = apiKey;
            if (baseUrl !== undefined) body.baseUrl = baseUrl;
            const list = await api.updateProvider(editing.id, body);
            setEditing(null);
            await changed(list);
          }}
        />
      )}
    </section>
  );
}

function KeyModal({
  preset,
  existing,
  onClose,
  onSave,
}: {
  preset: ProviderPresetView;
  existing?: ProviderView;
  onClose(): void;
  onSave(apiKey: string, baseUrl?: string): Promise<void>;
}) {
  const { toast } = useApp();
  const [key, setKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? (preset.kind === 'custom' ? '' : ''));
  const [busy, setBusy] = useState(false);
  const needsUrl = preset.kind === 'custom';
  const showUrl = needsUrl || preset.keyless || !!existing?.baseUrl;
  const canSave = needsUrl ? !!baseUrl.trim() : preset.keyless || !!key.trim() || (!!existing && baseUrl !== (existing.baseUrl ?? ''));
  return (
    <Modal
      title={existing ? `${preset.name} settings` : `Connect ${preset.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={!canSave || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onSave(key.trim(), showUrl ? baseUrl.trim() : undefined);
              } catch (err) {
                toast((err as Error).message);
                setBusy(false);
              }
            }}
          >
            {existing ? 'Save' : 'Connect'}
          </button>
        </>
      }
    >
      {preset.keyUrl && (
        <p className="small" style={{ marginTop: 0 }}>
          Create a key at{' '}
          <a href={preset.keyUrl} target="_blank" rel="noreferrer">
            {new URL(preset.keyUrl).host} <ExternalLink size={11} />
          </a>
        </p>
      )}
      {!preset.keyless && (
        <label className="field">
          <span className="field-label">API key</span>
          <input
            className="input mono"
            type="password"
            autoFocus
            autoComplete="off"
            placeholder={existing?.hasKey ? 'Saved; enter a new key to replace it' : 'Paste your key'}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          <span className="field-hint">Stored in ~/.mitzi/config.json on this computer, readable only by you.</span>
        </label>
      )}
      {showUrl && (
        <label className="field">
          <span className="field-label">Base URL</span>
          <input className="input mono" placeholder={preset.baseUrl || 'https://api.example.com/v1'} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          <span className="field-hint">{needsUrl ? 'Any OpenAI-compatible API (vLLM, LiteLLM, Azure, …).' : `Leave empty for ${preset.baseUrl}.`}</span>
        </label>
      )}
    </Modal>
  );
}

// ---------- Media & voice ----------

const MEDIA_FIELDS: { key: keyof MediaModels; label: string; hint: string; empty: string }[] = [
  { key: 'imageModel', label: 'Images', hint: 'Lets bots create images.', empty: 'Add OpenAI, Google, OpenRouter or another provider with image models.' },
  { key: 'videoModel', label: 'Video', hint: 'Short clips; slow and costly, so the bot asks before each one.', empty: 'Add OpenAI (Sora) or Google (Veo) to generate video.' },
  { key: 'speechModel', label: 'Speech (text to speech)', hint: 'Natural voices for read-aloud and live mode. Without it, your browser’s voices are used.', empty: 'Add OpenAI, ElevenLabs, Google or OpenRouter for natural voices.' },
  { key: 'soundModel', label: 'Sound effects', hint: 'Sound design from a description.', empty: 'Add ElevenLabs to generate sound effects.' },
  { key: 'musicModel', label: 'Music', hint: 'Original music from a description.', empty: 'Add ElevenLabs to generate music.' },
  { key: 'transcribeModel', label: 'Transcription (speech to text)', hint: 'For live mode in browsers without built-in speech recognition (Firefox, some Safari).', empty: 'Add OpenAI, Groq, Google or OpenRouter for transcription.' },
];

function voicePlaceholder(model: string): string {
  if (model.startsWith('elevenlabs:')) return 'ElevenLabs voice id (default: George)';
  if (model.startsWith('google:')) return 'Kore, Puck, Charon, Zephyr, Aoede… (default: Kore)';
  if (!/^[a-z0-9-]+:/.test(model)) return 'Voice name; depends on the model (empty: its default voice)';
  return 'alloy, ash, coral, nova, sage, shimmer…';
}

export function MediaSettingsSection() {
  const { settings, refreshSettings, toast, models } = useApp();
  const [catalog, setCatalog] = useState<MediaModels>();
  const [prefs, setPrefs] = useState(loadVoicePrefs);
  const [voices, setVoices] = useState(browserVoices);
  const [voiceId, setVoiceId] = useState(settings?.media.voice ?? '');

  // The chat model list reloads whenever providers change; media models follow it.
  useEffect(() => {
    api.mediaModels().then((r) => setCatalog(r.models), () => {});
  }, [models]);
  useEffect(() => {
    if (typeof speechSynthesis === 'undefined') return;
    const update = () => setVoices(speechSynthesis.getVoices());
    speechSynthesis.addEventListener('voiceschanged', update);
    return () => speechSynthesis.removeEventListener('voiceschanged', update);
  }, []);
  if (!settings) return null;

  const save = async (patch: Partial<MediaSettings>) => {
    try {
      await api.updateSettings({ media: { ...settings.media, ...patch } });
      await refreshSettings();
    } catch (err) {
      toast((err as Error).message);
    }
  };
  const setPref = (p: Partial<typeof prefs>) => {
    const next = { ...prefs, ...p };
    setPrefs(next);
    saveVoicePrefs(next);
  };

  return (
    <section className="settings-section card">
      <p className="muted small" style={{ marginTop: 0 }}>
        Each kind of media can use a different provider: for example chat through OpenRouter and speech through Google. Any <code>provider:model</code> id works.
      </p>
      {MEDIA_FIELDS.map((f) => (
        <div key={f.key} className="field">
          <span className="field-label">{f.label}</span>
          <ModelPicker
            value={settings.media[f.key]}
            onChange={(v) => void save({ [f.key]: v })}
            variant="input"
            direction="down"
            allowEmpty="Off"
            options={catalog ? catalog[f.key].map((m): ModelInfo => ({ ...m, tools: true, vision: false })) : []}
            emptyHint={catalog ? f.empty : 'Loading models…'}
          />
          <span className="field-hint">{f.hint}</span>
        </div>
      ))}
      <div className="field">
        <span className="field-label">Language you speak</span>
        <select className="select" style={{ maxWidth: 320 }} value={prefs.language} onChange={(e) => setPref({ language: e.target.value })}>
          <option value="">{settings.media.transcribeModel ? 'Detect automatically' : `Same as the browser (${languageName(navigator.language || 'en-US')})`}</option>
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.name}
            </option>
          ))}
        </select>
        <span className="field-hint">
          For live conversations. {settings.media.transcribeModel ? 'Your transcription model detects the language, so you can switch languages mid-conversation.' : 'The browser’s speech recognition understands one language at a time; choose a transcription model above to have the language detected for you.'} Answers are read in their own language, with a voice that speaks it.
        </span>
      </div>
      {settings.media.speechModel && (
        <form
          className="field"
          onSubmit={(e) => {
            e.preventDefault();
            void save({ voice: voiceId.trim() });
          }}
        >
          <span className="field-label">Voice</span>
          <div className="row">
            <input
              className="input mono"
              value={voiceId}
              placeholder={voicePlaceholder(settings.media.speechModel)}
              onChange={(e) => setVoiceId(e.target.value)}
            />
            <button className="btn" disabled={voiceId.trim() === settings.media.voice}>
              Save
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                speaker.useServer = true;
                void speaker.speak('settings-test', 'Hi! This is how I sound when I read answers aloud.').catch((err) => toast(err.message));
              }}
            >
              <Volume2 size={14} /> Try
            </button>
          </div>
        </form>
      )}
      {!settings.media.speechModel && (
        <div className="field" style={{ marginBottom: 0 }}>
          <span className="field-label">Browser voice</span>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <select className="select" style={{ flex: 1, minWidth: 200 }} value={prefs.voice} onChange={(e) => setPref({ voice: e.target.value })}>
              <option value="">System default</option>
              {voices.map((v) => (
                <option key={v.name} value={v.name}>
                  {v.name} ({v.lang})
                </option>
              ))}
            </select>
            <select className="select" style={{ width: 110 }} value={prefs.rate} onChange={(e) => setPref({ rate: Number(e.target.value) })} aria-label="Speed">
              {[0.8, 0.9, 1, 1.1, 1.25, 1.5].map((r) => (
                <option key={r} value={r}>
                  {r}×
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                speaker.useServer = false;
                void speaker.speak('settings-test', 'Hi! This is how I sound when I read answers aloud.').catch((err) => toast(err.message));
              }}
            >
              <Volume2 size={14} /> Try
            </button>
          </div>
          <span className="field-hint">
            <Mic size={11} /> Live mode uses your browser’s speech recognition when available.
          </span>
        </div>
      )}
    </section>
  );
}
