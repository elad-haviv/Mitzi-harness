import { isAbsolute, resolve } from 'node:path';

/** What a tool can do, which decides whether it needs the user's permission. */
export type ToolKind = 'read' | 'edit' | 'exec' | 'network';

export interface Todo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface ToolContext {
  cwd: string;
  /** Absolute path → mtimeMs at the time the agent last read or wrote it. */
  readFiles: Map<string, number>;
  todos: Todo[];
  signal?: AbortSignal;
  /** Id of the tool call currently running. */
  callId?: string;
  onTodos?(todos: Todo[]): void;
}

export interface Tool<A = any> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  kind: ToolKind;
  /** One-line description of a call, shown next to the tool name. */
  summarize(args: A, ctx: ToolContext): string;
  /** Why a call is risky enough to ask about even in the `sensitive` mode; undefined when it's safe. */
  sensitive?(args: A, ctx: ToolContext): string | undefined;
  /** Optional longer preview (e.g. a diff) shown when asking for permission. */
  preview?(args: A, ctx: ToolContext): Promise<string | undefined>;
  run(args: A, ctx: ToolContext): Promise<string>;
}

/** An error whose message is reported back to the model as the tool result. */
export class ToolError extends Error {}

export function resolvePath(ctx: ToolContext, p: string): string {
  if (typeof p !== 'string' || !p) throw new ToolError('A file path is required');
  if (p.startsWith('~/')) p = `${process.env.HOME ?? ''}/${p.slice(2)}`;
  return isAbsolute(p) ? p : resolve(ctx.cwd, p);
}

export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  const dropped = text.length - max;
  return `${text.slice(0, half)}\n\n… [${dropped} characters truncated] …\n\n${text.slice(-half)}`;
}
