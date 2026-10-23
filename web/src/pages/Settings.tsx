import { AlertTriangle, ArrowUpCircle, Languages, Wallet, Brain, Check, CircleDashed, Loader2, RefreshCw, Copy, Database, Download, KeyRound, MessagesSquare, Monitor, Moon, Palette, Plug, Puzzle, Sparkles, Sun, Volume2, WandSparkles, Send, X, Smartphone, Bell } from 'lucide-react';
import { ReactNode, useEffect, useState } from 'react';
import { api, UpdateStep } from '../api';
import { MessagingSettings } from './MessagingSettings';
import { ImportModal } from '../components/Import';
import { ModelPicker } from '../components/ModelPicker';
import { Toggle } from '../components/ui';
import { href } from '../router';
import { Theme, useApp } from '../state';
import { MediaSettingsSection, ProvidersSection } from './ProviderSettings';
import { BudgetMeters } from './Insights';
import { qrSvg } from '../../../src/shared/qr';
import { APPROVAL, LEVELS } from '../components/Approval';
import { lang, LANGUAGES, plural, setLanguage, tr } from '../i18n';

type Section = 'general' | 'models' | 'providers' | 'media' | 'budget' | 'phone' | 'messaging' | 'memory' | 'data' | 'updates';

const SECTIONS: { id: Section; label: string; icon: ReactNode; hint: string }[] = [
  { id: 'general', label: tr('General'), icon: <Palette size={16} />, hint: tr('Appearance and long conversations') },
  { id: 'providers', label: tr('Providers'), icon: <KeyRound size={16} />, hint: tr('API keys for OpenRouter, OpenAI, Anthropic, Google and more') },
  { id: 'models', label: tr('Models'), icon: <Sparkles size={16} />, hint: tr('The models Mitzi uses by default') },
  { id: 'media', label: tr('Media & voice'), icon: <Volume2 size={16} />, hint: tr('Image, video, speech, sound and music models, and read-aloud voices') },
  { id: 'budget', label: tr('Usage & budget'), icon: <Wallet size={16} />, hint: tr('Spending limits and alerts') },
  { id: 'phone', label: tr('Phone & notifications'), icon: <Smartphone size={16} />, hint: tr('Use Mitzi on your phone, and get notified when chats finish') },
  { id: 'messaging', label: tr('Messaging'), icon: <Send size={16} />, hint: tr('Chat with Mitzi from Telegram, Discord, Slack, WhatsApp or email, and get approvals there') },
  { id: 'memory', label: tr('Memory'), icon: <Brain size={16} />, hint: tr('How bots remember, and importing memories from other AIs') },
  { id: 'data', label: tr('Data & about'), icon: <Database size={16} />, hint: tr('Where your data lives, importing chats, and version') },
  { id: 'updates', label: tr('Updates'), icon: <ArrowUpCircle size={16} />, hint: tr('Get the latest version of Mitzi') },
];

/** Pages of their own, linked from Settings so everything configurable is in one place. */
const EXTENSIONS = [
  { page: 'connectors' as const, label: tr('Connectors'), icon: <Plug size={16} /> },
  { page: 'skills' as const, label: tr('Skills'), icon: <WandSparkles size={16} /> },
  { page: 'plugins' as const, label: tr('Plugins'), icon: <Puzzle size={16} /> },
];

