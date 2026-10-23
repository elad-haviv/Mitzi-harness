#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import * as readline from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { Agent } from './agent.js';
import { Config, DEFAULT_MODEL, loadConfig, PermissionMode, PERMISSION_MODES } from './config.js';
import { RoutingClient, resolveProviders, usable } from './providers.js';
import { Asker, Permissions, terminalApprover } from './permissions.js';
import { runRepl } from './repl.js';
import { listSessions, loadSession, newSessionId, saveSession, SessionData } from './session.js';
import { ALL_TOOLS } from './tools/index.js';
import { color, TerminalUI } from './ui.js';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version as string;

const USAGE = `${color.bold('mitzi')} — an agentic coding CLI powered by OpenRouter

${color.bold('Usage')}
  mitzi ui                    Open the Mitzi desktop web app (chats, projects, artifacts, bots)
  mitzi [prompt]              Start an interactive session (optionally with a first message)
  mitzi -p "prompt"           Print mode: run once, print the answer, exit
  cat file | mitzi -p "..."   Piped stdin is appended to the prompt

${color.bold('Options')}
  -p, --print                 Non-interactive mode
  -m, --model <id>            OpenRouter model id (default: ${DEFAULT_MODEL})
      --mode <mode>           Permission mode: ${PERMISSION_MODES.join(', ')}
      --yolo                  Skip all permission prompts (same as --mode yolo)
      --allow <rule>          Always allow a tool, e.g. "Edit" or "Bash(npm test)". Repeatable
  -c, --continue              Resume the most recent session in this directory
  -r, --resume <id>           Resume a specific session
      --max-turns <n>         Maximum model calls per message (default: 100)
      --reasoning             Show model reasoning tokens when available
      --port <n>              Port for \`mitzi ui\` (default: 4545)
      --no-open               Don't open a browser for \`mitzi ui\`
  -v, --version               Print version
  -h, --help                  Show this help

${color.bold('Environment')}
  OPENROUTER_API_KEY          Your OpenRouter API key — https://openrouter.ai/keys
  OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, …
                              Keys for other providers; use their models as e.g. -m openai:gpt-5
  MITZI_MODEL                 Default model id
  OPENROUTER_BASE_URL         Override the API base URL

Config files: ~/.mitzi/config.json and ./.mitzi/config.json
`;

/**
 * Reads piped stdin. Gives up if nothing arrives quickly, so an inherited but
 * idle stdin (common in scripts and CI) doesn't hang print mode.
 */
