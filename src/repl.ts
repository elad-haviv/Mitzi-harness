import * as readline from 'node:readline/promises';
import type { Agent } from './agent.js';
import { PERMISSION_MODES, PermissionMode } from './config.js';
import type { LlmClient } from './openrouter.js';
import { listSessions, newSessionId, saveSession, SessionData } from './session.js';
import { bashTool } from './tools/bash.js';
import { color, UI } from './ui.js';

export interface ReplOptions {
  agent: Agent;
  client: LlmClient;
  ui: UI;
  rl: readline.Interface;
  session: SessionData;
  initialPrompt?: string;
}

const INIT_PROMPT = `Analyze this codebase and create a MITZI.md file at the repository root to guide future coding agents working here. Include:
- Commands to build, lint, and run tests (including how to run a single test).
- A high-level overview of the architecture and how the main pieces fit together, focusing on what requires reading several files to understand.
- Important conventions that aren't obvious from a single file.
Keep it concise; don't list every file or include generic advice. If a MITZI.md, CLAUDE.md, AGENTS.md, README or similar already exists, build on it rather than duplicating it.`;

const HELP = `
${color.bold('Commands')}
  /help                Show this help
  /clear               Start a new conversation
  /compact [focus]     Summarize the conversation to free up context
  /model [id]          Show or switch the model (any OpenRouter model id)
  /models [filter]     List models available on OpenRouter
  /mode [mode]         Show or set permission mode: ${PERMISSION_MODES.join(', ')}
  /cost                Show token usage and cost for this session
  /todos               Show the current todo list
  /sessions            List saved sessions for this directory
  /init                Create a MITZI.md with notes about this codebase
  /exit                Quit

${color.bold('Tips')}
  !<command>           Run a shell command; its output is added to your next message
  End a line with \\    Continue input on the next line
  Ctrl+C               Interrupt the agent; press twice at the prompt to quit
`;