export function SettingsPage({ section }: { section?: string }) {
  const { settings, update } = useApp();
  if (!settings) return <div className="page muted">{tr('Loading…')}</div>;
  // Without a provider there's nothing else to do, so start there.
  // Telegram had its own section before the other messaging services came.
  if (section === 'telegram') section = 'messaging';
  const current: Section = SECTIONS.some((s) => s.id === section) ? (section as Section) : settings.hasApiKey ? 'general' : 'providers';
  const info = SECTIONS.find((s) => s.id === current)!;

  return (
    <div className="page">
      <div className="settings-layout">
        <nav className="settings-nav" aria-label={tr('Settings sections')}>
          <h1 className="settings-nav-title">{tr('Settings')}</h1>
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
              {s.id === 'providers' && !settings.hasApiKey && <span className="nav-dot" aria-label={tr('Needs setup')} />}
              {s.id === 'updates' && !!update?.behind && update.supported && <span className="nav-dot accent-dot" aria-label={tr('Update available')} />}
            </a>
          ))}
          <div className="settings-nav-label">{tr('Extensions')}</div>
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
          {current === 'budget' && <BudgetSettings />}
          {current === 'messaging' && <MessagingSettings />}
          {current === 'phone' && <PhoneSettings />}
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
        <h2>{tr('Appearance')}</h2>
        <div className="segmented">
          {(
            [
              ['system', <Monitor size={14} key="s" />, tr('System')],
              ['light', <Sun size={14} key="l" />, tr('Light')],
              ['dark', <Moon size={14} key="d" />, tr('Dark')],
            ] as [Theme, ReactNode, string][]
          ).map(([t, icon, label]) => (
            <button key={t} className={theme === t ? 'active' : ''} onClick={() => setTheme(t)}>
              {icon} {label}
            </button>
          ))}
        </div>
        <div className="field" style={{ marginTop: 16, marginBottom: 0 }}>
          <span className="field-label">{tr('Language')}</span>
          <div className="segmented">
            {LANGUAGES.map((l) => (
              <button key={l.code} className={lang === l.code ? 'active' : ''} lang={l.code} onClick={() => l.code !== lang && setLanguage(l.code)}>
                <Languages size={14} /> {l.name}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="settings-section card">
        <h2>{tr('Approvals')}</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          {tr('How much Mitzi may do on its own in new chats. Each chat can change it from the chat box (Shift+Tab), and a project’s permissions apply to its chats.')}
        </p>
        <div className="approval-options" role="radiogroup" aria-label={tr('Default approval level')}>
          {LEVELS.map((l) => (
            <button key={l} role="radio" aria-checked={(settings.approval ?? 'kitten') === l} className={`approval-option${(settings.approval ?? 'kitten') === l ? ' on' : ''}`} onClick={() => void save({ approval: l }, tr('New chats: {0}', APPROVAL[l].name))}>
              <span className="approval-emoji big" aria-hidden>
                {APPROVAL[l].emoji}
              </span>
              <span className="t">{APPROVAL[l].name}</span>
              <span className="s">{APPROVAL[l].description}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="settings-section card">
        <h2>{tr('Browser')}</h2>
        <div className="tool-toggle" style={{ padding: 0, border: 0 }}>
          <div className="grow">
            <div className="t">{tr('Show the browser window')}</div>
            <div className="s">{tr('When bots use the browser, open its window on your screen so you can watch, sign in to sites or take over. Otherwise it works out of sight and you see its pages in the chat’s side panel.')}</div>
          </div>
          <Toggle label={tr('Show the browser window')} on={!!settings.browserHeaded} onChange={(v) => void save({ browserHeaded: v })} />
        </div>
      </section>

      <section className="settings-section card">
        <h2>{tr('Computer control')}</h2>
        <div className="tool-toggle" style={{ padding: 0, border: 0 }}>
          <div className="grow">
            <div className="t">{tr('Let bots use this computer')}</div>
            <div className="s">
              {tr('Bots can take screenshots and use the mouse and keyboard to work in your apps. They ask before every click or keystroke unless the chat is on Alley cat, and screenshots go to the chat’s model, so use a model that can see images. On a Mac, allow the app running Mitzi under Privacy &amp; Security → Screen Recording and Accessibility; on Linux it needs an X11 session with xdotool and ImageMagick.')}
            </div>
          </div>
          <Toggle label={tr('Let bots use this computer')} on={!!settings.computerUse} onChange={(v) => void save({ computerUse: v })} />
        </div>
      </section>

      <section className="settings-section card">
        <h2>{tr('Long conversations')}</h2>
        <div className="field">
          <span className="field-label">{tr('Auto-compact when the context window is')}</span>
          <div className="range-row">
            <input
              type="range"
              min={0}
              max={95}
              step={5}
              defaultValue={settings.autoCompactPercent}
              onPointerUp={(e) => void save({ autoCompactPercent: Number((e.target as HTMLInputElement).value) })}
              onKeyUp={(e) => void save({ autoCompactPercent: Number((e.target as HTMLInputElement).value) })}
              aria-label={tr('Auto-compact threshold')}
            />
            <span className="val">{settings.autoCompactPercent === 0 ? tr('Off') : tr('{0}% full', settings.autoCompactPercent)}</span>
          </div>
          <span className="field-hint">{tr('Older messages are summarized automatically so long conversations never hit the model\'s limit.')}</span>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <span className="field-label">{tr('Recent turns kept word-for-word')}</span>
          <select className="select" style={{ maxWidth: 200 }} value={settings.keepRecentTurns} onChange={(e) => void save({ keepRecentTurns: Number(e.target.value) })}>
            {[0, 1, 2, 3, 4, 6, 8].map((n) => (
              <option key={n} value={n}>
                {n === 0 ? tr('None (summarize all)') : plural(n, 'Last turn', 'Last {0} turns')}
              </option>
            ))}
          </select>
        </div>
      </section>
    </>
  );
}

const PROVIDER_NAMES: Record<string, string> = {
  openai: tr('OpenAI'),
  google: tr('Google'),
  anthropic: tr('Anthropic'),
  elevenlabs: tr('ElevenLabs'),
  groq: tr('Groq'),
  xai: 'xAI',
  mistral: tr('Mistral'),
  deepseek: tr('DeepSeek'),
  together: tr('Together AI'),
  ollama: tr('Ollama'),
  lmstudio: tr('LM Studio'),
};

/** The provider a model id runs on: "google:…" → Google; ids without a prefix go through OpenRouter. */
function providerOf(id: string): string {
  const prefix = /^([a-z0-9-]+):/.exec(id)?.[1];
  return prefix ? (PROVIDER_NAMES[prefix] ?? prefix) : tr('OpenRouter');
}

const JOBS = [
  ['imageModel', tr('Images')],
  ['videoModel', tr('Video')],
  ['speechModel', tr('Speech')],
  ['transcribeModel', tr('Transcription')],
  ['soundModel', 'Sound effects'],
  ['musicModel', tr('Music')],
] as const;

function ModelSettings() {
  const { settings, models } = useApp();
  const save = useSave();
  if (!settings) return null;
  const name = (id: string) => models.find((m) => m.id === id)?.name ?? id;
  const jobs: [string, string | undefined][] = [
    [tr('Chat'), settings.defaultModel],
    ['Fast tasks', settings.smallModel || settings.defaultModel],
    ...JOBS.map(([k, label]): [string, string | undefined] => [label, settings.media[k] || undefined]),
  ];
  return (
    <>
    <section className="settings-section card">
      <div className="field">
        <span className="field-label">{tr('Default model')}</span>
        <ModelPicker value={settings.defaultModel} onChange={(m) => void save({ defaultModel: m })} variant="input" direction="down" />
        <span className="field-hint">{tr('Used for new chats. You can switch models any time from the chat box, and give each bot its own.')}</span>
      </div>
      <div className="field" style={{ marginBottom: 0 }}>
        <span className="field-label">{tr('Fast model')}</span>
        <ModelPicker value={settings.smallModel ?? ''} onChange={(m) => void save({ smallModel: m })} variant="input" direction="down" allowEmpty={tr('Same as the chat\'s model')} />
        <span className="field-hint">{tr('A cheaper model for titles, summaries, memory, suggestions and learning from ratings.')}</span>
      </div>
    </section>
    <AutoSettings />
    <section className="settings-section card">
      <h2>{tr('Who does what')}</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        {tr('Every job can use its own provider, for example chat through OpenRouter and speech through Google. Bots can also have their own model.')}
      </p>
      <div className="jobs">
        {jobs.map(([label, id]) => (
          <div key={label} className="job-row">
            <span className="job-label">{label}</span>
            {id ? (
              <>
                <span className="job-model" title={id}>{name(id)}</span>
                <span className="badge">{providerOf(id)}</span>
              </>
            ) : (
              <span className="muted">{tr('Off')}</span>
            )}
          </div>
        ))}
      </div>
      <a className="link-btn small" href={href({ page: 'settings', section: 'media' })}>{tr('Choose media and voice models →')}</a>
    </section>
    </>
  );
}

function BudgetSettings() {
  const { settings, budget, refreshBudget } = useApp();
  const save = useSave();
  const b = settings?.budget ?? { alertPercent: 80, hardStop: false };
  const [daily, setDaily] = useState(b.daily ? String(b.daily) : '');
  const [monthly, setMonthly] = useState(b.monthly ? String(b.monthly) : '');
  useEffect(() => {
    void refreshBudget();
  }, [refreshBudget]);
  if (!settings) return null;
  const update = async (patch: Partial<typeof b>) => {
    await save({ budget: { ...b, daily: Number(daily) || undefined, monthly: Number(monthly) || undefined, ...patch } }, 'Budget saved');
    void refreshBudget();
  };
  return (
    <>
      <section className="settings-section card">
        <h2>{tr('Spending limits')}</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          {tr('Costs come from your providers (or the model list’s prices when a provider doesn’t report them). Leave a limit empty for none.')}
        </p>
        <form
          className="budget-form"
          onSubmit={(e) => {
            e.preventDefault();
            void update({});
          }}
        >
          <label className="field">
            <span className="field-label">{tr('Per day')}</span>
            <span className="money-input">
              $<input className="input" type="number" min={0} step="any" value={daily} placeholder={tr('No limit')} onChange={(e) => setDaily(e.target.value)} />
            </span>
          </label>
          <label className="field">
            <span className="field-label">{tr('Per month')}</span>
            <span className="money-input">
              $<input className="input" type="number" min={0} step="any" value={monthly} placeholder={tr('No limit')} onChange={(e) => setMonthly(e.target.value)} />
            </span>
          </label>
          <button className="btn btn-primary">{tr('Save limits')}</button>
        </form>
        <div className="field">
          <span className="field-label">{tr('Warn me at')}</span>
          <select className="select" style={{ maxWidth: 200 }} value={b.alertPercent} onChange={(e) => void update({ alertPercent: Number(e.target.value) })}>
            {[50, 70, 80, 90, 95].map((p) => (
              <option key={p} value={p}>
                {p}{tr('% of a limit')}
              </option>
            ))}
          </select>
        </div>
        <div className="tool-toggle" style={{ padding: 0, border: 0 }}>
          <div className="grow">
            <div className="t">{tr('Stop at the limit')}</div>
            <div className="s">{tr('Refuse new requests once a limit is reached, including scheduled tasks and workflows. Otherwise Mitzi only warns.')}</div>
          </div>
          <Toggle label={tr('Stop at the limit')} on={b.hardStop} onChange={(v) => void update({ hardStop: v })} />
        </div>
      </section>
      {budget && (budget.daily || budget.monthly) ? (
        <section className="settings-section card">
          <h2>{tr('So far')}</h2>
          <BudgetMeters budget={budget} />
          <a className="link-btn small" href={href({ page: 'insights' })}>
            {tr('See where it goes in Insights →')}
          </a>
        </section>
      ) : null}
    </>
  );
}

/** The two models "Auto" picks between, per message. */
function AutoSettings() {
  const { settings } = useApp();
  const save = useSave();
  if (!settings) return null;
  const routing = { fast: '', strong: '', newChats: false, ...settings.routing };
  const update = (patch: Partial<typeof routing>) => void save({ routing: { ...routing, ...patch } }, 'Auto updated');
  return (
    <section className="settings-section card">
      <h2>
        <Sparkles size={16} className="accent" style={{ verticalAlign: -2, marginRight: 6 }} />
        {tr('Auto')}
      </h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        {tr('Choose')}{' '}<b>{tr('Auto')}</b> {tr('in the model picker and Mitzi picks a model for each message: the quick model for everyday questions and small talk, the in-depth model for code, analysis, long documents, planning and multi-step work. Each answer shows which one it used and why.')}
      </p>
      <div className="field">
        <span className="field-label">{tr('Quick model')}</span>
        <ModelPicker value={routing.fast} onChange={(m) => update({ fast: m })} variant="input" direction="down" allowEmpty={tr('The fast model (above)')} />
      </div>
      <div className="field">
        <span className="field-label">{tr('In-depth model')}</span>
        <ModelPicker value={routing.strong} onChange={(m) => update({ strong: m })} variant="input" direction="down" allowEmpty={tr('The default model (above)')} />
      </div>
      <div className="tool-toggle" style={{ padding: 0, border: 0 }}>
        <div className="grow">
          <div className="t">{tr('Start new chats on Auto')}</div>
          <div className="s">{tr('Bots with their own model keep it.')}</div>
        </div>
        <Toggle label={tr('Start new chats on Auto')} on={routing.newChats} onChange={(v) => update({ newChats: v })} />
      </div>
    </section>
  );
}

function PhoneSettings() {
  const { toast } = useApp();
  const [phone, setPhone] = useState<{ lan: boolean; urls: string[] }>();
  const [permission, setPermission] = useState(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  useEffect(() => {
    api.phone().then(setPhone, (err) => toast(err.message));
  }, [toast]);
  const url = phone?.urls[0];
  return (
    <>
      <section className="settings-section card">
        <h2>{tr('Use Mitzi on your phone')}</h2>
        {!phone ? (
          <Loader2 className="spin muted" size={18} />
        ) : url ? (
          <div className="phone-pair">
            <div className="phone-qr" aria-label={tr('QR code for your phone')} dangerouslySetInnerHTML={{ __html: qrSvg(url, 5) }} />
            <div>
              <ol className="steps-list">
                <li>{tr('On your phone, connect to the same Wi-Fi as this computer.')}</li>
                <li>{tr('Scan the code with the camera, or open the address below.')}</li>
                <li>
                  {tr('To keep Mitzi on your home screen:')}{' '}<b>{tr('Share → Add to Home Screen')}</b> {tr('on iPhone, or')}{' '}<b>{tr('⋮ → Add to Home screen')}</b> {tr('on Android.')}
                </li>
              </ol>
              <code className="phone-url">{url}</code>
              {phone.urls.length > 1 && <p className="muted small">{tr('Other addresses of this computer:')}{' '}{phone.urls.slice(1).map((u) => new URL(u).host).join(', ')}</p>}
              <p className="muted small">{tr('The address includes your private access token: anyone on this network who has it can use Mitzi as you.')}</p>
            </div>
          </div>
        ) : (
          <>
            <p className="muted small" style={{ marginTop: 0 }}>
              {tr('Mitzi only accepts connections from this computer right now. To open it on your phone (on the same Wi-Fi), start it with:')}
            </p>
            <pre className="trigger-example">mitzi web --lan</pre>
            <p className="muted small">
              {tr('It then shows a QR code here and in the terminal. Use it on networks you trust, like your home Wi-Fi. Away from home, a private network like Tailscale gives the same access securely.')}
            </p>
          </>
        )}
      </section>
      <section className="settings-section card">
        <h2>{tr('Notifications')}</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          {tr('A system notification when a chat finishes or needs your approval while you’re in another window or app.')}
          {!window.isSecureContext && tr(' Browsers allow notifications only over https or on this computer (localhost).')}
        </p>
        {permission === 'granted' ? (
          <span className="badge ok">{tr('On')}</span>
        ) : permission === 'denied' ? (
          <p className="small">{tr('Notifications are blocked for this site in your browser’s settings.')}</p>
        ) : permission === 'unsupported' || !window.isSecureContext ? (
          <p className="small muted">{tr('Not available here.')}</p>
        ) : (
          <button className="btn btn-sm" onClick={() => void Notification.requestPermission().then(setPermission)}>
            <Bell size={14} /> {tr('Turn on notifications')}
          </button>
        )}
      </section>
    </>
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
          <Download size={17} /> {tr('Import from other AIs')}
        </h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          {tr('Bring what ChatGPT, Claude or Gemini know about you, and your chat history from ChatGPT or Claude.')}
        </p>
        <button className="btn" onClick={() => setImporting(true)}>
          <MessagesSquare size={15} /> {tr('Import memories or chats…')}
        </button>
        {importing && <ImportModal onClose={() => setImporting(false)} />}
      </section>
      <section className="settings-section card">
        <h2>{tr('Your data')}</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          {tr('Everything stays on this computer: settings and API keys in')}{' '}<code>config.json</code>{tr(', and chats, projects, bots, artifacts, memory banks and generated media under')}{' '}<code>data</code>{tr('. Back up this folder to keep it all.')}
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
                () => toast(tr('Couldn’t copy')),
              )
            }
          >
            {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? tr('Copied') : tr('Copy path')}
          </button>
        </div>
      </section>
      <section className="settings-section card">
        <h2>{tr('About')}</h2>
        <p className="small" style={{ margin: 0 }}>
          {tr('Mitzi')}{' '}<strong>v{settings.version}</strong> {tr('· settings are shared with the')}{' '}<code>mitzi</code> {tr('command-line tool.')}
        </p>
        <p className="muted small" style={{ marginBottom: 0 }}>
          {tr('Updates:')}{' '}<a href={href({ page: 'settings', section: 'updates' })}>{tr('check for a new version')}</a>.
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
      <h2>{tr('Memory engine')}</h2>
      <div className="field">
        <span className="field-label">{tr('Memory engine')}</span>
        <div className="segmented" style={{ alignSelf: 'flex-start' }}>
          <button className={settings.memoryBackend === 'builtin' ? 'active' : ''} onClick={() => save({ memoryBackend: 'builtin' })}>
            {tr('Built-in')}
          </button>
          <button className={settings.memoryBackend === 'hindsight' ? 'active' : ''} onClick={() => save({ memoryBackend: 'hindsight' })}>
            {tr('Hindsight server')}
          </button>
        </div>
        <span className="field-hint">
          {settings.memoryBackend === 'builtin'
            ? tr('Banks are stored in ~/.mitzi/data/banks and use your fast model to extract and consolidate memories.')
            : tr('Banks live on a Hindsight server, which runs its own extraction, embeddings and reranking.')}
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
          <span className="field-label">{tr('Embedding model (optional)')}</span>
          <div className="row">
            <input className="input mono" placeholder={tr('e.g. openai/text-embedding-3-small')} value={embedding} onChange={(e) => setEmbedding(e.target.value)} />
            <button className="btn" disabled={embedding.trim() === settings.embeddingModel}>
              {tr('Save')}
            </button>
          </div>
          <span className="field-hint">
            {tr('Adds semantic search to recall, using an OpenAI-compatible embeddings endpoint on your API provider. Leave empty to recall with keywords, entities and time only.')}
          </span>
        </form>
      ) : (
        <>
          <div className="field">
            <span className="field-label">{tr('Server URL')}</span>
            <div className="row">
              <input className="input mono" placeholder="http://localhost:8888" value={url} onChange={(e) => setUrl(e.target.value)} />
              <button className="btn" disabled={url.trim() === settings.hindsightUrl} onClick={() => save({ hindsightUrl: url.trim() }, 'Hindsight server saved')}>
                {tr('Save')}
              </button>
            </div>
            <span className="field-hint">
              {tr('Run one with')}{' '}<code>docker run -p 8888:8888 -p 9999:9999 -e HINDSIGHT_API_LLM_API_KEY=… ghcr.io/vectorize-io/hindsight:latest</code>{tr('. See')}{' '}
              <a href="https://github.com/vectorize-io/hindsight" target="_blank" rel="noreferrer">
                github.com/vectorize-io/hindsight
              </a>
              .
            </span>
          </div>
          <div className="field">
            <span className="field-label">{tr('API key (if your server needs one)')}</span>
            <div className="row">
              <input
                className="input mono"
                type="password"
                autoComplete="off"
                placeholder={settings.hasHindsightKey ? tr('Saved; enter a new key to replace it') : tr('Optional')}
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
                {tr('Save')}
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
              {testing === 'ok' ? <Check size={14} /> : null} {testing === 'busy' ? tr('Testing…') : testing === 'ok' ? tr('Connected') : tr('Test connection')}
            </button>
          </div>
        </>
      )}

      <div className="field" style={{ marginTop: 18, marginBottom: 0 }}>
        <span className="field-label">{tr('Memories recalled per message')}</span>
        <select className="select" style={{ maxWidth: 260 }} value={settings.recallTokens} onChange={(e) => void save({ recallTokens: Number(e.target.value) })}>
          {[600, 1200, 2000, 4000].map((n) => (
            <option key={n} value={n}>
              {tr('Up to ~')}{n.toLocaleString()} tokens{n === 1200 ? tr(' (default)') : ''}
            </option>
          ))}
        </select>
      </div>
    </section>
    <section className="settings-section card">
      <h2>{tr('Memory banks')}</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        {tr('Browse, edit and teach each bot’s memory, or bring memories over from ChatGPT, Claude and Gemini.')}
      </p>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <a className="btn" href={href({ page: 'memory' })}>
          <Brain size={15} /> {tr('Open memory banks')}
        </a>
        <button className="btn" onClick={() => setImporting(true)}>
          <Download size={15} /> {tr('Import from other AIs')}
        </button>
      </div>
      {importing && <ImportModal initialTab="memory" onClose={() => setImporting(false)} />}
    </section>
    </>
  );
}

const STEP_LABEL: Record<UpdateStep, string> = { download: tr('Download the new version'), install: tr('Install dependencies'), build: tr('Build') };

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
        <h2>{tr('Restarting Mitzi…')}</h2>
        <p className="muted small">{tr('The new version is starting. This page reloads by itself in a few seconds.')}</p>
      </section>
    );
  }

  return (
    <>
      <section className="settings-section card">
        <div className="update-head">
          <div className="grow">
            <div className="update-version">
              {tr('Mitzi')}{' '}<strong>v{u?.current.version ?? settings.version}</strong>
              {u?.current.commit && <span className="muted small"> · {u.current.commit} · {date(u.current.date)}</span>}
            </div>
            <div className="small">
              {!u ? (
                <span className="muted">{tr('Checking…')}</span>
              ) : !u.supported ? (
                <span className="update-warn">
                  <AlertTriangle size={13} /> {u.reason}
                </span>
              ) : u.behind ? (
                <span className="accent">
                  <ArrowUpCircle size={13} /> {u.latest && u.latest.version !== u.current.version ? tr('Version {0} is available', u.latest.version) : tr('An update is available')} ({plural(u.behind, '1 change', '{0} changes')}, {date(u.latest?.date)})
                </span>
              ) : (
                <span className="ok-text">
                  <Check size={13} /> {tr('You have the latest version')}
                </span>
              )}
              {u && <span className="muted"> {tr('· checked')}{' '}{new Date(u.checkedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>}
            </div>
          </div>
          <button className="btn btn-sm" disabled={checking || phase === 'updating'} onClick={() => void check()}>
            {checking ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} {tr('Check now')}
          </button>
        </div>

        {u?.supported && u.behind > 0 && phase === 'idle' && (
          <>
            <div className="update-changes">
              <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>
                {tr('What’s new')}
              </div>
              <ul>
                {u.commits.slice(0, 12).map((c) => (
                  <li key={c.sha}>
                    {c.subject} <span className="muted small">{date(c.date)}</span>
                  </li>
                ))}
                {u.commits.length > 12 && <li className="muted">{tr('…and')}{' '}{u.behind - 12} more</li>}
              </ul>
            </div>
            <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
              <button className="btn btn-primary" onClick={() => void run()}>
                <ArrowUpCircle size={15} /> {u.canRestart ? tr('Update and restart') : tr('Update')}
              </button>
              <span className="muted small">
                {u.canRestart ? tr('Takes a minute or two. Replies in progress stop when Mitzi restarts.') : tr('After updating, restart Mitzi to use the new version.')}
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
                  {st === 'skipped' && <span className="muted small"> {tr('· no changes')}</span>}
                </div>
              );
            })}
            {log.length > 0 && (
              <details className="update-log">
                <summary className="small muted">{tr('Details')}</summary>
                <pre>{log.slice(-60).join('\n')}</pre>
              </details>
            )}
          </div>
        )}
        {phase === 'error' && <div className="error-box" style={{ marginTop: 12, whiteSpace: 'pre-wrap' }}>{error}</div>}
        {phase === 'restart-required' && (
          <div className="card small" style={{ marginTop: 12, padding: 12 }}>
            {tr('Updated. Close Mitzi and start it again (')}<code>mitzi ui</code>{tr(') to use the new version.')}
          </div>
        )}
      </section>

      <section className="settings-section card">
        <div className="setting-row" style={{ borderTop: 0, paddingTop: 0 }}>
          <div>
            <div>{tr('Check for updates automatically')}</div>
            <div className="muted small">{tr('Mitzi looks for a new version twice a day and shows “Update available” in the sidebar. It never updates without asking.')}</div>
          </div>
          <Toggle on={settings.autoCheckUpdates} label={tr('Check for updates automatically')} onChange={(v) => void save({ autoCheckUpdates: v })} />
        </div>
        <p className="muted small" style={{ marginBottom: 0 }}>
          {tr('From a terminal:')}{' '}<code>mitzi update</code>.
        </p>
      </section>
    </>
  );
}
