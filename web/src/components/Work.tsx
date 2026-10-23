// Pieces of a chat that works on tasks: the stopwatch, response stats, modes, the side panel's
// tabs (tasks, browser, usage), the goal bar, /btw answers and plans.
import {
  BarChart3,
  Check,
  CheckCircle2,
  Circle,
  CircleDot,
  ClipboardList,
  Gauge,
  Globe,
  Layers,
  ListChecks,
  Loader2,
  MessageCircleQuestion,
  MessagesSquare,
  Pause,
  Play,
  Plus,
  Target,
  Timer,
  Workflow as WorkflowIcon,
  X,
} from 'lucide-react';
import { createContext, ReactNode, useContext, useEffect, useState } from 'react';
import type { Chat, ChatMode, FeedbackLoop, Goal, Plan, ResponseStats, Todo } from '../api';
import { href, navigate } from '../router';
import { formatTokens, useApp } from '../state';
import { Markdown } from './Markdown';
import { plural, tr } from '../i18n';

// ---------- Time ----------

/** Seconds since `since`, ticking every half second while `active`. */
export function useElapsed(since: number | undefined, active = true): number {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!since || !active) return;
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [since, active]);
  return since ? Math.max(0, (Date.now() - since) / 1000) : 0;
}

/** 0:07, 1:42, 1:02:03 — a running clock. */
export function clock(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** 4.2s, 1m 05s, 1h 02m — a finished duration. */
export function duration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return tr('{0}m {1}s', m, String(Math.round(s % 60)).padStart(2, '0'));
  return tr('{0}h {1}m', Math.floor(m / 60), String(m % 60).padStart(2, '0'));
}

export function money(cost: number): string {
  if (!cost) return '$0';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

/** The stopwatch shown while Mitzi works on a response. */
export function Stopwatch({ since, label }: { since: number; label?: string }) {
  const s = useElapsed(since);
  return (
    <span className="stopwatch" aria-live="off" title={tr('Time spent on this response')}>
      <Timer size={13} />
      <span className="stopwatch-time">{clock(s)}</span>
      {label && <span className="stopwatch-label">{label}</span>}
    </span>
  );
}

/** Time, tokens and cost of a finished response. */
export function StatsLine({ stats }: { stats: ResponseStats }) {
  const tokens = stats.promptTokens + stats.completionTokens;
  return (
    <span
      className="meta response-stats"
      title={tr('{0} · {1} tokens in, {2} out · {3} · {4}', duration(stats.durationMs), stats.promptTokens.toLocaleString(), stats.completionTokens.toLocaleString(), plural(stats.requests, '{0} request', '{0} requests'), money(stats.cost))}
    >
      <Timer size={12} /> {duration(stats.durationMs)}
      {tokens > 0 && <>{' '}{tr('· {0} tokens', formatTokens(tokens))}</>}
      {stats.cost > 0 && <> · {money(stats.cost)}</>}
    </span>
  );
}

// ---------- Modes ----------

export type UiMode = ChatMode | 'workflow';

const MODES: { id: UiMode; label: string; icon: ReactNode; hint: string }[] = [
  { id: 'chat', label: tr('Chat'), icon: <MessagesSquare size={15} />, hint: tr('Talk things through') },
  { id: 'work', label: tr('Work'), icon: <ListChecks size={15} />, hint: tr('Hand over a task: Mitzi plans, keeps a task list and works until it’s done') },
  { id: 'workflow', label: tr('Workflow'), icon: <WorkflowIcon size={15} />, hint: tr('Build automations that run on their own or from a chat') },
];

export function ModeSwitch({ mode, onChange, compact }: { mode: ChatMode; onChange(m: ChatMode): void; compact?: boolean }) {
  return (
    <div className={`mode-switch${compact ? ' compact' : ''}`} role="radiogroup" aria-label={tr('Mode')}>
      {MODES.map((m) => (
        <button
          key={m.id}
          role="radio"
          aria-checked={mode === m.id}
          className={mode === m.id ? 'on' : ''}
          title={m.hint}
          onClick={() => (m.id === 'workflow' ? navigate({ page: 'workflows' }) : onChange(m.id))}
        >
          {m.icon}
          <span>{m.label}</span>
        </button>
      ))}
    </div>
  );
}

// ---------- Chat actions (shared with messages deep in the tree) ----------

export interface ChatActions {
  chat?: Chat;
  running: boolean;
  /** Feedback loops of this chat. */
  loops: FeedbackLoop[];
  approvePlan(): void;
  revisePlan(): void;
  /** Sends a message on the user's behalf (redo directions, plan approval, goal follow-ups). */
  sendAuto(text: string, auto: 'redo' | 'plan' | 'goal', feedbackLoopId?: string): void;
  reload(): void;
}

export const ChatActionsContext = createContext<ChatActions | null>(null);
export const useChatActions = () => useContext(ChatActionsContext);

// ---------- Side panel tabs ----------

export type SideTab = 'tasks' | 'artifacts' | 'browser' | 'context' | 'usage';

export function SideTabs({ tab, onTab, onClose, counts }: { tab: SideTab; onTab(t: SideTab): void; onClose(): void; counts: Partial<Record<SideTab, number>> }) {
  const tabs: { id: SideTab; label: string; icon: ReactNode }[] = [
    { id: 'tasks', label: tr('Tasks'), icon: <ClipboardList size={15} /> },
    { id: 'artifacts', label: tr('Artifacts'), icon: <Layers size={15} /> },
    { id: 'browser', label: tr('Browser'), icon: <Globe size={15} /> },
    { id: 'context', label: tr('Context'), icon: <Gauge size={15} /> },
    { id: 'usage', label: tr('Usage'), icon: <BarChart3 size={15} /> },
  ];
  return (
    <div className="side-tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => onTab(t.id)} title={t.label}>
          {t.icon}
          <span>{t.label}</span>
          {!!counts[t.id] && <span className="count">{counts[t.id]}</span>}
        </button>
      ))}
      <button className="icon-btn sm side-tabs-close" onClick={onClose} aria-label={tr('Close panel')}>
        <X size={15} />
      </button>
    </div>
  );
}

