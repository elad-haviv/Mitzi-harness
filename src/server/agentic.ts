// Work mode, plans (/plan) and goals (/goal, /subgoal): the parts of a chat that take on a task and
// keep at it, as opposed to answering one message.
import type { LlmClient } from '../openrouter.js';
import type { Chat, Goal, Plan, Subgoal } from '../shared/types.js';
import { Tool, ToolError } from '../tools/types.js';
import { newId, now } from './store.js';

export const DEFAULT_GOAL_TURNS = 20;

/** Built-in slash commands handled by Mitzi itself (the rest come from plugins and the user). */
export const BUILTIN_COMMANDS = [
  { name: 'plan', description: 'Make a plan first: look around without changing anything, then propose steps to approve', argumentHint: '<what to plan>' },
  { name: 'goal', description: 'Set a goal and keep working, turn after turn, until it is met (pause, resume, clear)', argumentHint: '<goal> | pause | resume | clear' },
  { name: 'subgoal', description: 'Add a milestone to the current goal (or "done <number>")', argumentHint: '<milestone>' },
  { name: 'btw', description: 'Ask a quick side question; the answer isn’t added to the chat', argumentHint: '<question>' },
  { name: 'compare', description: 'Send one prompt to two models side by side, then pick the winner', argumentHint: '[modelA] [modelB] <prompt>' },
];

export type Builtin = { name: 'plan' | 'goal' | 'subgoal' | 'btw' | 'compare'; args: string };

export function parseBuiltin(text: string): Builtin | undefined {
  const m = /^\/(plan|goal|subgoal|btw|compare)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return m ? { name: m[1] as Builtin['name'], args: (m[2] ?? '').trim() } : undefined;
}

export function newGoal(text: string, maxTurns = DEFAULT_GOAL_TURNS): Goal {
  return { text, status: 'active', subgoals: [], turns: 0, maxTurns, createdAt: now() };
}

export function addSubgoal(goal: Goal, text: string): Subgoal {
  const sub = { id: String(goal.subgoals.length + 1), text, done: false };
  goal.subgoals.push(sub);
  return sub;
}

export const WORK_PROMPT = `# Work mode
The user gave you a task to carry out, not just a question. Work like a capable colleague:
- For anything with several steps, start with TodoWrite: list the steps, keep exactly one in progress, and mark each \
completed as soon as it's done.
- Use your tools to do the work rather than describing what you would do. Check your results.
- Keep going until the task is done; ask only when you're blocked by something only the user can decide.
- Finish with a short summary of what you did and anything left open.`;

export const PLAN_PROMPT = `# Plan mode
The user wants a plan before any work starts. Look around as much as you need with the tools you have (they can't \
change anything), then call SubmitPlan with a clear, numbered plan: what you'll do, in which order, and anything the \
user should decide first. Don't carry out the plan. After submitting it, end your turn with one short sentence.`;

export function planPrompt(plan: Plan): string {
  return `# Approved plan\nThe user approved this plan. Carry it out step by step, keeping the task list up to date:\n\n${plan.text}`;
}

export function goalPrompt(goal: Goal): string {
  const subs = goal.subgoals.length ? `\n\nMilestones:\n${goal.subgoals.map((s) => `${s.id}. [${s.done ? 'x' : ' '}] ${s.text}`).join('\n')}` : '';
  return (
    `# Goal\nYou are working toward this goal and will keep getting turns until it's met:\n${goal.text}${subs}\n\n` +
    'Make real progress each turn. Use the Goal tool to mark milestones done (or add ones you discover). When the goal ' +
    'is fully met, say so plainly and show the evidence.' +
    (goal.lastCheck ? `\n\nLast check: ${goal.lastCheck}` : '')
  );
}

export function todosPrompt(chat: Chat): string | undefined {
  if (!chat.todos?.length) return undefined;
  const mark = { pending: ' ', in_progress: '~', completed: 'x' } as const;
  return `# Task list\nYour current task list (update it with TodoWrite):\n${chat.todos.map((t) => `- [${mark[t.status]}] ${t.content}`).join('\n')}`;
}

