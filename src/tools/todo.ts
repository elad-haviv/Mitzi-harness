import { Todo, Tool, ToolError } from './types.js';

interface TodoArgs {
  todos: Todo[];
}

const STATUSES = new Set(['pending', 'in_progress', 'completed']);

export const todoTool: Tool<TodoArgs> = {
  name: 'TodoWrite',
  kind: 'read',
  description:
    'Create or replace the task list for the current job. Use it for multi-step work (3+ steps): plan the steps, ' +
    'mark exactly one item in_progress while working on it, and mark items completed as soon as they are done. ' +
    'Always send the full list.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  summarize: (a) => `${a.todos?.length ?? 0} items`,
  async run(args, ctx) {
    if (!Array.isArray(args.todos)) throw new ToolError('todos must be an array');
    for (const t of args.todos) {
      if (typeof t?.content !== 'string' || !STATUSES.has(t.status)) {
        throw new ToolError('Each todo needs a string content and a status of pending, in_progress or completed');
      }
    }
    ctx.todos = args.todos.map((t) => ({ content: t.content, status: t.status }));
    ctx.onTodos?.(ctx.todos);
    const done = ctx.todos.filter((t) => t.status === 'completed').length;
    return `Todo list updated (${done}/${ctx.todos.length} completed).`;
  },
};