// ---------- Tasks: goal, plan and task list ----------

const GOAL_STATUS: Record<Goal['status'], string> = { active: tr('Working'), paused: tr('Paused'), complete: tr('Achieved'), budget: tr('Out of turns') };

export function TasksPanel({ chat, running, onCommand, onApprove, onRevise }: { chat?: Chat; running: boolean; onCommand(text: string): void; onApprove(): void; onRevise(): void }) {
  const goal = chat?.goal;
  const plan = chat?.plan;
  const todos = chat?.todos ?? [];
  const [milestone, setMilestone] = useState('');
  if (!goal && !plan && !todos.length) {
    return (
      <div className="panel-body tasks-empty">
        <ClipboardList size={28} className="muted" />
        <p>
          <strong>{tr('No tasks yet.')}</strong> {tr('In Work mode, Mitzi keeps its task list here while it works.')}
        </p>
        <ul className="muted small">
          <li>
            <code>/plan</code> {tr('to get a plan to approve before any work starts')}
          </li>
          <li>
            <code>/goal</code> {tr('to keep Mitzi working until something is achieved')}
          </li>
          <li>
            <code>/subgoal</code> {tr('to add milestones to the goal')}
          </li>
          <li>
            <code>/btw</code> {tr('for a quick side question')}
          </li>
        </ul>
      </div>
    );
  }
  const done = todos.filter((t) => t.status === 'completed').length;
  return (
    <div className="panel-body tasks-panel">
      {goal && (
        <section className="task-section">
          <div className="task-section-head">
            <Target size={15} />
            <span>{tr('Goal')}</span>
            <span className={`status-pill ${goal.status}`}>{GOAL_STATUS[goal.status]}</span>
          </div>
          <p className="goal-text">{goal.text}</p>
          <div className="muted small">
            {tr('Turn {0} of {1}', goal.turns, goal.maxTurns)}
            {goal.subgoals.length > 0 && tr(' · {0}/{1} milestones', goal.subgoals.filter((s) => s.done).length, goal.subgoals.length)}
          </div>
          {goal.subgoals.length > 0 && (
            <ul className="todo-list">
              {goal.subgoals.map((s) => (
                <li key={s.id} className={s.done ? 'completed' : ''}>
                  <button className="todo-check" disabled={s.done} onClick={() => onCommand(`/subgoal done ${s.id}`)} aria-label={s.done ? tr('Done') : tr('Mark "{0}" done', s.text)}>
                    {s.done ? <CheckCircle2 size={16} /> : <Circle size={16} />}
                  </button>
                  <span>{s.text}</span>
                </li>
              ))}
            </ul>
          )}
          <form
            className="row add-milestone"
            onSubmit={(e) => {
              e.preventDefault();
              if (milestone.trim()) onCommand(`/subgoal ${milestone.trim()}`);
              setMilestone('');
            }}
          >
            <input className="input" value={milestone} onChange={(e) => setMilestone(e.target.value)} placeholder={tr('Add a milestone')} />
            <button className="icon-btn" aria-label={tr('Add milestone')} disabled={!milestone.trim()}>
              <Plus size={15} />
            </button>
          </form>
          {goal.lastCheck && <div className="goal-check">{tr('Last check: {0}', goal.lastCheck)}</div>}
          <div className="row" style={{ gap: 6, marginTop: 8 }}>
            {goal.status === 'active' ? (
              <button className="btn btn-sm" onClick={() => onCommand('/goal pause')}>
                <Pause size={13} /> {tr('Pause')}
              </button>
            ) : (
              goal.status !== 'complete' && (
                <button className="btn btn-sm" onClick={() => onCommand('/goal resume')} disabled={running}>
                  <Play size={13} /> {tr('Resume')}
                </button>
              )
            )}
            <button className="btn btn-sm btn-ghost" onClick={() => onCommand('/goal clear')}>
              {tr('Clear goal')}
            </button>
          </div>
        </section>
      )}
      {plan && (
        <section className="task-section">
          <div className="task-section-head">
            <ListChecks size={15} />
            <span>{tr('Plan')}</span>
            <span className={`status-pill ${plan.status}`}>{plan.status === 'proposed' ? tr('Waiting for you') : plan.status === 'approved' ? tr('Approved') : tr('Being revised')}</span>
          </div>
          <div className="plan-body">
            <Markdown text={plan.text} />
          </div>
          {plan.status === 'proposed' && (
            <div className="row" style={{ gap: 6 }}>
              <button className="btn btn-primary btn-sm" onClick={onApprove} disabled={running}>
                <Check size={13} /> {tr('Approve and start')}
              </button>
              <button className="btn btn-sm" onClick={onRevise}>
                {tr('Change it')}
              </button>
            </div>
          )}
        </section>
      )}
      {todos.length > 0 && (
        <section className="task-section">
          <div className="task-section-head">
            <ClipboardList size={15} />
            <span>{tr('Task list')}</span>
            <span className="muted small">
              {done}/{todos.length}
            </span>
          </div>
          <div className="progress">
            <div style={{ width: `${(done / todos.length) * 100}%` }} />
          </div>
          <TodoItems todos={todos} running={running} />
        </section>
      )}
    </div>
  );
}

