// Subagents: a bot splits off focused parts of its work to copies of itself. Each starts with a clean
// context and the same tools, works in parallel with the others, and reports back.
import { Tool, ToolError } from '../tools/types.js';

const MAX_SUBAGENTS = 6;

export interface SubagentTask {
  title: string;
  task: string;
}

/** Progress events for subagent `i` of a call use this id in place of a teammate's bot id. */
export const subagentId = (i: number) => `subagent-${i + 1}`;

/** The Subagents tool. `run` performs one task and resolves to the subagent's final answer. */
export function subagentsTool(run: (task: SubagentTask, index: number, callId: string, signal?: AbortSignal) => Promise<string>): Tool<{ tasks: SubagentTask[] }> {
  return {
    name: 'Subagents',
    kind: 'read',
    description:
      'Hand focused parts of your work to subagents: copies of you, each starting with a clean context and your tools, ' +
      'that work at the same time and report back. Use them for independent pieces of a larger task (research several ' +
      'topics, review several files, try several approaches) or to keep long explorations out of your own context. ' +
      'Subagents don’t see this conversation, so give each a complete, self-contained task and say what its result should ' +
      'contain. Do simple things yourself. Then combine their results into your answer.',
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_SUBAGENTS,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'A short name for the task, shown to the user (3–6 words)' },
              task: { type: 'string', description: 'What to do, with all the context needed and the form the result should take' },
            },
            required: ['title', 'task'],
          },
        },
      },
      required: ['tasks'],
    },
    summarize: (a) => (Array.isArray(a.tasks) ? a.tasks.map((t) => t?.title).filter(Boolean).join(', ') : ''),
    async run(a, ctx) {
      const tasks = Array.isArray(a.tasks) ? a.tasks : [];
      if (!tasks.length) throw new ToolError('Give at least one task');
      if (tasks.length > MAX_SUBAGENTS) throw new ToolError(`At most ${MAX_SUBAGENTS} subagents per call`);
      const clean = tasks.map((t, i) => {
        const task = String(t?.task ?? '').trim();
        if (!task) throw new ToolError(`Task ${i + 1} is empty`);
        return { title: String(t?.title ?? '').trim() || `Task ${i + 1}`, task };
      });
      const results = await Promise.allSettled(clean.map((t, i) => run(t, i, ctx.callId ?? '', ctx.signal)));
      if (ctx.signal?.aborted) throw new ToolError('Stopped');
      return results
        .map((r, i) =>
          r.status === 'fulfilled'
            ? `## ${clean[i].title}\n${r.value.trim() || '(No answer)'}`
            : `## ${clean[i].title} (failed)\n${(r.reason as Error)?.message ?? String(r.reason)}`,
        )
        .join('\n\n');
    },
  };
}
