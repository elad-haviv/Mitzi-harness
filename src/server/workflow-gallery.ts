// Ready-made workflows to start from, and the builder that drafts a workflow from a description.
import type { LlmClient, Message } from '../openrouter.js';
import { DEFAULT_BOT_ID, Workflow, WorkflowEdge, WorkflowNode, WorkflowNodeType } from '../shared/types.js';
import { NODE_SPECS, order } from './workflows.js';

type Draft = Pick<Workflow, 'name' | 'description' | 'emoji' | 'nodes' | 'edges'>;

export interface GalleryItem {
  id: string;
  category: 'Start here' | 'Research & writing' | 'Messages' | 'Data' | 'Routines';
  emoji: string;
  name: string;
  description: string;
  /** Steps as [id, type, label, config]; edges as "from>to" or "from>to:true|false". */
  steps: [string, WorkflowNodeType, string, Record<string, unknown>?][];
  edges: string[];
}

export const GALLERY: GalleryItem[] = [
  {
    id: 'blank',
    category: 'Start here',
    emoji: '⚡',
    name: 'Blank',
    description: 'Start → ask Mitzi → result. Build from there.',
    steps: [
      ['start', 'trigger', 'Start'],
      ['ask', 'ai', 'Ask Mitzi'],
      ['out', 'output', 'Result'],
    ],
    edges: ['start>ask', 'ask>out'],
  },
  {
    id: 'digest',
    category: 'Research & writing',
    emoji: '📰',
    name: 'Web page digest',
    description: 'Reads a page, summarizes it, and saves the summary as a document.',
    steps: [
      ['start', 'trigger', 'Start', { inputHint: 'A web address' }],
      ['read', 'browse', 'Read page'],
      ['sum', 'ai', 'Summarize', { prompt: 'Summarize this page in 5 bullet points, then one line on why it matters:\n\n{{input}}' }],
      ['save', 'artifact', 'Save digest', { title: 'Digest: {{trigger}}' }],
      ['out', 'output', 'Result'],
    ],
    edges: ['start>read', 'read>sum', 'sum>save', 'save>out'],
  },
  {
    id: 'research',
    category: 'Research & writing',
    emoji: '🔎',
    name: 'Research brief',
    description: 'Outlines a topic, researches each section in parallel, and assembles a brief.',
    steps: [
      ['start', 'trigger', 'Start', { inputHint: 'A topic to research' }],
      ['outline', 'ai', 'Outline', { prompt: 'List the 4 to 6 questions a good brief on this topic should answer, as a JSON list of strings, nothing else:\n\n{{input}}' }],
      ['each', 'loop', 'Research each', { split: 'json', mode: 'ai', prompt: 'For a brief on "{{trigger}}", answer this question in one or two short paragraphs, with sources where you can:\n\n{{item}}', parallel: 3, join: 'paragraphs' }],
      ['write', 'ai', 'Write the brief', { prompt: 'Turn these notes into a clear brief on "{{trigger}}" with a summary at the top and a heading per question:\n\n{{input}}' }],
      ['save', 'artifact', 'Save brief', { title: 'Brief: {{trigger}}' }],
      ['out', 'output', 'Result'],
    ],
    edges: ['start>outline', 'outline>each', 'each>write', 'write>save', 'save>out'],
  },
  {
    id: 'translate',
    category: 'Research & writing',
    emoji: '🌍',
    name: 'Translate into several languages',
    description: 'Translates a text into each language on a list, at the same time.',
    steps: [
      ['start', 'trigger', 'Start', { inputHint: 'The text to translate' }],
      ['langs', 'transform', 'Languages', { template: 'Hebrew\nSpanish\nFrench\nGerman' }],
      ['each', 'loop', 'Translate', { split: 'lines', mode: 'ai', prompt: 'Translate into {{item}}. Reply with "## {{item}}" and the translation only:\n\n{{trigger}}', parallel: 4, join: 'paragraphs' }],
      ['out', 'output', 'Result'],
    ],
    edges: ['start>langs', 'langs>each', 'each>out'],
  },
  {
    id: 'triage',
    category: 'Messages',
    emoji: '📬',
    name: 'Message triage',
    description: 'Decides whether a message is urgent and drafts the right reply.',
    steps: [
      ['start', 'trigger', 'Start', { inputHint: 'A message to triage' }],
      ['classify', 'ai', 'Classify', { prompt: 'Is this message urgent? Answer with one word, URGENT or ROUTINE.\n\n{{input}}' }],
      ['if', 'condition', 'Urgent?', { test: 'contains', value: 'urgent' }],
      ['urgent', 'ai', 'Urgent reply', { prompt: 'Draft a short reply that acknowledges this urgent message and gives a time for a full answer:\n\n{{trigger}}' }],
      ['routine', 'ai', 'Routine reply', { prompt: 'Draft a friendly reply to this message:\n\n{{trigger}}' }],
      ['out', 'output', 'Result'],
    ],
    edges: ['start>classify', 'classify>if', 'if>urgent:true', 'if>routine:false', 'urgent>out', 'routine>out'],
  },
  {
    id: 'approve-post',
    category: 'Messages',
    emoji: '✅',
    name: 'Draft, approve, then save',
    description: 'Drafts a post or email and waits for your approval before saving it.',
    steps: [
      ['start', 'trigger', 'Start', { inputHint: 'What the post is about' }],
      ['draft', 'ai', 'Draft', { prompt: 'Write a short, friendly post about this:\n\n{{input}}' }],
      ['check', 'approval', 'Approve draft', { message: 'Save this draft?\n\n{{input}}' }],
      ['save', 'artifact', 'Save post', { title: 'Post: {{trigger}}' }],
      ['skip', 'transform', 'Not saved', { template: 'The draft was rejected.' }],
      ['out', 'output', 'Result'],
    ],
    edges: ['start>draft', 'draft>check', 'check>save:true', 'check>skip:false', 'save>out', 'skip>out'],
  },
  {
    id: 'meeting',
    category: 'Messages',
    emoji: '📝',
    name: 'Meeting notes to follow-ups',
    description: 'Pulls the action items out of meeting notes and drafts a follow-up for each.',
    steps: [
      ['start', 'trigger', 'Start', { inputHint: 'Meeting notes' }],
      ['actions', 'ai', 'Find action items', { prompt: 'List the action items in these notes as a JSON list of strings like "Dana: send the budget by Friday". Nothing else.\n\n{{input}}' }],
      ['each', 'loop', 'Draft follow-ups', { split: 'json', mode: 'ai', prompt: 'Write a two-line follow-up message for this action item:\n\n{{item}}', parallel: 3, join: 'paragraphs' }],
      ['save', 'artifact', 'Save follow-ups', { title: 'Follow-ups {{date}}' }],
      ['out', 'output', 'Result'],
    ],
    edges: ['start>actions', 'actions>each', 'each>save', 'save>out'],
  },
  {
    id: 'api-summary',
    category: 'Data',
    emoji: '🛰️',
    name: 'API to summary',
    description: 'Calls a JSON API, picks out the fields that matter with code, and explains them.',
    steps: [
      ['start', 'trigger', 'Start', { inputHint: 'An API address returning JSON' }],
      ['call', 'http', 'Call the API', { method: 'GET', url: '{{input}}' }],
      ['pick', 'code', 'Pick fields', { language: 'javascript', code: 'const data = JSON.parse(input);\nconst list = Array.isArray(data) ? data : [data];\nreturn list.slice(0, 20).map((x) => JSON.stringify(x).slice(0, 300)).join("\\n");' }],
      ['explain', 'ai', 'Explain', { prompt: 'Explain what this data shows, in plain words, with anything notable first:\n\n{{input}}' }],
      ['out', 'output', 'Result'],
    ],
    edges: ['start>call', 'call>pick', 'pick>explain', 'explain>out'],
  },
  {
    id: 'csv-stats',
    category: 'Data',
    emoji: '📊',
    name: 'Crunch a CSV with Python',
    description: 'Computes statistics for CSV data with pandas and explains them.',
    steps: [
      ['start', 'trigger', 'Start', { inputHint: 'CSV data' }],
      ['stats', 'code', 'Statistics', { language: 'python', code: 'import io\nimport pandas as pd\ndf = pd.read_csv(io.StringIO(input))\ndf.describe(include="all").to_string()' }],
      ['explain', 'ai', 'Explain', { prompt: 'Explain these statistics for someone who isn’t a data person, with the three most interesting points first:\n\n{{input}}' }],
      ['out', 'output', 'Result'],
    ],
    edges: ['start>stats', 'stats>explain', 'explain>out'],
  },
  {
    id: 'briefing',
    category: 'Routines',
    emoji: '☀️',
    name: 'Morning briefing',
    description: 'A daily briefing from what Mitzi knows and can look up; schedule it for each morning.',
    steps: [
      ['start', 'trigger', 'Start', { inputHint: 'Anything to focus on today (optional)' }],
      ['brief', 'ai', 'Briefing', { prompt: 'Write my briefing for {{date}}: what I’m working on and what’s coming up (from memory), plus anything I asked to focus on: {{input}}. Keep it under 200 words.', tools: true }],
      ['save', 'artifact', 'Save briefing', { title: 'Briefing {{date}}' }],
      ['out', 'output', 'Result'],
    ],
    edges: ['start>brief', 'brief>save', 'save>out'],
  },
];

