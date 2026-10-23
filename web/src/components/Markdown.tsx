import { Check, Copy } from 'lucide-react';
import { memo, ReactNode, useEffect, useReducer, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { tr } from '../i18n';

export function CopyButton({ text, label = tr('Copy') }: { text: () => string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="icon-btn sm"
      title={label}
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text());
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        } catch {
          // Clipboard blocked; nothing useful to do.
        }
      }}
    >
      {done ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

function CodeBlock({ children, className }: { children?: ReactNode; className?: string }) {
  const ref = useRef<HTMLPreElement>(null);
  // rehype-highlight puts `language-x` on the inner <code>.
  const child = Array.isArray(children) ? children[0] : children;
  const codeClass: string = (child as any)?.props?.className ?? className ?? '';
  const lang = /language-([\w+-]+)/.exec(codeClass)?.[1];
  return (
    <div className="code-block">
      <div className="code-block-head">
        <span>{lang ?? tr('text')}</span>
        <CopyButton text={() => ref.current?.innerText ?? ''} label={tr('Copy code')} />
      </div>
      <pre ref={ref}>{children}</pre>
    </div>
  );
}

const plugins = [remarkGfm];
const rehype = [[rehypeHighlight, { detect: true, ignoreMissing: true }]] as any;

/**
 * Reveals streamed text at an even pace instead of in the bursts it arrives in. The pace follows the
 * stream's average speed, so the gaps between bursts are filled, and speeds up when text piles up.
 */
export function useSmoothText(text: string, active: boolean): string {
  const target = useRef(text);
  target.current = text;
  const shown = useRef(active ? 0 : text.length);
  const started = useRef<number | undefined>(undefined);
  const [, render] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!active) return;
    let frame = 0;
    let last = performance.now();
    let carry = 0;
    const tick = (now: number) => {
      const length = target.current.length;
      if (length && started.current === undefined) started.current = now;
      const backlog = length - shown.current;
      if (backlog > 0) {
        const elapsed = (now - (started.current ?? now)) / 1000;
        // Characters per second the model has produced so far.
        const rate = elapsed > 0.3 ? length / elapsed : backlog / 0.3;
        // Never more than about half a second behind.
        const perSecond = Math.max(rate, backlog / 0.5, 30);
        carry += (perSecond * Math.min(50, now - last)) / 1000;
        const step = Math.floor(carry);
        if (step > 0) {
          carry -= step;
          shown.current = Math.min(length, shown.current + step);
          render();
        }
      } else carry = 0;
      last = now;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active]);
  if (!active) {
    shown.current = text.length;
    return text;
  }
  return text.slice(0, shown.current);
}

/** Splits Markdown into top-level blocks (at blank lines outside code fences), so finished blocks needn't re-render. */
export function splitBlocks(text: string): string[] {
  const lines = text.split('\n');
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length))) fence = fence ? undefined : marker;
    if (!fence && !line.trim() && !current.length) continue;
    // A blank line ends a block unless the next line continues it (indented list content).
    if (!fence && !line.trim() && current.length && !/^\s+\S/.test(lines[i + 1] ?? '')) {
      blocks.push(current.join('\n'));
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length) blocks.push(current.join('\n'));
  return blocks;
}

export const Markdown = memo(function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  const shown = useSmoothText(text, !!streaming);
  if (streaming) {
    const blocks = splitBlocks(shown);
    return (
      <div className="md streaming">
        {blocks.map((b, i) => (
          <MarkdownBlock key={i} text={b} last={i === blocks.length - 1} />
        ))}
      </div>
    );
  }
  return (
    <div className="md">
      <MarkdownBody text={text} />
    </div>
  );
});

const MarkdownBlock = memo(function MarkdownBlock({ text, last }: { text: string; last: boolean }) {
  return (
    <div className={`md-block${last ? ' caret' : ''}`}>
      <MarkdownBody text={text} />
    </div>
  );
});

function MarkdownBody({ text }: { text: string }) {
  return (
      <ReactMarkdown
        remarkPlugins={plugins}
        rehypePlugins={rehype}
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          // Each paragraph takes the direction of its own text, so Hebrew and Arabic read right to left.
          p: ({ children }) => <p dir="auto">{children}</p>,
          li: ({ children }) => <li dir="auto">{children}</li>,
          ul: ({ children }) => <ul dir="auto">{children}</ul>,
          ol: ({ children, start }) => (
            <ol dir="auto" start={start}>
              {children}
            </ol>
          ),
          h1: ({ children }) => <h1 dir="auto">{children}</h1>,
          h2: ({ children }) => <h2 dir="auto">{children}</h2>,
          h3: ({ children }) => <h3 dir="auto">{children}</h3>,
          blockquote: ({ children }) => <blockquote dir="auto">{children}</blockquote>,
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
  );
}
