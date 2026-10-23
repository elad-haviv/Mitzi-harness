// Workflows: a list of automations and an n8n-style editor. Steps are cards on a canvas you can pan
// and zoom; drag from a step's output to another step to connect them; run with live step status.
import {
  ArrowLeft,
  Bot as BotIcon,
  Brain,
  CalendarClock,
  Check,
  FileText,
  GitFork,
  Globe,
  ImageIcon,
  Loader2,
  LogIn,
  Maximize,
  MessageSquare,
  Minus,
  Play,
  Plus,
  Send,
  Square,
  Trash2,
  Type,
  Webhook,
  Workflow as WorkflowIcon,
  X,
  AlertTriangle,
  Repeat,
  Code2,
  Timer,
  Hand,
  Sparkles,
  Zap,
  FolderOpen,
  FolderSearch,
} from 'lucide-react';
import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, GalleryItem, NodeSpec, WorkflowEdge, WorkflowNode, WorkflowNodeType, WorkflowRun, WorkflowStep, WorkflowView } from '../api';
import { ModelPicker } from '../components/ModelPicker';
import { FolderPicker } from '../components/Folders';
import { Markdown } from '../components/Markdown';
import { Empty, Modal, Toggle, useConfirm } from '../components/ui';
import { duration, money } from '../components/Work';
import { href, navigate } from '../router';
import { relativeTime, useApp } from '../state';
import { plural, tr } from '../i18n';

export const NODE_ICON: Record<WorkflowNodeType, ReactNode> = {
  trigger: <LogIn size={15} />,
  ai: <BotIcon size={15} />,
  browse: <Globe size={15} />,
  http: <Webhook size={15} />,
  condition: <GitFork size={15} />,
  transform: <Type size={15} />,
  image: <ImageIcon size={15} />,
  artifact: <FileText size={15} />,
  memory: <Brain size={15} />,
  loop: <Repeat size={15} />,
  code: <Code2 size={15} />,
  delay: <Timer size={15} />,
  approval: <Hand size={15} />,
  output: <Send size={15} />,
};

const PALETTE: WorkflowNodeType[] = ['ai', 'browse', 'http', 'condition', 'loop', 'code', 'approval', 'delay', 'transform', 'image', 'artifact', 'memory', 'output', 'trigger'];

/** Steps with "yes" and "no" outputs. */
const twoWay = (t: WorkflowNodeType) => t === 'condition' || t === 'approval';

// ---------- List ----------

export function WorkflowsPage() {
  const { toast } = useApp();
  const [list, setList] = useState<WorkflowView[]>();
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    api.workflows().then(setList, (err) => toast(err.message));
  }, [toast]);
  const create = async (template: string) => {
    try {
      const w = await api.createWorkflow(template);
      navigate({ page: 'workflow', id: w.id });
    } catch (err) {
      toast((err as Error).message);
    }
  };
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{tr('Workflows')}</h1>
          <p className="page-subtitle">{tr('Automations made of steps: ask a bot, read a page, call an API, branch, save the result. Run them yourself, on a schedule, or from a chat.')}</p>
        </div>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          <Plus size={16} /> {tr('New workflow')}
        </button>
      </div>
      {!list ? (
        <Loader2 className="spin muted" size={18} />
      ) : !list.length ? (
        <Empty
          icon={<WorkflowIcon size={28} />}
          title={tr('No workflows yet')}
          action={
            <button className="btn btn-primary" onClick={() => setCreating(true)}>
              <Plus size={16} /> {tr('New workflow')}
            </button>
          }
        >
          {tr('Start from a template, like a web page digest or a message triage, or from a blank canvas.')}
        </Empty>
      ) : (
        <div className="grid">
          {list.map((w) => {
            const last = w.runs[0];
            return (
              <a key={w.id} className="tile workflow-tile" href={href({ page: 'workflow', id: w.id })}>
                <div className="workflow-tile-emoji">{w.emoji}</div>
                <div className="tile-title">{w.name}</div>
                <div className="tile-desc">{w.description || tr('{0} steps', w.nodes.length)}</div>
                <div className="tile-foot">
                  {last?.status === 'waiting' ? (
                    <span className="badge warn">
                      <Hand size={11} /> {tr('Waiting for you')}
                    </span>
                  ) : w.running ? (
                    <>
                      <Loader2 size={12} className="spin" /> {tr('Running')}
                    </>
                  ) : last ? (
                    <>
                      {last.status === 'error' ? <AlertTriangle size={12} /> : <Check size={12} />}{' '}{tr('Last run {0}', relativeTime(last.startedAt))}
                    </>
                  ) : (
                    tr('Never run')
                  )}
                  {w.exposeToChat && (
                    <span className="badge">
                      <MessageSquare size={11} /> {tr('In chats')}
                    </span>
                  )}
                </div>
              </a>
            );
          })}
        </div>
      )}
      {creating && <NewWorkflow onClose={() => setCreating(false)} onCreate={(t) => void create(t)} />}
    </div>
  );
}

/** Describe a workflow for Mitzi to build, or start from the gallery. */
function NewWorkflow({ onClose, onCreate }: { onClose(): void; onCreate(template: string): void }) {
  const { toast } = useApp();
  const [gallery, setGallery] = useState<GalleryItem[]>();
  const [description, setDescription] = useState('');
  const [building, setBuilding] = useState(false);
  useEffect(() => {
    api.workflowGallery().then(setGallery, (err) => toast(err.message));
  }, [toast]);
  const build = async () => {
    setBuilding(true);
    try {
      const w = await api.draftWorkflow(description.trim());
      toast(tr('Built “{0}”. Check each step before you run it.', w.name), 'info');
      navigate({ page: 'workflow', id: w.id });
    } catch (err) {
      toast((err as Error).message);
      setBuilding(false);
    }
  };
  const categories = [...new Set((gallery ?? []).map((g) => g.category))];
  return (
    <Modal title={tr('New workflow')} onClose={onClose} wide>
      <form
        className="wf-builder"
        onSubmit={(e) => {
          e.preventDefault();
          if (description.trim() && !building) void build();
        }}
      >
        <label className="field" style={{ marginBottom: 8 }}>
          <span className="field-label">
            <Sparkles size={14} className="accent" style={{ verticalAlign: -2 }} /> {tr('Describe it, and Mitzi builds it')}
          </span>
          <textarea
            className="textarea"
            rows={3}
            dir="auto"
            value={description}
            disabled={building}
            placeholder={tr('e.g. Every morning, read the Hacker News front page, pick the 5 stories about AI, summarize each in two lines and save a digest')}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) (e.currentTarget.form as HTMLFormElement).requestSubmit();
            }}
          />
        </label>
        <button className="btn btn-primary" disabled={!description.trim() || building}>
          {building ? (
            <>
              <Loader2 size={15} className="spin" /> {tr('Building…')}
            </>
          ) : (
            <>
              <Sparkles size={15} /> {tr('Build workflow')}
            </>
          )}
        </button>
      </form>
      <div className="panel-subhead" style={{ marginTop: 18 }}>
        {tr('Or start from the gallery')}
      </div>
      {!gallery ? (
        <Loader2 className="spin muted" size={18} />
      ) : (
        categories.map((c) => (
          <div key={c} className="gallery-group">
            <div className="gallery-category">{tr(c)}</div>
            <div className="template-grid">
              {gallery
                .filter((g) => g.category === c)
                .map((t) => (
                  <button key={t.id} className="template-card" onClick={() => onCreate(t.id)} disabled={building}>
                    <span className="workflow-tile-emoji">{t.emoji}</span>
                    <strong>{tr(t.name)}</strong>
                    <span className="muted small">{tr(t.description)}</span>
                    <span className="muted small">{tr('{0} steps', t.steps)}</span>
                  </button>
                ))}
            </div>
          </div>
        ))
      )}
    </Modal>
  );
}

