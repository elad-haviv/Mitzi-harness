// Insights: what Mitzi costs (tokens and money by day, model, project, bot and chat) and how the
// bots are learning from feedback loops (attempts needed and first-try ratings over time).
import { BarChart3, Columns2, GraduationCap, Loader2, Sparkles, Trash2, Trophy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, BudgetStatus, CompareInsights, FeedbackLoop, LearningCurve, LearningMetrics, UsageGroup, UsageReport } from '../api';
import { Breakdown, Chart, movingAverage } from '../components/Charts';
import { Stars } from '../components/Feedback';
import { Kpi, money } from '../components/Work';
import { href } from '../router';
import { formatTokens, modelLabel, relativeTime, useApp } from '../state';
import { plural, tr } from '../i18n';

const KIND_LABEL: Record<string, string> = {
  chat: tr('Answers in chats'),
  task: tr('Scheduled tasks'),
  workflow: tr('Workflows'),
  title: tr('Chat titles'),
  memory: tr('Memory'),
  goal: tr('Goal checks'),
  btw: tr('Side questions (/btw)'),
  learning: tr('Learning from feedback'),
  review: tr('Self-reviews before finishing'),
  eval: tr('Replaying your tasks (evals)'),
  other: tr('Other'),
};

export function InsightsPage({ tab }: { tab?: string }) {
  const current = tab === 'learning' ? 'learning' : tab === 'compare' ? 'compare' : 'usage';
  return (
    <div className="page insights">
      <div className="page-header">
        <div>
          <h1 className="page-title">{tr('Insights')}</h1>
          <p className="page-subtitle">{tr('What Mitzi costs, and how your bots are learning from your feedback')}</p>
        </div>
      </div>
      <div className="tabs-row" role="tablist">
        <a role="tab" aria-selected={current === 'usage'} className={`tab${current === 'usage' ? ' on' : ''}`} href={href({ page: 'insights' })}>
          <BarChart3 size={15} /> {tr('Usage')}
        </a>
        <a role="tab" aria-selected={current === 'learning'} className={`tab${current === 'learning' ? ' on' : ''}`} href={href({ page: 'insights', tab: 'learning' })}>
          <GraduationCap size={15} /> {tr('Learning')}
        </a>
        <a role="tab" aria-selected={current === 'compare'} className={`tab${current === 'compare' ? ' on' : ''}`} href={href({ page: 'insights', tab: 'compare' })}>
          <Columns2 size={15} /> {tr('Compare')}
        </a>
      </div>
      {current === 'usage' ? <UsageView /> : current === 'compare' ? <CompareInsightsView /> : <LearningView />}
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
      detail: tr('{0} · {1} tokens in, {2} out · {3} requests', money(g.totals.cost), g.totals.prompt.toLocaleString(), g.totals.completion.toLocaleString(), g.totals.requests),
    }));
  const label = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return (
    <div className="insights-body">
      <div className="filters">
        <div className="segmented">
          {[7, 30, 90].map((d) => (
            <button key={d} className={days === d ? 'active' : ''} onClick={() => setDays(d)}>
              {tr('{0} days', d)}
            </button>
          ))}
        </div>
        {!fixedProject && (
          <select className="select" value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label={tr('Project')}>
            <option value="">{tr('All projects')}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <select className="select" value={botId} onChange={(e) => setBotId(e.target.value)} aria-label={tr('Bot')}>
          <option value="">{tr('All bots')}</option>
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
            {tr('Budget')}{' '}<a className="small" href={href({ page: 'settings', section: 'budget' })} style={{ fontWeight: 400, marginLeft: 6 }}>{tr('Change')}</a>
          </h2>
          <BudgetMeters budget={budget} />
        </section>
      ) : null}
      <div className="kpis">
        <Kpi label={tr('Cost, last {0} days', days)} value={money(t.cost)} hint={tr('All time: {0}', money(data.allTime.cost))} />
        <Kpi label={tr('Tokens')} value={formatTokens(t.prompt + t.completion)} hint={tr('{0} in · {1} out', t.prompt.toLocaleString(), t.completion.toLocaleString())} />
        <Kpi label={tr('Requests')} value={t.requests.toLocaleString()} />
        <Kpi label={tr('Average per day')} value={priced ? money(t.cost / days) : formatTokens((t.prompt + t.completion) / days)} />
      </div>
      {data.auto && <AutoCard auto={data.auto} />}
      <section className="card chart-card">
        <h2>{priced ? tr('Cost per day') : tr('Tokens per day')}</h2>
        {!priced && t.requests > 0 && <p className="muted small">{tr('Your providers didn’t report prices, so this shows tokens.')}</p>}
        <Chart
          title={priced ? tr('Cost per day over the last {0} days', days) : tr('Tokens per day over the last {0} days', days)}
          points={data.daily.map((d) => ({ label: label(d.day), value: metric(d), tip: tr('{0} · {1} tokens · {2} requests', money(d.cost), formatTokens(d.prompt + d.completion), d.requests) }))}
          format={fmt}
        />
        <details className="table-view">
          <summary>{tr('Show as table')}</summary>
          <table className="data-table">
            <thead>
              <tr>
                <th>{tr('Day')}</th>
                <th>{tr('Cost')}</th>
                <th>{tr('Tokens in')}</th>
                <th>{tr('Tokens out')}</th>
                <th>{tr('Requests')}</th>
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
          <h2>{tr('By model')}</h2>
          <Breakdown rows={rows(data.byModel)} format={fmt} empty={tr('No requests in this period.')} />
        </section>
        {!fixedProject && (
          <section className="card">
            <h2>{tr('By project')}</h2>
            <Breakdown rows={rows(data.byProject, (g) => (g.key ? <a href={href({ page: 'project', id: g.key })}>{g.name}</a> : tr(g.name ?? '')))} format={fmt} empty={tr('No requests in this period.')} />
          </section>
        )}
        <section className="card">
          <h2>{tr('By bot')}</h2>
          <Breakdown rows={rows(data.byBot, (g) => (g.name === 'Deleted bot' ? tr('Deleted bot') : (g.name ?? g.key)))} format={fmt} empty={tr('No requests in this period.')} />
        </section>
        <section className="card">
          <h2>{tr('By activity')}</h2>
          <Breakdown rows={rows(data.byKind, (g) => KIND_LABEL[g.key] ?? g.key)} format={fmt} empty={tr('No requests in this period.')} />
        </section>
        <section className="card">
          <h2>{tr('Most expensive chats')}</h2>
          <Breakdown rows={rows(data.topChats, (g) => <a href={href({ page: 'chat', id: g.key })}>{g.name}</a>)} format={fmt} empty={tr('No chats in this period.')} />
        </section>
      </div>
    </div>
  );
}