/** Positions steps left to right by depth, stacking those at the same depth. */
export function layout(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowNode[] {
  const depth = new Map<string, number>();
  for (const n of order(nodes, edges)) {
    const parents = edges.filter((e) => e.to === n.id).map((e) => depth.get(e.from) ?? 0);
    depth.set(n.id, parents.length ? Math.max(...parents) + 1 : 0);
  }
  const columns = new Map<number, WorkflowNode[]>();
  for (const n of nodes) columns.set(depth.get(n.id)!, [...(columns.get(depth.get(n.id)!) ?? []), n]);
  const tallest = Math.max(...[...columns.values()].map((c) => c.length));
  return nodes.map((n) => {
    const col = columns.get(depth.get(n.id)!)!;
    const i = col.indexOf(n);
    return { ...n, x: 60 + depth.get(n.id)! * 270, y: 80 + (tallest - col.length) * 65 + i * 130 };
  });
}

/** Builds a workflow from compact steps and edges, laid out on the canvas. */
function build(meta: Pick<Workflow, 'name' | 'description' | 'emoji'>, steps: GalleryItem['steps'], edgeSpecs: string[]): Draft {
  const nodes: WorkflowNode[] = steps.map(([id, type, label, config]) => ({ id, type, label, x: 0, y: 0, config: { ...NODE_SPECS[type].defaults, ...config } }));
  const edges: WorkflowEdge[] = edgeSpecs.map((s) => {
    const [from, rest] = s.split('>');
    const [to, port] = rest.split(':');
    return { id: `${from}-${to}${port ? `-${port}` : ''}`, from, to, ...(port ? { port } : {}) };
  });
  return { ...meta, nodes: layout(nodes, edges), edges };
}

export function fromGallery(id: string): Draft {
  const item = GALLERY.find((g) => g.id === id) ?? GALLERY[0];
  return build({ name: item.id === 'blank' ? 'New workflow' : item.name, description: item.id === 'blank' ? '' : item.description, emoji: item.emoji }, item.steps, item.edges);
}

const BUILDER_PROMPT = `You design workflows for Mitzi, an AI assistant app. A workflow is a graph of steps that runs left to right; each step gets the output of the steps leading to it as {{input}}.

Step types (type: what it does; config fields):
${(Object.keys(NODE_SPECS) as WorkflowNodeType[]).map((t) => `- ${t}: ${NODE_SPECS[t].description} Config: ${JSON.stringify(NODE_SPECS[t].defaults)}`).join('\n')}

Placeholders in any text field: {{input}} (previous step's output), {{trigger}} (the workflow's input), {{date}}, {{Step label}} (any earlier step's output), and in "loop" prompts {{item}} and {{index}}.
Rules:
- Exactly one "trigger" step, first, and at least one "output" step, last.
- "condition" and "approval" steps have two outputs: edges from them need "port": "true" or "false".
- Steps only lead forward (no cycles). Use "loop" to repeat work over items.
- Prefer few, clear steps. Write prompts in full, as instructions to a capable assistant.
- botId is "${DEFAULT_BOT_ID}" unless the user names another bot.

Reply with JSON only, no prose or code fence:
{"name": "...", "emoji": "one emoji", "description": "one sentence", "steps": [{"id": "short_id", "type": "...", "label": "Short name", "config": {...}}], "edges": [{"from": "id", "to": "id", "port": "true"}]}`;

/** Turns a model's reply into a valid workflow, or throws with what's wrong (to tell the model). */
export function parseDraft(text: string): Draft {
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  let raw: any;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('The reply wasn’t valid JSON.');
  }
  const steps = Array.isArray(raw?.steps) ? raw.steps : [];
  if (!steps.length) throw new Error('There are no steps.');
  const types = Object.keys(NODE_SPECS);
  const nodes: WorkflowNode[] = steps.slice(0, 30).map((s: any, i: number) => {
    if (!types.includes(s?.type)) throw new Error(`Step ${i + 1} has an unknown type "${s?.type}".`);
    const id = String(s.id ?? `s${i + 1}`).replace(/[^\w-]/g, '_').slice(0, 40) || `s${i + 1}`;
    const type = s.type as WorkflowNodeType;
    return { id, type, label: String(s.label ?? NODE_SPECS[type].label).slice(0, 60), x: 0, y: 0, config: { ...NODE_SPECS[type].defaults, ...(s.config && typeof s.config === 'object' ? s.config : {}) } };
  });
  if (new Set(nodes.map((n) => n.id)).size !== nodes.length) throw new Error('Two steps have the same id.');
  if (nodes.filter((n) => n.type === 'trigger').length !== 1) throw new Error('There must be exactly one trigger step.');
  if (!nodes.some((n) => n.type === 'output')) throw new Error('There is no output step.');
  const ids = new Set(nodes.map((n) => n.id));
  const edges: WorkflowEdge[] = (Array.isArray(raw?.edges) ? raw.edges : []).map((e: any) => {
    const from = String(e?.from ?? '');
    const to = String(e?.to ?? '');
    if (!ids.has(from) || !ids.has(to)) throw new Error(`An edge connects unknown steps (${from} → ${to}).`);
    const twoWay = ['condition', 'approval'].includes(nodes.find((n) => n.id === from)!.type);
    const port = twoWay ? (String(e?.port) === 'false' ? 'false' : 'true') : undefined;
    return { id: `${from}-${to}${port ? `-${port}` : ''}`, from, to, ...(port ? { port } : {}) };
  });
  try {
    order(nodes, edges);
  } catch {
    throw new Error('The steps form a loop; they must only lead forward.');
  }
  const emoji = String(raw.emoji ?? '⚡').trim().slice(0, 8) || '⚡';
  return { name: String(raw.name ?? 'New workflow').slice(0, 80), description: String(raw.description ?? '').slice(0, 500), emoji, nodes: layout(nodes, edges), edges };
}

/** Drafts a workflow from a description; one retry tells the model what was wrong. */
export async function draftWorkflow(client: LlmClient, model: string, description: string, signal?: AbortSignal): Promise<Draft> {
  const messages: Message[] = [
    { role: 'system', content: BUILDER_PROMPT },
    { role: 'user', content: description },
  ];
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await client.chat({ model, messages, maxTokens: 4000, temperature: 0.2, signal });
    try {
      return parseDraft(res.content);
    } catch (err) {
      lastError = (err as Error).message;
      messages.push({ role: 'assistant', content: res.content }, { role: 'user', content: `That doesn't work: ${lastError} Reply with the corrected JSON only.` });
    }
  }
  throw new Error(`Couldn't build a valid workflow: ${lastError}`);
}