/** SubmitPlan: how the bot hands over a plan in plan mode. */
export function submitPlanTool(chat: Chat, request: string, onPlan: (plan: Plan) => void): Tool<{ plan: string; steps?: string[] }> {
  return {
    name: 'SubmitPlan',
    kind: 'read',
    description: 'Submit your plan for the user to approve. `plan` is the full plan in Markdown; `steps` lists its steps in order, briefly.',
    parameters: {
      type: 'object',
      properties: { plan: { type: 'string' }, steps: { type: 'array', items: { type: 'string' } } },
      required: ['plan'],
    },
    summarize: (a) => `${a.steps?.length ?? 0} steps`,
    async run(a) {
      if (!String(a.plan ?? '').trim()) throw new ToolError('The plan is empty');
      const steps = Array.isArray(a.steps) && a.steps.length ? a.steps.map(String) : stepsFrom(String(a.plan));
      chat.plan = { request, text: String(a.plan).trim(), steps, status: 'proposed', createdAt: now() };
      onPlan(chat.plan);
      return 'Plan submitted. The user will approve it or ask for changes.';
    },
  };
}

/** Numbered or bulleted lines of a Markdown plan. */
export function stepsFrom(markdown: string): string[] {
  const numbered = [...markdown.matchAll(/^\s*\d+[.)]\s+(.+)$/gm)].map((m) => m[1].replace(/\*\*/g, '').trim());
  return numbered.length ? numbered : [...markdown.matchAll(/^\s*[-*]\s+(.+)$/gm)].map((m) => m[1].replace(/\*\*/g, '').trim());
}

/** Goal: lets the bot check off and add milestones of the chat's goal. */
export function goalTool(goal: Goal, onChange: () => void): Tool<{ action: 'complete' | 'add'; id?: string; text?: string }> {
  return {
    name: 'Goal',
    kind: 'read',
    description: 'Update the milestones of the current goal: mark one done ("complete" with its id) or add one ("add" with text).',
    parameters: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['complete', 'add'] }, id: { type: 'string' }, text: { type: 'string' } },
      required: ['action'],
    },
    summarize: (a) => (a.action === 'add' ? `add: ${a.text ?? ''}` : `complete ${a.id ?? ''}`),
    async run(a) {
      if (a.action === 'add') {
        if (!a.text?.trim()) throw new ToolError('Give the milestone text');
        const sub = addSubgoal(goal, a.text.trim());
        onChange();
        return `Added milestone ${sub.id}.`;
      }
      const sub = goal.subgoals.find((s) => s.id === String(a.id));
      if (!sub) throw new ToolError(`No milestone ${a.id}. Milestones: ${goal.subgoals.map((s) => s.id).join(', ') || 'none'}`);
      sub.done = true;
      onChange();
      return `Milestone ${sub.id} done.`;
    },
  };
}

/** Asks a model whether the goal is met, given the latest work. Unparseable answers count as "not yet". */
export async function checkGoal(client: LlmClient, model: string, goal: Goal, work: string, signal?: AbortSignal): Promise<{ met: boolean; done: string[]; reason: string }> {
  const subs = goal.subgoals.map((s) => `${s.id}. [${s.done ? 'x' : ' '}] ${s.text}`).join('\n');
  const prompt =
    `You check whether an AI assistant has fully achieved a goal. Be strict: "met" only when the work clearly and completely ` +
    `achieves it, not when it's planned or partly done.\n\nGoal:\n${goal.text}\n\n${subs ? `Milestones:\n${subs}\n\n` : ''}` +
    `The assistant's latest work:\n<work>\n${work.slice(-8000)}\n</work>\n\n` +
    'Reply with JSON only: {"met": true|false, "done_milestones": ["<ids now done>"], "reason": "<one sentence: what is done or still missing>"}';
  const res = await client.chat({ model, messages: [{ role: 'user', content: prompt }], maxTokens: 300, signal });
  try {
    const json = JSON.parse(/\{[\s\S]*\}/.exec(res.content)?.[0] ?? '');
    return { met: json.met === true, done: Array.isArray(json.done_milestones) ? json.done_milestones.map(String) : [], reason: String(json.reason ?? '').slice(0, 400) };
  } catch {
    return { met: false, done: [], reason: 'The check could not decide.' };
  }
}

export const newSubgoalId = () => newId();
