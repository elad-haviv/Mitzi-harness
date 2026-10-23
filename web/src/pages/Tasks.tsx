import { AlertTriangle, CalendarClock, CheckCircle2, Loader2, Pause, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, DEFAULT_BOT_ID, ScheduledTask, TaskSchedule, TaskView, WorkflowView } from '../api';
import { ModelPicker } from '../components/ModelPicker';
import { Empty, Modal, Toggle, useConfirm } from '../components/ui';
import { href } from '../router';
import { stripMarkdown } from '../speech';
import { relativeTime, useApp } from '../state';
import { tr } from '../i18n';

const DAYS = [tr('Sun'), tr('Mon'), tr('Tue'), tr('Wed'), tr('Thu'), tr('Fri'), tr('Sat')];

const EXAMPLES = [
  { name: 'Morning briefing', prompt: tr('Give me a short briefing to start my day: what I should focus on based on what you know about my current projects, plus one useful tip.'), schedule: { kind: 'daily', time: '08:00' } },
  { name: 'Weekly review', prompt: tr('Help me review my week: summarize what we worked on together, what seems unfinished, and suggest three priorities for next week.'), schedule: { kind: 'weekly', time: '17:00', days: [5] } },
  { name: 'News digest', prompt: tr('Search the web for the most important AI news from the last 24 hours and summarize the top 5 stories with links.'), schedule: { kind: 'daily', time: '07:30' } },
] satisfies { name: string; prompt: string; schedule: TaskSchedule }[];

