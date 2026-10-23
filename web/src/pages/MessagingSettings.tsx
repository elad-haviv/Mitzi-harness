// Settings → Messaging: reach Mitzi through Telegram, Discord, Slack, WhatsApp or email. Each service describes
// its own setup (steps and fields); pairing, paired conversations and notifications work the same everywhere.
import { AtSign, Copy, Hash, Loader2, Mail, MessageCircle, MessagesSquare, Send, X } from 'lucide-react';
import { ReactNode, useEffect, useState } from 'react';
import { api, ChannelKind, ChannelView } from '../api';
import { Toggle } from '../components/ui';
import { href } from '../router';
import { useApp } from '../state';

export const CHANNEL_ICONS: Record<ChannelKind, ReactNode> = {
  telegram: <Send size={15} />,
  discord: <Hash size={15} />,
  slack: <MessagesSquare size={15} />,
  whatsapp: <MessageCircle size={15} />,
  email: <Mail size={15} />,
};

/** Steps use a little Markdown: `code`, **bold**, *italics* and [links](https://…). */
function Inline({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g);
  return (
    <>
      {parts.map((p, i) => {
        const code = /^`([^`]+)`$/.exec(p);
        if (code) return <code key={i}>{code[1]}</code>;
        const bold = /^\*\*([^*]+)\*\*$/.exec(p);
        if (bold) return <strong key={i}>{bold[1]}</strong>;
        const em = /^\*([^*]+)\*$/.exec(p);
        if (em) return <em key={i}>{em[1]}</em>;
        const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(p);
        if (link) {
          return (
            <a key={i} href={link[2]} target="_blank" rel="noreferrer">
              {link[1]}
            </a>
          );
        }
        return p;
      })}
    </>
  );
}

export function MessagingSettings({ initial }: { initial?: string }) {
  const { toast } = useApp();
  const [list, setList] = useState<ChannelView[]>();
  const [kind, setKind] = useState<ChannelKind>((initial as ChannelKind) || 'telegram');
  useEffect(() => {
    api.channels().then(setList, (err) => toast(err.message));
  }, [toast]);
  const current = list?.find((c) => c.kind === kind);
  // Pairing happens on the other service; keep the list fresh while this page is open.
  useEffect(() => {
    if (!current?.running) return;
    const timer = setInterval(() => api.channels().then(setList, () => {}), 3000);
    return () => clearInterval(timer);
  }, [current?.running]);
  if (!list) return <Loader2 className="spin muted" size={18} />;

  return (
    <>
      <div className="channel-tabs" role="tablist" aria-label="Messaging services">
        {list.map((c) => (
          <button key={c.kind} role="tab" aria-selected={c.kind === kind} className={`channel-tab${c.kind === kind ? ' on' : ''}`} onClick={() => setKind(c.kind)}>
            {CHANNEL_ICONS[c.kind]}
            <span>{c.label}</span>
            {c.running && <span className="channel-dot" aria-label="On" />}
          </button>
        ))}
      </div>
      {current && <ChannelSettingsView key={current.kind} channel={current} onChange={(next) => setList((all) => all?.map((c) => (c.kind === next.kind ? next : c)))} />}
    </>
  );
}

function ChannelSettingsView({ channel: c, onChange }: { channel: ChannelView; onChange(next: ChannelView): void }) {
  const { toast } = useApp();
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(c.fields.map((f) => [f.key, f.secret ? '' : String(c.values[f.key] ?? '')])));
  const [busy, setBusy] = useState(false);
  const update = async (body: Parameters<typeof api.updateChannel>[1], message?: string) => {
    setBusy(true);
    try {
      const next = await api.updateChannel(c.kind, body);
      onChange(next);
      if (next.error) toast(`${c.label}: ${next.error}`);
      else if (message) toast(message, 'info');
      return next;
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const dirty = c.fields.some((f) => (f.secret ? !!values[f.key]?.trim() : values[f.key] !== String(c.values[f.key] ?? '')));
  const webhook = c.webhookPath ? `${location.origin}${c.webhookPath}` : '';
  const pairLink = c.kind === 'telegram' && c.username ? `https://t.me/${c.username}?start=${c.pairingCode}` : undefined;

  return (
    <>
      <section className="settings-section card">
        <h2>Set up {c.label}</h2>
        {c.unsupported && <p className="danger-text small">{c.unsupported}</p>}
        <ol className="steps-list">
          {c.steps.map((s, i) => (
            <li key={i}>
              <Inline text={s} />
            </li>
          ))}
        </ol>
        {webhook && (
          <div className="field">
            <span className="field-label">Webhook address</span>
            <div className="row" style={{ gap: 8 }}>
              <code className="pairing-code grow" style={{ overflowWrap: 'anywhere' }}>
                {webhook}
              </code>
              <button className="btn btn-sm btn-ghost" onClick={() => void navigator.clipboard?.writeText(webhook).then(() => toast('Copied', 'info'), () => {})}>
                <Copy size={13} /> Copy
              </button>
            </div>
            <span className="muted small">{c.label} must be able to reach it: use your public address (a tunnel such as Cloudflare Tunnel or ngrok in front of Mitzi) in place of this one.</span>
          </div>
        )}
        <form
          className="channel-form"
          onSubmit={(e) => {
            e.preventDefault();
            void update({ config: values, enabled: true }, `${c.label} on`).then((next) => next && setValues((v) => Object.fromEntries(Object.entries(v).map(([k, x]) => [k, c.fields.find((f) => f.key === k)?.secret ? '' : x]))));
          }}
        >
          {c.fields.map((f) => (
            <label key={f.key} className="field">
              <span className="field-label">
                {f.label}
                {f.optional && <span className="muted small"> · optional</span>}
              </span>
              <input
                className={`input${f.secret ? ' mono' : ''}`}
                type={f.secret ? 'password' : 'text'}
                autoComplete="off"
                placeholder={f.secret && c.values[f.key] ? 'Saved · type a new one to replace it' : f.placeholder}
                value={values[f.key] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              />
            </label>
          ))}
          <div>
            <button className="btn btn-primary" disabled={!dirty || busy}>
              Save and turn on
            </button>
          </div>
        </form>
        <div className="tool-toggle" style={{ padding: 0, border: 0, marginTop: 14 }}>
          <div className="grow">
            <div className="t">
              {c.label} {c.running ? <span className="badge ok">on{c.username ? ` · ${c.username}` : ''}</span> : <span className="badge">off</span>}
            </div>
            <div className="s">{c.error ? <span className="danger-text">{c.error}</span> : 'Mitzi answers while it’s running on this computer.'}</div>
          </div>
          <Toggle label={c.label} on={c.enabled && c.running} onChange={(v) => void update({ enabled: v }, v ? `${c.label} on` : `${c.label} off`)} />
        </div>
      </section>
      {c.running && (
        <section className="settings-section card">
          <h2>Pair a conversation</h2>
          <p className="muted small" style={{ marginTop: 0 }}>
            Send this to Mitzi on {c.label}
            {pairLink && (
              <>
                {' '}
                (<a href={pairLink} target="_blank" rel="noreferrer">open @{c.username}</a> with the message ready)
              </>
            )}
            . Each code works once; only paired conversations can use Mitzi.
          </p>
          <div className="row" style={{ gap: 8 }}>
            <code className="pairing-code">{c.pairHint}</code>
            <button className="btn btn-sm btn-ghost" onClick={() => void update({ newCode: true })}>
              New code
            </button>
          </div>
          <div className="panel-subhead" style={{ marginTop: 16 }}>
            Paired
          </div>
          {c.links.length ? (
            c.links.map((l) => (
              <div key={l.address} className="file-row">
                <AtSign size={14} className="muted" />
                <span className="name">{l.name}</span>
                {l.mitziChatId && (
                  <a className="small" href={href({ page: 'chat', id: l.mitziChatId })}>
                    Open chat
                  </a>
                )}
                <button className="icon-btn sm" aria-label={`Unpair ${l.name}`} title="Unpair" onClick={() => void update({ unlink: l.address }, `${l.name} unpaired`)}>
                  <X size={13} />
                </button>
              </div>
            ))
          ) : (
            <p className="muted small">None yet.</p>
          )}
          <div className="tool-toggle" style={{ padding: 0, border: 0, marginTop: 12 }}>
            <div className="grow">
              <div className="t">Notifications</div>
              <div className="s">Workflow approvals and finished scheduled tasks</div>
            </div>
            <Toggle label="Notifications" on={c.notify} onChange={(v) => void update({ notify: v })} />
          </div>
        </section>
      )}
    </>
  );
}
