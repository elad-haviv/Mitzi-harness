import { AlertTriangle, ArrowUpCircle, Brain, Check, CircleDashed, Loader2, RefreshCw, Copy, Database, Download, KeyRound, MessagesSquare, Monitor, Moon, Palette, Plug, Puzzle, Sparkles, Sun, Volume2, WandSparkles } from 'lucide-react';
import { ReactNode, useEffect, useState } from 'react';
import { api, UpdateStep } from '../api';
import { ImportModal } from '../components/Import';
import { ModelPicker } from '../components/ModelPicker';
import { Toggle } from '../components/ui';
import { href } from '../router';
import { Theme, useApp } from '../state';
import { MediaSettingsSection, ProvidersSection } from './ProviderSettings';

type Section = 'general' | 'models' | 'providers' | 'media' | 'memory' | 'data' | 'updates';

const SECTIONS: { id: Section; label: string; icon: ReactNode; hint: string }[] = [
  { id: 'general', label: 'General', icon: <Palette size={16} />, hint: 'Appearance and long conversations' },
  { id: 'providers', label: 'Providers', icon: <KeyRound size={16} />, hint: 'API keys for OpenRouter, OpenAI, Anthropic, Google and more' },
  { id: 'models', label: 'Models', icon: <Sparkles size={16} />, hint: 'The models Mitzi uses by default' },
  { id: 'media', label: 'Media & voice', icon: <Volume2 size={16} />, hint: 'Image, video, speech, sound and music models, and read-aloud voices' },
  { id: 'memory', label: 'Memory', icon: <Brain size={16} />, hint: 'How bots remember, and importing memories from other AIs' },
  { id: 'data', label: 'Data & about', icon: <Database size={16} />, hint: 'Where your data lives, importing chats, and version' },
  { id: 'updates', label: 'Updates', icon: <ArrowUpCircle size={16} />, hint: 'Get the latest version of Mitzi' },
];

/** Pages of their own, linked from Settings so everything configurable is in one place. */
const EXTENSIONS = [
  { page: 'connectors' as const, label: 'Connectors', icon: <Plug size={16} /> },
  { page: 'skills' as const, label: 'Skills', icon: <WandSparkles size={16} /> },
  { page: 'plugins' as const, label: 'Plugins', icon: <Puzzle size={16} /> },
];

export function SettingsPage({ section }: { section?: string }) {
  const { settings, update } = useApp();
  if (!settings) return <div className="page muted">Loading…</div>;
  // Without a provider there's nothing else to do, so start there.
  const current: Section = SECTIONS.some((s) => s.id === section) ? (section as Section) : settings.hasApiKey ? 'general' : 'providers';
  const info = SECTIONS.find((s) => s.id === current)!;

  return (
    <div className="page">
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          <h1 className="settings-nav-title">Settings</h1>
          {SECTIONS.map((s) => (
            <a
              key={s.id}
              ref={(el) => {
                // On phones the menu scrolls sideways; keep the current section in view.
                if (el && s.id === current) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
              }}
              className={`settings-nav-item${s.id === current ? ' active' : ''}`} href={href({ page: 'settings', section: s.id })} aria-current={s.id === current ? 'page' : undefined}>
              {s.icon}
              <span>{s.label}</span>
              {s.id === 'providers' && !settings.hasApiKey && <span className="nav-dot" aria-label="Needs setup" />}
              {s.id === 'updates' && !!update?.behind && update.supported && <span className="nav-dot accent-dot" aria-label="Update available" />}
            </a>
          ))}
          <div className="settings-nav-label">Extensions</div>
          {EXTENSIONS.map((e) => (
            <a key={e.page} className="settings-nav-item" href={href({ page: e.page })}>
              {e.icon}
              <span>{e.label}</span>
            </a>
          ))}
        </nav>
        <div className="settings-content">
          <div className="page-header">
            <div>
              <h2 className="page-title">{info.label}</h2>
              <p className="page-subtitle">{info.hint}</p>
            </div>
          </div>
          {current === 'general' && <GeneralSettings />}
          {current === 'models' && <ModelSettings />}
          {current === 'providers' && <ProvidersSection />}
          {current === 'media' && <MediaSettingsSection />}
          {current === 'memory' && <MemorySettings />}
          {current === 'data' && <DataSettings />}
          {current === 'updates' && <UpdateSettings />}
        </div>
      </div>
    </div>
  );
}

function useSave() {
  const { refreshSettings, toast } = useApp();
  return async (patch: Parameters<typeof api.updateSettings>[0], message?: string) => {
    try {
      await api.updateSettings(patch);
      await refreshSettings();
      if (message) toast(message, 'info');
    } catch (err) {
      toast((err as Error).message);
    }
  };
}

function GeneralSettings() {
  const { settings, theme, setTheme } = useApp();
  const save = useSave();
  if (!settings) return null;
  return (
    <>
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

      <section className="settings-section card">
        <h2>Long conversations</h2>
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
    </>
  );
}