// ---------- Editor ----------

const NODE_W = 210;
const NODE_H = 64;

interface Drag {
  kind: 'node' | 'pan' | 'wire';
  id?: string;
  port?: string;
  startX: number;
  startY: number;
  origX: number;
  origY: number;
  /** Cursor in canvas coordinates, for the wire being drawn. */
  x?: number;
  y?: number;
  moved?: boolean;
}

export function WorkflowEditor({ id }: { id: string }) {
  const { toast, bots } = useApp();
  const [wf, setWf] = useState<WorkflowView>();
  const [specs, setSpecs] = useState<Record<WorkflowNodeType, NodeSpec>>();
  const [selected, setSelected] = useState<{ kind: 'node' | 'edge'; id: string }>();
  const [view, setView] = useState({ x: 40, y: 40, k: 1 });
  const [drag, setDrag] = useState<Drag>();
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved');
  const [input, setInput] = useState('');
  const [run, setRun] = useState<WorkflowRun>();
  const [runOpen, setRunOpen] = useState(true);
  const [scheduling, setScheduling] = useState(false);
  const [triggering, setTriggering] = useState(false);
  const [confirmNode, confirm] = useConfirm();
  const canvas = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    api.workflow(id).then(
      (w) => {
        setWf(w);
        setRun(w.runs[0]);
      },
      (err) => {
        toast(err.message);
        navigate({ page: 'workflows' }, true);
      },
    );
    api.workflowNodeTypes().then(setSpecs, () => {});
  }, [id, toast]);

  // A run going on without this page streaming it (from a chat, a schedule, or after an approval): follow it.
  const streaming = useRef(false);
  useEffect(() => {
    if (!run || (run.status !== 'running' && run.status !== 'waiting') || streaming.current) return;
    const timer = setInterval(() => {
      api.workflow(id).then((w) => {
        setWf((cur) => (cur ? { ...cur, runs: w.runs, running: w.running } : w));
        setRun((r) => w.runs.find((x) => x.id === r?.id) ?? r);
      }, () => {});
    }, 1500);
    return () => clearInterval(timer);
  }, [id, run?.id, run?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Applies a change locally and saves it shortly after. */
  const change = useCallback(
    (patch: Partial<WorkflowView>) => {
      setWf((w) => {
        if (!w) return w;
        const next = { ...w, ...patch };
        clearTimeout(saveTimer.current);
        setSaveState('saving');
        saveTimer.current = setTimeout(() => {
          api
            .updateWorkflow(id, { name: next.name, description: next.description, emoji: next.emoji, exposeToChat: next.exposeToChat, nodes: next.nodes, edges: next.edges })
            .then(() => setSaveState('saved'))
            .catch((err) => {
              setSaveState('error');
              toast(err.message);
            });
        }, 500);
        return next;
      });
    },
    [id, toast],
  );

  const updateNode = (nodeId: string, patch: Partial<WorkflowNode>) => wf && change({ nodes: wf.nodes.map((n) => (n.id === nodeId ? { ...n, ...patch } : n)) });
  const setConfig = (nodeId: string, key: string, value: unknown) => {
    const n = wf?.nodes.find((x) => x.id === nodeId);
    if (n) updateNode(nodeId, { config: { ...n.config, [key]: value } });
  };

  const addNode = (type: WorkflowNodeType, at?: { x: number; y: number }) => {
    if (!wf || !specs) return;
    const rect = canvas.current?.getBoundingClientRect();
    const center = at ?? { x: ((rect?.width ?? 800) / 2 - view.x) / view.k - NODE_W / 2, y: ((rect?.height ?? 500) / 2 - view.y) / view.k - NODE_H / 2 };
    const nodeId = `${type}${Math.random().toString(36).slice(2, 7)}`;
    const node: WorkflowNode = { id: nodeId, type, label: specs[type].label, x: Math.round(center.x), y: Math.round(center.y), config: { ...specs[type].defaults } };
    // Connect it after the selected step, as you'd usually want.
    const from = selected?.kind === 'node' ? wf.nodes.find((n) => n.id === selected.id) : undefined;
    const edges = from && from.type !== 'output' ? [...wf.edges, { id: `${from.id}-${nodeId}`, from: from.id, to: nodeId, ...(twoWay(from.type) ? { port: 'true' } : {}) }] : wf.edges;
    if (from && !at) Object.assign(node, { x: from.x + NODE_W + 60, y: from.y });
    change({ nodes: [...wf.nodes, node], edges });
    setSelected({ kind: 'node', id: nodeId });
  };

  const removeSelected = () => {
    if (!wf || !selected) return;
    if (selected.kind === 'edge') change({ edges: wf.edges.filter((e) => e.id !== selected.id) });
    else change({ nodes: wf.nodes.filter((n) => n.id !== selected.id), edges: wf.edges.filter((e) => e.from !== selected.id && e.to !== selected.id) });
    setSelected(undefined);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName) || (e.target as HTMLElement).isContentEditable;
      if (!typing && (e.key === 'Delete' || e.key === 'Backspace') && selected) {
        e.preventDefault();
        removeSelected();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Canvas coordinates from a mouse event.
  const toCanvas = (clientX: number, clientY: number) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: (clientX - r.left - view.x) / view.k, y: (clientY - r.top - view.y) / view.k };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag || !wf) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (drag.kind === 'pan') setView((v) => ({ ...v, x: drag.origX + dx, y: drag.origY + dy }));
    else if (drag.kind === 'node' && drag.id) {
      if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
      setWf((w) => w && { ...w, nodes: w.nodes.map((n) => (n.id === drag.id ? { ...n, x: Math.round(drag.origX + dx / view.k), y: Math.round(drag.origY + dy / view.k) } : n)) });
    } else if (drag.kind === 'wire') {
      const p = toCanvas(e.clientX, e.clientY);
      setDrag({ ...drag, x: p.x, y: p.y });
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!drag || !wf) return setDrag(undefined);
    if (drag.kind === 'node' && drag.moved) change({ nodes: wf.nodes });
    if (drag.kind === 'wire' && drag.id) {
      const p = toCanvas(e.clientX, e.clientY);
      const target = wf.nodes.find((n) => n.id !== drag.id && p.x >= n.x - 12 && p.x <= n.x + NODE_W && p.y >= n.y - 12 && p.y <= n.y + NODE_H + 12);
      if (target && target.type !== 'trigger' && !wf.edges.some((x) => x.from === drag.id && x.to === target.id && (x.port ?? 'out') === (drag.port ?? 'out'))) {
        const edge: WorkflowEdge = { id: `${drag.id}-${target.id}-${drag.port ?? 'out'}`, from: drag.id, to: target.id, ...(drag.port && drag.port !== 'out' ? { port: drag.port } : {}) };
        change({ edges: [...wf.edges, edge] });
      }
    }
    setDrag(undefined);
  };

  const onWheel = (e: React.WheelEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    const k = Math.min(1.8, Math.max(0.4, view.k * (e.deltaY > 0 ? 0.92 : 1.08)));
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    setView({ k, x: mx - ((mx - view.x) / view.k) * k, y: my - ((my - view.y) / view.k) * k });
  };

  const fit = () => {
    if (!wf?.nodes.length || !canvas.current) return;
    const r = canvas.current.getBoundingClientRect();
    const minX = Math.min(...wf.nodes.map((n) => n.x));
    const minY = Math.min(...wf.nodes.map((n) => n.y));
    const maxX = Math.max(...wf.nodes.map((n) => n.x + NODE_W));
    const maxY = Math.max(...wf.nodes.map((n) => n.y + NODE_H));
    // Readable first: wide workflows start at the left and pan, rather than shrinking to fit.
    const k = Math.min(1.1, Math.max(0.75, Math.min((r.width - 80) / (maxX - minX), (r.height - 80) / (maxY - minY))));
    const w = (maxX - minX) * k;
    setView({ k, x: w <= r.width - 40 ? (r.width - w) / 2 - minX * k : 30 - minX * k, y: (r.height - (maxY - minY) * k) / 2 - minY * k });
  };
  const fitted = useRef(false);
  useEffect(() => {
    if (wf && !fitted.current) {
      fitted.current = true;
      requestAnimationFrame(fit);
    }
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    if (!wf) return;
    clearTimeout(saveTimer.current);
    try {
      // Run what's on screen.
      await api.updateWorkflow(id, { nodes: wf.nodes, edges: wf.edges });
      setSaveState('saved');
      setRunOpen(true);
      setWf((w) => w && { ...w, running: true });
      streaming.current = true;
      await api.runWorkflow(id, input, (e) => {
        if (e.type === 'run') setRun(e.run);
        else setRun((r) => (r && r.id === e.runId ? { ...r, steps: [...r.steps.filter((s) => s.nodeId !== e.step.nodeId), e.step] } : r));
      });
    } catch (err) {
      toast((err as Error).message);
    } finally {
      streaming.current = false;
      setWf((w) => w && { ...w, running: false });
      api.workflow(id).then((w) => setWf((cur) => (cur ? { ...cur, runs: w.runs } : w)), () => {});
    }
  };

  const stepOf = (nodeId: string): WorkflowStep | undefined => run?.steps.find((s) => s.nodeId === nodeId);
  const node = selected?.kind === 'node' ? wf?.nodes.find((n) => n.id === selected.id) : undefined;
  const trigger = wf?.nodes.find((n) => n.type === 'trigger');

  const edgePaths = useMemo(() => {
    if (!wf) return [];
    return wf.edges.map((e) => {
      const a = wf.nodes.find((n) => n.id === e.from);
      const b = wf.nodes.find((n) => n.id === e.to);
      if (!a || !b) return null;
      const ports = twoWay(a.type) ? ['true', 'false'] : ['out'];
      const pi = Math.max(0, ports.indexOf(e.port ?? (twoWay(a.type) ? 'true' : 'out')));
      const x1 = a.x + NODE_W;
      const y1 = a.y + (ports.length === 2 ? (pi === 0 ? NODE_H * 0.32 : NODE_H * 0.72) : NODE_H / 2);
      const x2 = b.x;
      const y2 = b.y + NODE_H / 2;
      const c = Math.max(40, Math.abs(x2 - x1) / 2);
      return { e, d: `M${x1},${y1} C${x1 + c},${y1} ${x2 - c},${y2} ${x2},${y2}`, mid: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 } };
    });
  }, [wf]);

  if (!wf || !specs) return <div className="page muted">{tr('Loading…')}</div>;

  const wire = drag?.kind === 'wire' && drag.id && drag.x !== undefined ? (() => {
    const a = wf.nodes.find((n) => n.id === drag.id)!;
    const two = twoWay(a.type);
    const x1 = a.x + NODE_W;
    const y1 = a.y + (two ? (drag.port === 'false' ? NODE_H * 0.72 : NODE_H * 0.32) : NODE_H / 2);
    const c = Math.max(40, Math.abs(drag.x! - x1) / 2);
    return `M${x1},${y1} C${x1 + c},${y1} ${drag.x! - c},${drag.y} ${drag.x},${drag.y}`;
  })() : '';

  return (
    <div className="wf-editor">
      <div className="wf-top">
        <a className="icon-btn" href={href({ page: 'workflows' })} aria-label={tr('All workflows')} title={tr('All workflows')}>
          <ArrowLeft size={18} />
        </a>
        <input className="wf-emoji" value={wf.emoji} onChange={(e) => change({ emoji: e.target.value })} aria-label={tr('Icon')} maxLength={4} />
        <div className="wf-titles">
          <input className="wf-name" value={wf.name} onChange={(e) => change({ name: e.target.value })} aria-label={tr('Workflow name')} />
          <input className="wf-desc" value={wf.description} placeholder={tr('What it does (bots see this when it’s used in chats)')} onChange={(e) => change({ description: e.target.value })} aria-label={tr('Description')} />
        </div>
        <span className="muted small wf-save">{saveState === 'saving' ? tr('Saving…') : saveState === 'error' ? tr('Not saved') : tr('Saved')}</span>
        <label className="wf-toggle" title={tr('Bots can run this workflow from any chat (they ask first)')}>
          <Toggle label={tr('Use in chats')} on={wf.exposeToChat} onChange={(v) => change({ exposeToChat: v })} />
          <span>{tr('Use in chats')}</span>
        </label>
        <button className={`btn btn-sm${wf.triggers?.webhook?.enabled || wf.triggers?.folder?.enabled ? ' on' : ''}`} onClick={() => setTriggering(true)}>
          <Zap size={14} /> {tr('Triggers')}
          {(wf.triggers?.webhook?.enabled || wf.triggers?.folder?.enabled) && <span className="dot-on" aria-label="on" />}
        </button>
        <button className="btn btn-sm" onClick={() => setScheduling(true)}>
          <CalendarClock size={14} /> {tr('Schedule')}
        </button>
        <button
          className="icon-btn"
          aria-label={tr('Delete workflow')}
          title={tr('Delete workflow')}
          onClick={async () => {
            if (!(await confirm(tr('“{0}” and its run history will be deleted. Scheduled tasks that run it are turned off.', wf.name), { title: tr('Delete workflow?') }))) return;
            await api.deleteWorkflow(id).catch((err) => toast(err.message));
            navigate({ page: 'workflows' });
          }}
        >
          <Trash2 size={17} />
        </button>
      </div>
      <div className="wf-body">
        <aside className="wf-palette" aria-label={tr('Steps')}>
          <div className="wf-palette-title">{tr('Add a step')}</div>
          {PALETTE.map((t) => (
            <button
              key={t}
              className="wf-palette-item"
              draggable
              onDragStart={(e) => e.dataTransfer.setData('application/x-mitzi-step', t)}
              onClick={() => addNode(t)}
              title={specs[t].description}
            >
              <span className={`wf-node-icon t-${t}`}>{NODE_ICON[t]}</span>
              <span className="wf-palette-name">{specs[t].label}</span>
            </button>
          ))}
        </aside>
        <div
          ref={canvas}
          className={`wf-canvas${drag?.kind === 'pan' ? ' panning' : ''}`}
          onPointerDown={(e) => {
            if (e.target !== e.currentTarget && !(e.target as Element).classList.contains('wf-surface')) return;
            setSelected(undefined);
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            setDrag({ kind: 'pan', startX: e.clientX, startY: e.clientY, origX: view.x, origY: view.y });
          }}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onWheel={onWheel}
          onDragOver={(e) => e.dataTransfer.types.includes('application/x-mitzi-step') && e.preventDefault()}
          onDrop={(e) => {
            const t = e.dataTransfer.getData('application/x-mitzi-step') as WorkflowNodeType;
            if (!t) return;
            e.preventDefault();
            const p = toCanvas(e.clientX, e.clientY);
            addNode(t, { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 });
          }}
          style={{ backgroundPosition: `${view.x}px ${view.y}px`, backgroundSize: `${22 * view.k}px ${22 * view.k}px` }}
        >
          <div className="wf-surface" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
            <svg className="wf-edges" width="4000" height="3000" style={{ left: -1000, top: -1000 }} viewBox="-1000 -1000 4000 3000">
              {edgePaths.map((p) =>
                p ? (
                  <g key={p.e.id}>
                    <path d={p.d} className="wf-edge-hit" onPointerDown={(ev) => (ev.stopPropagation(), setSelected({ kind: 'edge', id: p.e.id }))} />
                    <path d={p.d} className={`wf-edge${selected?.kind === 'edge' && selected.id === p.e.id ? ' selected' : ''}${run && stepOf(p.e.from)?.status === 'done' && stepOf(p.e.to) ? ' ran' : ''}`} />
                  </g>
                ) : null,
              )}
              {wire && <path d={wire} className="wf-edge drawing" />}
            </svg>
            {edgePaths.map((p) =>
              p && selected?.kind === 'edge' && selected.id === p.e.id ? (
                <button key={`x${p.e.id}`} className="wf-edge-delete" style={{ left: p.mid.x - 11, top: p.mid.y - 11 }} onClick={removeSelected} aria-label={tr('Remove connection')}>
                  <X size={12} />
                </button>
              ) : null,
            )}
            {wf.nodes.map((n) => {
              const step = stepOf(n.id);
              const two = twoWay(n.type);
              return (
                <div
                  key={n.id}
                  className={`wf-node t-${n.type}${selected?.kind === 'node' && selected.id === n.id ? ' selected' : ''}${step ? ` ${step.status}` : ''}`}
                  style={{ left: n.x, top: n.y, width: NODE_W, height: NODE_H }}
                  onPointerDown={(e) => {
                    if ((e.target as HTMLElement).closest('.wf-port')) return;
                    e.stopPropagation();
                    setSelected({ kind: 'node', id: n.id });
                    (canvas.current as HTMLElement).setPointerCapture(e.pointerId);
                    setDrag({ kind: 'node', id: n.id, startX: e.clientX, startY: e.clientY, origX: n.x, origY: n.y });
                  }}
                >
                  {n.type !== 'trigger' && <span className="wf-port in" aria-hidden />}
                  <span className={`wf-node-icon t-${n.type}`}>{NODE_ICON[n.type]}</span>
                  <span className="wf-node-text">
                    <span className="wf-node-label">{n.label}</span>
                    <span className="wf-node-sub">{nodeSummary(n, bots)}</span>
                  </span>
                  <span className="wf-node-state">
                    {step?.status === 'running' ? (
                      <Loader2 size={14} className="spin" />
                    ) : step?.status === 'waiting' ? (
                      <Hand size={14} className="waiting" />
                    ) : step?.status === 'done' ? (
                      <Check size={14} />
                    ) : step?.status === 'error' ? (
                      <AlertTriangle size={14} />
                    ) : null}
                  </span>
                  {(two ? ['true', 'false'] : n.type === 'output' ? [] : ['out']).map((port, i) => (
                    <span
                      key={port}
                      className={`wf-port out${two ? ` ${port}` : ''}`}
                      style={two ? { top: i === 0 ? NODE_H * 0.32 - 6 : NODE_H * 0.72 - 6 } : undefined}
                      title={two ? (port === 'true' ? tr('Yes') : tr('No')) : tr('Drag to connect')}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        (canvas.current as HTMLElement).setPointerCapture(e.pointerId);
                        const p = toCanvas(e.clientX, e.clientY);
                        setDrag({ kind: 'wire', id: n.id, port, startX: e.clientX, startY: e.clientY, origX: 0, origY: 0, x: p.x, y: p.y });
                      }}
                    >
                      {two && <span className="wf-port-label">{n.type === 'approval' ? (port === 'true' ? tr('approved') : tr('rejected')) : port === 'true' ? tr('yes') : tr('no')}</span>}
                    </span>
                  ))}
                </div>
              );
            })}
          </div>
          <div className="wf-zoom">
            <button className="icon-btn sm" onClick={() => setView((v) => ({ ...v, k: Math.min(1.8, v.k * 1.15) }))} aria-label={tr('Zoom in')}>
              <Plus size={14} />
            </button>
            <button className="icon-btn sm" onClick={() => setView((v) => ({ ...v, k: Math.max(0.4, v.k / 1.15) }))} aria-label={tr('Zoom out')}>
              <Minus size={14} />
            </button>
            <button className="icon-btn sm" onClick={fit} aria-label={tr('Fit to screen')} title={tr('Fit to screen')}>
              <Maximize size={14} />
            </button>
          </div>
          <div className="wf-hint muted small">{tr('Drag from a step’s right edge to another step to connect them. Delete removes the selection.')}</div>
        </div>
        <aside className="wf-side">
          {node ? (
            <NodeConfig key={node.id} node={node} spec={specs[node.type]} onLabel={(label) => updateNode(node.id, { label })} onConfig={(k, v) => setConfig(node.id, k, v)} onDelete={removeSelected} />
          ) : (
            <div className="wf-side-section">
              <div className="wf-side-title">{tr('Run')}</div>
              <label className="field">
                <span className="field-label">{tr('Input')}</span>
                <textarea
                  className="textarea"
                  rows={3}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder={String(trigger?.config.inputHint || tr('What to run it with (available as {{trigger}})'))}
                />
              </label>
              {wf.running ? (
                <button className="btn" onClick={() => void api.stopWorkflow(id)}>
                  <Square size={13} /> {tr('Stop')}
                </button>
              ) : (
                <button className="btn btn-primary" onClick={() => void start()}>
                  <Play size={14} /> {tr('Run workflow')}
                </button>
              )}
              <p className="muted small" style={{ marginTop: 14 }}>
                {tr('Select a step to change it. In prompts and fields,')}{' '}<code>{'{{input}}'}</code> {tr('is the previous step’s output,')}{' '}<code>{'{{trigger}}'}</code> {tr('the workflow’s input, and')}{' '}<code>{'{{Step name}}'}</code> {tr('any step’s output.')}
              </p>
            </div>
          )}
          {run && runOpen && (
            <RunLog
              run={run}
              wf={wf}
              onClose={() => setRunOpen(false)}
              onPick={(r) => setRun(r)}
              onDecide={(approved, note) =>
                void api.decideWorkflowRun(id, run.id, approved, note).then(
                  () => setRun((r) => r && { ...r, status: 'running', steps: r.steps.map((s) => (s.status === 'waiting' ? { ...s, status: 'running' } : s)) }),
                  (err) => toast(err.message),
                )
              }
            />
          )}
        </aside>
      </div>
      {scheduling && <ScheduleModal wf={wf} input={input} onClose={() => setScheduling(false)} />}
      {triggering && <TriggersModal wf={wf} onClose={() => setTriggering(false)} onSaved={(w) => setWf((cur) => (cur ? { ...cur, triggers: w.triggers } : w))} />}
      {confirmNode}
    </div>
  );
}

