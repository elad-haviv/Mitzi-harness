import { Check, ChevronDown, FolderGit2, FolderOpen, FolderSearch, GitBranch, Settings2, Terminal, X } from 'lucide-react';
import { useState } from 'react';
import { api, ProjectView } from '../api';
import { href } from '../router';
import { useApp } from '../state';
import { CloneRepoModal, FolderPicker } from './Folders';
import { Menu } from './ui';
import { tr } from '../i18n';

function ProjectIcon({ project, size = 14 }: { project?: ProjectView; size?: number }) {
  if (project?.repo) return <FolderGit2 size={size} />;
  if (project?.folder) return <Terminal size={size} />;
  return <FolderOpen size={size} />;
}

/** Picks the project a chat works in, or opens a folder or repository as one. */
export function ProjectChip({ projectId, onChange }: { projectId?: string; onChange(id: string | null): void }) {
  const { projects, refreshProjects, toast } = useApp();
  const [dialog, setDialog] = useState<'folder' | 'repo' | null>(null);
  const project = projects.find((p) => p.id === projectId);
  const sorted = [...projects].filter((p) => !p.archivedAt || p.id === projectId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 10);

  const chosen = async (p: ProjectView) => {
    await refreshProjects();
    setDialog(null);
    onChange(p.id);
    toast(p.folder ? tr('Working in {0}', p.folder.split(/[\\/]/).filter(Boolean).pop()) : tr('Project: {0}', p.name), 'info');
  };

  return (
    <>
      <Menu
        align="left"
        direction="up"
        trigger={(_open, toggle) => (
          <button
            type="button"
            className={`pill-btn project-chip${project ? ' on' : ''}`}
            onClick={toggle}
            title={project ? (project.folder ? `${project.name} · ${project.folder}` : project.name) : tr('Work in a project, a folder on this computer, or a repository')}
          >
            <ProjectIcon project={project} />
            <span className="project-chip-label">{project ? project.name : tr('Project')}</span>
            <ChevronDown size={13} />
          </button>
        )}
      >
        {(close) => (
          <div className="project-menu">
            <div className="menu-label">{tr('Work in')}</div>
            <button onClick={() => (close(), onChange(null))}>
              <X size={15} /> {tr('No project')}{' '}{!project && <Check size={14} className="menu-check" />}
            </button>
            {sorted.map((p) => (
              <button key={p.id} onClick={() => (close(), onChange(p.id))} title={p.folder ?? p.description}>
                <ProjectIcon project={p} size={15} />
                <span className="grow">
                  {p.name}
                  {p.folder && <span className="menu-sub">{p.repo ? p.repo.url.replace(/^https?:\/\/|\.git$/g, '') : p.folder}</span>}
                </span>
                {p.id === projectId && <Check size={14} className="menu-check" />}
              </button>
            ))}
            <hr />
            <button onClick={() => (close(), setDialog('folder'))}>
              <FolderSearch size={15} /> {tr('Open a folder…')}
            </button>
            <button onClick={() => (close(), setDialog('repo'))}>
              <GitBranch size={15} /> {tr('Connect a repository…')}
            </button>
            <a className="menu-link" href={href({ page: 'projects' })} onClick={close}>
              <Settings2 size={15} /> {tr('Manage projects')}
            </a>
          </div>
        )}
      </Menu>
      {dialog === 'folder' && (
        <FolderPicker
          title={tr('Open a folder')}
          action="Work in this folder"
          start={project?.folder}
          onClose={() => setDialog(null)}
          onPick={async (path) => void (await chosen(await api.openFolder(path)))}
        />
      )}
      {dialog === 'repo' && <CloneRepoModal onClose={() => setDialog(null)} onCloned={(p) => void chosen(p)} />}
    </>
  );
}
