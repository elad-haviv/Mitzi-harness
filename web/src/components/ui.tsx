import { X } from 'lucide-react';
import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../state';
import { tr } from '../i18n';

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={tr('Close')}>
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

/** A confirmation dialog driven by a promise: `if (await confirm('Delete?')) …`. */
export function useConfirm(): [ReactNode, (message: string, opts?: { title?: string; action?: string }) => Promise<boolean>] {
  const [state, setState] = useState<{ message: string; title: string; action: string; resolve(v: boolean): void }>();
  const ask = useCallback(
    (message: string, opts: { title?: string; action?: string } = {}) =>
      new Promise<boolean>((resolve) => setState({ message, title: opts.title ?? tr('Are you sure?'), action: opts.action ?? tr('Delete'), resolve })),
    [],
  );
  const close = (v: boolean) => {
    state?.resolve(v);
    setState(undefined);
  };
  const node = state ? (
    <Modal
      title={state.title}
      onClose={() => close(false)}
      footer={
        <>
          <button className="btn btn-ghost" onClick={() => close(false)}>
            {tr('Cancel')}
          </button>
          <button className="btn btn-primary" style={{ background: 'var(--danger)', borderColor: 'var(--danger)', color: '#fff' }} onClick={() => close(true)} autoFocus>
            {state.action}
          </button>
        </>
      }
    >
      <p style={{ margin: 0 }}>{state.message}</p>
    </Modal>
  ) : null;
  return [node, ask];
}

export function Menu({
  trigger,
  children,
  align = 'right',
  direction = 'down',
}: {
  trigger: (open: boolean, toggle: () => void) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
  direction?: 'up' | 'down';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="menu-wrap" ref={ref}>
      {trigger(open, () => setOpen((o) => !o))}
      {open && (
        <div
          className="menu"
          style={{ [align]: 0, ...(direction === 'down' ? { top: 'calc(100% + 4px)' } : { bottom: 'calc(100% + 4px)' }) }}
          role="menu"
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange(v: boolean): void; label: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={`toggle${on ? ' on' : ''}`} onClick={() => onChange(!on)} />;
}

export function Empty({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Toasts() {
  const { toasts, dismissToast } = useApp();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>
          <span>{t.message}</span>
          <button onClick={() => dismissToast(t.id)} aria-label={tr('Dismiss')}>
            <X size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Renders a "+ / - / context" preview as a colored diff. */
export function Diff({ text }: { text: string }) {
  return (
    <div className="diff">
      {text.split('\n').map((line, i) => (
        <div key={i} className={line.startsWith('+ ') ? 'add' : line.startsWith('- ') ? 'del' : line.startsWith('@@') ? 'hunk' : ''}>
          {line || ' '}
        </div>
      ))}
    </div>
  );
}

export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export function useAutoResize(ref: React.RefObject<HTMLTextAreaElement | null>, value: string) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [ref, value]);
}
