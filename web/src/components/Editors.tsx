// Editors for the artifact workspace: a syntax-highlighted code editor, a formatted (WYSIWYG) document editor that
// keeps the document as Markdown, and the formatting toolbar both share.
import hljs from 'highlight.js/lib/common';
import {
  Bold,
  Code,
  Hash,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link,
  List,
  ListOrdered,
  Minus,
  Pilcrow,
  Quote,
  Redo2,
  SquareCode,
  Strikethrough,
  Table,
  Undo2,
} from 'lucide-react';
import { forwardRef, useDeferredValue, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { htmlToMarkdown } from '../../../src/shared/htmlToMarkdown';
import { tr } from '../i18n';

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The highlight.js language for an artifact's text. */
export function editorLanguage(type: string, language?: string): string | undefined {
  switch (type) {
    case 'code':
      return language && hljs.getLanguage(language) ? language : undefined;
    case 'html':
    case 'svg':
      return 'xml';
    case 'react':
      return 'javascript';
    case 'markdown':
    case 'slides':
      return 'markdown';
    default:
      return undefined;
  }
}

/**
 * A textarea over a highlighted copy of its text: the text you type is transparent, the colors come from the copy
 * underneath, scrolled in step. `wrap` wraps long lines (prose); code scrolls sideways.
 */
export const CodeEditor = forwardRef<
  HTMLTextAreaElement,
  {
    value: string;
    onChange(v: string): void;
    language?: string;
    readOnly?: boolean;
    placeholder?: string;
    spellCheck?: boolean;
    wrap?: boolean;
    /** Return true when the key was handled. */
    onKey?(e: React.KeyboardEvent<HTMLTextAreaElement>): boolean;
  }
>(function CodeEditor({ value, onChange, language, readOnly, placeholder, spellCheck, wrap, onKey }, ref) {
  const input = useRef<HTMLTextAreaElement>(null);
  const layer = useRef<HTMLPreElement>(null);
  useImperativeHandle(ref, () => input.current!, []);
  // Highlighting a long file on every keystroke would lag typing; React catches up when it's idle.
  const deferred = useDeferredValue(value);
  const html = useMemo(() => {
    try {
      const out = language ? hljs.highlight(deferred, { language, ignoreIllegals: true }).value : escapeHtml(deferred);
      // A trailing newline needs something after it, or the last line's height is lost.
      return `${out}\n `;
    } catch {
      return `${escapeHtml(deferred)}\n `;
    }
  }, [deferred, language]);
  const sync = () => {
    if (layer.current && input.current) {
      layer.current.scrollTop = input.current.scrollTop;
      layer.current.scrollLeft = input.current.scrollLeft;
    }
  };
  useEffect(sync, [html]);
  return (
    <div className={`code-editor${wrap ? ' wrap' : ''}`}>
      <pre ref={layer} className="code-editor-layer hljs" aria-hidden>
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
      <textarea
        ref={input}
        className="code-editor-input"
        value={value}
        readOnly={readOnly}
        placeholder={placeholder}
        spellCheck={!!spellCheck}
        autoCapitalize="off"
        autoComplete="off"
        wrap={wrap ? 'soft' : 'off'}
        onScroll={sync}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (onKey?.(e)) return;
          // Tab indents in code (Shift+Tab or Escape then Tab still leave the editor).
          if (e.key === 'Tab' && !e.shiftKey && !wrap && !readOnly) {
            e.preventDefault();
            const el = e.currentTarget;
            const { selectionStart: a, selectionEnd: b } = el;
            const next = `${el.value.slice(0, a)}  ${el.value.slice(b)}`;
            onChange(next);
            requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2));
          }
        }}
      />
    </div>
  );
});

// ---------- Formatting ----------

export type FormatCommand = 'bold' | 'italic' | 'strike' | 'code' | 'h1' | 'h2' | 'h3' | 'p' | 'ul' | 'ol' | 'quote' | 'codeblock' | 'link' | 'hr' | 'table' | 'undo' | 'redo';