function when(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const diff = d.getTime() - Date.now();
  if (diff < 0) return 'now';
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return tr('in {0} min', mins);
  const hours = Math.round(mins / 60);
  if (hours < 24) return tr('in {0} h', hours);
  return d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function TasksPage() {
  const { tasks, refreshTasks, bots, projects, toast } = useApp();
  const [editing, setEditing] = useState<Partial<ScheduledTask> | null>(null);
  const [confirmNode, confirm] = useConfirm();

  // Opening the page counts as seeing the latest results.
  useEffect(() => {
    if (tasks.some((t) => t.runs.some((r) => !r.seen && r.status !== 'running'))) void api.markTasksSeen().then(refreshTasks);
  }, [tasks, refreshTasks]);
  // Poll faster while something runs.
  useEffect(() => {
    if (!tasks.some((t) => t.running)) return;
    const timer = setInterval(() => void refreshTasks(), 2000);
    return () => clearInterval(timer);
  }, [tasks, refreshTasks]);

  const act = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (err) {
      toast((err as Error).message);
    }
    void refreshTasks();
  };

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-header">
          <div>
            <h1 className="page-title">{tr('Scheduled tasks')}</h1>
            <p className="page-subtitle">{tr('Prompts that run on their own: daily briefings, weekly reviews, reminders, monitoring. Each run is saved as a chat.')}</p>
          </div>
          <button className="btn btn-primary" onClick={() => setEditing({})}>
            <Plus size={16} /> {tr('New task')}
          </button>
        </div>
        {!tasks.length ? (
          <>
            <Empty
              icon={<CalendarClock size={22} />}
              title={tr('No scheduled tasks yet')}
              action={
                <button className="btn btn-primary" onClick={() => setEditing({})}>
                  <Plus size={16} /> {tr('Schedule a task')}
                </button>
              }
            >
              {tr('Tasks run while Mitzi is open (missed runs catch up when it starts).')}
            </Empty>
            <div className="nav-label" style={{ marginTop: 24 }}>
              {tr('Ideas')}
            </div>
            <div className="grid">
              {EXAMPLES.map((e) => (
                <button key={e.name} className="tile" style={{ textAlign: 'left' }} onClick={() => setEditing(e)}>
                  <div className="tile-title">{e.name}</div>
                  <p className="tile-desc">{e.prompt}</p>
                </button>
              ))}
            </div>
          </>
        ) : (
          <div className="task-list">
            {tasks.map((t) => {
              const bot = bots.find((b) => b.id === (t.botId ?? DEFAULT_BOT_ID));
              const last = t.runs.at(-1);
              return (
                <div key={t.id} className={`task-card${t.enabled ? '' : ' off'}`}>
                  <div className="task-main">
                    <div className="row" style={{ gap: 8 }}>
                      <span className="tile-title">{t.name}</span>
                      {t.workflowId ? (
                        <a className="badge" href={href({ page: 'workflow', id: t.workflowId })}>
                          {tr('⚡ Workflow')}
                        </a>
                      ) : (
                        bot && !bot.builtIn && <span className="badge">{bot.emoji} {bot.name}</span>
                      )}
                      {t.autoApprove && <span className="badge warn">{tr('Auto-approves tools')}</span>}
                    </div>
                    <div className="muted small">
                      {t.description}
                      {t.enabled ? tr(' · next {0}', when(t.nextRunAt)) : tr(' · paused')}
                    </div>
                    <p className="task-prompt">{t.prompt}</p>
                    {last && (
                      <div className={`task-run ${last.status}`}>
                        {last.status === 'running' ? <Loader2 size={14} className="spin" /> : last.status === 'ok' ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
                        <span className="grow">
                          {last.status === 'running' ? tr('Running now…') : last.status === 'ok' ? stripMarkdown(last.preview ?? '') || tr('Finished') : last.error}
                        </span>
                        {last.workflowRunId && t.workflowId && last.status !== 'running' && (
                          <a href={href({ page: 'workflow', id: t.workflowId })} className="small">
                            {tr('Open · {0}', relativeTime(last.finishedAt ?? last.startedAt))}
                          </a>
                        )}
                        {last.chatId && last.status !== 'running' && (
                          <a href={href({ page: 'chat', id: last.chatId })} className="small">
                            {tr('Open · {0}', relativeTime(last.finishedAt ?? last.startedAt))}
                          </a>
                        )}
                      </div>
                    )}
                    {t.runs.length > 1 && (
                      <details className="task-history">
                        <summary className="small muted">{tr('{0} runs', t.runs.length)}</summary>
                        {[...t.runs].reverse().slice(1, 15).map((r) => (
                          <div key={r.id} className="small row" style={{ gap: 8 }}>
                            <span className={`dot ${r.status}`} />
                            {r.chatId ? <a href={href({ page: 'chat', id: r.chatId })}>{new Date(r.startedAt).toLocaleString()}</a> : new Date(r.startedAt).toLocaleString()}
                            {r.error && <span className="muted">· {r.error.slice(0, 80)}</span>}
                          </div>
                        ))}
                      </details>
                    )}
                  </div>
                  <div className="task-actions">
                    <Toggle on={t.enabled} label={t.enabled ? tr('Pause task') : tr('Resume task')} onChange={(on) => void act(api.updateTask(t.id, { enabled: on }))} />
                    <button className="icon-btn sm" title={tr('Run now')} aria-label={tr('Run now')} disabled={t.running} onClick={() => void act(api.runTask(t.id))}>
                      {t.running ? <Pause size={14} /> : <Play size={14} />}
                    </button>
                    <button className="icon-btn sm" title={tr('Edit')} aria-label={tr('Edit task')} onClick={() => setEditing(t)}>
                      <Pencil size={14} />
                    </button>
                    <button
                      className="icon-btn sm"
                      title={tr('Delete')}
                      aria-label={tr('Delete task')}
                      onClick={async () => {
                        if (await confirm(tr('Delete “{0}”? Chats from earlier runs are kept.', t.name), { title: tr('Delete task?') })) void act(api.deleteTask(t.id));
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {editing && (
        <TaskEditor
          task={editing}
          bots={bots}
          projects={projects}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void refreshTasks();
          }}
        />
      )}
      {confirmNode}
    </div>
  );
}

function localInput(iso?: string): string {
  const d = iso ? new Date(iso) : new Date(Date.now() + 3600_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function TaskEditor({
  task,
  bots,
  projects,
  onClose,
  onSaved,
}: {
  task: Partial<ScheduledTask>;
  bots: ReturnType<typeof useApp>['bots'];
  projects: ReturnType<typeof useApp>['projects'];
  onClose(): void;
  onSaved(t: TaskView): void;
}) {
  const { toast } = useApp();
  const [name, setName] = useState(task.name ?? '');
  const [prompt, setPrompt] = useState(task.prompt ?? '');
  const [schedule, setSchedule] = useState<TaskSchedule>(task.schedule ?? { kind: 'daily', time: '09:00' });
  const [botId, setBotId] = useState(task.botId ?? DEFAULT_BOT_ID);
  const [projectId, setProjectId] = useState(task.projectId ?? '');
  const [model, setModel] = useState(task.model ?? '');
  const [autoApprove, setAutoApprove] = useState(task.autoApprove ?? false);
  const [reuseChat, setReuseChat] = useState(task.reuseChat ?? false);
  const [workflowId, setWorkflowId] = useState(task.workflowId ?? '');
  const [runsWorkflow, setRunsWorkflow] = useState(!!task.workflowId);
  const [workflows, setWorkflows] = useState<WorkflowView[]>([]);
  useEffect(() => {
    api.workflows().then(setWorkflows, () => {});
  }, []);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<TaskSchedule>) => setSchedule((s) => ({ ...s, ...patch }));

  const save = async () => {
    setBusy(true);
    const body = { name, prompt, schedule, botId, projectId, model, autoApprove, reuseChat, workflowId: runsWorkflow ? workflowId : '' };
    try {
      onSaved(task.id ? await api.updateTask(task.id, body) : await api.createTask(body));
    } catch (err) {
      toast((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal
      title={task.id ? tr('Edit task') : tr('New scheduled task')}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            {tr('Cancel')}
          </button>
          <button className="btn btn-primary" disabled={busy || !name.trim() || (runsWorkflow ? !workflowId : !prompt.trim())} onClick={() => void save()}>
            {task.id ? tr('Save') : tr('Schedule')}
          </button>
        </>
      }
    >
      <label className="field">
        <span className="field-label">{tr('Name')}</span>
        <input className="input" autoFocus value={name} placeholder={tr('Morning briefing')} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="field">
        <span className="field-label">{tr('What runs')}</span>
        <div className="segmented" style={{ alignSelf: 'flex-start' }}>
          <button type="button" className={!runsWorkflow ? 'active' : ''} onClick={() => setRunsWorkflow(false)}>
            {tr('A prompt for a bot')}
          </button>
          <button type="button" className={runsWorkflow ? 'active' : ''} onClick={() => setRunsWorkflow(true)}>
            {tr('A workflow')}
          </button>
        </div>
      </div>
      {runsWorkflow && (
        <label className="field">
          <span className="field-label">{tr('Workflow')}</span>
          <select className="select" value={workflowId} onChange={(e) => setWorkflowId(e.target.value)}>
            <option value="">{tr('Choose a workflow…')}</option>
            {workflows.map((w) => (
              <option key={w.id} value={w.id}>
                {w.emoji} {w.name}
              </option>
            ))}
          </select>
          {!workflows.length && (
            <span className="field-hint">
              {tr('No workflows yet.')}{' '}<a href={href({ page: 'workflows' })}>{tr('Make one')}</a>.
            </span>
          )}
        </label>
      )}
      <label className="field">
        <span className="field-label">{runsWorkflow ? tr('Input for each run (optional)') : tr('Prompt')}</span>
        <textarea className="textarea" rows={runsWorkflow ? 2 : 4} value={prompt} placeholder={runsWorkflow ? tr('Passed to the workflow as its input') : tr('What should the bot do each time?')} onChange={(e) => setPrompt(e.target.value)} />
      </label>
      <div className="field">
        <span className="field-label">{tr('Schedule')}</span>
        <div className="segmented" role="tablist" style={{ alignSelf: 'flex-start', flexWrap: 'wrap' }}>
          {(['once', 'interval', 'daily', 'weekly', 'cron'] as const).map((k) => (
            <button
              key={k}
              type="button"
              className={schedule.kind === k ? 'active' : ''}
              onClick={() =>
                setSchedule((s) => ({
                  kind: k,
                  time: s.time ?? '09:00',
                  days: s.days ?? [1, 2, 3, 4, 5],
                  everyMinutes: s.everyMinutes ?? 60,
                  at: s.at ?? new Date(Date.now() + 3600_000).toISOString(),
                  cron: s.cron ?? '0 9 * * 1-5',
                }))
              }
            >
              {k === 'once' ? tr('Once') : k === 'interval' ? tr('Every…') : k === 'daily' ? tr('Daily') : k === 'weekly' ? tr('Weekly') : tr('Cron')}
            </button>
          ))}
        </div>
        <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          {schedule.kind === 'once' && (
            <input type="datetime-local" className="input" style={{ width: 'auto' }} value={localInput(schedule.at)} onChange={(e) => set({ at: new Date(e.target.value).toISOString() })} />
          )}
          {schedule.kind === 'interval' && (
            <>
              <input type="number" min={5} className="input" style={{ width: 100 }} value={schedule.everyMinutes ?? 60} onChange={(e) => set({ everyMinutes: Number(e.target.value) })} />
              <span className="muted small">{tr('minutes (at least 5)')}</span>
            </>
          )}
          {(schedule.kind === 'daily' || schedule.kind === 'weekly') && (
            <input type="time" className="input" style={{ width: 'auto' }} value={schedule.time ?? '09:00'} onChange={(e) => set({ time: e.target.value })} />
          )}
          {schedule.kind === 'weekly' &&
            DAYS.map((d, i) => (
              <button
                key={d}
                type="button"
                className={`pill-btn${schedule.days?.includes(i) ? ' on' : ''}`}
                onClick={() => set({ days: schedule.days?.includes(i) ? schedule.days.filter((x) => x !== i) : [...(schedule.days ?? []), i] })}
              >
                {d}
              </button>
            ))}
          {schedule.kind === 'cron' && (
            <>
              <input className="input mono" style={{ width: 180 }} value={schedule.cron ?? ''} onChange={(e) => set({ cron: e.target.value })} />
              <span className="muted small">{tr('minute hour day month weekday, local time')}</span>
            </>
          )}
        </div>
      </div>
      {!runsWorkflow && (
      <>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
        <label className="field" style={{ flex: 1, minWidth: 160 }}>
          <span className="field-label">{tr('Bot')}</span>
          <select className="select" value={botId} onChange={(e) => setBotId(e.target.value)}>
            {bots.map((b) => (
              <option key={b.id} value={b.id}>
                {b.emoji} {b.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field" style={{ flex: 1, minWidth: 160 }}>
          <span className="field-label">{tr('Project')}</span>
          <select className="select" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">{tr('None')}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="field">
        <span className="field-label">{tr('Model')}</span>
        <ModelPicker value={model} onChange={setModel} variant="input" direction="down" allowEmpty={tr('Bot\'s default model')} auto />
      </div>
      <div className="setting-row">
        <div>
          <div>{tr('Start a new chat for each run')}</div>
          <div className="muted small">{tr('Off: every run continues the same chat, so the bot sees earlier results.')}</div>
        </div>
        <Toggle on={!reuseChat} onChange={(on) => setReuseChat(!on)} label={tr('New chat per run')} />
      </div>
      <div className="setting-row">
        <div>
          <div>{tr('Allow tools that need approval')}</div>
          <div className="muted small">{tr('Nobody is there to click “Allow”, so these tools are skipped unless you turn this on. Commands in a coding project would run unattended.')}</div>
        </div>
        <Toggle on={autoApprove} onChange={setAutoApprove} label={tr('Auto-approve tools')} />
      </div>
      </>
      )}
    </Modal>
  );
}
