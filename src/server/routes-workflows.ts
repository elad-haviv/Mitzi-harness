// Routes for workflows: list, edit, run (streaming each step), stop.
import { Workflow, WorkflowEdge, WorkflowEvent, WorkflowNode, WorkflowNodeType } from '../shared/types.js';
import { newId, now, Store } from './store.js';
import { fail, HttpError, Route, STREAMED, str } from './util.js';
import { NODE_SPECS, order, WorkflowEngine } from './workflows.js';
import { draftWorkflow, fromGallery, GALLERY } from './workflow-gallery.js';
import type { RoutingClient } from '../providers.js';
import type { Config } from '../config.js';
import { withUsage } from './usage.js';

const TYPES = Object.keys(NODE_SPECS) as WorkflowNodeType[];

function cleanNodes(raw: unknown): WorkflowNode[] {
  if (!Array.isArray(raw)) throw new HttpError(400, 'nodes must be a list');
  const seen = new Set<string>();
  return raw.slice(0, 100).map((n: any) => {
    const id = str(n?.id);
    if (!/^[\w-]{1,40}$/.test(id) || seen.has(id)) throw new HttpError(400, 'Each step needs a unique id');
    seen.add(id);
    if (!TYPES.includes(n?.type)) throw new HttpError(400, `Unknown step type "${n?.type}"`);
    return {
      id,
      type: n.type,
      label: str(n.label).trim().slice(0, 60) || NODE_SPECS[n.type as WorkflowNodeType].label,
      x: Math.round(Number(n.x) || 0),
      y: Math.round(Number(n.y) || 0),
      config: n.config && typeof n.config === 'object' ? n.config : {},
    };
  });
}

function cleanEdges(raw: unknown, nodes: WorkflowNode[]): WorkflowEdge[] {
  if (!Array.isArray(raw)) throw new HttpError(400, 'edges must be a list');
  const ids = new Set(nodes.map((n) => n.id));
  const out: WorkflowEdge[] = [];
  for (const e of raw.slice(0, 300) as any[]) {
    const from = str(e?.from);
    const to = str(e?.to);
    if (!ids.has(from) || !ids.has(to) || from === to) continue;
    const port = e?.port === 'true' || e?.port === 'false' ? e.port : undefined;
    if (out.some((x) => x.from === from && x.to === to && x.port === port)) continue;
    out.push({ id: str(e?.id) || newId(), from, to, ...(port ? { port } : {}) });
  }
  return out;
}

export function registerWorkflowRoutes(route: Route, deps: { store: Store; engine: WorkflowEngine; client: () => RoutingClient; config: () => Config }): void {
  const { store, engine } = deps;
  const get = (id: string) => store.workflows.get(id) ?? fail(404, 'Workflow not found');
  const view = (w: Workflow) => ({ ...w, running: engine.isRunning(w.id) });

  route('GET', '/api/workflows/node-types', () => NODE_SPECS);
  route('GET', '/api/workflows', () =>
    store.workflows
      .all()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((w) => ({ ...view(w), runs: w.runs.slice(0, 1) })),
  );
  route('GET', '/api/workflows/gallery', () => GALLERY.map(({ steps, edges: _edges, ...g }) => ({ ...g, steps: steps.length })));
  /** Drafts a workflow from a description and saves it. */
  route('POST', '/api/workflows/draft', async ({ body }) => {
    const description = str(body?.description).trim();
    if (!description) throw new HttpError(400, 'Describe what the workflow should do');
    const config = deps.config();
    const draft = await withUsage({ kind: 'workflow' }, () => draftWorkflow(deps.client(), config.model === 'auto' ? (config.smallModel ?? config.model) : config.model, description.slice(0, 4000)));
    const w: Workflow = { id: newId(), ...draft, exposeToChat: false, runs: [], createdAt: now(), updatedAt: now() };
    return view(store.workflows.put(w));
  });
  route('POST', '/api/workflows', ({ body }) => {
    const template = fromGallery(str(body?.template));
    const w: Workflow = { id: newId(), ...template, exposeToChat: false, runs: [], createdAt: now(), updatedAt: now() };
    if (str(body?.name).trim()) w.name = str(body.name).trim().slice(0, 80);
    return view(store.workflows.put(w));
  });
  route('GET', '/api/workflows/:id', ({ params }) => view(get(params.id)));
  route('PATCH', '/api/workflows/:id', ({ params, body }) => {
    const w = get(params.id);
    if (typeof body?.name === 'string' && body.name.trim()) w.name = body.name.trim().slice(0, 80);
    if (typeof body?.description === 'string') w.description = body.description.slice(0, 500);
    if (typeof body?.emoji === 'string' && body.emoji.trim()) w.emoji = body.emoji.trim().slice(0, 8);
    if (typeof body?.exposeToChat === 'boolean') w.exposeToChat = body.exposeToChat;
    if (body?.nodes !== undefined) {
      const nodes = cleanNodes(body.nodes);
      const edges = cleanEdges(body.edges ?? w.edges, nodes);
      try {
        order(nodes, edges);
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
      w.nodes = nodes;
      w.edges = edges;
    }
    w.updatedAt = now();
    return view(store.workflows.put(w));
  });
  route('DELETE', '/api/workflows/:id', ({ params }) => {
    const w = get(params.id);
    engine.stop(w.id);
    store.workflows.delete(w.id);
    // Scheduled tasks that ran it go back to being prompts.
    for (const t of store.tasks.all().filter((t) => t.workflowId === w.id)) store.tasks.put({ ...t, workflowId: undefined, enabled: false });
    return { ok: true };
  });
  route('POST', '/api/workflows/:id/stop', ({ params }) => ({ stopped: engine.stop(params.id) }));
  /** Approves or rejects a run waiting at an approval step. */
  route('POST', '/api/workflows/:id/runs/:runId/decide', ({ params, body }) => {
    get(params.id);
    if (!engine.decide(params.runId, { approved: body?.approved === true, note: str(body?.note) || undefined })) throw new HttpError(404, 'That run isn’t waiting for approval');
    return { ok: true };
  });

  /** Runs the workflow, streaming each step as it starts and finishes. */
  route('POST', '/api/workflows/:id/run', async ({ params, body, req, res }) => {
    const w = get(params.id);
    if (engine.isRunning(w.id)) throw new HttpError(409, 'This workflow is already running');
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
    req.socket.setTimeout(0);
    const send = (e: WorkflowEvent) => !res.writableEnded && res.write(`data: ${JSON.stringify(e)}\n\n`);
    // Closing the editor doesn't stop the run; it keeps going and is recorded.
    await engine.run(w, str(body?.input), 'manual', send);
    res.end();
    return STREAMED;
  });
}
