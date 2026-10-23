import { AlertTriangle, Check, ChevronDown, ChevronRight, Loader2, Users, Split } from 'lucide-react';
import { useState } from 'react';
import type { Bot, StreamEvent } from '../api';
import { useApp } from '../state';
import { Markdown } from './Markdown';

type DelegateEvent = Extract<StreamEvent, { type: 'delegate' }>;

export interface TeammateProgress {
  text: string;
  tool?: string;
  status: 'working' | 'done' | 'error';
  error?: string;
}

/** Live progress of a Delegate call, by bot id. */
export type TeamProgress = Record<string, TeammateProgress>;

export function applyDelegateEvent(team: TeamProgress | undefined, e: DelegateEvent): TeamProgress {
  const cur: TeammateProgress = team?.[e.botId] ?? { text: '', status: 'working' };
  let next: TeammateProgress;
  switch (e.event) {
    case 'start':
      next = { text: '', status: 'working' };
      break;
    case 'text':
      next = { ...cur, text: cur.text + e.text };
      break;
    case 'tool':
      // Text before a tool call was the bot thinking aloud; start fresh after it.
      next = { ...cur, tool: e.text, text: '' };
      break;
    case 'done':
      next = { ...cur, status: 'done', tool: undefined };
      break;
    case 'error':
      next = { ...cur, status: 'error', error: e.text };
      break;
  }
  return { ...team, [e.botId]: next };
}

/** Splits the Delegate result ("## 🔬 Researcher\n…") into each bot's answer. */
function answers(output: string): { head: string; body: string; failed: boolean }[] {
  return output
    .split(/^## /m)
    .filter((s) => s.trim())
    .map((s) => {
      const nl = s.indexOf('\n');
      const head = (nl < 0 ? s : s.slice(0, nl)).trim();
      return { head: head.replace(/ \(failed\)$/, ''), body: nl < 0 ? '' : s.slice(nl + 1).trim(), failed: / \(failed\)$/.test(head) };
    });
}

function findBot(bots: Bot[], ref: string): Bot | undefined {
  const q = ref.trim().toLowerCase();
  return bots.find((b) => b.id === ref) ?? bots.find((b) => b.name.toLowerCase() === q) ?? bots.find((b) => b.name.toLowerCase().includes(q));
}

/** A Subagents call: copies of the bot working on focused tasks in parallel. */
export function SubagentsCard({ args, result, running, progress, bot }: { args: any; result?: { output: string; isError: boolean }; running?: boolean; progress?: TeamProgress; bot?: Bot }) {
  const tasks: { title: string; task: string }[] = Array.isArray(args?.tasks) ? args.tasks : [];
  const finished = result && !result.isError ? answers(result.output) : [];
  const busy = running && !result;
  return (
    <div className="team-card">
      <div className="team-head">
        <Split size={14} />
        <span>
          {busy ? 'Working with' : 'Worked with'} {tasks.length === 1 ? 'a subagent' : `${tasks.length} subagents`}
        </span>
        {result?.isError && <span className="team-error">{result.output}</span>}
      </div>
      {tasks.map((t, i) => {
        const live = progress?.[`subagent-${i + 1}`];
        const answer = finished[i];
        const state: 'working' | 'done' | 'error' = answer ? (answer.failed ? 'error' : 'done') : live?.status ?? (busy ? 'working' : result ? 'error' : 'working');
        return <Teammate key={i} name={String(t.title ?? `Task ${i + 1}`)} emoji={bot?.emoji ?? '🐾'} task={String(t.task ?? '')} state={state} live={live} answer={answer?.body} />;
      })}
    </div>
  );
}

export function TeamCard({ args, result, running, progress }: { args: any; result?: { output: string; isError: boolean }; running?: boolean; progress?: TeamProgress }) {
  const { bots } = useApp();
  const assignments: { bot: string; task: string }[] = Array.isArray(args?.assignments) ? args.assignments : [];
  const finished = result && !result.isError ? answers(result.output) : [];
  const busy = running && !result;
  return (
    <div className="team-card">
      <div className="team-head">
        <Users size={14} />
        <span>
          {busy ? 'Working with' : 'Worked with'} {assignments.length === 1 ? 'a teammate' : `${assignments.length} teammates`}
        </span>
        {result?.isError && <span className="team-error">{result.output}</span>}
      </div>
      {assignments.map((a, i) => {
        const bot = findBot(bots, String(a.bot ?? ''));
        const live = bot ? progress?.[bot.id] : undefined;
        const answer = finished.find((f) => (bot ? f.head.endsWith(bot.name) : f.head.includes(String(a.bot)))) ?? finished[i];
        const state: 'working' | 'done' | 'error' = answer ? (answer.failed ? 'error' : 'done') : live?.status ?? (busy ? 'working' : result ? 'error' : 'working');
        return <Teammate key={i} name={bot?.name ?? String(a.bot)} emoji={bot?.emoji ?? '🤖'} task={String(a.task ?? '')} state={state} live={live} answer={answer?.body} />;
      })}
    </div>
  );
}

function Teammate({ name, emoji, task, state, live, answer }: { name: string; emoji: string; task: string; state: 'working' | 'done' | 'error'; live?: TeammateProgress; answer?: string }) {
  const [open, setOpen] = useState(false);
  const tail = live?.text.trim().split('\n').filter(Boolean).at(-1)?.replace(/[*_#`>]/g, '').slice(-160);
  return (
    <div className={`teammate ${state}`}>
      <button className="teammate-head" onClick={() => answer && setOpen((o) => !o)} aria-expanded={answer ? open : undefined} disabled={!answer}>
        <span className="teammate-emoji">{emoji}</span>
        <span className="teammate-main">
          <span className="teammate-name">{name}</span>
          <span className="teammate-task">{task}</span>
        </span>
        <span className="teammate-state">
          {state === 'working' ? <Loader2 size={14} className="spin" /> : state === 'error' ? <AlertTriangle size={14} /> : <Check size={14} />}
        </span>
        {answer && (open ? <ChevronDown size={14} className="muted" /> : <ChevronRight size={14} className="muted" />)}
      </button>
      {state === 'working' && (live?.tool || tail) && (
        <div className="teammate-live">
          {live?.tool && <div className="teammate-tool">{live.tool}</div>}
          {tail && <div className="teammate-tail">{tail}</div>}
        </div>
      )}
      {state === 'error' && live?.error && !answer && <div className="teammate-live teammate-tool">{live.error}</div>}
      {open && answer && (
        <div className="teammate-answer">
          <Markdown text={answer} />
        </div>
      )}
    </div>
  );
}
