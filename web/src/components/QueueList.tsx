// Messages waiting for the current response to finish. Drag one by its grip (mouse or touch) to change the
// order; with the keyboard, focus the grip and use the up and down arrows. Click a message (or its pencil) to edit it.
import { GripVertical, Pencil, X, Zap } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { QueuedMessage } from '../api';
import { tr } from '../i18n';
import { moved, useSortable } from './sortable';

export function QueueList({
  queue,
  onReorder,
  onSendNow,
  onRemove,
  onEdit,
}: {
  queue: QueuedMessage[];
  onReorder(order: string[]): void;
  onSendNow(id: string): void;
  onRemove(id: string): void;
  onEdit(id: string, content: string): void;
}) {
  const ids = queue.map((q) => q.id);
  const { listRef, dragging, gripProps, rowStyle } = useSortable(ids, (from, to) => onReorder(moved(ids, from, to)), '.queue-item');
  const [editing, setEditing] = useState<string>();

  return (
    <div className={`queue-list${dragging ? ' dragging' : ''}`} aria-label={tr('Queued messages')} ref={listRef}>
      {queue.map((q, i) => (
        <div key={q.id} className={`queue-item${dragging === q.id ? ' lifted' : ''}${editing === q.id ? ' editing' : ''}`} style={rowStyle(q.id, i)}>
          {queue.length > 1 && editing !== q.id ? (
            <button
              className="queue-grip"
              aria-label={tr('Move “{0}” (position {1} of {2}); drag, or use the arrow keys', q.content.slice(0, 40), i + 1, queue.length)}
              title={tr('Drag to reorder')}
              {...gripProps(q.id, i)}
            >
              <GripVertical size={14} />
            </button>
          ) : (
            <span className="queue-grip idle" aria-hidden>
              <GripVertical size={14} />
            </span>
          )}
          {editing === q.id ? (
            <QueueEditor
              initial={q.content}
              onDone={(text) => {
                setEditing(undefined);
                if (text !== undefined && text !== q.content) onEdit(q.id, text);
              }}
            />
          ) : (
            <button className="queue-text" dir="auto" title={tr('Click to edit')} onClick={() => setEditing(q.id)}>
              <span className="muted small">{i === 0 ? tr('Next') : `${i + 1}.`}</span> {q.content || q.attachments?.map((a) => a.name).join(', ')}
            </button>
          )}
          {editing !== q.id && (
            <>
              <button className="icon-btn sm" aria-label={tr('Edit this message')} title={tr('Edit')} onClick={() => setEditing(q.id)}>
                <Pencil size={13} />
              </button>
              <button className="link-btn small" onClick={() => onSendNow(q.id)}>
                <Zap size={12} /> {tr('Send now')}
              </button>
              <button className="icon-btn sm" aria-label={tr('Remove from the queue')} title={tr('Remove')} onClick={() => onRemove(q.id)}>
                <X size={13} />
              </button>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

/** Edits a queued message in place: Enter saves, Shift+Enter starts a new line, Escape cancels. */
function QueueEditor({ initial, onDone }: { initial: string; onDone(text?: string): void }) {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  const finish = (value?: string) => {
    if (done.current) return;
    done.current = true;
    onDone(value);
  };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);
  return (
    <textarea
      ref={ref}
      className="queue-edit"
      dir="auto"
      rows={1}
      value={text}
      aria-label={tr('Queued message')}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => finish(text)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          finish(text);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish();
        }
      }}
    />
  );
}
