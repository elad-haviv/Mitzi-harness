// Small SVG charts: columns with an optional reference line, and dots over time. One y-axis,
// hairline grid, thin marks, a hover tooltip on every mark.
import { useEffect, useMemo, useRef, useState } from 'react';
import { tr } from '../i18n';

export interface Point {
  label: string;
  value: number;
  /** Tooltip text; defaults to "label: value". */
  tip?: string;
}

interface Props {
  points: Point[];
  height?: number;
  format?: (v: number) => string;
  /** A second measure in the same unit, drawn as a line (e.g. a moving average). */
  line?: { values: (number | null)[]; label: string };
  /** Draw dots instead of columns. */
  dots?: boolean;
  /** Fixed y range, e.g. [1, 5] for ratings. */
  domain?: [number, number];
  /** Accessible summary of what the chart shows. */
  title: string;
  /** Show every nth x label (default: about 6 labels). */
  labelEvery?: number;
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

export function Chart({ points, height = 180, format = (v) => String(Math.round(v * 100) / 100), line, dots, domain, title, labelEvery }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ i: number; x: number; y: number }>();
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const pad = { l: 44, r: 12, t: 10, b: 26 };
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  const [min, max] = useMemo(() => {
    if (domain) return domain;
    const all = [...points.map((p) => p.value), ...(line?.values.filter((v): v is number => v !== null) ?? [])];
    return [0, niceMax(Math.max(0, ...all))];
  }, [points, line, domain]);
  const ticks = domain ? Array.from({ length: domain[1] - domain[0] + 1 }, (_, i) => domain[0] + i) : [0, max / 4, max / 2, (3 * max) / 4, max];
  const y = (v: number) => pad.t + plotH - ((v - min) / (max - min || 1)) * plotH;
  const band = plotW / Math.max(1, points.length);
  const cx = (i: number) => pad.l + band * i + band / 2;
  const barW = Math.max(2, Math.min(24, band - 2));
  const every = labelEvery ?? Math.max(1, Math.ceil(points.length / 6));

  const linePath = line
    ? line.values
        .map((v, i) => (v === null ? null : `${cx(i).toFixed(1)},${y(v).toFixed(1)}`))
        .reduce<string[]>((segs, p) => {
          if (p === null) segs.push('');
          else segs[segs.length - 1] = segs.at(-1) ? `${segs.at(-1)} L${p}` : `M${p}`;
          return segs;
        }, [''])
        .filter(Boolean)
        .join(' ')
    : '';

  const show = (i: number, e: React.MouseEvent | React.FocusEvent) => {
    const box = wrap.current?.getBoundingClientRect();
    const target = (e.currentTarget as SVGElement).getBoundingClientRect();
    if (box) setHover({ i, x: target.left + target.width / 2 - box.left, y: target.top - box.top });
  };

  return (
    <div className="chart" ref={wrap} onMouseLeave={() => setHover(undefined)}>
      <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label={title}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} className="chart-grid" />
            <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" className="chart-tick">
              {format(t)}
            </text>
          </g>
        ))}
        {points.map((p, i) =>
          i % every === 0 || i === points.length - 1 ? (
            <text key={`x${i}`} x={cx(i)} y={height - 8} textAnchor="middle" className="chart-tick">
              {p.label}
            </text>
          ) : null,
        )}
        {points.map((p, i) => {
          const active = hover?.i === i;
          if (dots) {
            return <circle key={i} cx={cx(i)} cy={y(p.value)} r={active ? 6 : 4.5} className="chart-dot" />;
          }
          const h = Math.max(0, y(min) - y(p.value));
          const x = cx(i) - barW / 2;
          const r = Math.min(4, barW / 2, h);
          // Rounded data end, square at the baseline.
          const d = h <= 0 ? '' : `M${x},${y(min)} V${y(p.value) + r} Q${x},${y(p.value)} ${x + r},${y(p.value)} H${x + barW - r} Q${x + barW},${y(p.value)} ${x + barW},${y(p.value) + r} V${y(min)} Z`;
          return d ? <path key={i} d={d} className={`chart-bar${active ? ' active' : ''}`} /> : null;
        })}
        {linePath && <path d={linePath} className="chart-line" />}
        {/* Hit targets larger than the marks. */}
        {points.map((p, i) => (
          <rect
            key={`h${i}`}
            x={pad.l + band * i}
            y={pad.t}
            width={band}
            height={plotH}
            className="chart-hit"
            tabIndex={0}
            aria-label={p.tip ?? `${p.label}: ${format(p.value)}`}
            onMouseEnter={(e) => show(i, e)}
            onFocus={(e) => show(i, e)}
            onBlur={() => setHover(undefined)}
          />
        ))}
      </svg>
      {hover && points[hover.i] && (
        <div className="chart-tip" style={{ left: hover.x, top: hover.y }}>
          <strong>{points[hover.i].label}</strong>
          <span>{points[hover.i].tip ?? format(points[hover.i].value)}</span>
          {line && line.values[hover.i] !== null && line.values[hover.i] !== undefined && (
            <span className="muted">
              {line.label}: {format(line.values[hover.i]!)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** Mean of the last `n` values at each point (null until there's at least one). */
export function movingAverage(values: number[], n: number): (number | null)[] {
  return values.map((_, i) => {
    const slice = values.slice(Math.max(0, i - n + 1), i + 1);
    return slice.length ? slice.reduce((a, b) => a + b, 0) / slice.length : null;
  });
}

/** Rows with a name, an inline bar and a value: a breakdown that is also a table. */
export function Breakdown({ rows, format, empty }: { rows: { key: string; name: React.ReactNode; value: number; detail?: string }[]; format(v: number): string; empty: string }) {
  const max = Math.max(0, ...rows.map((r) => r.value)) || 1;
  if (!rows.length) return <p className="muted small">{empty}</p>;
  return (
    <table className="breakdown">
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} title={r.detail}>
            <td className="breakdown-name">{r.name}</td>
            <td className="breakdown-bar">
              <div style={{ width: `${Math.max(1.5, (r.value / max) * 100)}%` }} />
            </td>
            <td className="breakdown-value">{format(r.value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
