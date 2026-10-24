// Marking up an image: draw, point, box and label on top of it, then save the result as a version or send it to the
// bot as a guide for an edit ("make this sign blue", with the sign circled).
import { ArrowUpRight, Brush, Eraser, Loader2, Save, Sparkles, Square, Type, Undo2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { tr } from '../i18n';

type Point = { x: number; y: number };
type Shape =
  | { kind: 'pen'; pts: Point[]; color: string; w: number }
  | { kind: 'arrow' | 'rect'; a: Point; b: Point; color: string; w: number }
  | { kind: 'text'; at: Point; text: string; color: string; w: number };
type ToolKind = 'pen' | 'arrow' | 'rect' | 'text';

const COLORS = ['#ef4444', '#f97316', '#facc15', '#22c55e', '#3b82f6', '#ffffff', '#111111'];
const WIDTHS = [3, 6, 12];

function draw(ctx: CanvasRenderingContext2D, s: Shape, scale: number) {
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineWidth = s.w * scale;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (s.kind === 'pen') {
    ctx.beginPath();
    s.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    if (s.pts.length === 1) ctx.lineTo(s.pts[0].x + 0.1, s.pts[0].y);
    ctx.stroke();
  } else if (s.kind === 'rect') {
    ctx.strokeRect(Math.min(s.a.x, s.b.x), Math.min(s.a.y, s.b.y), Math.abs(s.b.x - s.a.x), Math.abs(s.b.y - s.a.y));
  } else if (s.kind === 'arrow') {
    const angle = Math.atan2(s.b.y - s.a.y, s.b.x - s.a.x);
    const head = Math.max(12, s.w * 4) * scale;
    ctx.beginPath();
    ctx.moveTo(s.a.x, s.a.y);
    ctx.lineTo(s.b.x, s.b.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(s.b.x, s.b.y);
    ctx.lineTo(s.b.x - head * Math.cos(angle - 0.45), s.b.y - head * Math.sin(angle - 0.45));
    ctx.lineTo(s.b.x - head * Math.cos(angle + 0.45), s.b.y - head * Math.sin(angle + 0.45));
    ctx.closePath();
    ctx.fill();
  } else if (s.kind === 'text') {
    const size = Math.max(16, s.w * 5) * scale;
    ctx.font = `600 ${size}px system-ui, sans-serif`;
    ctx.textBaseline = 'top';
    // An outline keeps the label readable on any background.
    ctx.lineWidth = Math.max(2, size / 6);
    ctx.strokeStyle = s.color === '#111111' ? '#ffffff' : '#000000';
    ctx.strokeText(s.text, s.at.x, s.at.y);
    ctx.fillText(s.text, s.at.x, s.at.y);
  }
}

export function Annotator({
  src,
  botName,
  busy,
  onSaveVersion,
  onAsk,
}: {
  src: string;
  botName: string;
  busy?: boolean;
  onSaveVersion(dataUrl: string): Promise<void>;
  onAsk(dataUrl: string, request: string): Promise<void>;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const image = useRef<HTMLImageElement | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const drawing = useRef<Shape | null>(null);
  const [tool, setTool] = useState<ToolKind>('pen');
  const [color, setColor] = useState(COLORS[0]);
  const [width, setWidth] = useState(WIDTHS[1]);
  const [request, setRequest] = useState('');
  const [working, setWorking] = useState<'save' | 'ask'>();

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      image.current = img;
      const c = canvas.current;
      if (c) {
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
      }
      setReady(true);
    };
    img.onerror = () => setFailed(true);
    img.src = src;
    setShapes([]);
  }, [src]);

  /** Canvas pixels per screen pixel, so marks look the same size whatever the image's resolution. */
  const scale = () => {
    const c = canvas.current!;
    return c.width / Math.max(1, c.getBoundingClientRect().width);
  };

  const render = useCallback(() => {
    const c = canvas.current;
    const img = image.current;
    if (!c || !img) return;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0);
    const k = scale();
    for (const s of shapes) draw(ctx, s, k);
    if (drawing.current) draw(ctx, drawing.current, k);
  }, [shapes]);
  useEffect(render, [render, ready]);

  const point = (e: React.PointerEvent): Point => {
    const r = canvas.current!.getBoundingClientRect();
    const k = scale();
    return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k };
  };

  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!ready || busy) return;
    const p = point(e);
    if (tool === 'text') {
      const text = window.prompt(tr('Label'))?.trim();
      if (text) setShapes((list) => [...list, { kind: 'text', at: p, text, color, w: width }]);
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = tool === 'pen' ? { kind: 'pen', pts: [p], color, w: width } : { kind: tool, a: p, b: p, color, w: width };
    render();
  };
  const move = (e: React.PointerEvent) => {
    const s = drawing.current;
    if (!s) return;
    if (s.kind === 'pen') s.pts.push(point(e));
    else if (s.kind !== 'text') s.b = point(e);
    render();
  };
  const up = () => {
    const s = drawing.current;
    drawing.current = null;
    if (s) setShapes((list) => [...list, s]);
  };

  const exportImage = () => {
    render();
    return canvas.current!.toDataURL('image/png');
  };
  const run = async (kind: 'save' | 'ask') => {
    setWorking(kind);
    try {
      if (kind === 'save') await onSaveVersion(exportImage());
      else await onAsk(exportImage(), request.trim());
      setShapes([]);
      setRequest('');
    } finally {
      setWorking(undefined);
    }
  };

  if (failed) return <p className="muted">{tr('This image couldn’t be loaded for markup.')}</p>;
  const tools: { id: ToolKind; icon: React.ReactNode; label: string }[] = [
    { id: 'pen', icon: <Brush size={15} />, label: tr('Draw') },
    { id: 'arrow', icon: <ArrowUpRight size={15} />, label: tr('Arrow') },
    { id: 'rect', icon: <Square size={15} />, label: tr('Box') },
    { id: 'text', icon: <Type size={15} />, label: tr('Label') },
  ];
  return (
    <div className="annotator">
      <div className="format-bar" role="toolbar" aria-label={tr('Markup tools')}>
        {tools.map((t) => (
          <button key={t.id} type="button" className={`icon-btn sm${tool === t.id ? ' on' : ''}`} title={t.label} aria-label={t.label} aria-pressed={tool === t.id} onClick={() => setTool(t.id)}>
            {t.icon}
          </button>
        ))}
        <span className="format-sep" />
        {COLORS.map((c) => (
          <button key={c} type="button" className={`swatch${color === c ? ' on' : ''}`} style={{ background: c }} title={c} aria-label={tr('Color {0}', c)} aria-pressed={color === c} onClick={() => setColor(c)} />
        ))}
        <span className="format-sep" />
        {WIDTHS.map((w) => (
          <button key={w} type="button" className={`icon-btn sm${width === w ? ' on' : ''}`} title={tr('Thickness {0}', w)} aria-label={tr('Thickness {0}', w)} aria-pressed={width === w} onClick={() => setWidth(w)}>
            <span className="stroke-dot" style={{ width: w + 2, height: w + 2 }} />
          </button>
        ))}
        <span className="format-sep" />
        <button type="button" className="icon-btn sm" title={tr('Undo')} aria-label={tr('Undo')} disabled={!shapes.length} onClick={() => setShapes((l) => l.slice(0, -1))}>
          <Undo2 size={15} />
        </button>
        <button type="button" className="icon-btn sm" title={tr('Clear the markup')} aria-label={tr('Clear the markup')} disabled={!shapes.length} onClick={() => setShapes([])}>
          <Eraser size={15} />
        </button>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn btn-sm" disabled={!shapes.length || !!working || busy} onClick={() => void run('save')} title={tr('Keep the image with your marks as its next version')}>
          {working === 'save' ? <Loader2 size={13} className="spin" /> : <Save size={13} />} {tr('Save as version')}
        </button>
      </div>
      <div className="annotator-stage">
        <canvas
          ref={canvas}
          className={`annotator-canvas tool-${tool}`}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          aria-label={tr('Image to mark up')}
        />
      </div>
      <form
        className="annotator-ask"
        onSubmit={(e) => {
          e.preventDefault();
          if (request.trim()) void run('ask');
        }}
      >
        <input
          className="input grow"
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          placeholder={shapes.length ? tr('What should change where you marked? e.g. “make this sign blue”') : tr('Mark the spots, then say what should change…')}
          aria-label={tr('What should change')}
          disabled={busy}
        />
        <button className="btn btn-primary btn-sm" disabled={!request.trim() || !!working || busy}>
          {working === 'ask' ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />} {tr('Ask {0}', botName)}
        </button>
      </form>
    </div>
  );
}