function nodeSummary(n: WorkflowNode, bots: { id: string; name: string; emoji: string }[]): string {
  const c = n.config;
  switch (n.type) {
    case 'ai': {
      const b = bots.find((x) => x.id === c.botId);
      return `${b ? `${b.emoji} ${b.name}` : 'Mitzi'}${c.tools ? ' · with tools' : ''}`;
    }
    case 'browse':
    case 'http':
      return `${n.type === 'http' ? `${c.method ?? 'GET'} ` : ''}${String(c.url || 'no address yet')}`;
    case 'condition':
      return c.test === 'empty' ? tr('is empty') : `${c.test ?? 'contains'} “${c.value ?? ''}”`;
    case 'trigger':
      return String(c.inputHint || tr('Manual, schedule or chat'));
    case 'artifact':
      return String(c.title || tr('Untitled'));
    case 'loop':
      return tr('each {0} · {1}', c.split === 'json' ? tr('JSON item') : c.split === 'paragraphs' ? tr('paragraph') : c.split === 'separator' ? tr('“{0}”-separated item', c.separator) : tr('line'), c.mode === 'template' ? tr('text') : tr('ask a bot'));
    case 'code':
      return c.language === 'python' ? tr('Python') : tr('JavaScript');
    case 'delay': {
      const s = Number(c.seconds) || 0;
      return s >= 60 ? tr('{0} min', Math.round(s / 6) / 10) : `${s} s`;
    }
    case 'approval':
      return tr('waits for you');
    default:
      return String(c.template ?? c.prompt ?? c.content ?? '').slice(0, 40);
  }
}