/** Applies a formatting command to Markdown source, around the selection. Returns the new text and selection. */
export function formatMarkdown(text: string, start: number, end: number, cmd: FormatCommand, url = ''): { text: string; start: number; end: number } {
  const sel = text.slice(start, end);
  const wrap = (before: string, after = before, empty = 'text') => {
    const inner = sel || empty;
    const next = text.slice(0, start) + before + inner + after + text.slice(end);
    return { text: next, start: start + before.length, end: start + before.length + inner.length };
  };
  // Line commands work on every line the selection touches.
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const lineEndAt = text.indexOf('\n', end);
  const lineEnd = lineEndAt < 0 ? text.length : lineEndAt;
  const lines = text.slice(lineStart, lineEnd).split('\n');
  const prefixLines = (prefix: (i: number) => string) => {
    const strip = (l: string) => l.replace(/^(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, '');
    // Applying the same prefix again removes it.
    const already = lines.every((l, i) => l.startsWith(prefix(i)));
    const next = lines.map((l, i) => (already ? l.slice(prefix(i).length) : prefix(i) + strip(l))).join('\n');
    return { text: text.slice(0, lineStart) + next + text.slice(lineEnd), start: lineStart, end: lineStart + next.length };
  };
  const insertBlock = (block: string) => {
    const before = text.slice(0, start).replace(/\n*$/, '');
    const after = text.slice(end).replace(/^\n*/, '');
    const head = before ? `${before}\n\n` : '';
    const next = `${head}${block}\n\n${after}`;
    return { text: next, start: head.length, end: head.length + block.length };
  };
  switch (cmd) {
    case 'bold':
      return wrap('**');
    case 'italic':
      return wrap('*');
    case 'strike':
      return wrap('~~');
    case 'code':
      return wrap('`', '`', 'code');
    case 'link':
      return wrap('[', `](${url || 'https://'})`, 'link');
    case 'h1':
      return prefixLines(() => '# ');
    case 'h2':
      return prefixLines(() => '## ');
    case 'h3':
      return prefixLines(() => '### ');
    case 'p':
      return prefixLines(() => '');
    case 'ul':
      return prefixLines(() => '- ');
    case 'ol':
      return prefixLines((i) => `${i + 1}. `);
    case 'quote':
      return prefixLines(() => '> ');
    case 'codeblock':
      return insertBlock(`\`\`\`\n${sel || 'code'}\n\`\`\``);
    case 'hr':
      return insertBlock('---');
    case 'table':
      return insertBlock('| Column | Column |\n| --- | --- |\n| | |');
    default:
      return { text, start, end };
  }
}

const TOOLS: { cmd: FormatCommand; icon: React.ReactNode; label: string; key?: string }[] = [
  { cmd: 'undo', icon: <Undo2 size={15} />, label: tr('Undo') },
  { cmd: 'redo', icon: <Redo2 size={15} />, label: tr('Redo') },
  { cmd: 'p', icon: <Pilcrow size={15} />, label: tr('Normal text') },
  { cmd: 'h1', icon: <Heading1 size={15} />, label: tr('Heading 1') },
  { cmd: 'h2', icon: <Heading2 size={15} />, label: tr('Heading 2') },
  { cmd: 'h3', icon: <Heading3 size={15} />, label: tr('Heading 3') },
  { cmd: 'bold', icon: <Bold size={15} />, label: tr('Bold'), key: 'b' },
  { cmd: 'italic', icon: <Italic size={15} />, label: tr('Italic'), key: 'i' },
  { cmd: 'strike', icon: <Strikethrough size={15} />, label: tr('Strikethrough') },
  { cmd: 'code', icon: <Code size={15} />, label: tr('Inline code') },
  { cmd: 'link', icon: <Link size={15} />, label: tr('Link'), key: 'k' },
  { cmd: 'ul', icon: <List size={15} />, label: tr('Bulleted list') },
  { cmd: 'ol', icon: <ListOrdered size={15} />, label: tr('Numbered list') },
  { cmd: 'quote', icon: <Quote size={15} />, label: tr('Quote') },
  { cmd: 'codeblock', icon: <SquareCode size={15} />, label: tr('Code block') },
  { cmd: 'table', icon: <Table size={15} />, label: tr('Table') },
  { cmd: 'hr', icon: <Minus size={15} />, label: tr('Divider') },
];

/** Bold, headings, lists… and the switch between the formatted view and the Markdown behind it. */
export function FormatToolbar({
  onCommand,
  source,
  onToggleSource,
  disabled,
  hideToggle,
}: {
  onCommand(cmd: FormatCommand): void;
  source: boolean;
  onToggleSource(): void;
  disabled?: boolean;
  hideToggle?: boolean;
}) {
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';
  return (
    <div className="format-bar" role="toolbar" aria-label={tr('Formatting')}>
      {TOOLS.map((t, i) => (
        <span key={t.cmd} className="row" style={{ gap: 0 }}>
          {(i === 2 || i === 6 || i === 11) && <span className="format-sep" />}
          <button
            type="button"
            className="icon-btn sm"
            title={t.key ? `${t.label} (${mod}${t.key.toUpperCase()})` : t.label}
            aria-label={t.label}
            disabled={disabled}
            // Keep the selection in the editor.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onCommand(t.cmd)}
          >
            {t.icon}
          </button>
        </span>
      ))}
      <span style={{ flex: 1 }} />
      {!hideToggle && <button
        type="button"
        className={`pill-btn${source ? ' on' : ''}`}
        aria-pressed={source}
        title={source ? tr('Show the document formatted') : tr('Show the Markdown behind the formatting')}
        onClick={onToggleSource}
      >
        <Hash size={14} /> {tr('Markdown')}
      </button>}
    </div>
  );
}

/** Keyboard shortcuts shared by both editors. */
export function shortcut(e: React.KeyboardEvent): FormatCommand | undefined {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return undefined;
  const k = e.key.toLowerCase();
  return k === 'b' ? 'bold' : k === 'i' ? 'italic' : k === 'k' ? 'link' : undefined;
}

// ---------- Formatted document editor ----------

export function markdownToHtml(md: string): string {
  return renderToStaticMarkup(<ReactMarkdown remarkPlugins={[remarkGfm]}>{md}</ReactMarkdown>);
}

export interface RichEditorHandle {
  run(cmd: FormatCommand): void;
  element(): HTMLDivElement | null;
}

/**
 * Edits a Markdown document as formatted text. The document stays Markdown: each change is read back from the
 * editor's HTML. Outside changes (the bot, a restored version) replace the content; the user's own typing never does.
 */
export const RichEditor = forwardRef<RichEditorHandle, { value: string; onChange(md: string): void; readOnly?: boolean; placeholder?: string }>(function RichEditor(
  { value, onChange, readOnly, placeholder },
  ref,
) {
  const el = useRef<HTMLDivElement>(null);
  const emitted = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!el.current || value === emitted.current) return;
    el.current.innerHTML = value.trim() ? markdownToHtml(value) : '<p><br></p>';
    el.current.dataset.empty = String(!value.trim());
    emitted.current = value;
  }, [value]);
  const read = () => {
    if (!el.current) return;
    const md = htmlToMarkdown(el.current);
    const next = md.trim() ? md : '';
    el.current.dataset.empty = String(!next);
    emitted.current = next;
    onChange(next);
  };
  const run = (cmd: FormatCommand) => {
    if (readOnly || !el.current) return;
    el.current.focus();
    const exec = (name: string, arg?: string) => document.execCommand(name, false, arg);
    switch (cmd) {
      case 'bold':
      case 'italic':
      case 'undo':
      case 'redo':
        exec(cmd);
        break;
      case 'strike':
        exec('strikeThrough');
        break;
      case 'code': {
        const text = window.getSelection()?.toString() || 'code';
        exec('insertHTML', `<code>${escapeHtml(text)}</code>&#8203;`);
        break;
      }
      case 'h1':
      case 'h2':
      case 'h3':
      case 'p':
        exec('formatBlock', cmd);
        break;
      case 'quote':
        exec('formatBlock', 'blockquote');
        break;
      case 'codeblock': {
        const text = window.getSelection()?.toString() || 'code';
        exec('insertHTML', `<pre><code>${escapeHtml(text)}</code></pre><p><br></p>`);
        break;
      }
      case 'ul':
        exec('insertUnorderedList');
        break;
      case 'ol':
        exec('insertOrderedList');
        break;
      case 'hr':
        exec('insertHorizontalRule');
        break;
      case 'table':
        exec('insertHTML', '<table><thead><tr><th>Column</th><th>Column</th></tr></thead><tbody><tr><td><br></td><td><br></td></tr></tbody></table><p><br></p>');
        break;
      case 'link': {
        const url = window.prompt(tr('Link address'), 'https://');
        if (url) exec('createLink', url);
        break;
      }
    }
    read();
  };
  useImperativeHandle(ref, () => ({ run, element: () => el.current }));
  return (
    <div
      ref={el}
      className="doc-paper md rich-editor"
      contentEditable={!readOnly}
      suppressContentEditableWarning
      role="textbox"
      aria-multiline
      aria-label={tr('Document')}
      data-placeholder={placeholder}
      spellCheck
      onFocus={() => document.execCommand('defaultParagraphSeparator', false, 'p')}
      onInput={read}
      onKeyDown={(e) => {
        const cmd = shortcut(e);
        if (cmd) {
          e.preventDefault();
          run(cmd);
        }
      }}
      onPaste={(e) => {
        // Paste as plain text: pasted styles can't be kept in Markdown anyway.
        const text = e.clipboardData.getData('text/plain');
        if (!text) return;
        e.preventDefault();
        document.execCommand('insertText', false, text);
      }}
    />
  );
});
