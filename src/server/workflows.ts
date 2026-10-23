// Workflows: small graphs of steps (ask a bot, fetch a page, call an API, branch, save an artifact…)
// that run from the editor, on a schedule, or when a bot calls them from a chat.
import { htmlToText } from '../tools/web.js';
import { Tool, ToolError } from '../tools/types.js';
import { Artifact, Chat, DEFAULT_BOT_ID, Workflow, WorkflowEdge, WorkflowEvent, WorkflowNode, WorkflowNodeType, WorkflowRun, WorkflowStep } from '../shared/types.js';
import type { MediaService } from './media.js';
import type { MemoryService } from './memory/index.js';
import type { ChatRunner } from './runner.js';
import { newId, now, Store } from './store.js';
import { withUsage } from './usage.js';
import type { PythonSandbox } from './python.js';
import vm from 'node:vm';

const MAX_RUNS = 20;
const MAX_OUTPUT = 40_000;

export interface NodeSpec {
  label: string;
  description: string;
  /** Condition nodes have two outputs; the rest have one (output nodes none). */
  outputs: string[];
  defaults: Record<string, unknown>;
}

export const NODE_SPECS: Record<WorkflowNodeType, NodeSpec> = {
  trigger: { label: 'Start', description: 'Where the workflow starts. Its output is the input you run it with.', outputs: ['out'], defaults: { inputHint: '' } },
  ai: { label: 'Ask a bot', description: 'A bot (or model) works on a prompt, optionally with its tools.', outputs: ['out'], defaults: { botId: DEFAULT_BOT_ID, model: '', prompt: '{{input}}', tools: false } },
  browse: { label: 'Read a web page', description: 'Fetches a page and returns its text.', outputs: ['out'], defaults: { url: '{{input}}' } },
  http: { label: 'HTTP request', description: 'Calls an API and returns the response body.', outputs: ['out'], defaults: { method: 'GET', url: '', headers: '', body: '' } },
  condition: { label: 'If', description: 'Continues on "yes" or "no" depending on the input.', outputs: ['true', 'false'], defaults: { test: 'contains', value: '', text: '{{input}}' } },
  loop: {
    label: 'For each',
    description: 'Splits the input into items (lines, a JSON list…) and runs a prompt or text on each; the results are joined.',
    outputs: ['out'],
    defaults: { split: 'lines', separator: ',', mode: 'ai', prompt: 'Summarize this in one sentence:\n\n{{item}}', template: '- {{item}}', botId: DEFAULT_BOT_ID, model: '', parallel: 3, join: 'paragraphs' },
  },
  code: {
    label: 'Code',
    description: 'Runs a snippet of JavaScript or Python on the input; its result is passed on.',
    outputs: ['out'],
    defaults: { language: 'javascript', code: 'return input.toUpperCase();' },
  },
  delay: { label: 'Wait', description: 'Waits a while, then passes the input on.', outputs: ['out'], defaults: { seconds: 60 } },
  approval: {
    label: 'Approval',
    description: 'Pauses the run until you approve or reject it, then continues on "yes" or "no".',
    outputs: ['true', 'false'],
    defaults: { message: 'Approve this?\n\n{{input}}' },
  },
  transform: { label: 'Text', description: 'Builds text from earlier steps with {{placeholders}}.', outputs: ['out'], defaults: { template: '{{input}}' } },
  image: { label: 'Generate image', description: 'Creates an image from a prompt (needs an image model).', outputs: ['out'], defaults: { prompt: '{{input}}' } },
  artifact: { label: 'Save artifact', description: 'Saves the text as an artifact you can open later.', outputs: ['out'], defaults: { title: 'Workflow result', type: 'markdown', content: '{{input}}' } },
  memory: { label: 'Remember', description: 'Saves a memory to a bot’s memory bank.', outputs: ['out'], defaults: { botId: DEFAULT_BOT_ID, content: '{{input}}' } },
  output: { label: 'Result', description: 'The workflow’s result.', outputs: [], defaults: { template: '{{input}}' } },
};

/** Fills {{input}}, {{trigger}}, {{date}} and {{Step label}} placeholders (and {{item}}/{{index}} in a loop). */
export function render(template: string, vars: { input: string; trigger: string; outputs: Map<string, string>; extra?: Record<string, string> }): string {
  return String(template ?? '').replace(/\{\{\s*([^}]+?)\s*\}\}/g, (whole, key: string) => {
    const k = key.toLowerCase();
    if (vars.extra && k in vars.extra) return vars.extra[k];
    if (k === 'input') return vars.input;
    if (k === 'trigger') return vars.trigger;
    if (k === 'date') return new Date().toDateString();
    return vars.outputs.get(k) ?? whole;
  });
}