function NodeConfig({ node, spec, onLabel, onConfig, onDelete }: { node: WorkflowNode; spec: NodeSpec; onLabel(v: string): void; onConfig(k: string, v: unknown): void; onDelete(): void }) {
  const { bots } = useApp();
  const c = { ...spec.defaults, ...node.config } as Record<string, any>;
  const text = (k: string, label: string, placeholder?: string, rows = 0) => (
    <label className="field">
      <span className="field-label">{label}</span>
      {rows ? (
        <textarea className="textarea mono-ish" rows={rows} value={c[k] ?? ''} placeholder={placeholder} onChange={(e) => onConfig(k, e.target.value)} />
      ) : (
        <input className="input" value={c[k] ?? ''} placeholder={placeholder} onChange={(e) => onConfig(k, e.target.value)} />
      )}
    </label>
  );
  const botSelect = (
    <label className="field">
      <span className="field-label">{tr('Bot')}</span>
      <select className="select" value={c.botId ?? ''} onChange={(e) => onConfig('botId', e.target.value)}>
        {bots.map((b) => (
          <option key={b.id} value={b.id}>
            {b.emoji} {b.name}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <div className="wf-side-section">
      <div className="wf-side-title">
        <span className={`wf-node-icon t-${node.type}`}>{NODE_ICON[node.type]}</span> {spec.label}
      </div>
      <p className="muted small" style={{ marginTop: 0 }}>
        {spec.description}
      </p>
      <label className="field">
        <span className="field-label">{tr('Name')}</span>
        <input className="input" value={node.label} onChange={(e) => onLabel(e.target.value)} />
      </label>
      {node.type === 'trigger' && text('inputHint', 'What the input is', tr('e.g. A web address'))}
      {node.type === 'ai' && (
        <>
          {botSelect}
          <div className="field">
            <span className="field-label">{tr('Model')}</span>
            <ModelPicker value={c.model ?? ''} onChange={(m) => onConfig('model', m)} variant="input" direction="down" allowEmpty={tr('The bot’s model')} auto />
          </div>
          {text('prompt', tr('Prompt'), tr('What should the bot do? Use {{input}} for the previous step.'), 6)}
          <div className="tool-toggle">
            <div className="grow">
              <div className="t">{tr('Let it use its tools')}</div>
              <div className="s">{tr('Web, memory, media, browser and connectors, as set for the bot')}</div>
            </div>
            <Toggle label={tr('Use tools')} on={!!c.tools} onChange={(v) => onConfig('tools', v)} />
          </div>
          {c.tools && (
            <div className="tool-toggle">
              <div className="grow">
                <div className="t">{tr('Allow tools that would ask')}</div>
                <div className="s">{tr('Nobody is there to approve during a run; otherwise those tools are skipped')}</div>
              </div>
              <Toggle label={tr('Allow')} on={!!c.autoApprove} onChange={(v) => onConfig('autoApprove', v)} />
            </div>
          )}
        </>
      )}
      {node.type === 'browse' && text('url', 'Web address', tr('{{input}} or https://…'))}
      {node.type === 'http' && (
        <>
          <label className="field">
            <span className="field-label">{tr('Method')}</span>
            <select className="select" value={c.method ?? 'GET'} onChange={(e) => onConfig('method', e.target.value)}>
              {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          {text('url', 'URL', 'https://api.example.com/…')}
          {text('headers', tr('Headers (one per line)'), 'Authorization: Bearer …\nContent-Type: application/json', 3)}
          {c.method !== 'GET' && text('body', tr('Body'), '{"text": "{{input}}"}', 4)}
        </>
      )}
      {node.type === 'condition' && (
        <>
          {text('text', 'Check this text', '{{input}}')}
          <label className="field">
            <span className="field-label">{tr('Test')}</span>
            <select className="select" value={c.test ?? 'contains'} onChange={(e) => onConfig('test', e.target.value)}>
              <option value="contains">{tr('contains')}</option>
              <option value="equals">{tr('equals')}</option>
              <option value="regex">{tr('matches pattern')}</option>
              <option value="number">{tr('number is (e.g. &gt; 10)')}</option>
              <option value="empty">{tr('is empty')}</option>
            </select>
          </label>
          {c.test !== 'empty' && text('value', tr('Value'), c.test === 'number' ? '> 10' : 'urgent')}
          <p className="muted small">{tr('Connect the “yes” and “no” outputs to the steps for each case.')}</p>
        </>
      )}
      {(node.type === 'transform' || node.type === 'output') && text('template', node.type === 'output' ? tr('Result') : tr('Text'), '{{input}}', 5)}
      {node.type === 'image' && text('prompt', 'Image prompt', tr('A watercolor of {{input}}'), 4)}
      {node.type === 'artifact' && (
        <>
          {text('title', tr('Title'), tr('Weekly digest {{date}}'))}
          <label className="field">
            <span className="field-label">{tr('Type')}</span>
            <select className="select" value={c.type ?? 'markdown'} onChange={(e) => onConfig('type', e.target.value)}>
              <option value="markdown">{tr('Document')}</option>
              <option value="html">{tr('Web page')}</option>
              <option value="code">{tr('Code')}</option>
              <option value="svg">{tr('SVG graphic')}</option>
              <option value="mermaid">{tr('Diagram')}</option>
            </select>
          </label>
          {text('content', tr('Content'), '{{input}}', 4)}
        </>
      )}
      {node.type === 'memory' && (
        <>
          {botSelect}
          {text('content', tr('Memory'), '{{input}}', 3)}
        </>
      )}
      {node.type === 'loop' && (
        <>
          <label className="field">
            <span className="field-label">{tr('Split the input into')}</span>
            <select className="select" value={c.split ?? 'lines'} onChange={(e) => onConfig('split', e.target.value)}>
              <option value="lines">{tr('Lines (bullets and numbers removed)')}</option>
              <option value="paragraphs">{tr('Paragraphs')}</option>
              <option value="json">{tr('A JSON list')}</option>
              <option value="separator">{tr('Pieces split by…')}</option>
            </select>
          </label>
          {c.split === 'separator' && text('separator', tr('Separator'), ',')}
          <div className="segmented" style={{ marginBottom: 10 }}>
            <button className={c.mode !== 'template' ? 'active' : ''} onClick={() => onConfig('mode', 'ai')}>
              {tr('Ask a bot')}
            </button>
            <button className={c.mode === 'template' ? 'active' : ''} onClick={() => onConfig('mode', 'template')}>
              {tr('Text only')}
            </button>
          </div>
          {c.mode === 'template' ? (
            text('template', 'For each item', '- {{item}}', 3)
          ) : (
            <>
              {botSelect}
              {text('prompt', 'Prompt for each item', tr('Use {{item}} for the item and {{index}} for its number'), 5)}
              <label className="field">
                <span className="field-label">{tr('At the same time')}</span>
                <select className="select" value={c.parallel ?? 3} onChange={(e) => onConfig('parallel', Number(e.target.value))}>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>
                      {plural(n, '1 item', '{0} items')}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          <label className="field">
            <span className="field-label">{tr('Join the results as')}</span>
            <select className="select" value={c.join ?? 'paragraphs'} onChange={(e) => onConfig('join', e.target.value)}>
              <option value="paragraphs">{tr('Paragraphs')}</option>
              <option value="lines">{tr('Lines')}</option>
              <option value="json">{tr('A JSON list')}</option>
            </select>
          </label>
        </>
      )}
      {node.type === 'code' && (
        <>
          <div className="segmented" style={{ marginBottom: 10 }}>
            {(['javascript', 'python'] as const).map((l) => (
              <button key={l} className={(c.language ?? 'javascript') === l ? 'active' : ''} onClick={() => onConfig('language', l)}>
                {l === 'python' ? tr('Python') : tr('JavaScript')}
              </button>
            ))}
          </div>
          {text('code', tr('Code'), c.language === 'python' ? 'input.upper()' : 'return input.toUpperCase();', 9)}
          <p className="muted small">
            {c.language === 'python'
              ? tr('input, trigger and steps (outputs by step name) are set; the value of the last line is the result (or what it prints).')
              : tr('input, trigger and steps (outputs by step name) are set; return the result (or console.log it). Runs up to 5 seconds.')}
          </p>
        </>
      )}
      {node.type === 'delay' && (
        <label className="field">
          <span className="field-label">{tr('Wait (seconds, up to an hour)')}</span>
          <input className="input" type="number" min={0} max={3600} value={c.seconds ?? 60} onChange={(e) => onConfig('seconds', Number(e.target.value))} />
        </label>
      )}
      {node.type === 'approval' && (
        <>
          {text('message', 'What to ask', tr('Send this email?\n\n{{input}}'), 5)}
          <p className="muted small">{tr('The run pauses here until you approve or reject it, in this editor. Connect “approved” and “rejected” to what should happen next.')}</p>
        </>
      )}
      <button className="btn btn-sm btn-ghost danger-text" onClick={onDelete}>
        <Trash2 size={13} /> {tr('Delete step')}
      </button>
    </div>
  );
}

function RunLog({ run, wf, onClose, onPick, onDecide }: { run: WorkflowRun; wf: WorkflowView; onClose(): void; onPick(r: WorkflowRun): void; onDecide(approved: boolean, note?: string): void }) {
  const [note, setNote] = useState('');
  return (
    <div className="wf-side-section wf-runlog">
      <div className="wf-side-title">
        {run.status === 'running' ? <Loader2 size={14} className="spin" /> : run.status === 'waiting' ? <Hand size={14} /> : run.status === 'error' ? <AlertTriangle size={14} /> : <Check size={14} />}
        <span>{run.status === 'running' ? tr('Running…') : run.status === 'waiting' ? tr('Waiting for your approval') : run.status === 'error' ? tr('Run failed') : tr('Run finished')}</span>
        <span className="muted small" style={{ marginLeft: 'auto' }}>
          {run.finishedAt ? duration(new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) : ''}
          {run.cost ? ` · ${money(run.cost)}` : ''}
        </span>
        <button className="icon-btn sm" onClick={onClose} aria-label={tr('Close run log')}>
          <X size={14} />
        </button>
      </div>
      {run.error && <div className="error-box small">{run.error}</div>}
      <ol className="wf-steps">
        {run.steps.map((s) => {
          const n = wf.nodes.find((x) => x.id === s.nodeId);
          return (
            <li key={s.nodeId} className={s.status}>
              <details open={s.status === 'error' || s.status === 'waiting' || n?.type === 'output'}>
                <summary>
                  {n ? NODE_ICON[n.type] : null} <span>{n?.label ?? s.nodeId}</span>
                  <span className="muted small">{s.ms !== undefined ? duration(s.ms) : ''}</span>
                </summary>
                {s.status === 'waiting' ? (
                  <div className="wf-approval">
                    <StepOutput text={s.ask ?? ''} />
                    <textarea className="textarea" rows={2} placeholder={tr('A note for the next steps (optional)')} value={note} onChange={(e) => setNote(e.target.value)} />
                    <div className="row" style={{ gap: 8 }}>
                      <button className="btn btn-primary btn-sm" onClick={() => onDecide(true, note)}>
                        <Check size={14} /> {tr('Approve')}
                      </button>
                      <button className="btn btn-sm" onClick={() => onDecide(false, note)}>
                        <X size={14} /> {tr('Reject')}
                      </button>
                    </div>
                  </div>
                ) : s.error ? (
                  <div className="small" style={{ color: 'var(--danger)' }}>{s.error}</div>
                ) : s.output ? (
                  <StepOutput text={s.output} />
                ) : null}
              </details>
            </li>
          );
        })}
      </ol>
      {wf.runs.length > 1 && (
        <>
          <div className="panel-subhead">{tr('Earlier runs')}</div>
          <ul className="wf-history">
            {wf.runs.slice(0, 10).map((r) => (
              <li key={r.id}>
                <button className={`link-btn small${r.id === run.id ? ' on' : ''}`} onClick={() => onPick(r)}>
                  {r.status === 'error' ? '⚠︎' : '✓'} {relativeTime(r.startedAt)} · {r.trigger === 'schedule' ? tr('scheduled') : r.trigger === 'chat' ? tr('from a chat') : r.trigger === 'webhook' ? tr('webhook') : r.trigger === 'folder' ? tr('file {0}', r.source ?? '') : tr('manual')}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function StepOutput({ text }: { text: string }) {
  if (/^\/media\/[a-f0-9]{32}\.\w+$/.test(text)) return <img className="wf-step-img" src={text} alt={tr('Generated')} />;
  return (
    <div className="wf-step-output">
      <Markdown text={text.length > 4000 ? `${text.slice(0, 4000)}\n\n…` : text} />
    </div>
  );
}

/** Webhook and watched-folder triggers. */
function TriggersModal({ wf, onClose, onSaved }: { wf: WorkflowView; onClose(): void; onSaved(w: WorkflowView): void }) {
  const { toast } = useApp();
  const [folder, setFolder] = useState(wf.triggers?.folder ?? { path: '', pattern: '*.txt, *.md', enabled: false });
  const [browsing, setBrowsing] = useState(false);
  const [copied, setCopied] = useState(false);
  const hook = wf.triggers?.webhook;
  const url = hook ? `${location.origin}/hooks/${hook.token}` : '';
  const save = async (triggers: Parameters<typeof api.updateWorkflow>[1]['triggers'], message?: string) => {
    try {
      onSaved(await api.updateWorkflow(wf.id, { triggers }));
      if (message) toast(message, 'info');
    } catch (err) {
      toast((err as Error).message);
    }
  };
  return (
    <Modal title={tr('Triggers')} onClose={onClose} wide>
      <p className="muted small" style={{ marginTop: 0 }}>
        {tr('Start “{0}” by itself, besides running it here, from a chat, or on a schedule.', wf.name)}
      </p>
      <section className="trigger-card">
        <div className="tool-toggle" style={{ padding: 0, border: 0 }}>
          <Webhook size={18} className="muted" />
          <div className="grow">
            <div className="t">{tr('Webhook')}</div>
            <div className="s">{tr('Anything sent to a secret address runs the workflow, with what was sent as its input. Use it from other apps, scripts, or email services that forward mail to a webhook.')}</div>
          </div>
          <Toggle label={tr('Webhook')} on={!!hook?.enabled} onChange={(v) => void save({ webhook: { enabled: v } }, v ? 'Webhook on' : 'Webhook off')} />
        </div>
        {hook?.enabled && (
          <>
            <div className="row" style={{ gap: 6, marginTop: 10 }}>
              <input className="input mono" readOnly value={url} onFocus={(e) => e.target.select()} />
              <button
                className="btn btn-sm"
                onClick={() => {
                  navigator.clipboard.writeText(url).catch(() => {});
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? <Check size={14} /> : null} {copied ? tr('Copied') : tr('Copy')}
              </button>
              <button className="btn btn-sm btn-ghost" title={tr('Make a new address; the old one stops working')} onClick={() => void save({ webhook: { enabled: true, regenerate: true } }, tr('New address made; the old one no longer works'))}>
                {tr('New address')}
              </button>
            </div>
            <pre className="trigger-example">{`curl -X POST ${url} -d 'text to work on'\n# or JSON: -H 'content-type: application/json' -d '{"input": "…"}'\n# add ?wait=1 to get the result back`}</pre>
            <p className="muted small">{tr('Keep the address private: anyone who has it can run the workflow. Other services can reach it only if Mitzi is reachable from where they run (on your network, or through a tunnel).')}</p>
          </>
        )}
      </section>
      <section className="trigger-card">
        <div className="tool-toggle" style={{ padding: 0, border: 0 }}>
          <FolderOpen size={18} className="muted" />
          <div className="grow">
            <div className="t">{tr('Watch a folder')}</div>
            <div className="s">{tr('Each new or changed text file in the folder runs the workflow, with the file’s text as its input. Files already there when you start watching don’t count.')}</div>
          </div>
          <Toggle
            label={tr('Watch a folder')}
            on={!!wf.triggers?.folder?.enabled}
            onChange={(v) => {
              if (v && !folder.path) return setBrowsing(true);
              void save({ folder: { ...folder, enabled: v } }, v ? tr('Watching {0}', folder.path) : 'Stopped watching');
            }}
          />
        </div>
        <div className="row" style={{ gap: 6, marginTop: 10 }}>
          <input className="input mono" placeholder={tr('Choose a folder')} value={folder.path} readOnly onClick={() => setBrowsing(true)} />
          <button className="btn btn-sm" onClick={() => setBrowsing(true)}>
            <FolderSearch size={14} /> {tr('Choose…')}
          </button>
        </div>
        <label className="field" style={{ marginTop: 10, marginBottom: 0 }}>
          <span className="field-label">{tr('Files')}</span>
          <input
            className="input"
            value={folder.pattern}
            placeholder={'*.txt, *.md'}
            onChange={(e) => setFolder((f) => ({ ...f, pattern: e.target.value }))}
            onBlur={() => wf.triggers?.folder?.enabled && void save({ folder: { ...folder, enabled: true } })}
          />
        </label>
        {browsing && (
          <FolderPicker
            title={tr('Watch a folder')}
            action="Watch this folder"
            start={folder.path || undefined}
            onClose={() => setBrowsing(false)}
            onPick={(path) => {
              setBrowsing(false);
              setFolder((f) => ({ ...f, path }));
              void save({ folder: { ...folder, path, enabled: true } }, tr('Watching {0}', path));
            }}
          />
        )}
      </section>
    </Modal>
  );
}

function ScheduleModal({ wf, input, onClose }: { wf: WorkflowView; input: string; onClose(): void }) {
  const { toast, refreshTasks } = useApp();
  const [kind, setKind] = useState<'daily' | 'weekly' | 'interval'>('daily');
  const [time, setTime] = useState('09:00');
  const [every, setEvery] = useState(60);
  const [text, setText] = useState(input);
  const save = async () => {
    try {
      await api.createTask({
        name: wf.name,
        prompt: text,
        workflowId: wf.id,
        schedule: kind === 'interval' ? { kind: 'interval', everyMinutes: every } : kind === 'weekly' ? { kind: 'weekly', time, days: [1] } : { kind: 'daily', time },
      } as never);
      void refreshTasks();
      toast(tr('“{0}” will run on its schedule. You\'ll find it under Scheduled.', wf.name), 'info');
      onClose();
    } catch (err) {
      toast((err as Error).message);
    }
  };
  return (
    <Modal
      title={tr('Run on a schedule')}
      onClose={onClose}
      footer={
        <>
          <a className="btn btn-ghost" href={href({ page: 'tasks' })}>
            {tr('All scheduled tasks')}
          </a>
          <button className="btn btn-primary" onClick={() => void save()}>
            {tr('Schedule it')}
          </button>
        </>
      }
    >
      <div className="segmented" style={{ marginBottom: 12 }}>
        {(['daily', 'weekly', 'interval'] as const).map((k) => (
          <button key={k} className={kind === k ? 'active' : ''} onClick={() => setKind(k)}>
            {k === 'daily' ? tr('Every day') : k === 'weekly' ? tr('Every Monday') : tr('Every few minutes')}
          </button>
        ))}
      </div>
      {kind === 'interval' ? (
        <label className="field">
          <span className="field-label">{tr('Every (minutes)')}</span>
          <input className="input" type="number" min={5} value={every} onChange={(e) => setEvery(Number(e.target.value))} />
        </label>
      ) : (
        <label className="field">
          <span className="field-label">{tr('At')}</span>
          <input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </label>
      )}
      <label className="field">
        <span className="field-label">{tr('Input for each run')}</span>
        <textarea className="textarea" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={String(wf.nodes.find((n) => n.type === 'trigger')?.config.inputHint || tr('Optional'))} />
      </label>
    </Modal>
  );
}
