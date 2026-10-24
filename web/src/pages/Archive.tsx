// Archived chats and projects: out of the sidebar and the project list, but kept, and one click from coming back.
import { Archive, ArchiveRestore, FolderOpen, MessageSquare, Trash2 } from 'lucide-react';
import { api } from '../api';
import { Empty, useConfirm } from '../components/ui';
import { href } from '../router';
import { relativeTime, useApp } from '../state';
import { plural, tr } from '../i18n';

export function ArchivePage() {
  const { chats, projects, refreshChats, refreshProjects, toast } = useApp();
  const [confirmNode, confirm] = useConfirm();
  const archivedProjects = projects.filter((p) => p.archivedAt).sort((a, b) => b.archivedAt!.localeCompare(a.archivedAt!));
  const archivedChats = chats.filter((c) => c.archivedAt).sort((a, b) => b.archivedAt!.localeCompare(a.archivedAt!));
  const run = async (job: () => Promise<unknown>) => {
    try {
      await job();
    } catch (err) {
      toast((err as Error).message);
    }
    await Promise.all([refreshChats(), refreshProjects()]);
  };
  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-header">
          <div>
            <h1 className="page-title">{tr('Archived')}</h1>
            <p className="page-subtitle">{tr('Chats and projects you put away. They’re kept as they were and still show up in search; restore one to bring it back.')}</p>
          </div>
        </div>
        {!archivedProjects.length && !archivedChats.length ? (
          <Empty icon={<Archive size={22} />} title={tr('Nothing archived')}>
            {tr('Archive a chat from its menu in the sidebar, or a project from its page, to put it away without deleting it.')}
          </Empty>
        ) : (
          <>
            {archivedProjects.length > 0 && (
              <section className="archive-section">
                <h2 className="section-heading">{tr('Projects')}</h2>
                {archivedProjects.map((p) => (
                  <div key={p.id} className="archive-row">
                    <FolderOpen size={16} className="muted" />
                    <a className="grow" href={href({ page: 'project', id: p.id })}>
                      {p.name}
                    </a>
                    <span className="muted small">
                      {plural(p.chatCount, '1 chat', '{0} chats')} · {tr('archived {0}', relativeTime(p.archivedAt!))}
                    </span>
                    <button className="btn btn-sm" onClick={() => void run(() => api.updateProject(p.id, { archived: false }))}>
                      <ArchiveRestore size={14} /> {tr('Restore')}
                    </button>
                  </div>
                ))}
              </section>
            )}
            {archivedChats.length > 0 && (
              <section className="archive-section">
                <h2 className="section-heading">{tr('Chats')}</h2>
                {archivedChats.map((c) => (
                  <div key={c.id} className="archive-row">
                    <MessageSquare size={16} className="muted" />
                    <a className="grow" href={href({ page: 'chat', id: c.id })}>
                      {c.title}
                    </a>
                    <span className="muted small">{tr('archived {0}', relativeTime(c.archivedAt!))}</span>
                    <button className="btn btn-sm" onClick={() => void run(() => api.updateChat(c.id, { archived: false }))}>
                      <ArchiveRestore size={14} /> {tr('Restore')}
                    </button>
                    <button
                      className="icon-btn sm"
                      aria-label={tr('Delete {0}', c.title)}
                      title={tr('Delete')}
                      onClick={async () => {
                        if (!(await confirm(tr('“{0}” and its artifacts will be permanently deleted.', c.title), { title: tr('Delete chat?') }))) return;
                        await run(() => api.deleteChat(c.id));
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </section>
            )}
          </>
        )}
      </div>
      {confirmNode}
    </div>
  );
}

/** Shown on an archived chat or project, with a way back. */
export function ArchivedBanner({ what, onRestore }: { what: 'chat' | 'project'; onRestore(): void }) {
  return (
    <div className="archived-banner">
      <Archive size={15} />
      <span className="grow">{what === 'chat' ? tr('This chat is archived. Sending a message brings it back.') : tr('This project is archived, with its chats.')}</span>
      <button className="btn btn-sm" onClick={onRestore}>
        <ArchiveRestore size={14} /> {tr('Restore')}
      </button>
    </div>
  );
}
