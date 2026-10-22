import { BookOpen, FileText, FolderOpen, Layers, MessageSquare, MoreHorizontal, Pencil, Plus, ShieldCheck, SquarePen, Terminal, Trash2, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, ArtifactListItem, ChatListItem, PermissionMode, ProjectView } from '../api';
import { ArtifactIcon, TYPE_LABEL } from '../components/Artifacts';
import { Empty, Menu, Modal, readFileAsText, useConfirm } from '../components/ui';
import { href, navigate } from '../router';
import { formatTokens, relativeTime, useApp } from '../state';

export function ProjectsPage() {
  const { projects, refreshProjects } = useApp();
  const [creating, setCreating] = useState(false);
  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-header">
          <div>
            <h1 className="page-title">Projects</h1>
            <p className="page-subtitle">Group chats with shared instructions and knowledge, or point Mitzi at a folder to work on code.</p>
          </div>
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            <Plus size={16} /> New project
          </button>
        </div>
        {projects.length === 0 ? (
          <Empty
            icon={<FolderOpen size={22} />}
            title="No projects yet"
            action={
              <button className="btn btn-primary" onClick={() => setCreating(true)}>
                <Plus size={16} /> Create a project
              </button>
            }
          >
            Projects keep related chats together. Every chat in a project shares its instructions and knowledge files.
          </Empty>
        ) : (
          <div className="grid">
            {projects.map((p) => (
              <a key={p.id} className="tile" href={href({ page: 'project', id: p.id })}>
                <div className="row" style={{ gap: 10 }}>
                  <div className="artifact-icon" style={{ width: 36, height: 36, borderRadius: 10 }}>
                    {p.folder ? <Terminal size={17} /> : <FolderOpen size={17} />}
                  </div>
                  <div className="tile-title">{p.name}</div>
                </div>
                <div className="tile-desc">{p.description || <span className="muted">No description</span>}</div>
                <div className="tile-foot">
                  <span>
                    <MessageSquare size={12} /> {p.chatCount} chat{p.chatCount === 1 ? '' : 's'}
                  </span>
                  {p.files.length > 0 && (
                    <span>
                      · <BookOpen size={12} /> {p.files.length} file{p.files.length === 1 ? '' : 's'}
                    </span>
                  )}
                  {p.folder && <span className="badge ok">Coding</span>}
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
      title={project ? 'Edit project' : 'New project'}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!name.trim() || busy} onClick={save}>
            {project ? 'Save' : 'Create project'}
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
          <span className="field-label">Name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Thesis research" autoFocus />
        </label>
        <label className="field">
          <span className="field-label">Description</span>
          <textarea className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is this project about?" rows={3} />
        </label>
      </form>
    </Modal>
  );
}

const MODE_INFO: Record<PermissionMode, string> = {
  default: 'Ask before editing files, running commands or fetching URLs',
  acceptEdits: 'Edit files freely, ask before commands and network',
  plan: 'Read-only: research and propose a plan',
  yolo: 'Never ask (use with care)',
};

export function ProjectPage({ id }: { id: string }) {
  const { projects, refreshProjects, refreshChats, toast } = useApp();
  const project = projects.find((p) => p.id === id);
  const [chats, setChats] = useState<ChatListItem[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactListItem[]>([]);
  const [editing, setEditing] = useState(false);
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const [folder, setFolder] = useState(project?.folder ?? '');
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
        <div className="page-inner muted">Loading project…</div>
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
        const text = await readFileAsText(f);
        if (text.includes('\u0000')) throw new Error(`${f.name} is not a text file`);
        await api.addProjectFile(project.id, f.name, text);
      } catch (err) {
        toast((err as Error).message);
      }
    }
    await refreshProjects();
  };

  const knowledgeTokens = project.files.reduce((n, f) => n + Math.ceil(f.size / 4), 0);

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-header">
          <div style={{ minWidth: 0 }}>
            <a className="small muted" href={href({ page: 'projects' })}>
              ← All projects
            </a>
            <h1 className="page-title" style={{ marginTop: 6 }}>
              {project.name}
            </h1>
            {project.description && <p className="page-subtitle">{project.description}</p>}
          </div>
          <Menu
            trigger={(_o, toggle) => (
              <button className="icon-btn" onClick={toggle} aria-label="Project options">
                <MoreHorizontal size={18} />
              </button>
            )}
          >
            {(close) => (
              <>
                <button onClick={() => (close(), setEditing(true))}>
                  <Pencil size={15} /> Edit details
                </button>
                <hr />
                <button
                  className="danger"
                  onClick={async () => {
                    close();
                    if (!(await confirm(`This deletes “${project.name}”, its ${project.chatCount} chats, their artifacts and project memories.`, { title: 'Delete project?' }))) return;
                    await api.deleteProject(project.id).catch((err) => toast(err.message));
                    void refreshProjects();
                    void refreshChats();
                    navigate({ page: 'projects' });
                  }}
                >
                  <Trash2 size={15} /> Delete project
                </button>
              </>
            )}
          </Menu>
        </div>

        <div className="project-layout">
          <div>
            <a className="big-composer-link" href={href({ page: 'new', projectId: project.id })}>
              <SquarePen size={18} /> Start a new chat in {project.name}
            </a>
            <h2 className="card-title" style={{ marginBottom: 10 }}>
              Chats
            </h2>
            {chats.filter((c) => c.messageCount > 0).length === 0 ? (
              <div className="empty" style={{ padding: 32 }}>
                No chats in this project yet.
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
                          {c.messageCount} messages · {relativeTime(c.updatedAt)}
                        </div>
                      </div>
                    </a>
                  ))}
              </div>
            )}
            {artifacts.length > 0 && (
              <>
                <h2 className="card-title" style={{ margin: '28px 0 10px' }}>
                  <Layers size={16} /> Artifacts
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
            <div className="card">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <div className="card-title">
                  <Pencil size={15} /> Instructions
                </div>
                <button className="btn btn-sm" onClick={() => setInstructionsOpen(true)}>
                  {project.instructions ? 'Edit' : 'Add'}
                </button>
              </div>
              {project.instructions ? (
                <div className="instructions-preview" style={{ marginTop: 8 }}>
                  {project.instructions}
                </div>
              ) : (
                <p className="muted small" style={{ margin: '6px 0 0' }}>
                  Tell Mitzi how to behave in this project: tone, format, background, rules.
                </p>
              )}
            </div>

            <div className="card">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <div className="card-title">
                  <BookOpen size={15} /> Knowledge
                </div>
                <button className="btn btn-sm" onClick={() => fileInput.current?.click()}>
                  <Upload size={14} /> Add files
                </button>
                <input ref={fileInput} type="file" multiple hidden onChange={(e) => e.target.files && void upload(e.target.files).then(() => (e.target.value = ''))} />
              </div>
              <p className="muted small" style={{ margin: '6px 0 8px' }}>
                Text files included in every chat's context
                {project.files.length > 0 && ` · ~${formatTokens(knowledgeTokens)} tokens`}.
              </p>
              {project.files.map((f) => (
                <div key={f.id} className="file-row">
                  <FileText size={15} className="muted" />
                  <span className="name" title={f.name}>
                    {f.name}
                  </span>
                  <span className="muted small">{formatTokens(Math.ceil(f.size / 4))}</span>
                  <button
                    className="icon-btn sm"
                    aria-label={`Remove ${f.name}`}
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
                <Terminal size={15} /> Coding workspace
              </div>
              <p className="muted small" style={{ margin: '6px 0 10px' }}>
                Link a local folder to give chats the coding tools: read, edit, search and run commands there.
              </p>
              <form
                className="row"
                onSubmit={(e) => {
                  e.preventDefault();
                  void update({ folder: folder.trim() || null });
                }}
              >
                <input className="input mono" placeholder="~/code/my-app" value={folder} onChange={(e) => setFolder(e.target.value)} />
                <button className="btn btn-sm" type="submit" disabled={folder === (project.folder ?? '')}>
                  Save
                </button>
              </form>
              {project.folder && (
                <div className="field" style={{ marginTop: 14, marginBottom: 0 }}>
                  <span className="field-label row" style={{ gap: 6 }}>
                    <ShieldCheck size={14} /> Permissions
                  </span>
                  <select className="select" value={project.permissionMode} onChange={(e) => void update({ permissionMode: e.target.value })}>
                    {(Object.keys(MODE_INFO) as PermissionMode[]).map((m) => (
                      <option key={m} value={m}>
                        {m === 'acceptEdits' ? 'Accept edits' : m[0].toUpperCase() + m.slice(1)}: {MODE_INFO[m]}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      {editing && <ProjectForm project={project} onClose={() => setEditing(false)} onSaved={() => void refreshProjects()} />}
      {instructionsOpen && <InstructionsModal initial={project.instructions} onClose={() => setInstructionsOpen(false)} onSave={(text) => update({ instructions: text })} />}
      {confirmNode}
    </div>
  );
}

function InstructionsModal({ initial, onClose, onSave }: { initial: string; onClose(): void; onSave(text: string): Promise<void> }) {
  const [text, setText] = useState(initial);
  return (
    <Modal
      title="Project instructions"
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={async () => {
              await onSave(text);
              onClose();
            }}
          >
            Save instructions
          </button>
        </>
      }
    >
      <p className="muted small" style={{ marginTop: 0 }}>
        These are added to the system prompt of every chat in this project.
      </p>
      <textarea
        className="textarea"
        rows={14}
        value={text}
        onChange={(e) => setText(e.target.value)}
        autoFocus
        placeholder={'e.g.\nYou are helping me write my thesis on urban heat islands.\nUse British English and cite sources in APA style.\nKeep answers under 300 words unless I ask for more.'}
      />
    </Modal>
  );
}
