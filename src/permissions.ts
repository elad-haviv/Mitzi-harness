import type { PermissionMode } from './config.js';
import type { Tool, ToolContext } from './tools/index.js';
import { color } from './ui.js';

export type Asker = (question: string, signal?: AbortSignal) => Promise<string>;

export type Decision =
  | { allow: true }
  /** `stop` ends the agent's turn so the user can redirect it. */
  | { allow: false; reason: string; stop: boolean };

export interface ApprovalRequest {
  tool: Tool;
  args: any;
  summary: string;
  preview?: string;
  /** The rule that "always allow" would add, e.g. `Bash(npm)`. */
  alwaysRule: string;
  callId?: string;
}

export type ApprovalAnswer = { kind: 'yes' } | { kind: 'always' } | { kind: 'no' } | { kind: 'feedback'; text: string };

/** Asks the user about one tool call. Rejecting (e.g. on abort) counts as an interruption. */
export type Approver = (req: ApprovalRequest, signal?: AbortSignal) => Promise<ApprovalAnswer>;

export interface PermissionChecker {
  mode: PermissionMode;
  check(tool: Tool, args: any, ctx: ToolContext, signal?: AbortSignal, callId?: string): Promise<Decision>;
}

// A prefix rule must never approve a command that chains in something else.
const SHELL_CONTROL = /[;&|`<>\n]|\$\(/;

export function ruleMatches(rule: string, tool: Tool, args: any): boolean {
  const m = /^(\w+)(?:\((.*)\))?$/.exec(rule.trim());
  if (!m || m[1] !== tool.name) return false;
  const prefix = m[2];
  if (prefix === undefined || prefix === '*') return true;
  if (tool.name !== 'Bash') return false;
  const command = String(args?.command ?? '').trim();
  if (SHELL_CONTROL.test(command)) return false;
  return command === prefix || command.startsWith(`${prefix} `);
}

export function alwaysRuleFor(tool: Tool, args: any): string {
  if (tool.name !== 'Bash') return tool.name;
  const first = String(args?.command ?? '').trim().split(/\s+/)[0];
  return first && !SHELL_CONTROL.test(first) ? `Bash(${first})` : 'Bash';
}

export class Permissions implements PermissionChecker {
  readonly sessionRules: string[] = [];

  constructor(
    public mode: PermissionMode,
    private readonly rules: string[] = [],
    /** Asks the user; absent in non-interactive mode. */
    private readonly approver?: Approver,
  ) {}

  async check(tool: Tool, args: any, ctx: ToolContext, signal?: AbortSignal, callId?: string): Promise<Decision> {
    if (tool.kind === 'read' || this.mode === 'yolo') return { allow: true };
    if (this.mode === 'plan') {
      return {
        allow: false,
        stop: false,
        reason: 'Plan mode is active: only read-only tools may be used. Investigate, then present a plan for the user to approve.',
      };
    }
    if (this.mode === 'acceptEdits' && tool.kind === 'edit') return { allow: true };
    if ([...this.rules, ...this.sessionRules].some((r) => ruleMatches(r, tool, args))) return { allow: true };

    if (!this.approver) {
      return {
        allow: false,
        stop: false,
        reason: `Permission to use ${tool.name} was not granted (non-interactive mode). The user can allow it with --allow "${tool.name}" or --yolo.`,
      };
    }

    const alwaysRule = alwaysRuleFor(tool, args);
    const preview = await tool.preview?.(args, ctx).catch(() => undefined);
    let summary = '';
    try {
      summary = tool.summarize(args, ctx);
    } catch {
      // Malformed args; the tool itself will report them.
    }

    let answer: ApprovalAnswer;
    try {
      answer = await this.approver({ tool, args, summary, preview, alwaysRule, callId }, signal);
    } catch {
      return { allow: false, stop: true, reason: 'The user interrupted the permission prompt.' };
    }
    switch (answer.kind) {
      case 'yes':
        return { allow: true };
      case 'always':
        this.sessionRules.push(alwaysRule);
        return { allow: true };
      case 'no':
        return { allow: false, stop: true, reason: 'The user declined this tool call. Stop and wait for their instructions.' };
      case 'feedback':
        return { allow: false, stop: false, reason: `The user declined this tool call and said: ${answer.text}` };
    }
  }
}

/** Approver that prints a diff preview and reads y/a/n (or feedback) from a terminal prompt. */
export function terminalApprover(ask: Asker, write: (s: string) => void = (s) => process.stdout.write(s)): Approver {
  return async ({ tool, summary, preview, alwaysRule }, signal) => {
    write(`\n${color.yellow('?')} ${color.bold(tool.name)}${color.dim(`(${summary})`)}\n`);
    if (preview) {
      const lines = preview.split('\n');
      const shown = lines.slice(0, 40).map((l) => (l.startsWith('+ ') ? color.green(l) : l.startsWith('- ') ? color.red(l) : color.dim(l)));
      if (lines.length > 40) shown.push(color.dim(`… +${lines.length - 40} lines`));
      write(shown.map((l) => `    ${l}`).join('\n') + '\n');
    }
    const answer = (
      await ask(`  Allow? ${color.bold('y')}es / ${color.bold('a')}lways allow ${color.dim(alwaysRule)} / ${color.bold('n')}o, or type feedback: `, signal)
    ).trim();
    const lower = answer.toLowerCase();
    if (lower === 'y' || lower === 'yes' || lower === '') return { kind: 'yes' };
    if (lower === 'a' || lower === 'always') return { kind: 'always' };
    if (lower === 'n' || lower === 'no') return { kind: 'no' };
    return { kind: 'feedback', text: answer };
  };
}
