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
  cyan: wrap('36'),
  gray: wrap('90'),
};

export interface UI {
  startThinking(): void;
  stopThinking(): void;
  text(chunk: string): void;
  reasoning(chunk: string): void;
  toolCall(name: string, summary: string): void;
  toolResult(output: string, isError: boolean): void;
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
      this.log.write(`\r${color.magenta(SPINNER[i++ % SPINNER.length])} ${color.dim('Thinking…')}`);
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

/** Hard-wraps text into pane rows, keeping at most maxRows with an overflow marker. */
function wrapPane(text: string, width: number, maxRows: number): string[] {
  const all: string[] = [];
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    if (!raw) {
      all.push('');
      continue;
    }
    for (let i = 0; i < raw.length; i += width) all.push(raw.slice(i, i + width));
  }
  while (all.length && all[all.length - 1] === '') all.pop();
  if (all.length <= maxRows) return all;
  return [...all.slice(0, maxRows - 1), `… +${all.length - (maxRows - 1)} more lines`];
}

/**
 * Live side-by-side renderer for /compare: A and B stream into two columns that
 * are redrawn in place with cursor controls. Without a TTY (tests, pipes) it
 * degrades to printing both answers once they finish.
 */
export class CompareUI {
  private static readonly MAX_ROWS = 20;

  private textA = '';
  private textB = '';
  private doneA = false;
  private doneB = false;
  private readonly startedAt = Date.now();
  private endedA?: number;
  private endedB?: number;
  private paintedRows = 0;
  private ticks = 0;
  private ticker?: NodeJS.Timeout;
  private flush?: NodeJS.Timeout;
  private dirty = false;

  constructor(
    private readonly labelA: string,
    private readonly labelB: string,
    private readonly out: Writable & { isTTY?: boolean } = process.stdout,
  ) {}

  private get live(): boolean {
    return !!this.out.isTTY;
  }

  start(): void {
    this.out.write(`  ${color.bold('A')} ${color.dim(this.labelA)}    ${color.bold('B')} ${color.dim(this.labelB)}\n`);
    if (!this.live) return;
    this.out.write(`  ${color.dim('Both answers stream below — Ctrl+C skips the race entirely.')}\n`);
    this.ticker = setInterval(() => this.schedule(), 150);
  }

  pushA(chunk: string): void {
    this.textA += chunk;
    this.schedule();
  }

  pushB(chunk: string): void {
    this.textB += chunk;
    this.schedule();
  }

  endA(): void {
    this.doneA = true;
    this.endedA ??= Date.now();
    this.schedule();
  }

  endB(): void {
    this.doneB = true;
    this.endedB ??= Date.now();
    this.schedule();
  }

  /** Marks a side as failed, showing the error in its column. */
  failA(message: string): void {
    this.textA = `${this.textA ? `${this.textA}\n` : ''}⚠ ${message}`;
    this.endA();
  }

  failB(message: string): void {
    this.textB = `${this.textB ? `${this.textB}\n` : ''}⚠ ${message}`;
    this.endB();
  }

  /** Final paint once both sides settled; returns per-side elapsed seconds. */
  finish(): { a: number; b: number } {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
    if (this.flush) {
      clearTimeout(this.flush);
      this.flush = undefined;
    }
    const elapsed = (ended?: number) => ((ended ?? Date.now()) - this.startedAt) / 1000;
    const result = { a: elapsed(this.endedA), b: elapsed(this.endedB) };
    if (!this.live) {
      const rule = color.dim('─'.repeat(60));
      this.out.write(
        `  ${rule}\n` +
          `${color.bold('A')} ${color.dim(this.labelA)}\n${this.textA || color.dim('(no output)')}\n` +
          `${color.bold('B')} ${color.dim(this.labelB)}\n${this.textB || color.dim('(no output)')}\n`,
      );
      return result;
    }
    this.repaint();
    return result;
  }

  private schedule(): void {
    if (!this.live || (this.doneA && this.doneB)) return;
    this.dirty = true;
    if (this.flush) return;
    this.flush = setTimeout(() => {
      this.flush = undefined;
      if (this.dirty) this.repaint();
    }, 60);
  }

  private repaint(): void {
    this.dirty = false;
    const w = this.width();
    const paneA = wrapPane(this.textA, w, CompareUI.MAX_ROWS);
    const paneB = wrapPane(this.textB, w, CompareUI.MAX_ROWS);
    const rows = Math.max(paneA.length, paneB.length, 1);
    const spinner = SPINNER[this.ticks++ % SPINNER.length];
    const elapsed = (ended?: number) => ((ended ?? Date.now()) - this.startedAt) / 1000;
    const status = (done: boolean, ended?: number) =>
      done ? `${color.green('✓')} ${elapsed(ended).toFixed(1)}s` : `${color.magenta(spinner)} ${color.dim(`${elapsed().toFixed(1)}s…`)}`;
    const rule = '─'.repeat(w);
    const block: string[] = [`  ${color.gray(rule)}   ${color.gray(rule)}`];
    for (let i = 0; i < rows; i++) {
      block.push(`  ${(paneA[i] ?? '').padEnd(w)}${color.gray(' │ ')}${paneB[i] ?? ''}`);
    }
    block.push(`  ${color.gray(rule)}   ${color.gray(rule)}`);
    block.push(`  ${status(this.doneA, this.endedA)}    ${status(this.doneB, this.endedB)}`);

    if (this.paintedRows > 0) this.out.write(`\x1b[${this.paintedRows}A`);
    this.out.write(block.map((line) => `${line}\x1b[K\n`).join(''));
    if (block.length < this.paintedRows) this.out.write('\x1b[J');
    this.paintedRows = block.length;
  }

  private width(): number {
    const cols = (this.out as { columns?: number }).columns ?? 100;
    return Math.max(24, Math.min(80, Math.floor((cols - 6) / 2)));
  }
}
