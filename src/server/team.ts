// Orchestration: a bot hands self-contained tasks to other bots, which work in parallel with their
// own instructions, model, tools and memory, and report back to it.
import type { Bot } from '../shared/types.js';
import { Tool, ToolError } from '../tools/types.js';

const MAX_ASSIGNMENTS = 6;

export interface Assignment {
  bot: string;
  task: string;
}

/** A teammate named by id, name or "emoji name"; loose matches last. */
export function findTeammate(team: Bot[], ref: string): Bot | undefined {
  const q = ref.trim().toLowerCase();
  if (!q) return undefined;
  return (
    team.find((b) => b.id === ref.trim()) ??
    team.find((b) => b.name.toLowerCase() === q || `${b.emoji} ${b.name}`.toLowerCase() === q) ??
    team.find((b) => b.name.toLowerCase().includes(q) || q.includes(b.name.toLowerCase()))
  );
}

export function teamPrompt(team: Bot[]): string {
  return (
    '# Your team\n' +
    'You can hand tasks to these bots with the Delegate tool:\n' +
    team.map((b) => `- ${b.emoji} ${b.name}${b.description ? `: ${b.description}` : ''}`).join('\n') +
    '\n\nDelegate when parts of a task fit a teammate’s specialty, or when independent parts can be done at the same time ' +
    '(for example research, drafting and reviewing). Answer simple requests yourself. Teammates don’t see this ' +
    'conversation, so give each one a complete task with all the context it needs. Bots in one Delegate call work at the ' +
    'same time; for steps that depend on earlier results, call Delegate again and include those results. Then combine ' +
    'their work into your own answer to the user.'
  );
}

/** The Delegate tool. `run` performs one assignment and resolves to the teammate's final answer. */
export function delegateTool(team: Bot[], run: (bot: Bot, task: string, callId: string, signal?: AbortSignal) => Promise<string>): Tool<{ assignments: Assignment[] }> {
  const names = team.map((b) => b.name);
  return {
    name: 'Delegate',
    kind: 'read',
    description:
      'Hand tasks to other bots on your team and get their results back. All assignments in one call run in parallel. ' +
      'Each task must be self-contained: teammates don’t see this conversation.',
    parameters: {
      type: 'object',
      properties: {
        assignments: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_ASSIGNMENTS,
          items: {
            type: 'object',
            properties: {
              bot: { type: 'string', enum: names, description: 'The teammate’s name' },
              task: { type: 'string', description: 'What to do, with all the context needed and the form the result should take' },
            },
            required: ['bot', 'task'],
          },
        },
      },
      required: ['assignments'],
    },
    summarize: (a) => (Array.isArray(a.assignments) ? a.assignments.map((x) => findTeammate(team, String(x?.bot ?? ''))?.name ?? x?.bot).join(', ') : ''),
    async run(a, ctx) {
      const list = Array.isArray(a.assignments) ? a.assignments : [];
      if (!list.length) throw new ToolError('Give at least one assignment');
      if (list.length > MAX_ASSIGNMENTS) throw new ToolError(`At most ${MAX_ASSIGNMENTS} assignments per call`);
      const resolved = list.map((x) => {
        const bot = findTeammate(team, String(x?.bot ?? ''));
        if (!bot) throw new ToolError(`No teammate called "${x?.bot}". Your team: ${names.join(', ')}`);
        if (!String(x?.task ?? '').trim()) throw new ToolError(`The task for ${bot.name} is empty`);
        return { bot, task: String(x.task) };
      });
      const results = await Promise.allSettled(resolved.map(({ bot, task }) => run(bot, task, ctx.callId ?? '', ctx.signal)));
      if (ctx.signal?.aborted) throw new ToolError('Stopped');
      return results
        .map((r, i) => {
          const { bot } = resolved[i];
          return r.status === 'fulfilled'
            ? `## ${bot.emoji} ${bot.name}\n${r.value.trim() || '(No answer)'}`
            : `## ${bot.emoji} ${bot.name} (failed)\n${(r.reason as Error)?.message ?? String(r.reason)}`;
        })
        .join('\n\n');
    },
  };
}