export function TodoItems({ todos, running }: { todos: Todo[]; running?: boolean }) {
  return (
    <ul className="todo-list">
      {todos.map((t, i) => (
        <li key={i} className={t.status}>
          <span className="todo-check">
            {t.status === 'completed' ? <CheckCircle2 size={16} /> : t.status === 'in_progress' ? running ? <Loader2 size={16} className="spin" /> : <CircleDot size={16} /> : <Circle size={16} />}
          </span>
          <span>{t.content}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------- Usage of this chat ----------

export function UsagePanel({ chat }: { chat?: Chat }) {
  if (!chat) return <div className="panel-body muted small">{tr('Send a message to see usage.')}</div>;
  const responses = chat.messages
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m.role === 'assistant' && m.stats)
    .map(({ m, i }) => {
      const question = chat.messages.slice(0, i).findLast((x) => x.role === 'user');
      const q = typeof question?.content === 'string' ? question.content : (question?.content ?? []).map((p) => (p.type === 'text' ? p.text : '')).join(' ');
      return { i, stats: m.stats!, question: (question?.command ?? q).replace(/<attachment[\s\S]*?<\/attachment>/g, '').trim() };
    });
  const max = Math.max(...responses.map((r) => r.stats.cost || r.stats.promptTokens + r.stats.completionTokens), 0) || 1;
  const u = chat.usage;
  const totalTime = responses.reduce((n, r) => n + r.stats.durationMs, 0);
  return (
    <div className="panel-body usage-panel">
      <div className="kpis">
        <Kpi label={tr('Cost')} value={money(u.cost)} />
        <Kpi label={tr('Tokens')} value={formatTokens(u.promptTokens + u.completionTokens)} hint={tr('{0} in · {1} out', formatTokens(u.promptTokens), formatTokens(u.completionTokens))} />
        <Kpi label={tr('Requests')} value={String(u.requests)} />
        <Kpi label={tr('Time working')} value={totalTime ? duration(totalTime) : '–'} />
      </div>
      <h3 className="panel-subhead">{tr('Responses')}</h3>
      {!responses.length && <p className="muted small">{tr('Responses from now on show their time, tokens and cost here.')}</p>}
      <ol className="response-usage">
        {responses.map((r) => {
          const value = r.stats.cost || r.stats.promptTokens + r.stats.completionTokens;
          return (
            <li key={r.i}>
              <div className="response-usage-q" title={r.question}>
                {r.question || tr('(regenerated)')}
              </div>
              <div className="response-usage-bar">
                <div style={{ width: `${Math.max(2, (value / max) * 100)}%` }} />
              </div>
              <div className="response-usage-meta">
                {tr('{0} · {1} tokens · {2}', duration(r.stats.durationMs), formatTokens(r.stats.promptTokens + r.stats.completionTokens), money(r.stats.cost))}
              </div>
            </li>
          );
        })}
      </ol>
      <a className="link-btn small" href={href({ page: 'insights' })}>
        {tr('All usage in Insights →')}
      </a>
    </div>
  );
}

export function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="kpi" title={hint}>
      <div className="kpi-value">{value}</div>
      <div className="kpi-label">{label}</div>
    </div>
  );
}

// ---------- Browser ----------

export interface BrowserView {
  url: string;
  title: string;
  screenshot?: string;
}

export function BrowserPanel({ view, history }: { view?: BrowserView; history: BrowserView[] }) {
  const { settings } = useApp();
  if (!view) {
    return (
      <div className="panel-body tasks-empty">
        <Globe size={28} className="muted" />
        <p>
          <strong>{tr('No browsing yet.')}</strong> {tr('Ask Mitzi to do something on a website, like “find the opening hours on the library’s site”, and you’ll see the pages here as it works.')}
        </p>
        <p className="muted small">
          {tr('It asks before each step unless you allow it for the chat.')}{' '}{settings?.browserHeaded ? tr('The browser window opens on your screen.') : tr('It works out of sight; you can show the window in Settings → General.')}
        </p>
      </div>
    );
  }
  return (
    <div className="panel-body browser-panel">
      <div className="browser-bar">
        <Globe size={14} className="muted" />
        <a href={view.url} target="_blank" rel="noreferrer noopener" title={view.url}>
          {view.url}
        </a>
      </div>
      {view.screenshot ? <img className="browser-shot" src={view.screenshot} alt={tr('Screenshot of {0}', view.title || view.url)} /> : <div className="muted small">{tr('No screenshot')}</div>}
      {history.length > 1 && (
        <>
          <h3 className="panel-subhead">{tr('Pages visited')}</h3>
          <ol className="browser-history">
            {[...new Map(history.map((h) => [h.url, h])).values()].reverse().map((h) => (
              <li key={h.url}>
                <a href={h.url} target="_blank" rel="noreferrer noopener">
                  {h.title || h.url}
                </a>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

// ---------- Goal bar above the message box ----------

export function GoalBar({ goal, onCommand, onOpen }: { goal: Goal; onCommand(text: string): void; onOpen(): void }) {
  const done = goal.subgoals.filter((s) => s.done).length;
  return (
    <div className={`goal-bar ${goal.status}`}>
      <Target size={15} />
      <button className="goal-bar-text" onClick={onOpen} title={tr('Show the goal in the side panel')}>
        {goal.text}
      </button>
      <span className="goal-bar-meta">
        {GOAL_STATUS[goal.status]}
        {goal.subgoals.length > 0 && ` · ${done}/${goal.subgoals.length}`}
        {goal.status === 'active' && tr(' · turn {0}/{1}', goal.turns, goal.maxTurns)}
      </span>
      {goal.status === 'active' ? (
        <button className="icon-btn sm" onClick={() => onCommand('/goal pause')} title={tr('Pause the goal')} aria-label={tr('Pause the goal')}>
          <Pause size={14} />
        </button>
      ) : goal.status !== 'complete' ? (
        <button className="icon-btn sm" onClick={() => onCommand('/goal resume')} title={tr('Resume the goal')} aria-label={tr('Resume the goal')}>
          <Play size={14} />
        </button>
      ) : null}
      <button className="icon-btn sm" onClick={() => onCommand('/goal clear')} title={tr('Clear the goal')} aria-label={tr('Clear the goal')}>
        <X size={14} />
      </button>
    </div>
  );
}

// ---------- /btw ----------

export interface BtwState {
  question: string;
  answer: string;
  status: 'asking' | 'done' | 'error';
}

export function BtwCard({ state, onClose }: { state: BtwState; onClose(): void }) {
  return (
    <div className="btw-card" role="dialog" aria-label={tr('Side question')}>
      <div className="btw-head">
        <MessageCircleQuestion size={15} />
        <span className="btw-q">{state.question}</span>
        <button className="icon-btn sm" onClick={onClose} aria-label={tr('Dismiss')}>
          <X size={14} />
        </button>
      </div>
      <div className="btw-answer">
        {state.answer ? <Markdown text={state.answer} streaming={state.status === 'asking'} /> : state.status === 'asking' ? <Loader2 size={15} className="spin" /> : null}
      </div>
      <div className="btw-foot muted">{tr('Side question · not added to the chat')}</div>
    </div>
  );
}

// ---------- Plans in the conversation ----------

export function PlanCard({ args, result, running }: { args: any; result?: { output: string; isError: boolean }; running?: boolean }) {
  const actions = useChatActions();
  const plan: Plan | undefined = actions?.chat?.plan;
  const text = String(args?.plan ?? '');
  const latest = plan && plan.text === text.trim();
  const status = latest ? plan.status : 'revised';
  return (
    <div className="plan-card">
      <div className="plan-card-head">
        <ListChecks size={15} />
        <span>{tr('Plan')}</span>
        {result && !result.isError && latest && <span className={`status-pill ${status}`}>{status === 'proposed' ? tr('Waiting for you') : status === 'approved' ? tr('Approved') : tr('Replaced')}</span>}
        {running && !result && <Loader2 size={14} className="spin" />}
      </div>
      <div className="plan-card-body">
        <Markdown text={text} />
      </div>
      {latest && status === 'proposed' && actions && (
        <div className="plan-card-actions">
          <button className="btn btn-primary btn-sm" onClick={actions.approvePlan} disabled={actions.running}>
            <Check size={13} /> {tr('Approve and start')}
          </button>
          <button className="btn btn-sm" onClick={actions.revisePlan}>
            {tr('Change it')}
          </button>
        </div>
      )}
    </div>
  );
}
