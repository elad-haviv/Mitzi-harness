// Insights: what Mitzi costs (tokens and money by day, model, project, bot and chat) and how the
// bots are learning from feedback loops (attempts needed and first-try ratings over time).
import { BarChart3, GraduationCap, Loader2, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, BudgetStatus, FeedbackLoop, LearningCurve, UsageGroup, UsageReport } from '../api';
import { Breakdown, Chart, movingAverage } from '../components/Charts';
import { Stars } from '../components/Feedback';
import { Kpi, money } from '../components/Work';
import { href } from '../router';
import { formatTokens, relativeTime, useApp } from '../state';

const KIND_LABEL: Record<string, string> = {
  chat: 'Answers in chats',
  task: 'Scheduled tasks',
  workflow: 'Workflows',
  title: 'Chat titles',
  memory: 'Memory',
  goal: 'Goal checks',
  btw: 'Side questions (/btw)',
  learning: 'Learning from feedback',
  other: 'Other',
};

export function InsightsPage({ tab }: { tab?: string }) {
  const current = tab === 'learning' ? 'learning' : 'usage';
  return (
    <div className="page insights">
      <div className="page-header">
        <div>
          <h1 className="page-title">Insights</h1>
          <p className="page-subtitle">What Mitzi costs, and how your bots are learning from your feedback</p>
        </div>
      </div>
      <div className="tabs-row" role="tablist">
        <a role="tab" aria-selected={current === 'usage'} className={`tab${current === 'usage' ? ' on' : ''}`} href={href({ page: 'insights' })}>
          <BarChart3 size={15} /> Usage
        </a>
        <a role="tab" aria-selected={current === 'learning'} className={`tab${current === 'learning' ? ' on' : ''}`} href={href({ page: 'insights', tab: 'learning' })}>
          <GraduationCap size={15} /> Learning
        </a>
      </div>
      {current === 'usage' ? <UsageView /> : <LearningView />}
    </div>
  );
}

// ---------- Usage ----------

