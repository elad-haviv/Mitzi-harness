// Share a chat or artifact as a read-only link (a snapshot, optionally expiring), or download it as a web page.
import { Check, Copy, Download, Link2, Loader2, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, ShareView } from '../api';
import { relativeTime, useApp } from '../state';
import { Modal } from './ui';
import { locale, plural, tr } from '../i18n';

const EXPIRY = [
  { days: 1, label: tr('1 day') },
  { days: 7, label: tr('7 days') },
  { days: 30, label: tr('30 days') },
  { days: 0, label: tr('Never') },
];

/** Saves a page as an .html file. */
function downloadPage(title: string, html: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  a.download = `${title.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-|-$/g, '') || 'mitzi'}.html`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function ShareDialog({ kind, targetId, title, page, onClose }: { kind: 'chat' | 'artifact'; targetId: string; title: string; page: () => Promise<string>; onClose(): void }) {
  const { toast } = useApp();
  const [shares, setShares] = useState<ShareView[]>();
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState<'link' | 'download' | null>(null);
  const [copied, setCopied] = useState<string>();
  useEffect(() => {
    api.shares(targetId).then(setShares, (err) => toast(err.message));
  }, [targetId, toast]);
  const full = (s: ShareView) => `${location.origin}${s.url}`;
  const copy = (s: ShareView) => {
    navigator.clipboard.writeText(full(s)).catch(() => {});
    setCopied(s.id);
    setTimeout(() => setCopied(undefined), 1500);
  };
  const create = async () => {
    setBusy('link');
    try {
      const s = await api.createShare({ kind, targetId, title, html: await page(), expiresInDays: days });
      setShares((list) => [s, ...(list ?? [])]);
      copy(s);
      toast(tr('Link created and copied'), 'info');
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const download = async () => {
    setBusy('download');
    try {
      downloadPage(title, await page());
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Modal title={tr('Share “{0}”', title)} onClose={onClose}>
      <p className="muted small" style={{ marginTop: 0 }}>
        {tr('A read-only page of the')}{' '}{kind} {tr('as it is now (later changes aren’t included). Anyone with the link can open it, as long as they can reach this computer: on your network (')}<code>mitzi web --lan</code>{tr(') or through a tunnel.')}
      </p>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <label className="row small" style={{ gap: 6 }}>
          {tr('Expires after')}
          <select className="select" style={{ width: 'auto' }} value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {EXPIRY.map((x) => (
              <option key={x.days} value={x.days}>
                {x.label}
              </option>
            ))}
          </select>
        </label>
        <button className="btn btn-primary btn-sm" onClick={() => void create()} disabled={!!busy}>
          {busy === 'link' ? <Loader2 size={14} className="spin" /> : <Link2 size={14} />} {tr('Create link')}
        </button>
        <button className="btn btn-sm" onClick={() => void download()} disabled={!!busy} title={tr('One HTML file you can keep, email or open anywhere')}>
          {busy === 'download' ? <Loader2 size={14} className="spin" /> : <Download size={14} />} {tr('Download as web page')}
        </button>
      </div>
      {shares && shares.length > 0 && (
        <>
          <div className="panel-subhead" style={{ marginTop: 18 }}>
            {tr('Links')}
          </div>
          {shares.map((s) => {
            const expired = s.expiresAt && Date.parse(s.expiresAt) < Date.now();
            return (
              <div key={s.id} className="share-row">
                <a className="mono small share-url" href={s.url} target="_blank" rel="noreferrer">
                  {full(s)}
                </a>
                <span className="muted small">
                  {relativeTime(s.createdAt)} · {expired ? tr('expired') : s.expiresAt ? tr('until {0}', new Date(s.expiresAt).toLocaleDateString(locale)) : tr('no expiry')} · {plural(s.views, '1 view', '{0} views')}
                </span>
                <button className="icon-btn sm" title={tr('Copy link')} aria-label={tr('Copy link')} onClick={() => copy(s)}>
                  {copied === s.id ? <Check size={14} /> : <Copy size={14} />}
                </button>
                <button
                  className="icon-btn sm"
                  title={tr('Turn off this link')}
                  aria-label={tr('Turn off this link')}
                  onClick={() => void api.deleteShare(s.id).then(() => setShares((list) => list?.filter((x) => x.id !== s.id)), (err) => toast(err.message))}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })}
        </>
      )}
    </Modal>
  );
}
