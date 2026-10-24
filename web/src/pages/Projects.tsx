import { extractText, isDocument } from '../documents';
import { ProjectUsage } from './Insights';
import { BadgeCheck, BookOpen, FileText, FolderGit2, FolderOpen, FolderSearch, GitBranch, Loader2, RefreshCw, Layers, MessageSquare, MoreHorizontal, Pencil, Plus, ShieldCheck, SquarePen, Terminal, Trash2, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, ArtifactListItem, ChatListItem, PermissionMode, ProjectView, RepoStatus } from '../api';
import { CloneRepoModal, FolderPicker } from '../components/Folders';
import { ArtifactIcon, TYPE_LABEL } from '../components/Artifacts';
import { Empty, Menu, Modal, readFileAsText, useConfirm } from '../components/ui';
import { href, navigate } from '../router';
import { formatTokens, relativeTime, useApp } from '../state';
import { plural, tr } from '../i18n';

export function ProjectsPage() {
  const { projects, refreshProjects, toast } = useApp();
  const [creating, setCreating] = useState(false);
  const [dialog, setDialog] = useState<'folder' | 'repo' | null>(null);
  const [deleting, setDeleting] = useState<ProjectView | null>(null);
  // Chat counts change as you chat; show current ones.
  useEffect(() => void refreshProjects(), [refreshProjects]);
  const opened = async (p: ProjectView) => {
    await refreshProjects();
    setDialog(null);
    navigate({ page: 'project', id: p.id });
  };
  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-header">
          <div>
            <h1 className="page-title">{tr('Projects')}</h1>
            <p className="page-subtitle">{tr('Group chats with shared instructions and knowledge, or point Mitzi at a folder to work on code.')}</p>
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="btn" onClick={() => setDialog('folder')}>
              <FolderSearch size={16} /> {tr('Open folder')}
            </button>
            <button className="btn" onClick={() => setDialog('repo')}>
              <GitBranch size={16} /> {tr('Connect repository')}
            </button>
            <button className="btn btn-primary" onClick={() => setCreating(true)}>
              <Plus size={16} /> {tr('New project')}
            </button>
          </div>
        </div>
        {dialog === 'folder' && (
          <FolderPicker
            title={tr('Open a folder')}
            action="Work in this folder"
            onClose={() => setDialog(null)}
            onPick={async (path) => {
              try {
                await opened(await api.openFolder(path));
              } catch (err) {
                toast((err as Error).message);
              }
            }}
          />
        )}
        {dialog === 'repo' && <CloneRepoModal onClose={() => setDialog(null)} onCloned={(p) => void opened(p)} />}
        {deleting && <DeleteProjectModal project={deleting} onClose={() => setDeleting(null)} />}
        {projects.length === 0 ? (
          <Empty
            icon={<FolderOpen size={22} />}
            title={tr('No projects yet')}
            action={
              <button className="btn btn-primary" onClick={() => setCreating(true)}>
                <Plus size={16} /> {tr('Create a project')}
              </button>
            }
          >
            {tr('Projects keep related chats together. Every chat in a project shares its instructions and knowledge files.')}
          </Empty>
        ) : (
          <div className="grid">
            {projects.map((p) => (
              <a key={p.id} className="tile" href={href({ page: 'project', id: p.id })}>
                <div className="tile-actions">
                  <button
                    className="icon-btn sm"
                    aria-label={tr('Delete {0}', p.name)}
                    title={tr('Delete project')}
                    onClick={(e) => {
                      e.preventDefault();
                      setDeleting(p);
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <div className="row" style={{ gap: 10 }}>
                  <div className="artifact-icon" style={{ width: 36, height: 36, borderRadius: 10 }}>
                    {p.repo ? <FolderGit2 size={17} /> : p.folder ? <Terminal size={17} /> : <FolderOpen size={17} />}
                  </div>
                  <div className="tile-title">{p.name}</div>
                </div>
                <div className="tile-desc">{p.description || <span className="muted">{tr('No description')}</span>}</div>
                <div className="tile-foot">
                  <span>
                    <MessageSquare size={12} /> {plural(p.chatCount, '1 chat', '{0} chats')}
                  </span>
                  {p.files.length > 0 && (
                    <span>
                      · <BookOpen size={12} /> {plural(p.files.length, '1 file', '{0} files')}
                    </span>
                  )}
                  {p.folder && <span className="badge ok">{tr('Coding')}</span>}
                  <span style={{ marginLeft: 'auto' }}>{relativeTime(p.updatedAt)}</span>
                </div>
              </a>
            ))}
          </div>
        )}
      </div>
      {creating && (
        <ProjectForm
          onClose={() => setCreating(false)}
          onSaved={(p) => {
            void refreshProjects();
            navigate({ page: 'project', id: p.id });
          }}
        />
      )}
    </div>
  );
}

function ProjectForm({ project, onClose, onSaved }: { project?: ProjectView; onClose(): void; onSaved(p: ProjectView): void }) {
  const { toast } = useApp();
  const [name, setName] = useState(project?.name ?? '');
  const [description, setDescription] = useState(project?.description ?? '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      onSaved(project ? await api.updateProject(project.id, { name, description }) : await api.createProject({ name, description }));
      onClose();
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={project ? tr('Edit project') : tr('New project')}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            {tr('Cancel')}
          </button>
          <button className="btn btn-primary" disabled={!name.trim() || busy} onClick={save}>
            {project ? tr('Save') : tr('Create project')}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void save();
        }}
      >
        <label className="field">
          <span className="field-label">{tr('Name')}</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={tr('e.g. Thesis research')} autoFocus />
        </label>
        <label className="field">
          <span className="field-label">{tr('Description')}</span>
          <textarea className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} placeholder={tr('What is this project about?')} rows={3} />
        </label>
      </form>
    </Modal>
  );
}

