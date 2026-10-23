import type { Writable } from 'node:stream';
import type { Todo } from './tools/types.js';

const colorEnabled = !process.env.NO_COLOR && (process.stdout.isTTY || !!process.env.FORCE_COLOR);
const wrap = (code: string) => (s: string) => (colorEnabled ? `\x1b[${code}m${s}\x1b[0m` : s);

export const color = {
  bold: wrap('1'),
  dim: wrap('2'),
  italic: wrap('3'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  magenta: wrap('35'),
  /** Mitzi's brand color (256-color ginger). */
  orange: wrap('38;5;208'),
  cyan: wrap('36'),
  gray: wrap('90'),
};

export interface UI {
  startThinking(): void;
  stopThinking(): void;
  text(chunk: string): void;
  reasoning(chunk: string): void;
  toolCall(name: string, summary: string, id?: string, args?: unknown): void;
  toolResult(output: string, isError: boolean, id?: string): void;
  todos(todos: Todo[]): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  endTurn(): void;
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Renders the conversation to a terminal. Assistant text goes to `out`;
 * everything else (tool activity, status) goes to `log`, so print mode can
 * pipe clean model output from stdout.
 */
export class TerminalUI implements UI {
  private spinner?: NodeJS.Timeout;
  private textAtLineStart = true;
  private inReasoning = false;

  constructor(
    private readonly out: Writable & { isTTY?: boolean } = process.stdout,
    private readonly log: Writable & { isTTY?: boolean } = process.stdout,
    public showReasoning = false,
  ) {}

  startThinking(): void {
    if (!this.log.isTTY || this.spinner) return;
    let i = 0;
    this.spinner = setInterval(() => {
      this.log.write(`\r${color.orange(SPINNER[i++ % SPINNER.length])} ${color.dim('Thinking…')}`);
    }, 80);
  }

  stopThinking(): void {
    if (!this.spinner) return;
    clearInterval(this.spinner);
    this.spinner = undefined;
    this.log.write('\r\x1b[K');
  }

  text(chunk: string): void {
    this.stopThinking();
    if (this.inReasoning) {
      this.log.write('\n');
      this.inReasoning = false;
    }
    this.out.write(chunk);
    this.textAtLineStart = chunk.endsWith('\n');
  }

  reasoning(chunk: string): void {
    if (!this.showReasoning) return;
    this.stopThinking();
    this.inReasoning = true;
    this.log.write(color.dim(color.italic(chunk)));
  }

  private breakLine(): void {
    this.stopThinking();
    if (this.inReasoning) {
      this.log.write('\n');
      this.inReasoning = false;
    }
    if (!this.textAtLineStart) {
      this.out.write('\n');
      this.textAtLineStart = true;
    }
  }

  toolCall(name: string, summary: string): void {
    this.breakLine();
    this.log.write(`${color.green('⏺')} ${color.bold(name)}${summary ? color.dim(`(${summary})`) : ''}\n`);
  }

  toolResult(output: string, isError: boolean): void {
    const lines = output.split('\n');
    const shown = lines.slice(0, 4).map((l) => (l.length > 160 ? `${l.slice(0, 160)}…` : l));
    if (lines.length > 4) shown.push(`… +${lines.length - 4} lines`);
    const paint = isError ? color.red : color.gray;
    this.log.write(shown.map((l, i) => `  ${i === 0 ? '⎿' : ' '}  ${paint(l)}`).join('\n') + '\n');
  }

  todos(todos: Todo[]): void {
    this.breakLine();
    for (const t of todos) {
      const mark = t.status === 'completed' ? color.green('☒') : t.status === 'in_progress' ? color.yellow('◐') : '☐';
      const label = t.status === 'completed' ? color.dim(t.content) : t.status === 'in_progress' ? color.bold(t.content) : t.content;
      this.log.write(`    ${mark} ${label}\n`);
    }
  }

  info(msg: string): void {
    this.breakLine();
    this.log.write(`${color.cyan(msg)}\n`);
  }

  warn(msg: string): void {
    this.breakLine();
    this.log.write(`${color.yellow(msg)}\n`);
  }

  error(msg: string): void {
    this.breakLine();
    this.log.write(`${color.red(`✗ ${msg}`)}\n`);
  }

  endTurn(): void {
    this.breakLine();
  }
}
