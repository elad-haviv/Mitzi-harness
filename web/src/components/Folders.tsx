import { ArrowUp, Check, ChevronRight, Eye, EyeOff, Folder, FolderGit2, FolderPlus, GitBranch, HardDrive, Home, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, DirListing, ProjectView } from '../api';
import { useApp } from '../state';
import { Modal } from './ui';
import { tr } from '../i18n';

/** Browses folders on this computer (through the local Mitzi server) and picks one. */
export function FolderPicker({
  title = 'Choose a folder',
  action = 'Use this folder',
  start,
  onPick,
  onClose,
}: {
  title?: string;
  action?: string;
  start?: string;
  onPick(path: string): void | Promise<void>;
  onClose(): void;
}) {
  const { toast } = useApp();
  const [listing, setListing] = useState<DirListing>();
  const [typed, setTyped] = useState('');
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [naming, setNaming] = useState<string | null>(null);

  const open = useCallback(
    async (path?: string) => {
      try {
        const l = await api.dirs(path, hidden);
        setListing(l);
        setTyped(l.path);
      } catch (err) {
        toast((err as Error).message);
      }
    },
    [hidden, toast],
  );
  useEffect(() => void open(listing?.path ?? start), [hidden]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = async () => {
    if (!listing) return;
    setBusy(true);
    try {
      await onPick(listing.path);
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Breadcrumbs from the path's parts.
  const sep = listing?.path.includes('\\') ? '\\' : '/';
  const parts = listing?.path.split(/[\\/]/).filter(Boolean) ?? [];
  const crumbs = parts.map((name, i) => ({ name, path: (sep === '/' ? '/' : '') + parts.slice(0, i + 1).join(sep) + (sep === '\\' && i === 0 ? '\\' : '') }));

  return (
    <Modal
      title={title}
      onClose={onClose}
      wide
      footer={
        <>
          <span className="muted small grow" style={{ textAlign: 'left' }}>
            {listing?.git && (
              <>
                <GitBranch size={12} /> {tr('Git repository')}
              </>
            )}
          </span>
          <button className="btn btn-ghost" onClick={onClose}>
            {tr('Cancel')}
          </button>
          <button className="btn btn-primary" disabled={!listing || busy} onClick={() => void pick()}>
            {busy ? <Loader2 size={14} className="spin" /> : <Check size={14} />} {action}
          </button>
        </>
      }
    >
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void open(typed);
        }}
      >
        <button type="button" className="icon-btn" disabled={!listing?.parent} onClick={() => void open(listing?.parent)} aria-label={tr('Up one folder')} title={tr('Up one folder')}>
          <ArrowUp size={16} />
        </button>
        <input className="input mono" value={typed} onChange={(e) => setTyped(e.target.value)} aria-label={tr('Folder path')} spellCheck={false} />
        <button type="button" className="icon-btn" onClick={() => setHidden((h) => !h)} aria-label={hidden ? tr('Hide hidden folders') : tr('Show hidden folders')} title={hidden ? tr('Hide hidden folders') : tr('Show hidden folders')}>
          {hidden ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </form>
      <div className="crumbs">
        {crumbs.map((c, i) => (
          <span key={c.path}>
            {i > 0 && <ChevronRight size={12} className="muted" />}
            <button className="link-btn" onClick={() => void open(c.path)}>
              {c.name}
            </button>
          </span>
        ))}
      </div>
      <div className="folder-browser">
        <nav className="folder-places" aria-label={tr('Places')}>
          {listing?.places.map((p) => (
            <button key={p.path} className={`folder-place${listing.path === p.path ? ' on' : ''}`} onClick={() => void open(p.path)}>
              {p.label === 'Home' ? <Home size={14} /> : /^[A-Z]:$|Computer/.test(p.label) ? <HardDrive size={14} /> : <Folder size={14} />}
              {p.label}
            </button>
          ))}
        </nav>
        <div className="folder-list" role="listbox" aria-label={tr('Folders')}>
          {!listing && <div className="muted small" style={{ padding: 12 }}>{tr('Loading…')}</div>}
          {listing && !listing.dirs.length && <div className="muted small" style={{ padding: 12 }}>{tr('No folders here.')}</div>}
          {listing?.dirs.map((d) => (
            <button key={d.path} className="folder-row" onClick={() => void open(d.path)} title={d.path}>
              {d.git ? <FolderGit2 size={16} className="accent" /> : <Folder size={16} className="muted" />}
              <span className="grow">{d.name}</span>
              <ChevronRight size={14} className="muted" />
            </button>
          ))}
          {listing &&
            (naming === null ? (
              <button className="folder-row muted" onClick={() => setNaming('')}>
                <FolderPlus size={16} /> {tr('New folder…')}
              </button>
            ) : (
              <form
                className="folder-row"
                onSubmit={async (e) => {
                  e.preventDefault();
                  try {
                    const l = await api.mkdir(listing.path, naming);
                    setNaming(null);
                    setListing(l);
                    setTyped(l.path);
                  } catch (err) {
                    toast((err as Error).message);
                  }
                }}
              >
                <FolderPlus size={16} />
                <input className="input input-sm" autoFocus placeholder={tr('Folder name')} value={naming} onChange={(e) => setNaming(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setNaming(null)} />
              </form>
            ))}
        </div>
      </div>
    </Modal>
  );
}

/** Clones a remote repository into a folder and makes it a project. */
export function CloneRepoModal({ onClose, onCloned }: { onClose(): void; onCloned(p: ProjectView): void }) {
  const { toast } = useApp();
  const [url, setUrl] = useState('');
  const [branch, setBranch] = useState('');
  const [token, setToken] = useState('');
  const [parent, setParent] = useState('');
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);

  const clone = async () => {
    setBusy(true);
    try {
      onCloned(await api.cloneRepo({ url: url.trim(), branch: branch.trim() || undefined, token: token.trim() || undefined, parent: parent || undefined }));
    } catch (err) {
      toast((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <>
      <Modal
        title={tr('Connect a repository')}
        onClose={() => !busy && onClose()}
        footer={
          <>
            <button className="btn btn-ghost" disabled={busy} onClick={onClose}>
              {tr('Cancel')}
            </button>
            <button className="btn btn-primary" disabled={!url.trim() || busy} onClick={() => void clone()}>
              {busy ? (
                <>
                  <Loader2 size={14} className="spin" /> {tr('Cloning…')}
                </>
              ) : (
                tr('Clone and open')
              )}
            </button>
          </>
        }
      >
        <p className="muted small" style={{ marginTop: 0 }}>
          {tr('Mitzi clones the repository to this computer and opens it as a project, so chats can read, edit and run code there (asking before changes).')}
        </p>
        <label className="field">
          <span className="field-label">{tr('Repository')}</span>
          <input
            className="input mono"
            autoFocus
            placeholder="https://github.com/owner/repo  ·  owner/repo  ·  git@gitlab.com:team/app.git"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && url.trim() && void clone()}
          />
        </label>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <label className="field" style={{ flex: 1, minWidth: 160 }}>
            <span className="field-label">
              {tr('Branch')}{' '}<span className="muted">{tr('(optional)')}</span>
            </span>
            <input className="input mono" placeholder={tr('default branch')} value={branch} onChange={(e) => setBranch(e.target.value)} />
          </label>
          <label className="field" style={{ flex: 2, minWidth: 220 }}>
            <span className="field-label">
              {tr('Access token')}{' '}<span className="muted">{tr('(private repositories)')}</span>
            </span>
            <input className="input mono" type="password" autoComplete="off" placeholder={tr('ghp_… or glpat-…')} value={token} onChange={(e) => setToken(e.target.value)} />
          </label>
        </div>
        <span className="field-hint" style={{ marginTop: -6, display: 'block' }}>
          {tr('A GitHub fine-grained token with Contents read access (read and write to let the bot push) or a GitLab token. It\'s stored only on this computer and used for clone and pull. Your own git credentials and SSH keys work too.')}
        </span>
        <div className="field" style={{ marginTop: 14, marginBottom: 0 }}>
          <span className="field-label">{tr('Clone into')}</span>
          <div className="row">
            <code className="grow small" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {parent || '~/.mitzi/repos'}
            </code>
            <button className="btn btn-sm" onClick={() => setChoosing(true)}>
              {tr('Change…')}
            </button>
          </div>
        </div>
      </Modal>
      {choosing && (
        <FolderPicker
          title={tr('Clone into which folder?')}
          action="Clone here"
          onClose={() => setChoosing(false)}
          onPick={(p) => {
            setParent(p);
            setChoosing(false);
          }}
        />
      )}
    </>
  );
}