function ModelSettings() {
  const { settings } = useApp();
  const save = useSave();
  if (!settings) return null;
  return (
    <section className="settings-section card">
      <div className="field">
        <span className="field-label">Default model</span>
        <ModelPicker value={settings.defaultModel} onChange={(m) => void save({ defaultModel: m })} variant="input" direction="down" />
        <span className="field-hint">Used for new chats. You can switch models any time from the chat box, and give each bot its own.</span>
      </div>
      <div className="field" style={{ marginBottom: 0 }}>
        <span className="field-label">Fast model</span>
        <ModelPicker value={settings.smallModel ?? ''} onChange={(m) => void save({ smallModel: m })} variant="input" direction="down" allowEmpty="Same as the chat's model" />
        <span className="field-hint">A cheaper model for titles, summaries, memory, suggestions and learning from ratings.</span>
      </div>
    </section>
  );
}

function DataSettings() {
  const { settings, toast } = useApp();
  const [importing, setImporting] = useState(false);
  const [copied, setCopied] = useState(false);
  if (!settings) return null;
  return (
    <>
      <section className="settings-section card">
        <h2 className="row" style={{ gap: 8 }}>
          <Download size={17} /> Import from other AIs
        </h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          Bring what ChatGPT, Claude or Gemini know about you, and your chat history from ChatGPT or Claude.
        </p>
        <button className="btn" onClick={() => setImporting(true)}>
          <MessagesSquare size={15} /> Import memories or chats…
        </button>
        {importing && <ImportModal onClose={() => setImporting(false)} />}
      </section>
      <section className="settings-section card">
        <h2>Your data</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          Everything stays on this computer: settings and API keys in <code>config.json</code>, and chats, projects, bots, artifacts, memory banks and
          generated media under <code>data</code>. Back up this folder to keep it all.
        </p>
        <div className="row">
          <code className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {settings.home}
          </code>
          <button
            className="btn btn-sm"
            onClick={() =>
              void navigator.clipboard.writeText(settings.home).then(
                () => (setCopied(true), setTimeout(() => setCopied(false), 1500)),
                () => toast('Couldn’t copy'),
              )
            }
          >
            {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy path'}
          </button>
        </div>
      </section>
      <section className="settings-section card">
        <h2>About</h2>
        <p className="small" style={{ margin: 0 }}>
          Mitzi <strong>v{settings.version}</strong> · settings are shared with the <code>mitzi</code> command-line tool.
        </p>
        <p className="muted small" style={{ marginBottom: 0 }}>
          Updates: <a href={href({ page: 'settings', section: 'updates' })}>check for a new version</a>.
        </p>
      </section>
    </>
  );
}

function MemorySettings() {
  const { settings, refreshSettings, toast } = useApp();
  const [url, setUrl] = useState(settings?.hindsightUrl ?? '');
  const [key, setKey] = useState('');
  const [embedding, setEmbedding] = useState(settings?.embeddingModel ?? '');
  const [testing, setTesting] = useState<'idle' | 'busy' | 'ok'>('idle');
  const [importing, setImporting] = useState(false);
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
    <>
    <section className="settings-section card">
      <h2>Memory engine</h2>
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
    <section className="settings-section card">
      <h2>Memory banks</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        Browse, edit and teach each bot’s memory, or bring memories over from ChatGPT, Claude and Gemini.
      </p>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <a className="btn" href={href({ page: 'memory' })}>
          <Brain size={15} /> Open memory banks
        </a>
        <button className="btn" onClick={() => setImporting(true)}>
          <Download size={15} /> Import from other AIs
        </button>
      </div>
      {importing && <ImportModal initialTab="memory" onClose={() => setImporting(false)} />}
    </section>
    </>
  );
}

const STEP_LABEL: Record<UpdateStep, string> = { download: 'Download the new version', install: 'Install dependencies', build: 'Build' };