// ---------- Learning ----------

const pct = (v?: number) => (v === undefined ? '–' : `${Math.round(v * 100)}%`);

/** What the outcome ledger says: is Mitzi getting things right on the first try, and finishing on green? */
function OutcomeMetrics({ botId }: { botId?: string }) {
  const { toast, models } = useApp();
  const [data, setData] = useState<LearningMetrics>();
  const [hints, setHints] = useState<Awaited<ReturnType<typeof api.modelHints>>>([]);
  useEffect(() => {
    api.outcomeMetrics(botId).then(setData, (err) => toast(err.message));
    api.modelHints().then(setHints, () => {});
  }, [botId, toast]);
  if (!data) return <Loader2 size={18} className="spin muted" />;
  const o = data.overall;
  if (!o.tasks) {
    return (
      <div className="card empty-learning">
        <GraduationCap size={28} className="muted" />
        <p>{tr('No tasks recorded yet. Every task that uses tools is recorded with how it went (errors, checks, redos, your edits), and Mitzi learns from them without you rating anything.')}</p>
      </div>
    );
  }
  const week = (w: string) => new Date(`${w}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const lessons = Object.values(data.lessonsBySource).reduce((a, b) => a + b, 0);
  return (
    <>
      <h2 className="section-heading">{tr('From how tasks went')}</h2>
      <div className="kpis">
        <Kpi label={tr('Tasks recorded')} value={String(o.tasks)} hint={tr('Last 90 days')} />
        <Kpi label={tr('Right on the first try')} value={pct(o.firstTryAccepted)} hint={tr('First attempts that weren’t sent back for a redo')} />
        <Kpi label={tr('Finished on green')} value={pct(o.firstCheckPassed)} hint={tr('Checked work that passed the project’s checks the first time, before Mitzi had to send it back')} />
        <Kpi label={tr('Checks pass in the end')} value={pct(o.checksPassed)} />
        <Kpi label={tr('Mistakes per task')} value={o.agentErrors.toFixed(1)} hint={tr('Failed tool calls that were the bot’s fault; {0} per task were the computer’s', o.environmentErrors.toFixed(1))} />
        <Kpi label={tr('Lessons in effect')} value={String(lessons)} />
      </div>
      {data.weekly.length >= 2 && (
        <div className="breakdowns two">
          <section className="card chart-card">
            <h2>{tr('Tasks that went well, by week')}</h2>
            <Chart
              title={tr('Share of tasks without redos, failing checks, mistakes or low ratings, per week')}
              points={data.weekly.map((w) => ({ label: week(w.week), value: (w.wentWell ?? 0) * 100, tip: tr('{0}% of {1} tasks', Math.round((w.wentWell ?? 0) * 100), w.tasks) }))}
              format={(v) => `${Math.round(v)}%`}
              domain={[0, 100]}
              dots
            />
          </section>
          <section className="card chart-card">
            <h2>{tr('Lessons in effect, by week')}</h2>
            <Chart title={tr('Lessons in the prompt at the end of each week')} points={data.weekly.map((w) => ({ label: week(w.week), value: w.lessons, tip: String(w.lessons) }))} dots />
          </section>
        </div>
      )}
      {data.byModel.length > 0 && (
        <section className="card">
          <h2>{tr('By model')}</h2>
          <p className="muted small">{tr('Once a model has enough tasks, the habits its numbers show (skipping checks, failing edits, needing redos) become notes in its prompt. Hover a note to see why.')}</p>
          <table className="data-table">
            <thead>
              <tr>
                <th>{tr('Model')}</th>
                <th>{tr('Tasks')}</th>
                <th>{tr('Right first try')}</th>
                <th>{tr('Finished on green')}</th>
                <th>{tr('Mistakes per task')}</th>
                <th>{tr('Notes it gets')}</th>
              </tr>
            </thead>
            <tbody>
              {data.byModel.map((m) => (
                <tr key={m.model}>
                  <td>{modelLabel(m.model, models)}</td>
                  <td>{m.tasks}</td>
                  <td>{pct(m.firstTryAccepted)}</td>
                  <td>{pct(m.firstCheckPassed)}</td>
                  <td>{m.agentErrors.toFixed(1)}</td>
                  <td className="small">
                    {(hints.find((h) => h.model === m.model)?.hints ?? []).map((h, i) => (
                      <div key={i} title={h.why}>
                        {h.hint}
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}

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
        <select className="select" value={botId} onChange={(e) => setBotId(e.target.value)} aria-label={tr('Bot')}>
          <option value="">{tr('All bots')}</option>
          {bots.map((b) => (
            <option key={b.id} value={b.id}>
              {b.emoji} {b.name}
            </option>
          ))}
        </select>
      </div>
      <OutcomeMetrics botId={botId || undefined} />
      <h2 className="section-heading">{tr('From your reviews')}</h2>
      {!pts.length ? (
        <div className="card empty-learning">
          <GraduationCap size={28} className="muted" />
          <p>
            <strong>{tr('No feedback loops yet.')}</strong> {tr('Under any answer, choose')}{' '}<strong>{tr('Review')}</strong> {tr('to rate how well it did the task. If it missed, tell Mitzi what you meant and what it did, and it redoes the task with your directions, as many times as you like. When you accept a result, Mitzi turns your directions into a lesson, and this page charts whether it gets things right sooner over time.')}
          </p>
        </div>
      ) : (
        <>
          <div className="kpis">
            <Kpi label={tr('Tasks reviewed')} value={String(s.loops)} />
            <Kpi label={tr('Accepted')} value={`${s.accepted}`} hint={tr('{0}% of reviewed tasks', s.loops ? Math.round((s.accepted / s.loops) * 100) : 0)} />
            <Kpi label={tr('Attempts to get it right')} value={s.avgAttempts ? s.avgAttempts.toFixed(1) : '–'} hint={tr('Average over accepted tasks')} />
            <Kpi
              label={tr('First-try rating')}
              value={s.avgFirstRating ? `${s.avgFirstRating.toFixed(1)} / 5` : '–'}
              hint={pts.length >= 4 ? tr('Earlier tasks {0}, recent tasks {1}', s.earlyFirstRating.toFixed(1), s.lateFirstRating.toFixed(1)) : undefined}
            />
            <Kpi label={tr('Lessons learned')} value={String(s.lessons)} />
          </div>
          {pts.length >= 4 && (
            <p className={`trend-note ${trend >= 0 ? 'up' : 'down'}`}>
              {trend > 0.05
                ? tr('First tries are getting better: recent tasks average {0}/5, up from {1}.', s.lateFirstRating.toFixed(1), s.earlyFirstRating.toFixed(1))
                : trend < -0.05
                  ? tr('First tries have slipped: recent tasks average {0}/5, down from {1}.', s.lateFirstRating.toFixed(1), s.earlyFirstRating.toFixed(1))
                  : tr('First tries are holding steady at about {0}/5.', s.lateFirstRating.toFixed(1))}
            </p>
          )}
          <div className="breakdowns two">
            <section className="card chart-card">
              <h2>{tr('Attempts needed per task')}</h2>
              <div className="chart-legend">
                <span>
                  <i className="key bar" /> {tr('Attempts')}
                </span>
                <span>
                  <i className="key line" />{' '}{tr('Average of the last {0}', window)}
                </span>
              </div>
              <Chart
                title={tr('Attempts needed per task, oldest to newest, with a moving average')}
                points={pts.map((p) => ({ label: `#${p.n}`, value: p.attempts, tip: `${plural(p.attempts, '1 attempt', '{0} attempts')} · ${date(p.at)} · ${p.task}` }))}
                line={{ values: movingAverage(pts.map((p) => p.attempts), window), label: tr('Average of the last {0}', window) }}
                format={(v) => (Number.isInteger(v) ? String(v) : v.toFixed(1))}
              />
            </section>
            <section className="card chart-card">
              <h2>{tr('First-try rating')}</h2>
              <div className="chart-legend">
                <span>
                  <i className="key dot" /> {tr('Rating of the first attempt')}
                </span>
                <span>
                  <i className="key line" />{' '}{tr('Average of the last {0}', window)}
                </span>
              </div>
              <Chart
                dots
                domain={[1, 5]}
                title={tr('Rating of each task\'s first attempt, oldest to newest, with a moving average')}
                points={pts.map((p) => ({ label: `#${p.n}`, value: p.firstRating, tip: `${p.firstRating}/5 · ${date(p.at)} · ${p.task}` }))}
                line={{ values: movingAverage(pts.map((p) => p.firstRating), window), label: tr('Average of the last {0}', window) }}
                format={(v) => (Number.isInteger(v) ? String(v) : v.toFixed(1))}
              />
            </section>
          </div>
          <section className="card">
            <h2>{tr('Reviewed tasks')}</h2>
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
                        {bot ? `${bot.emoji} ${bot.name}` : tr('Deleted bot')} · {relativeTime(l.createdAt)} · {plural(l.iterations.length, '1 attempt', '{0} attempts')} ·{' '}
                        {l.status === 'accepted' ? tr('accepted') : l.status === 'open' ? tr('in progress') : tr('abandoned')}
                      </div>
                      <div className="loop-ratings">
                        {l.iterations.map((it, i) => (
                          <span key={i} title={[it.meant && `Meant: ${it.meant}`, it.did && `Did: ${it.did}`, it.directions && `Directions: ${it.directions}`].filter(Boolean).join('\n')}>
                            <Stars value={it.rating} size={11} />
                          </span>
                        ))}
                      </div>
                      {l.lesson && <div className="loop-lesson">{tr('Learned: {0}', l.lesson)}</div>}
                    </div>
                    <button
                      className="icon-btn sm"
                      aria-label={tr('Remove from the learning history')}
                      title={tr('Remove from the learning history')}
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
        <BarChart3 size={15} /> {tr('Usage, last 30 days')}
      </div>
      <div className="project-usage-row">
        <div>
          <strong>{money(t.cost)}</strong>
          <span className="muted small">{tr('cost')}</span>
        </div>
        <div>
          <strong>{formatTokens(t.prompt + t.completion)}</strong>
          <span className="muted small">{tr('tokens')}</span>
        </div>
        <div>
          <strong>{t.requests}</strong>
          <span className="muted small">{tr('requests')}</span>
        </div>
      </div>
      <p className="muted small" style={{ margin: '6px 0 0' }}>
        {tr('All time: {0} · {1} tokens.', money(data.allTime.cost), formatTokens(data.allTime.prompt + data.allTime.completion))}{' '}<a href={href({ page: 'insights' })}>{tr('Details')}</a>
      </p>
    </div>
  );
}