/** Steps in dependency order; throws on loops. */
export function order(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowNode[] {
  const indegree = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of edges) if (indegree.has(e.to) && indegree.has(e.from)) indegree.set(e.to, indegree.get(e.to)! + 1);
  const queue = nodes.filter((n) => indegree.get(n.id) === 0);
  const out: WorkflowNode[] = [];
  while (queue.length) {
    const n = queue.shift()!;
    out.push(n);
    for (const e of edges.filter((x) => x.from === n.id)) {
      const d = indegree.get(e.to);
      if (d === undefined) continue;
      indegree.set(e.to, d - 1);
      if (d - 1 === 0) queue.push(nodes.find((x) => x.id === e.to)!);
    }
  }
  if (out.length !== nodes.length) throw new Error('The workflow has a loop; steps can only lead forward');
  return out;
}

export function testCondition(test: string, text: string, value: string): boolean {
  const t = text.trim();
  switch (test) {
    case 'equals':
      return t.toLowerCase() === value.trim().toLowerCase();
    case 'regex':
      try {
        return new RegExp(value, 'i').test(t);
      } catch {
        throw new Error(`"${value}" isn't a valid pattern`);
      }
    case 'empty':
      return !t;
    case 'number':
      // "> 10", "<= 3"…
      {
        const m = /^(<=|>=|<|>|=)\s*(-?[\d.]+)$/.exec(value.trim());
        const n = Number(/-?[\d.]+/.exec(t)?.[0]);
        if (!m || Number.isNaN(n)) return false;
        const v = Number(m[2]);
        return m[1] === '<' ? n < v : m[1] === '>' ? n > v : m[1] === '<=' ? n <= v : m[1] === '>=' ? n >= v : n === v;
      }
    default:
      return t.toLowerCase().includes(value.trim().toLowerCase());
  }
}

/** Splits a loop's input into items: lines, paragraphs, a JSON list, or by a separator. */
export function splitItems(text: string, how: string, separator = ','): string[] {
  const t = text.trim();
  if (!t) return [];
  if (how === 'json') {
    let list: unknown;
    try {
      // The list may be wrapped in prose or a code fence; take the outermost brackets.
      list = JSON.parse(t.slice(t.indexOf('['), t.lastIndexOf(']') + 1));
    } catch {
      throw new Error('The input isn’t a JSON list');
    }
    if (!Array.isArray(list)) throw new Error('The input isn’t a JSON list');
    return list.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)));
  }
  const parts = how === 'paragraphs' ? t.split(/\n\s*\n/) : how === 'separator' ? t.split(separator || ',') : t.split('\n');
  // Bullets and numbering are list syntax, not part of the item.
  return parts.map((p) => p.trim().replace(/^([-*•]|\d+[.)])\s+/, '')).filter(Boolean);
}