function UpdateSettings() {
  const { settings, update, setUpdate, toast } = useApp();
  const save = useSave();
  const [checking, setChecking] = useState(false);
  const [steps, setSteps] = useState<Partial<Record<UpdateStep, 'running' | 'done' | 'skipped'>>>();
  const [log, setLog] = useState<string[]>([]);
  const [phase, setPhase] = useState<'idle' | 'updating' | 'restarting' | 'restart-required' | 'error'>('idle');
  const [error, setError] = useState('');

  const check = async () => {
    setChecking(true);
    try {
      setUpdate(await api.updateInfo(true));
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setChecking(false);
    }
  };
  useEffect(() => {
    // Opening this page checks if the last check is more than a few minutes old.
    if (!update || Date.now() - Date.parse(update.checkedAt) > 5 * 60_000) void check();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async () => {
    setPhase('updating');
    setSteps({});
    setLog([]);
    setError('');
    let outcome: 'restarting' | 'restart-required' | 'error' | undefined;
    try {
      await api.applyUpdate((e) => {
        if (e.type === 'step') setSteps((s) => ({ ...s, [e.step]: e.status }));
        else if (e.type === 'log') setLog((l) => [...l.slice(-200), e.text]);
        else if (e.type === 'error') {
          outcome = 'error';
          setError(e.message);
        } else if (e.type === 'restarting' || e.type === 'restart-required') outcome = e.type;
      });
    } catch (err) {
      outcome = 'error';
      setError((err as Error).message);
    }
    setPhase(outcome ?? 'idle');
    if (outcome === 'restarting') {
      // The new version starts in a moment; reload into it.
      try {
        await api.waitForServer();
        location.reload();
      } catch (err) {
        setError((err as Error).message);
        setPhase('error');
      }
    } else if (!outcome) {
      void check();
    }
  };

  if (!settings) return null;
  const u = update;
  const date = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');

  if (phase === 'restarting') {
    return (
      <section className="settings-section card update-restart">
        <Loader2 size={26} className="spin accent" />
        <h2>Restarting Mitzi…</h2>
        <p className="muted small">The new version is starting. This page reloads by itself in a few seconds.</p>
      </section>
    );
  }

  return (
    <>
      <section className="settings-section card">
        <div className="update-head">
          <div className="grow">
            <div className="update-version">
              Mitzi <strong>v{u?.current.version ?? settings.version}</strong>
              {u?.current.commit && <span className="muted small"> · {u.current.commit} · {date(u.current.date)}</span>}
            </div>
            <div className="small">
              {!u ? (
                <span className="muted">Checking…</span>
              ) : !u.supported ? (
                <span className="update-warn">
                  <AlertTriangle size={13} /> {u.reason}
                </span>
              ) : u.behind ? (
                <span className="accent">
                  <ArrowUpCircle size={13} /> {u.latest && u.latest.version !== u.current.version ? `Version ${u.latest.version} is available` : 'An update is available'} ({u.behind} change
                  {u.behind === 1 ? '' : 's'}, {date(u.latest?.date)})
                </span>
              ) : (
                <span className="ok-text">
                  <Check size={13} /> You have the latest version
                </span>
              )}
              {u && <span className="muted"> · checked {new Date(u.checkedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>}
            </div>
          </div>
          <button className="btn btn-sm" disabled={checking || phase === 'updating'} onClick={() => void check()}>
            {checking ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Check now
          </button>
        </div>

        {u?.supported && u.behind > 0 && phase === 'idle' && (
          <>
            <div className="update-changes">
              <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>
                What’s new
              </div>
              <ul>
                {u.commits.slice(0, 12).map((c) => (
                  <li key={c.sha}>
                    {c.subject} <span className="muted small">{date(c.date)}</span>
                  </li>
                ))}
                {u.commits.length > 12 && <li className="muted">…and {u.behind - 12} more</li>}
              </ul>
            </div>
            <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
              <button className="btn btn-primary" onClick={() => void run()}>
                <ArrowUpCircle size={15} /> {u.canRestart ? 'Update and restart' : 'Update'}
              </button>
              <span className="muted small">
                {u.canRestart ? 'Takes a minute or two. Replies in progress stop when Mitzi restarts.' : 'After updating, restart Mitzi to use the new version.'}
              </span>
            </div>
          </>
        )}

        {(phase === 'updating' || phase === 'error' || phase === 'restart-required') && steps && (
          <div className="update-progress">
            {(['download', 'install', 'build'] as UpdateStep[]).map((step) => {
              const st = steps[step];
              return (
                <div key={step} className={`update-step ${st ?? 'waiting'}`}>
                  {st === 'running' ? <Loader2 size={15} className="spin" /> : st === 'done' ? <Check size={15} /> : <CircleDashed size={15} />}
                  {STEP_LABEL[step]}
                  {st === 'skipped' && <span className="muted small"> · no changes</span>}
                </div>
              );
            })}
            {log.length > 0 && (
              <details className="update-log">
                <summary className="small muted">Details</summary>
                <pre>{log.slice(-60).join('\n')}</pre>
              </details>
            )}
          </div>
        )}
        {phase === 'error' && <div className="error-box" style={{ marginTop: 12, whiteSpace: 'pre-wrap' }}>{error}</div>}
        {phase === 'restart-required' && (
          <div className="card small" style={{ marginTop: 12, padding: 12 }}>
            Updated. Close Mitzi and start it again (<code>mitzi ui</code>) to use the new version.
          </div>
        )}
      </section>

      <section className="settings-section card">
        <div className="setting-row" style={{ borderTop: 0, paddingTop: 0 }}>
          <div>
            <div>Check for updates automatically</div>
            <div className="muted small">Mitzi looks for a new version twice a day and shows “Update available” in the sidebar. It never updates without asking.</div>
          </div>
          <Toggle on={settings.autoCheckUpdates} label="Check for updates automatically" onChange={(v) => void save({ autoCheckUpdates: v })} />
        </div>
        <p className="muted small" style={{ marginBottom: 0 }}>
          From a terminal: <code>mitzi update</code>.
        </p>
      </section>
    </>
  );
}