/** Spending against the daily and monthly limits. */
export function BudgetMeters({ budget }: { budget: BudgetStatus }) {
  const rows = [
    { label: tr('Today'), spent: budget.spentToday, max: budget.daily },
    { label: tr('This month'), spent: budget.spentMonth, max: budget.monthly },
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
                {tr('{0} of {1}', money(r.spent), money(r.max!))}
              </span>
            </div>
            <div className="budget-bar" role="meter" aria-valuemin={0} aria-valuemax={r.max} aria-valuenow={r.spent} aria-label={tr('{0}: {1} of {2}', r.label, money(r.spent), money(r.max!))}>
              <div className={tone} style={{ width: `${pct}%` }} />
              <i style={{ left: `${budget.alertPercent}%` }} title={tr('Alert at {0}%', budget.alertPercent)} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** How Auto split the answers between its quick and in-depth models. */
function AutoCard({ auto }: { auto: NonNullable<UsageReport['auto']> }) {
  const all = auto.fast.requests + auto.strong.requests;
  const share = (n: number) => `${Math.round((n / all) * 100)}%`;
  return (
    <section className="card chart-card">
      <h2>
        <Sparkles size={15} className="accent" style={{ verticalAlign: -2, marginRight: 6 }} />
        {tr('Auto model')}
      </h2>
      <div className="route-split">
        <div>
          <div className="v">{share(auto.fast.requests)}</div>
          <div className="muted small">
            {tr('to the quick model · {0}', money(auto.fast.cost))}
          </div>
        </div>
        <div>
          <div className="v">{share(auto.strong.requests)}</div>
          <div className="muted small">
            {tr('to the in-depth model · {0}', money(auto.strong.cost))}
          </div>
        </div>
        <div>
          <div className="v">{money(auto.saved)}</div>
          <div className="muted small" title={tr('What the quick model\'s requests would have cost on the in-depth model, at listed prices')}>
            {tr('saved, estimated')}
          </div>
        </div>
      </div>
      <div className="route-bar" role="img" aria-label={tr('{0} quick, {1} in-depth', share(auto.fast.requests), share(auto.strong.requests))}>
        <span className="fast" style={{ width: share(auto.fast.requests) }} />
        <span className="strong" style={{ width: share(auto.strong.requests) }} />
      </div>
    </section>
  );
}

// ---------- Compare (/compare picks) ----------

function CompareInsightsView() {
  const { toast } = useApp();
  const [data, setData] = useState<CompareInsights>();
  useEffect(() => {
    api.compareInsights().then(setData, (err) => toast(err.message));
  }, [toast]);
  if (!data) return <Loader2 size={18} className="spin muted" />;
  const played = (id: string) => (data.wins[id] ?? 0) + (data.losses[id] ?? 0);
  const models = [...new Set([...Object.keys(data.wins), ...Object.keys(data.losses)])].sort(
    (a, b) => (data.wins[b] ?? 0) - (data.wins[a] ?? 0) || played(a) - played(b) || a.localeCompare(b),
  );
  return (
    <div className="insights-body">
      <div className="kpis">
        <Kpi label={tr('Comparisons')} value={String(data.comparisons)} hint={tr('{0} skipped', data.skipped)} />
        <Kpi label={tr('Models raced')} value={String(models.length)} />
      </div>
      <section className="card chart-card">
        <h2>{tr('Leaderboard')}</h2>
        {!models.length ? (
          <p className="muted">{tr('No picks yet. Race two models with /compare [modelA] [modelB] &lt;prompt&gt; in any chat, then pick the winner.')}</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th></th>
                <th>{tr('Model')}</th>
                <th>{tr('Wins')}</th>
                <th>{tr('Losses')}</th>
                <th>{tr('Win rate')}</th>
              </tr>
            </thead>
            <tbody>
              {models.map((id, i) => {
                const w = data.wins[id] ?? 0;
                const l = data.losses[id] ?? 0;
                const rate = Math.round((w / (w + l)) * 100);
                return (
                  <tr key={id}>
                    <td>{i === 0 ? <Trophy size={14} aria-label={tr('Leader')} /> : i + 1}</td>
                    <td><code>{id}</code></td>
                    <td>{w}</td>
                    <td>{l}</td>
                    <td>{rate}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
