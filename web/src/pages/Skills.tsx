import { Eye, FileText, FolderUp, Pencil, Plus, Trash2, WandSparkles } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, SkillDetail, SkillInfo } from '../api';
import { Markdown } from '../components/Markdown';
import { Empty, Modal, Toggle, useConfirm } from '../components/ui';
import { useApp } from '../state';
import { tr } from '../i18n';

const SOURCE_LABEL: Record<SkillInfo['source'], string> = { user: tr('Your skills'), plugin: tr('From plugins'), claude: tr('From ~/.claude/skills') };

export function SkillsPage() {
  const { settings, refreshSettings, toast } = useApp();
  const [skills, setSkills] = useState<SkillInfo[]>();
  const [editing, setEditing] = useState<SkillDetail | 'new'>();
  const [viewing, setViewing] = useState<SkillDetail>();
  const [confirmNode, confirm] = useConfirm();
  const folderInput = useRef<HTMLInputElement>(null);

  const load = useCallback(() => api.skills().then(setSkills, (err) => toast(err.message)), [toast]);
  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(() => {
    const out: { label: string; items: SkillInfo[] }[] = [];
    for (const s of skills ?? []) {
      const label = s.source === 'plugin' ? tr('From the {0} plugin', s.pluginId) : SOURCE_LABEL[s.source];
      const g = out.find((x) => x.label === label);
      if (g) g.items.push(s);
      else out.push({ label, items: [s] });
    }
    return out.sort((a, b) => Number(b.label === SOURCE_LABEL.user) - Number(a.label === SOURCE_LABEL.user));
  }, [skills]);

  const importFolder = async (files: FileList) => {
    const list: { path: string; content: string }[] = [];
    for (const f of Array.from(files)) {
      if (f.size > 1024 * 1024) continue;
      const text = await f.text();
      if (text.includes('\u0000')) continue; // binary files can't be imported as text
      list.push({ path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, content: text });
    }
    try {
      const skill = await api.importSkill(list);
      toast(tr('Imported “{0}”', skill.name), 'info');
      void load();
    } catch (err) {
      toast((err as Error).message);
    }
  };

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-header">
          <div>
            <h1 className="page-title">{tr('Skills')}</h1>
            <p className="page-subtitle">
              {tr('Packaged instructions and resources for specific kinds of tasks. Bots see each skill’s name and description, and load the full instructions only when a task needs them. Compatible with Claude’s SKILL.md format.')}
            </p>
          </div>
          <div className="row">
            <button className="btn" onClick={() => folderInput.current?.click()}>
              <FolderUp size={16} /> {tr('Import folder')}
            </button>
            <input
              ref={folderInput}
              type="file"
              hidden
              multiple
              {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
              onChange={(e) => e.target.files && void importFolder(e.target.files).then(() => (e.target.value = ''))}
            />
            <button className="btn btn-primary" onClick={() => setEditing('new')}>
              <Plus size={16} /> {tr('New skill')}
            </button>
          </div>
        </div>

        {settings && (
          <label className="row small" style={{ marginBottom: 18 }}>
            <Toggle
              label={tr('Use skills from ~/.claude/skills')}
              on={settings.useClaudeSkills}
              onChange={(v) =>
                api
                  .updateSettings({ useClaudeSkills: v })
                  .then(refreshSettings)
                  .then(load)
                  .catch((err) => toast(err.message))
              }
            />
            {tr('Also use skills from')}{' '}<code>~/.claude/skills</code>
          </label>
        )}

        {skills && skills.length === 0 ? (
          <Empty icon={<WandSparkles size={22} />} title={tr('No skills yet')}>
            {tr('Write one, import a skill folder, or install a plugin that includes skills (try Anthropic’s on the Plugins page).')}
          </Empty>
        ) : (
          groups.map((g) => (
            <div key={g.label} style={{ marginBottom: 22 }}>
              <h2 className="section-title" style={{ marginTop: 0 }}>
                {g.label}
              </h2>
              <div className="list">
                {g.items.map((s) => (
                  <div key={s.id} className="ext-row">
                    <div className="ext-head">
                      <span className="ext-icon">
                        <WandSparkles size={17} className="muted" />
                      </span>
                      <div className="grow">
                        <div className="t">{s.name}</div>
                        <div className="s" title={s.description}>
                          {s.description}
                        </div>
                      </div>
                      <span className="muted small" title={s.files.join('\n')}>
                        <FileText size={13} /> {s.files.length}
                      </span>
                      <button className="icon-btn sm" aria-label={tr('View {0}', s.name)} onClick={async () => setViewing(await api.skill(s.id))}>
                        <Eye size={15} />
                      </button>
                      {s.source === 'user' && (
                        <>
                          <button className="icon-btn sm" aria-label={tr('Edit {0}', s.name)} onClick={async () => setEditing(await api.skill(s.id))}>
                            <Pencil size={15} />
                          </button>
                          <button
                            className="icon-btn sm"
                            aria-label={tr('Delete {0}', s.name)}
                            onClick={async () => {
                              if (!(await confirm(tr('Delete the skill “{0}” and its files?', s.name), { title: tr('Delete skill?') }))) return;
                              await api.deleteSkill(s.id).catch((err) => toast(err.message));
                              void load();
                            }}
                          >
                            <Trash2 size={15} />
                          </button>
                        </>
                      )}
                      <Toggle
                        label={tr('Enable {0}', s.name)}
                        on={s.enabled}
                        onChange={(v) =>
                          api
                            .setSkillEnabled(s.id, v)
                            .then(load)
                            .catch((err) => toast(err.message))
                        }
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
      {editing && <SkillEditor skill={editing === 'new' ? undefined : editing} onClose={() => setEditing(undefined)} onSaved={() => void load()} />}
      {viewing && (
        <Modal title={viewing.name} wide onClose={() => setViewing(undefined)}>
          <p className="muted small" style={{ marginTop: 0 }}>
            {viewing.description}
          </p>
          <div className="card" style={{ maxHeight: '55vh', overflow: 'auto' }}>
            <Markdown text={viewing.body} />
          </div>
          {viewing.files.length > 1 && (
            <p className="muted small">
              {tr('Files: {0}', viewing.files.slice(0, 30).join(', '))}
              {viewing.files.length > 30 ? ` … +${viewing.files.length - 30}` : ''}
            </p>
          )}
          <p className="muted small" style={{ marginBottom: 0 }}>
            {tr('Location:')}{' '}<code>{viewing.dir}</code>
          </p>
        </Modal>
      )}
      {confirmNode}
    </div>
  );
}

function SkillEditor({ skill, onClose, onSaved }: { skill?: SkillDetail; onClose(): void; onSaved(): void }) {
  const { toast } = useApp();
  const [name, setName] = useState(skill?.name ?? '');
  const [description, setDescription] = useState(skill?.description ?? '');
  const [body, setBody] = useState(skill?.body.trim() ?? '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      if (skill) await api.updateSkill(skill.id, { name, description, body });
      else await api.createSkill({ name, description, body });
      onSaved();
      onClose();
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={skill ? tr('Edit {0}', skill.name) : tr('New skill')}
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            {tr('Cancel')}
          </button>
          <button className="btn btn-primary" disabled={busy || !name.trim() || !description.trim()} onClick={save}>
            {skill ? tr('Save skill') : tr('Create skill')}
          </button>
        </>
      }
    >
      <label className="field">
        <span className="field-label">{tr('Name')}</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={tr('e.g. release-notes')} autoFocus />
      </label>
      <label className="field">
        <span className="field-label">{tr('When to use it')}</span>
        <textarea
          className="textarea"
          rows={2}
          style={{ minHeight: 0 }}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={tr('Write release notes from a list of merged PRs. Use when the user asks for release notes, a changelog or a version summary.')}
        />
        <span className="field-hint">{tr('The model sees only this until it decides to load the skill, so say what it does and when to use it.')}</span>
      </label>
      <label className="field" style={{ marginBottom: 0 }}>
        <span className="field-label">{tr('Instructions')}</span>
        <textarea
          className="textarea mono"
          rows={14}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={'# Release notes\n\n1. Group changes into Features, Fixes and Internal.\n2. One line per change, starting with a verb.\n3. …'}
        />
      </label>
    </Modal>
  );
}