const MODE_INFO: Record<PermissionMode, string> = {
  default: tr('Ask before editing files, running commands or fetching URLs'),
  acceptEdits: tr('Edit files freely, ask before commands and network'),
  sensitive: tr('Work freely, ask only before risky actions'),
  plan: tr('Read-only: research and propose a plan'),
  yolo: tr('Never ask (use with care)'),
};

export function ProjectPage({ id }: { id: string }) {
  const { projects, refreshProjects, refreshChats, toast } = useApp();
  const project = projects.find((p) => p.id === id);
  const [chats, setChats] = useState<ChatListItem[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactListItem[]>([]);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const [folder, setFolder] = useState(project?.folder ?? '');
  const [browsing, setBrowsing] = useState(false);
  const [linking, setLinking] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [confirmNode, confirm] = useConfirm();

  useEffect(() => {
    api.chats(id).then(setChats, () => {});
    api.artifacts({ projectId: id }).then(setArtifacts, () => {});
  }, [id]);
  useEffect(() => setFolder(project?.folder ?? ''), [project?.folder]);

  if (!project) {
    return (
      <div className="page">
        <div className="page-inner muted">{tr('Loading project…')}</div>
      </div>
    );
  }

  const update = async (patch: Parameters<typeof api.updateProject>[1]) => {
    try {
      await api.updateProject(project.id, patch);
      await refreshProjects();
    } catch (err) {
      toast((err as Error).message);
    }
  };

  const upload = async (files: FileList) => {
    for (const f of Array.from(files)) {
      try {
        // Documents (PDF, Word, Excel, PowerPoint) become text; other files must be text already.
        const text = isDocument(f.name) ? (await extractText(f)).text : await readFileAsText(f);
        if (text.includes('\u0000')) throw new Error(tr('{0} isn\'t a file Mitzi can read. Add text, PDF, Word, Excel or PowerPoint files.', f.name));
        await api.addProjectFile(project.id, f.name, text);
      } catch (err) {
        toast((err as Error).message);
      }
    }
    await refreshProjects();
  };

  const knowledgeTokens = Math.ceil((project.knowledge?.chars ?? project.files.reduce((n, f) => n + f.size, 0)) / 4);
  const linked = project.knowledgeFolders ?? [];

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-header">
          <div style={{ minWidth: 0 }}>
            <a className="small muted" href={href({ page: 'projects' })}>
              {tr('← All projects')}
            </a>
            <h1 className="page-title" style={{ marginTop: 6 }}>
              {project.name}
            </h1>
            {project.description && <p className="page-subtitle">{project.description}</p>}
          </div>
          <Menu
            trigger={(_o, toggle) => (
              <button className="icon-btn" onClick={toggle} aria-label={tr('Project options')}>
                <MoreHorizontal size={18} />
              </button>
            )}
          >
            {(close) => (
              <>
                <button onClick={() => (close(), setEditing(true))}>
                  <Pencil size={15} /> {tr('Edit details')}
                </button>
                <hr />
                <button className="danger" onClick={() => (close(), setDeleting(true))}>
                  <Trash2 size={15} /> {tr('Delete project')}
                </button>
              </>
            )}
          </Menu>
        </div>

        <div className="project-layout">
          <div>
            <a className="big-composer-link" href={href({ page: 'new', projectId: project.id })}>
              <SquarePen size={18} />{' '}{tr('Start a new chat in {0}', project.name)}
            </a>
            <h2 className="card-title" style={{ marginBottom: 10 }}>
              {tr('Chats')}
            </h2>
            {chats.filter((c) => c.messageCount > 0).length === 0 ? (
              <div className="empty" style={{ padding: 32 }}>
                {tr('No chats in this project yet.')}
              </div>
            ) : (
              <div className="list">
                {chats
                  .filter((c) => c.messageCount > 0)
                  .map((c) => (
                    <a key={c.id} className="list-row" href={href({ page: 'chat', id: c.id })}>
                      <MessageSquare size={16} className="muted" />
                      <div className="grow">
                        <div className="t">{c.title}</div>
                        <div className="s">
                          {tr('{0} messages · {1}', c.messageCount, relativeTime(c.updatedAt))}
                        </div>
                      </div>
                    </a>
                  ))}
              </div>
            )}
            {artifacts.length > 0 && (
              <>
                <h2 className="card-title" style={{ margin: '28px 0 10px' }}>
                  <Layers size={16} /> {tr('Artifacts')}
                </h2>
                <div className="list">
                  {artifacts.slice(0, 8).map((a) => (
                    <a key={a.id} className="list-row" href={href({ page: 'artifact', id: a.id })}>
                      <span className="artifact-icon" style={{ width: 30, height: 30, borderRadius: 8 }}>
                        <ArtifactIcon type={a.type} size={15} />
                      </span>
                      <div className="grow">
                        <div className="t">{a.title}</div>
                        <div className="s">
                          {TYPE_LABEL[a.type]} · {relativeTime(a.updatedAt)}
                        </div>
                      </div>
                    </a>
                  ))}
                </div>
              </>
            )}
          </div>

          <div className="side-cards">
            <ProjectUsage projectId={project.id} />
            <div className="card">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <div className="card-title">
                  <Pencil size={15} /> {tr('Instructions')}
                </div>
                <button className="btn btn-sm" onClick={() => setInstructionsOpen(true)}>
                  {project.instructions ? tr('Edit') : tr('Add')}
                </button>
              </div>
              {project.instructions ? (
                <div className="instructions-preview" style={{ marginTop: 8 }}>
                  {project.instructions}
                </div>
              ) : (
                <p className="muted small" style={{ margin: '6px 0 0' }}>
                  {tr('Tell Mitzi how to behave in this project: tone, format, background, rules.')}
                </p>
              )}
            </div>

            <div className="card">
              <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                <div className="card-title">
                  <BookOpen size={15} /> {tr('Knowledge')}
                </div>
                <span className="row" style={{ gap: 6 }}>
                  <button className="btn btn-sm" onClick={() => setLinking(true)} title={tr('Use the text files in a folder on this computer, kept up to date')}>
                    <FolderSearch size={14} /> {tr('Folder')}
                  </button>
                  <button className="btn btn-sm" onClick={() => fileInput.current?.click()}>
                    <Upload size={14} /> {tr('Files')}
                  </button>
                </span>
                <input ref={fileInput} type="file" multiple hidden onChange={(e) => e.target.files && void upload(e.target.files).then(() => (e.target.value = ''))} />
              </div>
              <p className="muted small" style={{ margin: '6px 0 8px' }}>
                {project.knowledge?.searched ? (
                  <>
                    <b>{tr('{0} documents, ~{1} tokens', project.knowledge.docs.toLocaleString(), formatTokens(knowledgeTokens))}</b>{tr(': too much to send whole, so each message gets the passages most relevant to it, and Mitzi can search for more.')}
                  </>
                ) : (
                  <>
                    {tr('Documents included in every chat’s context')}
                    {knowledgeTokens > 0 && tr(' · ~{0} tokens', formatTokens(knowledgeTokens))}{tr('. Larger knowledge is searched per message instead.')}
                  </>
                )}
              </p>
              {linked.map((path) => (
                <div key={path} className="file-row">
                  <FolderOpen size={15} className="muted" />
                  <span className="name" title={path}>
                    {path.split(/[\\/]/).filter(Boolean).pop()}
                  </span>
                  <span className="muted small">{tr('linked folder')}</span>
                  <button className="icon-btn sm" aria-label={tr('Unlink {0}', path)} title={tr('Unlink (the folder itself isn’t touched)')} onClick={() => void update({ knowledgeFolders: linked.filter((p) => p !== path) })}>
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
              {linking && (
                <FolderPicker
                  title={tr('Link a folder as knowledge')}
                  action="Link this folder"
                  start={linked[0] ?? project.folder}
                  onClose={() => setLinking(false)}
                  onPick={async (path) => {
                    setLinking(false);
                    await update({ knowledgeFolders: [...linked, path] });
                  }}
                />
              )}
              {project.files.map((f) => (
                <div key={f.id} className="file-row">
                  <FileText size={15} className="muted" />
                  <span className="name" title={f.name}>
                    {f.name}
                  </span>
                  <span className="muted small">{formatTokens(Math.ceil(f.size / 4))}</span>
                  <button
                    className="icon-btn sm"
                    aria-label={tr('Remove {0}', f.name)}
                    onClick={() =>
                      api
                        .removeProjectFile(project.id, f.id)
                        .then(() => refreshProjects())
                        .catch((err) => toast(err.message))
                    }
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>

            <div className="card">
              <div className="card-title">
                <Terminal size={15} /> {tr('Coding workspace')}
              </div>
              <p className="muted small" style={{ margin: '6px 0 10px' }}>
                {tr('Link a local folder to give chats the coding tools: read, edit, search and run commands there.')}
              </p>
              <form
                className="row"
                onSubmit={(e) => {
                  e.preventDefault();
                  void update({ folder: folder.trim() || null });
                }}
              >
                <input className="input mono" placeholder={tr('~/code/my-app')} value={folder} onChange={(e) => setFolder(e.target.value)} />
                <button className="btn btn-sm" type="button" onClick={() => setBrowsing(true)}>
                  <FolderSearch size={14} /> {tr('Browse…')}
                </button>
                <button className="btn btn-sm" type="submit" disabled={folder === (project.folder ?? '')}>
                  {tr('Save')}
                </button>
              </form>
              {browsing && (
                <FolderPicker
                  start={project.folder}
                  onClose={() => setBrowsing(false)}
                  onPick={async (path) => {
                    setBrowsing(false);
                    setFolder(path);
                    await update({ folder: path });
                  }}
                />
              )}
              {project.folder && <RepoPanel project={project} />}
              {project.folder && (
                <div className="field" style={{ marginTop: 14, marginBottom: 0 }}>
                  <span className="field-label row" style={{ gap: 6 }}>
                    <ShieldCheck size={14} /> {tr('Permissions')}
                  </span>
                  <select className="select" value={project.permissionMode} onChange={(e) => void update({ permissionMode: e.target.value })}>
                    {(Object.keys(MODE_INFO) as PermissionMode[]).map((m) => (
                      <option key={m} value={m}>
                        {m === 'acceptEdits' ? tr('Accept edits') : m[0].toUpperCase() + m.slice(1)}: {MODE_INFO[m]}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {project.folder && <VerifyField project={project} onSave={(verify) => void update({ verify })} />}
            </div>
          </div>
        </div>
      </div>
      {editing && <ProjectForm project={project} onClose={() => setEditing(false)} onSaved={() => void refreshProjects()} />}
      {instructionsOpen && <InstructionsModal initial={project.instructions} onClose={() => setInstructionsOpen(false)} onSave={(text) => update({ instructions: text })} />}
      {confirmNode}
      {deleting && <DeleteProjectModal project={project} onClose={() => setDeleting(false)} onDeleted={() => navigate({ page: 'projects' })} />}
    </div>
  );
}

function InstructionsModal({ initial, onClose, onSave }: { initial: string; onClose(): void; onSave(text: string): Promise<void> }) {
  const [text, setText] = useState(initial);
  return (
    <Modal
      title={tr('Project instructions')}
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            {tr('Cancel')}
          </button>
          <button
            className="btn btn-primary"
            onClick={async () => {
              await onSave(text);
              onClose();
            }}
          >
            {tr('Save instructions')}
          </button>
        </>
      }
    >
      <p className="muted small" style={{ marginTop: 0 }}>
        {tr('These are added to the system prompt of every chat in this project.')}
      </p>
      <textarea
        className="textarea"
        rows={14}
        value={text}
        onChange={(e) => setText(e.target.value)}
        autoFocus
        placeholder={tr('e.g.\nYou are helping me write my thesis on urban heat islands.\nUse British English and cite sources in APA style.\nKeep answers under 300 words unless I ask for more.')}
      />
    </Modal>
  );
}

/** Branch, changes and sync state of a project folder that is a git repository. */
function RepoPanel({ project }: { project: ProjectView }) {
  const { toast } = useApp();
  const [status, setStatus] = useState<RepoStatus | null>();
  const [pulling, setPulling] = useState(false);
  const load = () => api.repoStatus(project.id).then(setStatus, () => setStatus(null));
  useEffect(() => void load(), [project.id, project.folder]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!status) return null;
  return (
    <div className="repo-panel">
      <div className="row" style={{ gap: 8 }}>
        <GitBranch size={14} />
        <strong>{status.branch ?? tr('detached')}</strong>
        <span className="muted small grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {status.remote ?? tr('No remote')}
        </span>
        <button className="icon-btn sm" aria-label={tr('Refresh')} title={tr('Refresh')} onClick={() => void load()}>
          <RefreshCw size={13} />
        </button>
      </div>
      <div className="repo-stats small">
        <span>{status.changed ? plural(status.changed, '1 changed file', '{0} changed files') : tr('No local changes')}</span>
        {status.ahead > 0 && <span>{tr('{0} to push', status.ahead)}</span>}
        {status.behind > 0 && <span>{tr('{0} to pull', status.behind)}</span>}
      </div>
      {status.remote && (
        <button
          className="btn btn-sm"
          disabled={pulling}
          onClick={async () => {
            setPulling(true);
            try {
              const r = await api.pull(project.id);
              toast(r.output.split('\n').slice(-1)[0] || tr('Pulled'), 'info');
              if (r.status) setStatus(r.status);
            } catch (err) {
              toast((err as Error).message);
            } finally {
              setPulling(false);
            }
          }}
        >
          {pulling ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} {tr('Pull latest')}
        </button>
      )}
    </div>
  );
}

/** Deletes a project; its chats move out of it unless the user chooses to delete them too. */
function DeleteProjectModal({ project: initial, onClose, onDeleted }: { project: ProjectView; onClose(): void; onDeleted?(): void }) {
  const { refreshProjects, refreshChats, toast } = useApp();
  const [project, setProject] = useState(initial);
  useEffect(() => {
    api.project(initial.id).then(setProject, () => {});
  }, [initial.id]);
  const [withChats, setWithChats] = useState(false);
  const [busy, setBusy] = useState(false);
  const del = async () => {
    setBusy(true);
    try {
      await api.deleteProject(project.id, withChats);
      await Promise.all([refreshProjects(), refreshChats()]);
      toast(tr('Deleted “{0}”', project.name), 'info');
      onClose();
      onDeleted?.();
    } catch (err) {
      toast((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={tr('Delete “{0}”?', project.name)}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            {tr('Cancel')}
          </button>
          <button className="btn btn-primary btn-danger-fill" disabled={busy} onClick={() => void del()} autoFocus>
            {busy ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />} {tr('Delete project')}
          </button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>
        {tr('The project’s instructions and knowledge files will be deleted.')}
        {project.folder && (
          <>
            {' '}
            {tr('Files in')}{' '}<code>{project.folder}</code> {tr('stay on your computer.')}
          </>
        )}
      </p>
      {project.chatCount > 0 && (
        <div className="choice-list">
          <label className="choice">
            <input type="radio" name="chats" checked={!withChats} onChange={() => setWithChats(false)} />
            <span>
              <strong>{plural(project.chatCount, 'Keep its chat', 'Keep its {0} chats')}</strong>
              <span className="muted small">{tr('They move out of the project, into your chat list.')}</span>
            </span>
          </label>
          <label className="choice">
            <input type="radio" name="chats" checked={withChats} onChange={() => setWithChats(true)} />
            <span>
              <strong>{tr('Delete the chats too')}</strong>
              <span className="muted small">{tr('Including their artifacts. This can’t be undone.')}</span>
            </span>
          </label>
        </div>
      )}
    </Modal>
  );
}

/** How Mitzi checks work in the folder before a work-mode turn ends. */
function VerifyField({ project, onSave }: { project: ProjectView; onSave(verify: { enabled: boolean; command?: string }): void }) {
  const enabled = project.verify?.enabled !== false;
  const [command, setCommand] = useState(project.verify?.command ?? '');
  useEffect(() => setCommand(project.verify?.command ?? ''), [project.verify?.command]);
  return (
    <div className="field" style={{ marginTop: 14, marginBottom: 0 }}>
      <span className="field-label row" style={{ gap: 6 }}>
        <BadgeCheck size={14} /> {tr('Checks before finishing')}
      </span>
      <label className="row small" style={{ gap: 6 }}>
        <input type="checkbox" checked={enabled} onChange={(e) => onSave({ enabled: e.target.checked, command: command.trim() || undefined })} />
        {tr('In Work mode, run the project’s checks after changes and keep working until they pass')}
      </label>
      {enabled && (
        <form
          className="row"
          style={{ gap: 6, marginTop: 6 }}
          onSubmit={(e) => {
            e.preventDefault();
            onSave({ enabled, command: command.trim() || undefined });
          }}
        >
          <input
            className="input grow"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder={project.verifyDetected ? tr('Detected: {0}', project.verifyDetected) : tr('No checks found; enter a command, e.g. npm test')}
            aria-label={tr('Check command')}
          />
          <button className="btn btn-sm" type="submit" disabled={command.trim() === (project.verify?.command ?? '')}>
            {tr('Save')}
          </button>
        </form>
      )}
    </div>
  );
}
