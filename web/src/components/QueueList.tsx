// Messages waiting for the current response to finish. Drag one by its grip (mouse or touch) to change the
// order; with the keyboard, focus the grip and use the up and down arrows.
import { GripVertical, X, Zap } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { QueuedMessage } from '../api';

interface Drag {
  id: string;
  /** Where the pointer started, and how far it has moved. */
  startY: number;
  dy: number;
  /** The index the item would land at. */
  target: number;
}

export function QueueList({ queue, onReorder, onSendNow, onRemove }: { queue: QueuedMessage[]; onReorder(order: string[]): void; onSendNow(id: string): void; onRemove(id: string): void }) {
  const [drag, setDrag] = useState<Drag>();
  const list = useRef<HTMLDivElement>(null);
  // Moving an item with the keyboard keeps focus on its grip.
  const refocus = useRef<string>(undefined);
  useEffect(() => {
    if (!refocus.current) return;
    list.current?.querySelector<HTMLElement>(`[data-qid="${refocus.current}"]`)?.focus();
    refocus.current = undefined;
  }, [queue]);

  const move = (from: number, to: number) => {
    if (from === to || to < 0 || to >= queue.length) return;
    const ids = queue.map((q) => q.id);
    const [id] = ids.splice(from, 1);
    ids.splice(to, 0, id);
    onReorder(ids);
  };

  /** The index the dragged item would take, from the middles of the other items. */
  const targetAt = (y: number, id: string): number => {
    const items = [...(list.current?.querySelectorAll<HTMLElement>('.queue-item') ?? [])];
    let target = 0;
    items.forEach((el, i) => {
      if (queue[i]?.id === id) return;
      const r = el.getBoundingClientRect();
      if (y > r.top + r.height / 2) target++;
    });
    return target;
  };

  const start = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ id, startY: e.clientY, dy: 0, target: queue.findIndex((q) => q.id === id) });
  };
  const moveTo = (e: React.PointerEvent) => {
    if (!drag) return;
    setDrag({ ...drag, dy: e.clientY - drag.startY, target: targetAt(e.clientY, drag.id) });
  };
  const end = () => {
    if (!drag) return;
    move(
      queue.findIndex((q) => q.id === drag.id),
      drag.target,
    );
    setDrag(undefined);
  };

  // While dragging, the others make room where the item would land.
  const from = drag ? queue.findIndex((q) => q.id === drag.id) : -1;
  const shift = (i: number): number => {
    if (!drag || i === from) return 0;
    if (from < drag.target && i > from && i <= drag.target) return -1;
    if (from > drag.target && i >= drag.target && i < from) return 1;
    return 0;
  };
  const rowHeight = (list.current?.querySelector<HTMLElement>('.queue-item')?.offsetHeight ?? 34) + 4;

  return (
    <div className={`queue-list${drag ? ' dragging' : ''}`} aria-label="Queued messages" ref={list}>
      {queue.map((q, i) => (
        <div
          key={q.id}
          className={`queue-item${drag?.id === q.id ? ' lifted' : ''}`}
          style={drag ? { transform: `translateY(${drag.id === q.id ? drag.dy : shift(i) * rowHeight}px)` } : undefined}
        >
          {queue.length > 1 ? (
            <button
              className="queue-grip"
              data-qid={q.id}
              aria-label={`Move “${q.content.slice(0, 40)}” (position ${i + 1} of ${queue.length}); drag, or use the arrow keys`}
              title="Drag to reorder"
              onPointerDown={(e) => start(e, q.id)}
              onPointerMove={moveTo}
              onPointerUp={end}
              onPointerCancel={() => setDrag(undefined)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                  e.preventDefault();
                  refocus.current = q.id;
                  move(i, e.key === 'ArrowUp' ? i - 1 : i + 1);
                }
              }}
            >
              <GripVertical size={14} />
            </button>
          ) : (
            <span className="queue-grip idle" aria-hidden>
              <GripVertical size={14} />
            </span>
          )}
          <span className="queue-text" dir="auto" title={q.content}>
            <span className="muted small">{i === 0 ? 'Next' : `${i + 1}.`}</span> {q.content || q.attachments?.map((a) => a.name).join(', ')}
          </span>
          <button className="link-btn small" onClick={() => onSendNow(q.id)}>
            <Zap size={12} /> Send now
          </button>
          <button className="icon-btn sm" aria-label="Remove from the queue" title="Remove" onClick={() => onRemove(q.id)}>
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