export function UsageView({ projectId: fixedProject, compact }: { projectId?: string; compact?: boolean }) {
  const { projects, bots, toast, budget } = useApp();
  const [days, setDays] = useState(30);
  const [projectId, setProjectId] = useState(fixedProject ?? '');
  const [botId, setBotId] = useState('');
  const [data, setData] = useState<UsageReport>();
  useEffect(() => {
    api.usage({ days, projectId: projectId || undefined, botId: botId || undefined }).then(setData, (err) => toast(err.message));
  }, [days, projectId, botId, toast]);
  if (!data) return <Loader2 size={18} className="spin muted" />;
  const t = data.totals;
  const priced = data.daily.some((d) => d.cost > 0);
  const metric = (g: { cost: number; prompt: number; completion: number }) => (priced ? g.cost : g.prompt + g.completion);
  const fmt = (v: number) => (priced ? money(v) : formatTokens(v));
  const rows = (groups: UsageGroup[], name: (g: UsageGroup) => React.ReactNode = (g) => g.name ?? g.key) =>
    groups.map((g) => ({
      key: g.key || 'none',
      name: name(g),
      value: metric(g.totals),
      detail: `${money(g.totals.cost)} · ${g.totals.prompt.toLocaleString()} tokens in, ${g.totals.completion.toLocaleString()} out · ${g.totals.requests} requests`,
    }));
  const label = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return (
    <div className="insights-body">
      <div className="filters">
        <div className="segmented">
          {[7, 30, 90].map((d) => (
            <button key={d} className={days === d ? 'active' : ''} onClick={() => setDays(d)}>
              {d} days
            </button>
          ))}
        </div>
        {!fixedProject && (
          <select className="select" value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Project">
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <select className="select" value={botId} onChange={(e) => setBotId(e.target.value)} aria-label="Bot">
          <option value="">All bots</option>
          {bots.map((b) => (
            <option key={b.id} value={b.id}>
              {b.emoji} {b.name}
            </option>
          ))}
        </select>
      </div>
      {budget && !fixedProject && (budget.daily || budget.monthly) ? (
        <section className="card chart-card">
          <h2>
            Budget <a className="small" href={href({ page: 'settings', section: 'budget' })} style={{ fontWeight: 400, marginLeft: 6 }}>Change</a>
          </h2>
          <BudgetMeters budget={budget} />
        </section>
      ) : null}
      <div className="kpis">
        <Kpi label={`Cost, last ${days} days`} value={money(t.cost)} hint={`All time: ${money(data.allTime.cost)}`} />
        <Kpi label="Tokens" value={formatTokens(t.prompt + t.completion)} hint={`${t.prompt.toLocaleString()} in · ${t.completion.toLocaleString()} out`} />
        <Kpi label="Requests" value={t.requests.toLocaleString()} />
        <Kpi label="Average per day" value={priced ? money(t.cost / days) : formatTokens((t.prompt + t.completion) / days)} />
      </div>
      <section className="card chart-card">
        <h2>{priced ? 'Cost per day' : 'Tokens per day'}</h2>
        {!priced && t.requests > 0 && <p className="muted small">Your providers didn’t report prices, so this shows tokens.</p>}
        <Chart
          title={`${priced ? 'Cost' : 'Tokens'} per day over the last ${days} days`}
          points={data.daily.map((d) => ({ label: label(d.day), value: metric(d), tip: `${money(d.cost)} · ${formatTokens(d.prompt + d.completion)} tokens · ${d.requests} requests` }))}
          format={fmt}
        />
        <details className="table-view">
          <summary>Show as table</summary>
          <table className="data-table">
            <thead>
              <tr>
                <th>Day</th>
                <th>Cost</th>
                <th>Tokens in</th>
                <th>Tokens out</th>
                <th>Requests</th>
              </tr>
            </thead>
            <tbody>
              {data.daily
                .filter((d) => d.requests)
                .reverse()
                .map((d) => (
                  <tr key={d.day}>
                    <td>{label(d.day)}</td>
                    <td>{money(d.cost)}</td>
                    <td>{d.prompt.toLocaleString()}</td>
                    <td>{d.completion.toLocaleString()}</td>
                    <td>{d.requests}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </details>
      </section>
      <div className={`breakdowns${compact ? ' compact' : ''}`}>
        <section className="card">
          <h2>By model</h2>
          <Breakdown rows={rows(data.byModel)} format={fmt} empty="No requests in this period." />
        </section>
        {!fixedProject && (
          <section className="card">
            <h2>By project</h2>
            <Breakdown rows={rows(data.byProject, (g) => (g.key ? <a href={href({ page: 'project', id: g.key })}>{g.name}</a> : g.name))} format={fmt} empty="No requests in this period." />
          </section>
        )}
        <section className="card">
          <h2>By bot</h2>
          <Breakdown rows={rows(data.byBot)} format={fmt} empty="No requests in this period." />
        </section>
        <section className="card">
          <h2>By activity</h2>
          <Breakdown rows={rows(data.byKind, (g) => KIND_LABEL[g.key] ?? g.key)} format={fmt} empty="No requests in this period." />
        </section>
        <section className="card">
          <h2>Most expensive chats</h2>
          <Breakdown rows={rows(data.topChats, (g) => <a href={href({ page: 'chat', id: g.key })}>{g.name}</a>)} format={fmt} empty="No chats in this period." />
        </section>
      </div>
    </div>
  );
}

// ---------- Learning ----------

function LearningView() {
  const { bots, toast } = useApp();
  const [botId, setBotId] = useState('');
  const [curve, setCurve] = useState<LearningCurve>();
  const [loops, setLoops] = useState<(FeedbackLoop & { chatTitle?: string })[]>([]);
  const load = () => {
    api.learning(botId || undefined).then(setCurve, (err) => toast(err.message));
    api.feedbackLoops(botId || undefined).then(setLoops, () => {});
  };
  useEffect(load, [botId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!curve) return <Loader2 size={18} className="spin muted" />;
  const s = curve.summary;
  const pts = curve.points;
  const window = Math.max(3, Math.min(5, Math.ceil(pts.length / 4)));
  const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const trend = s.lateFirstRating - s.earlyFirstRating;
  return (
    <div className="insights-body">
      <div className="filters">
        <select className="select" value={botId} onChange={(e) => setBotId(e.target.value)} aria-label="Bot">
          <option value="">All bots</option>
          {bots.map((b) => (
            <option key={b.id} value={b.id}>
              {b.emoji} {b.name}
            </option>
          ))}
        </select>
      </div>
      {!pts.length ? (
        <div className="card empty-learning">
          <GraduationCap size={28} className="muted" />
          <p>
            <strong>No feedback loops yet.</strong> Under any answer, choose <strong>Review</strong> to rate how well it did the task. If it missed, tell Mitzi what you meant and what it
            did, and it redoes the task with your directions, as many times as you like. When you accept a result, Mitzi turns your directions into a lesson, and this page
            charts whether it gets things right sooner over time.
          </p>
        </div>
      ) : (
        <>
          <div className="kpis">
            <Kpi label="Tasks reviewed" value={String(s.loops)} />
            <Kpi label="Accepted" value={`${s.accepted}`} hint={`${s.loops ? Math.round((s.accepted / s.loops) * 100) : 0}% of reviewed tasks`} />
            <Kpi label="Attempts to get it right" value={s.avgAttempts ? s.avgAttempts.toFixed(1) : '–'} hint="Average over accepted tasks" />
            <Kpi
              label="First-try rating"
              value={s.avgFirstRating ? `${s.avgFirstRating.toFixed(1)} / 5` : '–'}
              hint={pts.length >= 4 ? `Earlier tasks ${s.earlyFirstRating.toFixed(1)}, recent tasks ${s.lateFirstRating.toFixed(1)}` : undefined}
            />
            <Kpi label="Lessons learned" value={String(s.lessons)} />
          </div>
          {pts.length >= 4 && (
            <p className={`trend-note ${trend >= 0 ? 'up' : 'down'}`}>
              {trend > 0.05
                ? `First tries are getting better: recent tasks average ${s.lateFirstRating.toFixed(1)}/5, up from ${s.earlyFirstRating.toFixed(1)}.`
                : trend < -0.05
                  ? `First tries have slipped: recent tasks average ${s.lateFirstRating.toFixed(1)}/5, down from ${s.earlyFirstRating.toFixed(1)}.`
                  : `First tries are holding steady at about ${s.lateFirstRating.toFixed(1)}/5.`}
            </p>
          )}
          <div className="breakdowns two">
            <section className="card chart-card">
              <h2>Attempts needed per task</h2>
              <div className="chart-legend">
                <span>
                  <i className="key bar" /> Attempts
                </span>
                <span>
                  <i className="key line" /> Average of the last {window}
                </span>
              </div>
              <Chart
                title="Attempts needed per task, oldest to newest, with a moving average"
                points={pts.map((p) => ({ label: `#${p.n}`, value: p.attempts, tip: `${p.attempts} attempt${p.attempts === 1 ? '' : 's'} · ${date(p.at)} · ${p.task}` }))}
                line={{ values: movingAverage(pts.map((p) => p.attempts), window), label: `Average of the last ${window}` }}
                format={(v) => (Number.isInteger(v) ? String(v) : v.toFixed(1))}
              />
            </section>
            <section className="card chart-card">
              <h2>First-try rating</h2>
              <div className="chart-legend">
                <span>
                  <i className="key dot" /> Rating of the first attempt
                </span>
                <span>
                  <i className="key line" /> Average of the last {window}
                </span>
              </div>
              <Chart
                dots
                domain={[1, 5]}
                title="Rating of each task's first attempt, oldest to newest, with a moving average"
                points={pts.map((p) => ({ label: `#${p.n}`, value: p.firstRating, tip: `${p.firstRating}/5 · ${date(p.at)} · ${p.task}` }))}
                line={{ values: movingAverage(pts.map((p) => p.firstRating), window), label: `Average of the last ${window}` }}
                format={(v) => (Number.isInteger(v) ? String(v) : v.toFixed(1))}
              />
            </section>
          </div>
          <section className="card">
            <h2>Reviewed tasks</h2>
            <div className="loop-list">
              {loops.map((l) => {
                const bot = bots.find((b) => b.id === l.botId);
                return (
                  <div key={l.id} className="loop-row">
                    <div className="loop-main">
                      <a href={href({ page: 'chat', id: l.chatId })} className="loop-task">
                        {l.task}
                      </a>
                      <div className="muted small">
                        {bot ? `${bot.emoji} ${bot.name}` : 'Deleted bot'} · {relativeTime(l.createdAt)} · {l.iterations.length} attempt{l.iterations.length === 1 ? '' : 's'} ·{' '}
                        {l.status === 'accepted' ? 'accepted' : l.status === 'open' ? 'in progress' : 'abandoned'}
                      </div>
                      <div className="loop-ratings">
                        {l.iterations.map((it, i) => (
                          <span key={i} title={[it.meant && `Meant: ${it.meant}`, it.did && `Did: ${it.did}`, it.directions && `Directions: ${it.directions}`].filter(Boolean).join('\n')}>
                            <Stars value={it.rating} size={11} />
                          </span>
                        ))}
                      </div>
                      {l.lesson && <div className="loop-lesson">Learned: {l.lesson}</div>}
                    </div>
                    <button
                      className="icon-btn sm"
                      aria-label="Remove from the learning history"
                      title="Remove from the learning history"
                      onClick={() => void api.deleteLoop(l.id).then(load, (err) => toast(err.message))}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

/** The project page's usage card: the last 30 days, with a link to the full breakdown. */
export function ProjectUsage({ projectId }: { projectId: string }) {
  const [data, setData] = useState<UsageReport>();
  useEffect(() => {
    api.usage({ days: 30, projectId }).then(setData, () => {});
  }, [projectId]);
  if (!data) return null;
  const t = data.totals;
  return (
    <div className="card project-usage">
      <div className="card-title">
        <BarChart3 size={15} /> Usage, last 30 days
      </div>
      <div className="project-usage-row">
        <div>
          <strong>{money(t.cost)}</strong>
          <span className="muted small">cost</span>
        </div>
        <div>
          <strong>{formatTokens(t.prompt + t.completion)}</strong>
          <span className="muted small">tokens</span>
        </div>
        <div>
          <strong>{t.requests}</strong>
          <span className="muted small">requests</span>
        </div>
      </div>
      <p className="muted small" style={{ margin: '6px 0 0' }}>
        All time: {money(data.allTime.cost)} · {formatTokens(data.allTime.prompt + data.allTime.completion)} tokens. <a href={href({ page: 'insights' })}>Details</a>
      </p>
    </div>
  );
}

/** Spending against the daily and monthly limits. */
export function BudgetMeters({ budget }: { budget: BudgetStatus }) {
  const rows = [
    { label: 'Today', spent: budget.spentToday, max: budget.daily },
    { label: 'This month', spent: budget.spentMonth, max: budget.monthly },
  ].filter((r) => r.max);
  if (!rows.length) return null;
  return (
    <div className="budget-meters">
      {rows.map((r) => {
        const pct = Math.min(100, (r.spent / r.max!) * 100);
        const tone = pct >= 100 ? 'over' : pct >= budget.alertPercent ? 'warn' : 'ok';
        return (
          <div key={r.label} className="budget-meter">
            <div className="budget-meter-head">
              <span>{r.label}</span>
              <span className={`budget-meter-value ${tone}`}>
                {money(r.spent)} of {money(r.max!)}
              </span>
            </div>
            <div className="budget-bar" role="meter" aria-valuemin={0} aria-valuemax={r.max} aria-valuenow={r.spent} aria-label={`${r.label}: ${money(r.spent)} of ${money(r.max!)}`}>
              <div className={tone} style={{ width: `${pct}%` }} />
              <i style={{ left: `${budget.alertPercent}%` }} title={`Alert at ${budget.alertPercent}%`} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