function readStdin(firstByteTimeoutMs = 500): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const finish = () => {
      clearTimeout(timer);
      process.stdin.off('data', onData).off('end', finish).off('error', reject);
      process.stdin.pause();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const onData = (chunk: Buffer) => {
      clearTimeout(timer);
      chunks.push(chunk);
    };
    const timer = setTimeout(finish, firstByteTimeoutMs);
    process.stdin.on('data', onData).on('end', finish).on('error', reject);
  });
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      print: { type: 'boolean', short: 'p' },
      model: { type: 'string', short: 'm' },
      mode: { type: 'string' },
      yolo: { type: 'boolean' },
      'dangerously-skip-permissions': { type: 'boolean' },
      allow: { type: 'string', multiple: true },
      continue: { type: 'boolean', short: 'c' },
      resume: { type: 'string', short: 'r' },
      'max-turns': { type: 'string' },
      reasoning: { type: 'boolean' },
      port: { type: 'string' },
      'no-open': { type: 'boolean' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  if (positionals[0] === 'ui') {
    const { startServer, openBrowser } = await import('./server/index.js');
    const server = await startServer({ port: values.port ? Number(values.port) : undefined });
    process.stdout.write(
      `${color.bold(color.orange('🐱 Mitzi'))} ${color.dim(`v${VERSION}`)} is running at\n\n  ${color.cyan(server.url)}\n\n` +
        `${color.dim('The link includes your private access token. Press Ctrl+C to stop.')}\n`,
    );
    if (!values['no-open']) openBrowser(server.url);
    await new Promise<void>((resolve) => process.once('SIGINT', resolve));
    await server.close();
    return 0;
  }

  const cwd = process.cwd();
  const yolo = values.yolo || values['dangerously-skip-permissions'];
  const overrides: Partial<Config> = {
    model: values.model,
    permissionMode: (yolo ? 'yolo' : values.mode) as PermissionMode | undefined,
    allowedTools: values.allow,
    maxTurns: values['max-turns'] ? Number(values['max-turns']) : undefined,
    showReasoning: values.reasoning || undefined,
  };
  const config = loadConfig(cwd, overrides);
  if (!resolveProviders(config).some((p) => usable(p) && p.kind !== 'elevenlabs')) {
    process.stderr.write(
      `${color.red('No model provider is set up.')}\nSet a key for OpenRouter (or OpenAI, Anthropic, Gemini, …):\n\n  export OPENROUTER_API_KEY=sk-or-...\n\nor add providers in the app: mitzi ui → Settings → Providers.\n`,
    );
    return 1;
  }

  let session: SessionData | undefined;
  if (values.resume) {
    try {
      session = loadSession(values.resume);
    } catch {
      process.stderr.write(color.red(`No session found with id ${values.resume}\n`));
      return 1;
    }
  } else if (values.continue) {
    session = listSessions(cwd)[0];
    if (!session) process.stderr.write(color.yellow('No previous session in this directory; starting a new one.\n'));
  }
  if (session && !values.model) config.model = session.model;
  session ??= { id: newSessionId(), cwd, model: config.model, title: '', createdAt: new Date().toISOString(), updatedAt: '', messages: [] };

  const client = new RoutingClient(resolveProviders(config));
  const prompt = positionals.join(' ').trim();

  if (values.print) {
    const stdin = await readStdin();
    const input = [prompt, stdin.trim() && `<stdin>\n${stdin.trim()}\n</stdin>`].filter(Boolean).join('\n\n');
    if (!input) {
      process.stderr.write(color.red('Print mode needs a prompt: mitzi -p "your request"\n'));
      return 1;
    }
    const ui = new TerminalUI(process.stdout, process.stderr, config.showReasoning);
    const permissions = new Permissions(config.permissionMode, config.allowedTools);
    const agent = new Agent({ client, config, tools: ALL_TOOLS, permissions, ui, cwd });
    agent.messages = session.messages;
    const controller = new AbortController();
    process.on('SIGINT', () => controller.abort());
    try {
      await agent.run(input, controller.signal);
      return 0;
    } catch (err: any) {
      ui.error(err?.message ?? String(err));
      return 1;
    } finally {
      session.messages = agent.messages;
      session.title ||= input.slice(0, 80).replace(/\s+/g, ' ');
      session.updatedAt = new Date().toISOString();
      saveSession(session);
    }
  }

  if (!process.stdin.isTTY) {
    process.stderr.write(color.red('Interactive mode needs a terminal. Use -p for piped input.\n'));
    return 1;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const ask: Asker = (question, signal) => rl.question(question, { signal });
  const ui = new TerminalUI(process.stdout, process.stdout, config.showReasoning);
  const permissions = new Permissions(config.permissionMode, config.allowedTools, terminalApprover(ask));
  const agent = new Agent({ client, config, tools: ALL_TOOLS, permissions, ui, cwd });
  agent.messages = session.messages;

  process.stdout.write(
    `${color.bold(color.orange('🐱 Mitzi'))} ${color.dim(`v${VERSION}`)}\n` +
      `${color.dim(`model: ${config.model}  ·  mode: ${config.permissionMode}  ·  cwd: ${cwd}`)}\n` +
      (session.messages.length ? color.dim(`Resumed session ${session.id} (${session.messages.length} messages)\n`) : '') +
      `${color.dim('Type /help for commands, Ctrl+C to interrupt.')}\n`,
  );

  await runRepl({ agent, client, ui, rl, session, initialPrompt: prompt || undefined });
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${color.red(err?.message ?? String(err))}\n`);
    process.exit(1);
  },
);
