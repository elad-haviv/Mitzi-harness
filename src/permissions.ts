import type { PermissionMode } from './config.js';
import type { Tool, ToolContext } from './tools/index.js';
import { color } from './ui.js';

export type Asker = (question: string, signal?: AbortSignal) => Promise<string>;

export type Decision =
  | { allow: true }
  /** `stop` ends the agent's turn so the user can redirect it. */
  | { allow: false; reason: string; stop: boolean };

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

export class Permissions {
  private readonly sessionRules: string[] = [];

  constructor(
    public mode: PermissionMode,
    private readonly rules: string[] = [],
    /** Prompts the user; absent in non-interactive mode. */
    private readonly ask?: Asker,
    private readonly write: (s: string) => void = (s) => process.stdout.write(s),
  ) {}

  async check(tool: Tool, args: any, ctx: ToolContext, signal?: AbortSignal): Promise<Decision> {
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

    if (!this.ask) {
      return {
        allow: false,
        stop: false,
        reason: `Permission to use ${tool.name} was not granted (non-interactive mode). The user can allow it with --allow "${tool.name}" or --yolo.`,
      };
    }

    const preview = await tool.preview?.(args, ctx).catch(() => undefined);
    this.write(`\n${color.yellow('?')} ${color.bold(tool.name)}${color.dim(`(${tool.summarize(args, ctx)})`)}\n`);
    if (preview) {
      const lines = preview.split('\n');
      const shown = lines.slice(0, 40).map((l) => (l.startsWith('+ ') ? color.green(l) : l.startsWith('- ') ? color.red(l) : color.dim(l)));
      if (lines.length > 40) shown.push(color.dim(`… +${lines.length - 40} lines`));
      this.write(shown.map((l) => `    ${l}`).join('\n') + '\n');
    }

    const always = this.alwaysRule(tool, args);
    let answer: string;
    try {
      answer = (await this.ask(`  Allow? ${color.bold('y')}es / ${color.bold('a')}lways allow ${color.dim(always)} / ${color.bold('n')}o, or type feedback: `, signal)).trim();
    } catch {
      return { allow: false, stop: true, reason: 'The user interrupted the permission prompt.' };
    }
    const lower = answer.toLowerCase();
    if (lower === 'y' || lower === 'yes' || lower === '') return { allow: true };
    if (lower === 'a' || lower === 'always') {
      this.sessionRules.push(always);
      return { allow: true };
    }
    if (lower === 'n' || lower === 'no') {
      return { allow: false, stop: true, reason: 'The user declined this tool call. Stop and wait for their instructions.' };
    }
    return { allow: false, stop: false, reason: `The user declined this tool call and said: ${answer}` };
  }

  private alwaysRule(tool: Tool, args: any): string {
    if (tool.name !== 'Bash') return tool.name;
    const first = String(args?.command ?? '').trim().split(/\s+/)[0];
    return first && !SHELL_CONTROL.test(first) ? `Bash(${first})` : 'Bash';
  }
}
