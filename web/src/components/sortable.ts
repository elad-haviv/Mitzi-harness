// Reordering a vertical list by dragging a grip (mouse or touch), or with the arrow keys on a focused grip.
// While dragging, the other rows slide to make room where the item would land.
import { useEffect, useRef, useState } from 'react';

interface Drag {
  id: string;
  /** Where the pointer started, and how far it has moved. */
  startY: number;
  dy: number;
  /** The index the item would land at. */
  target: number;
}

/**
 * `ids` are the rows in order; `onMove(from, to)` is called once a drop or key press moves one. Rows are the
 * elements matching `rowSelector` inside the element `listRef` points at, and grips carry `data-sort-id`.
 */
export function useSortable(ids: string[], onMove: (from: number, to: number) => void, rowSelector: string) {
  const [drag, setDrag] = useState<Drag>();
  const listRef = useRef<HTMLDivElement>(null);
  // Moving an item with the keyboard keeps focus on its grip.
  const refocus = useRef<string>(undefined);
  useEffect(() => {
    if (!refocus.current) return;
    listRef.current?.querySelector<HTMLElement>(`[data-sort-id="${refocus.current}"]`)?.focus();
    refocus.current = undefined;
  }, [ids.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  const move = (from: number, to: number) => {
    if (from !== to && to >= 0 && to < ids.length) onMove(from, to);
  };

  /** The index the dragged item would take, from the middles of the other rows. */
  const targetAt = (y: number, id: string): number => {
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>(rowSelector) ?? [])];
    let target = 0;
    rows.forEach((el, i) => {
      if (ids[i] === id) return;
      const r = el.getBoundingClientRect();
      if (y > r.top + r.height / 2) target++;
    });
    return target;
  };

  const from = drag ? ids.indexOf(drag.id) : -1;
  const shift = (i: number): number => {
    if (!drag || i === from) return 0;
    if (from < drag.target && i > from && i <= drag.target) return -1;
    if (from > drag.target && i >= drag.target && i < from) return 1;
    return 0;
  };
  const rowHeight = (listRef.current?.querySelector<HTMLElement>(rowSelector)?.offsetHeight ?? 34) + 4;

  /** Props for a row's drag grip. */
  const gripProps = (id: string, index: number) => ({
    'data-sort-id': id,
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      setDrag({ id, startY: e.clientY, dy: 0, target: index });
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (drag?.id === id) setDrag({ ...drag, dy: e.clientY - drag.startY, target: targetAt(e.clientY, id) });
    },
    onPointerUp: () => {
      if (drag?.id !== id) return;
      move(ids.indexOf(id), drag.target);
      setDrag(undefined);
    },
    onPointerCancel: () => setDrag(undefined),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      refocus.current = id;
      move(index, e.key === 'ArrowUp' ? index - 1 : index + 1);
    },
  });

  /** The style that moves a row while something is dragged. */
  const rowStyle = (id: string, index: number): React.CSSProperties | undefined =>
    drag ? { transform: `translateY(${drag.id === id ? drag.dy : shift(index) * rowHeight}px)` } : undefined;

  return { listRef, dragging: drag?.id, gripProps, rowStyle };
}

/** The list with one item moved, by id. */
export function moved(ids: string[], from: number, to: number): string[] {
  const next = [...ids];
  const [id] = next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}