export async function runRepl(opts: ReplOptions): Promise<void> {
  const { agent, client, ui, rl, session } = opts;
  let controller: AbortController | undefined;
  let exitArmed = false;
  let pendingContext: string[] = [];

  rl.on('SIGINT', () => {
    if (controller && !controller.signal.aborted) {
      controller.abort();
      ui.warn('Interrupted.');
      return;
    }
    if (exitArmed) {
      rl.close();
      return;
    }
    exitArmed = true;
    process.stdout.write(`\n${color.dim('(press Ctrl+C again to exit)')}\n`);
    rl.write(null, { ctrl: true, name: 'u' });
    rl.prompt();
  });

  const persist = () => {
    session.messages = agent.messages;
    session.model = agent.model;
    session.updatedAt = new Date().toISOString();
    try {
      saveSession(session);
    } catch (err: any) {
      ui.warn(`Could not save session: ${err.message}`);
    }
  };

  const runAgent = async (input: string) => {
    if (pendingContext.length) {
      input = `${pendingContext.join('\n\n')}\n\n${input}`;
      pendingContext = [];
    }
    if (!session.title) session.title = input.slice(0, 80).replace(/\s+/g, ' ');
    controller = new AbortController();
    try {
      await agent.run(input, controller.signal);
    } catch (err: any) {
      if (controller.signal.aborted) ui.endTurn();
      else ui.error(err?.message ?? String(err));
    } finally {
      controller = undefined;
      persist();
    }
  };

  const commands: Record<string, (arg: string) => Promise<boolean | void>> = {
    help: async () => void process.stdout.write(HELP),
    exit: async () => true,
    quit: async () => true,
    clear: async () => {
      agent.reset();
      Object.assign(session, { id: newSessionId(), title: '', createdAt: new Date().toISOString(), messages: [] });
      ui.info('Started a new conversation.');
    },
    compact: async (arg) => {
      if (!agent.messages.length) return ui.info('Nothing to compact.');
      controller = new AbortController();
      try {
        await agent.compact(arg || undefined, controller.signal);
        persist();
        ui.info('Conversation compacted.');
      } catch (err: any) {
        ui.error(`Compaction failed: ${err.message}`);
      } finally {
        controller = undefined;
      }
    },
    model: async (arg) => {
      if (!arg) return ui.info(`Current model: ${agent.model}`);
      agent.model = arg;
      ui.info(`Switched model to ${arg}`);
    },
    models: async (arg) => {
      try {
        const models = await client.listModels();
        const filter = arg.toLowerCase();
        const shown = models.filter((m) => !filter || m.id.toLowerCase().includes(filter) || m.name?.toLowerCase().includes(filter));
        for (const m of shown.slice(0, 60)) {
          const price = m.promptPrice !== undefined ? color.dim(` $${m.promptPrice.toFixed(2)}/$${(m.completionPrice ?? 0).toFixed(2)} per Mtok`) : '';
          const ctx = m.contextLength ? color.dim(` ${Math.round(m.contextLength / 1000)}k ctx`) : '';
          process.stdout.write(`  ${m.id === agent.model ? color.green('●') : ' '} ${m.id}${ctx}${price}\n`);
        }
        if (shown.length > 60) ui.info(`… ${shown.length - 60} more. Add a filter, e.g. /models claude`);
        if (!shown.length) ui.info('No models matched.');
      } catch (err: any) {
        ui.error(err.message);
      }
    },
    mode: async (arg) => {
      if (!arg) return ui.info(`Permission mode: ${agent.permissions.mode}`);
      if (!PERMISSION_MODES.includes(arg as PermissionMode)) return ui.error(`Unknown mode. Use one of: ${PERMISSION_MODES.join(', ')}`);
      agent.permissions.mode = arg as PermissionMode;
      ui.info(`Permission mode: ${arg}`);
    },
    cost: async () => {
      const u = agent.usage;
      ui.info(
        `Requests: ${u.requests}  ·  Input: ${u.promptTokens.toLocaleString()} tokens  ·  Output: ${u.completionTokens.toLocaleString()} tokens  ·  Cost: $${u.cost.toFixed(4)}`,
      );
    },
    todos: async () => (agent.ctx.todos.length ? ui.todos(agent.ctx.todos) : ui.info('No todos.')),
    sessions: async () => {
      const sessions = listSessions(agent.ctx.cwd).slice(0, 15);
      if (!sessions.length) return ui.info('No saved sessions for this directory.');
      for (const s of sessions) {
        process.stdout.write(`  ${color.cyan(s.id)}  ${color.dim(s.updatedAt.slice(0, 16).replace('T', ' '))}  ${s.title || color.dim('(untitled)')}\n`);
      }
      ui.info('Resume one with: mitzi --resume <id>');
    },
    init: async () => runAgent(INIT_PROMPT),
  };

  const handle = async (line: string): Promise<boolean> => {
    const input = line.trim();
    if (!input) return false;
    if (input.startsWith('/')) {
      const [, name, arg = ''] = /^\/(\S+)\s*([\s\S]*)$/.exec(input) ?? [];
      const command = commands[name];
      if (!command) {
        ui.error(`Unknown command /${name}. Type /help for a list.`);
        return false;
      }
      return (await command(arg.trim())) === true;
    }
    if (input.startsWith('!')) {
      const cmd = input.slice(1).trim();
      controller = new AbortController();
      agent.ctx.signal = controller.signal;
      try {
        const output = await bashTool.run({ command: cmd }, agent.ctx);
        process.stdout.write(`${color.dim(output)}\n`);
        pendingContext.push(`<shell-command>${cmd}</shell-command>\n<shell-output>\n${output}\n</shell-output>`);
      } catch (err: any) {
        ui.error(err.message);
      } finally {
        controller = undefined;
      }
      return false;
    }
    await runAgent(input);
    return false;
  };

  if (opts.initialPrompt) {
    process.stdout.write(`${color.bold('>')} ${opts.initialPrompt}\n`);
    await runAgent(opts.initialPrompt);
  }

  const promptLabel = () => `\n${color.bold(color.orange('>'))} `;
  for (;;) {
    let line: string;
    try {
      line = await rl.question(promptLabel());
      while (line.endsWith('\\')) line = `${line.slice(0, -1)}\n${await rl.question(color.dim('… '))}`;
    } catch {
      break; // readline closed (Ctrl+C twice or Ctrl+D)
    }
    exitArmed = false;
    if (await handle(line)) break;
  }
  rl.close();
}