/** Runs JavaScript with `input`, `trigger` and `steps` (outputs by step name); `return` gives the result. */
export function runJavaScript(code: string, vars: { input: string; trigger: string; steps: Record<string, string> }, timeoutMs = 5000): string {
  const logs: string[] = [];
  const context = vm.createContext({ ...vars, console: { log: (...a: unknown[]) => logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')) } });
  const value = new vm.Script(`(function () {\n${code}\n})()`, { filename: 'step.js' }).runInContext(context, { timeout: timeoutMs });
  if (value === undefined || value === null) return logs.join('\n');
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

export interface WorkflowDeps {
  store: Store;
  runner: ChatRunner;
  media: MediaService;
  memory: MemoryService;
  /** For Python code steps, when Pyodide is installed. */
  python?: PythonSandbox;
  /** Creates an empty chat (the same as POST /api/chats). */
  newChat: (fields: Partial<Chat>) => Chat;
}

export class WorkflowEngine {
  private readonly active = new Map<string, AbortController>();
  /** Runs paused at an approval step, by run id. */
  private readonly waiting = new Map<string, (decision: { approved: boolean; note?: string }) => void>();

  constructor(private readonly deps: WorkflowDeps) {
    // Runs that were going when Mitzi stopped can't continue.
    for (const w of deps.store.workflows.all()) {
      if (!w.runs.some((r) => r.status === 'running' || r.status === 'waiting')) continue;
      for (const r of w.runs) {
        if (r.status !== 'running' && r.status !== 'waiting') continue;
        r.status = 'error';
        r.error = 'Mitzi was closed before the run finished';
        r.finishedAt = r.finishedAt ?? now();
        for (const s of r.steps) if (s.status === 'running' || s.status === 'waiting') s.status = 'error';
      }
      deps.store.workflows.put(w);
    }
  }

  /** Answers a run waiting at an approval step. */
  decide(runId: string, decision: { approved: boolean; note?: string }): boolean {
    const resolve = this.waiting.get(runId);
    resolve?.(decision);
    return !!resolve;
  }

  isRunning(workflowId: string): boolean {
    return this.active.has(workflowId);
  }

  stop(workflowId: string): boolean {
    const c = this.active.get(workflowId);
    c?.abort();
    return !!c;
  }

  /** Runs a workflow to the end; `onEvent` hears about each step. */
  async run(workflow: Workflow, input: string, trigger: WorkflowRun['trigger'], onEvent: (e: WorkflowEvent) => void = () => {}, outer?: AbortSignal, source?: string): Promise<WorkflowRun> {
    const { store } = this.deps;
    if (this.active.has(workflow.id)) throw new Error(`"${workflow.name}" is already running`);
    const controller = new AbortController();
    const signal = outer ? AbortSignal.any([outer, controller.signal]) : controller.signal;
    this.active.set(workflow.id, controller);
    const run: WorkflowRun = { id: newId(), trigger, ...(source ? { source } : {}), input, status: 'running', steps: [], startedAt: now() };
    const save = () => {
      const fresh = store.workflows.get(workflow.id);
      if (!fresh) return;
      fresh.runs = [run, ...fresh.runs.filter((r) => r.id !== run.id)].slice(0, MAX_RUNS);
      store.workflows.put(fresh);
    };
    save();
    onEvent({ type: 'run', run });
    let cost = 0;
    try {
      await withUsage({ kind: 'workflow', workflowId: workflow.id, chatId: undefined, sink: (e) => (cost += e.cost) }, async () => {
        const steps = order(workflow.nodes, workflow.edges);
        const outputs = new Map<string, string>(); // node id → output
        const byLabel = new Map<string, string>();
        // Which outgoing port each finished node took ('out', or 'true'/'false' for conditions).
        const taken = new Map<string, string>();
        let last = '';
        for (const node of steps) {
          if (signal.aborted) throw new Error('Stopped');
          const incoming = workflow.edges.filter((e) => e.to === node.id);
          const live = incoming.filter((e) => taken.has(e.from) && (taken.get(e.from) === 'out' || taken.get(e.from) === (e.port ?? 'true')));
          // Start nodes always run; others only when a finished step leads to them.
          if (incoming.length ? !live.length : node.type !== 'trigger' && steps.some((s) => s.type === 'trigger')) continue;
          const nodeInput = incoming.length ? live.map((e) => outputs.get(e.from) ?? '').join('\n\n') : input;
          const step: WorkflowStep = { nodeId: node.id, status: 'running', startedAt: now() };
          run.steps.push(step);
          onEvent({ type: 'step', runId: run.id, step: { ...step } });
          const t0 = Date.now();
          try {
            const vars = { input: nodeInput, trigger: input, outputs: byLabel };
            // An approval step pauses the run until the user decides (or the run is stopped).
            const pause = async (ask: string) => {
              Object.assign(step, { status: 'waiting', ask });
              run.status = 'waiting';
              save();
              onEvent({ type: 'step', runId: run.id, step: { ...step } });
              onEvent({ type: 'run', run });
              try {
                return await new Promise<{ approved: boolean; note?: string }>((resolve, reject) => {
                  this.waiting.set(run.id, resolve);
                  signal.addEventListener('abort', () => reject(new Error('Stopped')), { once: true });
                });
              } finally {
                this.waiting.delete(run.id);
                run.status = 'running';
                step.status = 'running';
                onEvent({ type: 'run', run });
              }
            };
            const result = await this.step(workflow, node, vars, signal, pause);
            const output = result.output.slice(0, MAX_OUTPUT);
            outputs.set(node.id, output);
            byLabel.set(node.label.trim().toLowerCase(), output);
            taken.set(node.id, result.port ?? 'out');
            if (node.type === 'output' || !steps.some((s) => s.type === 'output')) last = output;
            Object.assign(step, { status: 'done', output, ms: Date.now() - t0 });
          } catch (err) {
            Object.assign(step, { status: 'error', error: (err as Error).message, ms: Date.now() - t0 });
            onEvent({ type: 'step', runId: run.id, step: { ...step } });
            throw new Error(`${node.label}: ${(err as Error).message}`);
          }
          onEvent({ type: 'step', runId: run.id, step: { ...step } });
          save();
        }
        run.output = last;
      });
      run.status = 'done';
    } catch (err) {
      run.status = 'error';
      run.error = (err as Error).message;
    } finally {
      this.active.delete(workflow.id);
      run.finishedAt = now();
      run.cost = cost;
      save();
      onEvent({ type: 'run', run });
    }
    return run;
  }

  private async step(
    workflow: Workflow,
    node: WorkflowNode,
    vars: { input: string; trigger: string; outputs: Map<string, string> },
    signal: AbortSignal,
    pause: (ask: string) => Promise<{ approved: boolean; note?: string }>,
  ): Promise<{ output: string; port?: string }> {
    const c = { ...NODE_SPECS[node.type]?.defaults, ...node.config } as Record<string, any>;
    const r = (t: unknown) => render(String(t ?? ''), vars);
    switch (node.type) {
      case 'trigger':
        return { output: vars.input };
      case 'transform':
      case 'output':
        return { output: r(c.template) };
      case 'condition': {
        const ok = testCondition(String(c.test), r(c.text), String(c.value ?? ''));
        // A condition passes its input through unchanged.
        return { output: vars.input, port: ok ? 'true' : 'false' };
      }
      case 'ai': {
        const prompt = r(c.prompt);
        if (!prompt.trim()) throw new Error('The prompt is empty');
        return {
          output: await this.deps.runner.runOnce({
            botId: c.botId || DEFAULT_BOT_ID,
            model: c.model || undefined,
            prompt,
            tools: !!c.tools,
            autoApprove: !!c.autoApprove,
            note: `This is the step "${node.label}" of the workflow "${workflow.name}". Reply with the result only; it is passed on to the next step.`,
            signal,
          }),
        };
      }
      case 'browse':
      case 'http': {
        const url = r(c.url).trim();
        if (!/^https?:\/\//i.test(url)) throw new Error(`"${url.slice(0, 80)}" isn't a web address`);
        const headers: Record<string, string> = {};
        for (const line of r(c.headers).split('\n')) {
          const i = line.indexOf(':');
          if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
        }
        const method = node.type === 'browse' ? 'GET' : String(c.method || 'GET').toUpperCase();
        const body = method === 'GET' || method === 'HEAD' ? undefined : r(c.body);
        const res = await fetch(url, { method, headers: { 'user-agent': 'Mitzi', ...headers }, body, signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) });
        const text = await res.text();
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
        return { output: node.type === 'browse' || /html/i.test(res.headers.get('content-type') ?? '') ? htmlToText(text) : text };
      }
      case 'image': {
        const file = await this.deps.media.image(r(c.prompt), {}, signal);
        return { output: file.url };
      }
      case 'artifact': {
        const type = ['markdown', 'html', 'code', 'svg', 'mermaid'].includes(c.type) ? c.type : 'markdown';
        const title = r(c.title).trim().slice(0, 200) || 'Workflow result';
        // Every artifact lives in a chat, where you can keep working on it with a bot.
        const chat = this.deps.store.chats.put(
          this.deps.newChat({
            title,
            messages: [
              { role: 'user', content: `Workflow "${workflow.name}" saved this result.`, ts: Date.now() },
              { role: 'assistant', content: `Here's the result of the workflow "${workflow.name}". Open the artifact to read or edit it, or ask me to change it.`, ts: Date.now() },
            ],
          }),
        );
        const artifact: Artifact = {
          id: newId(),
          chatId: chat.id,
          title,
          type,
          versions: [{ content: r(c.content), title, author: 'assistant', note: `From the workflow "${workflow.name}"`, createdAt: now() }],
          comments: [],
          createdAt: now(),
          updatedAt: now(),
        };
        this.deps.store.artifacts.put(artifact);
        return { output: r(c.content) };
      }
      case 'delay': {
        const seconds = Math.min(3600, Math.max(0, Number(c.seconds) || 0));
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, seconds * 1000);
          signal.addEventListener('abort', () => (clearTimeout(t), reject(new Error('Stopped'))), { once: true });
        });
        return { output: vars.input };
      }
      case 'approval': {
        const decision = await pause(r(c.message) || vars.input);
        const note = decision.note?.trim();
        return { output: note ? `${vars.input}\n\nReviewer’s note: ${note}` : vars.input, port: decision.approved ? 'true' : 'false' };
      }
      case 'code': {
        const steps = Object.fromEntries(vars.outputs);
        if (c.language === 'python') {
          const python = this.deps.python;
          if (!python?.available()) throw new Error('Python isn’t installed (the optional "pyodide" package)');
          const prelude = `import json as _json\ninput = ${JSON.stringify(vars.input)}\ntrigger = ${JSON.stringify(vars.trigger)}\nsteps = _json.loads(${JSON.stringify(JSON.stringify(steps))})\n`;
          const res = await python.run(`workflow-${workflow.id}`, python.sandboxDir(`workflow-${workflow.id}`), prelude + String(c.code ?? ''), { signal });
          if (res.error) throw new Error(res.error.split('\n').filter(Boolean).slice(-3).join('\n'));
          return { output: res.result ?? res.output.trimEnd() };
        }
        try {
          return { output: runJavaScript(String(c.code ?? ''), { input: vars.input, trigger: vars.trigger, steps }) };
        } catch (err) {
          throw new Error(/timed out/i.test((err as Error).message) ? 'The code ran longer than 5 seconds' : (err as Error).message);
        }
      }
      case 'loop': {
        const items = splitItems(vars.input, String(c.split), String(c.separator ?? ','));
        if (items.length > 100) throw new Error(`Too many items (${items.length}); a loop handles up to 100`);
        const results: string[] = new Array(items.length);
        let next = 0;
        // A few items at a time, each with its own {{item}} and {{index}}.
        const worker = async () => {
          while (next < items.length) {
            if (signal.aborted) throw new Error('Stopped');
            const i = next++;
            const each = { ...vars, extra: { item: items[i], index: String(i + 1) } };
            results[i] =
              c.mode === 'template'
                ? render(String(c.template ?? ''), each)
                : await this.deps.runner.runOnce({
                    botId: c.botId || DEFAULT_BOT_ID,
                    model: c.model || undefined,
                    prompt: render(String(c.prompt ?? ''), each),
                    tools: false,
                    autoApprove: false,
                    note: `This is item ${i + 1} of ${items.length} in the step "${node.label}" of the workflow "${workflow.name}". Reply with the result for this item only.`,
                    signal,
                  });
          }
        };
        const parallel = c.mode === 'template' ? 1 : Math.min(5, Math.max(1, Number(c.parallel) || 1));
        await Promise.all(Array.from({ length: Math.min(parallel, items.length) }, worker));
        const output = c.join === 'json' ? JSON.stringify(results.map((x) => x.trim()), null, 2) : results.map((x) => x.trim()).join(c.join === 'lines' ? '\n' : '\n\n');
        return { output };
      }
      case 'memory': {
        const bot = this.deps.store.bots.get(c.botId || DEFAULT_BOT_ID);
        if (!bot) throw new Error('That bot no longer exists');
        const content = r(c.content).trim();
        if (content) await this.deps.memory.backend().remember(this.deps.memory.bankFor(bot), content.slice(0, 2000), 'user');
        return { output: vars.input };
      }
    }
  }
}

/** The Workflow tool: lets a bot run the workflows the user made available to chats. */
export function workflowTool(store: Store, engine: WorkflowEngine): Tool<{ workflow: string; input?: string }> | undefined {
  const list = store.workflows.all().filter((w) => w.exposeToChat);
  if (!list.length) return undefined;
  return {
    name: 'Workflow',
    // Workflows can call APIs and change things, so they ask first.
    kind: 'network',
    description:
      'Run one of the user’s workflows and get its result. Available workflows:\n' +
      list.map((w) => `- ${w.name}${w.description ? `: ${w.description}` : ''}${inputHint(w) ? ` (input: ${inputHint(w)})` : ''}`).join('\n'),
    parameters: {
      type: 'object',
      properties: { workflow: { type: 'string', enum: list.map((w) => w.name) }, input: { type: 'string', description: 'What to run it with' } },
      required: ['workflow'],
    },
    summarize: (a) => a.workflow,
    async run(a, ctx) {
      const w = list.find((x) => x.name.toLowerCase() === String(a.workflow).toLowerCase());
      const fresh = w && store.workflows.get(w.id);
      if (!fresh) throw new ToolError(`No workflow called "${a.workflow}"`);
      const run = await engine.run(fresh, String(a.input ?? ''), 'chat', () => {}, ctx.signal);
      if (run.status === 'error') throw new ToolError(`The workflow failed: ${run.error}`);
      return run.output || '(The workflow finished without a result.)';
    },
  };
}

function inputHint(w: Workflow): string {
  return String(w.nodes.find((n) => n.type === 'trigger')?.config.inputHint ?? '');
}
