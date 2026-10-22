import { Check, Copy } from 'lucide-react';
import { memo, ReactNode, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';

export function CopyButton({ text, label = 'Copy' }: { text: () => string; label?: string }) {
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
        <span>{lang ?? 'text'}</span>
        <CopyButton text={() => ref.current?.innerText ?? ''} label="Copy code" />
      </div>
      <pre ref={ref}>{children}</pre>
    </div>
  );
}

const plugins = [remarkGfm];
const rehype = [[rehypeHighlight, { detect: true, ignoreMissing: true }]] as any;

export const Markdown = memo(function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className={`md${streaming ? ' cursor' : ''}`}>
      <ReactMarkdown
        remarkPlugins={plugins}
        rehypePlugins={rehype}
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
