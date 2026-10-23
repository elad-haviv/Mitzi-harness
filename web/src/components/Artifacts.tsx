import hljs from 'highlight.js/lib/common';
import { ChevronLeft, ChevronRight, Code, Download, ExternalLink, FileCode, FileText, Globe, Image, ImageIcon, Maximize, Maximize2, Minimize2, Music, Network, PanelsTopLeft, Presentation, Shapes, SquareArrowOutUpRight, Video, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Artifact, ArtifactType } from '../api';
import { href } from '../router';
import { CopyButton, Markdown } from './Markdown';

export function ArtifactIcon({ type, size = 18 }: { type: ArtifactType; size?: number }) {
  switch (type) {
    case 'html':
      return <Globe size={size} />;
    case 'react':
      return <PanelsTopLeft size={size} />;
    case 'svg':
      return <Shapes size={size} />;
    case 'slides':
      return <Presentation size={size} />;
    case 'image':
      return <ImageIcon size={size} />;
    case 'video':
      return <Video size={size} />;
    case 'audio':
      return <Music size={size} />;
    case 'mermaid':
      return <Network size={size} />;
    case 'code':
      return <FileCode size={size} />;
    default:
      return <FileText size={size} />;
  }
}

export const TYPE_LABEL: Record<ArtifactType, string> = {
  markdown: 'Document',
  slides: 'Presentation',
  code: 'Code',
  html: 'Web page',
  react: 'Component',
  svg: 'Vector graphic',
  mermaid: 'Diagram',
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
};

export const isMedia = (type: ArtifactType) => type === 'image' || type === 'video' || type === 'audio';

/** Splits a Markdown presentation into slides at lines containing only ---. */
export function splitSlides(content: string): string[] {
  const slides = content.split(/^\s*---\s*$/m).map((s) => s.trim());
  return slides.filter((s, i) => s || i === 0);
}

/** A Markdown presentation: one slide at a time, with thumbnails and a full-screen mode. */
export function SlidesView({ content, compact }: { content: string; compact?: boolean }) {
  const slides = useMemo(() => splitSlides(content), [content]);
  const [index, setIndex] = useState(0);
  const stage = useRef<HTMLDivElement>(null);
  const at = Math.min(index, slides.length - 1);
  const go = useCallback((d: number) => setIndex((i) => Math.max(0, Math.min(slides.length - 1, i + d))), [slides.length]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!stage.current?.contains(document.activeElement) && document.fullscreenElement !== stage.current) return;
      if (['ArrowRight', 'PageDown', ' '].includes(e.key)) (e.preventDefault(), go(1));
      if (['ArrowLeft', 'PageUp'].includes(e.key)) (e.preventDefault(), go(-1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go]);
  return (
    <div className={`slides${compact ? ' compact' : ''}`}>
      <div className="slide-stage" ref={stage} tabIndex={0} onClick={(e) => document.fullscreenElement && (e.clientX > window.innerWidth / 2 ? go(1) : go(-1))}>
        <div className={`slide${at === 0 ? ' title-slide' : ''}`}>
          <Markdown text={slides[at] ?? ''} />
        </div>
      </div>
      <div className="slide-bar">
        <button className="icon-btn sm" disabled={at === 0} onClick={() => go(-1)} aria-label="Previous slide">
          <ChevronLeft size={16} />
        </button>
        <span className="small muted">
          {at + 1} / {slides.length}
        </span>
        <button className="icon-btn sm" disabled={at >= slides.length - 1} onClick={() => go(1)} aria-label="Next slide">
          <ChevronRight size={16} />
        </button>
        <div style={{ flex: 1 }} />
        <button className="btn btn-sm btn-ghost" onClick={() => void stage.current?.requestFullscreen?.()} title="Present full screen (arrow keys to move)">
          <Maximize size={14} /> Present
        </button>
      </div>
      {!compact && slides.length > 1 && (
        <div className="slide-thumbs">
          {slides.map((s, i) => (
            <button key={i} className={`slide-thumb${i === at ? ' on' : ''}`} onClick={() => setIndex(i)} aria-label={`Slide ${i + 1}`}>
              <div className={`slide${i === 0 ? ' title-slide' : ''}`}>
                <Markdown text={s} />
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function MediaView({ type, url, title }: { type: ArtifactType; url: string; title: string }) {
  if (type === 'image') return <img className="media-view" src={url} alt={title} />;
  if (type === 'video') return <video className="media-view" src={url} controls playsInline />;
  return (
    <div className="media-view audio">
      <Music size={40} className="muted" />
      <audio src={url} controls />
    </div>
  );
}

const ERROR_OVERLAY = `<script>
window.addEventListener('error', function (e) {
  var d = document.createElement('pre');
  d.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;margin:0;padding:12px 14px;background:#fdeee6;color:#9a3412;border:1px solid #f2865a;border-radius:10px;font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap;z-index:99999';
  d.textContent = 'Error: ' + (e.message || e.error);
  document.body.appendChild(d);
});
</script>`;

/** Converts a component module into a script that renders its default export. */
function reactDoc(code: string): string {
  const body = code
    .replace(/^\s*import\s+[^;]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^\s*import\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/export\s+default\s+/, 'window.__MitziDefault = ')
    .replace(/^export\s+(?=(const|let|var|function|class)\s)/gm, '');
  const script = `const { useState, useEffect, useRef, useMemo, useCallback, useReducer, useContext, createContext, Fragment, useLayoutEffect, useId } = React;
${body}
const __C = window.__MitziDefault;
if (!__C) throw new Error('The component needs a default export.');
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(__C));`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${ERROR_OVERLAY}
<script src="https://cdn.tailwindcss.com/3.4.16"></script>
<script src="https://unpkg.com/react@18.3.1/umd/react.production.min.js"></script>
<script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js"></script>
<script src="https://unpkg.com/@babel/standalone@7.26.4/babel.min.js"></script>
<style>body{margin:0;font-family:ui-sans-serif,system-ui,sans-serif}</style></head>
<body><div id="root"></div>
<script type="text/babel" data-presets="react">${script.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function artifactDocument(type: ArtifactType, content: string): string | undefined {
  switch (type) {
    case 'html':
      return /<html[\s>]/i.test(content) ? content.replace(/<head>/i, `<head>${ERROR_OVERLAY}`) : `<!doctype html><html><head><meta charset="utf-8">${ERROR_OVERLAY}</head><body>${content}</body></html>`;
    case 'svg':
      return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%}body{display:grid;place-items:center;background:#fff}svg{max-width:100%;max-height:100vh;height:auto}</style></head><body>${content}</body></html>`;
    case 'mermaid':
      return `<!doctype html><html><head><meta charset="utf-8">${ERROR_OVERLAY}<style>body{margin:0;padding:24px;display:flex;justify-content:center;font-family:ui-sans-serif,system-ui,sans-serif;background:#fff}</style></head>
<body><pre class="mermaid">${escapeHtml(content)}</pre>
<script type="module">import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs';mermaid.initialize({ startOnLoad: true, securityLevel: 'strict' });</script></body></html>`;
    case 'react':
      return reactDoc(content);
    default:
      return undefined;
  }
}

const EXT: Record<ArtifactType, string> = { markdown: 'md', slides: 'md', code: 'txt', html: 'html', react: 'jsx', svg: 'svg', mermaid: 'mmd', image: 'png', video: 'mp4', audio: 'mp3' };

export function download(artifact: Artifact, content: string) {
  if (isMedia(artifact.type)) {
    const a = document.createElement('a');
    a.href = content;
    a.download = `${artifact.title.replace(/[^\w.-]+/g, '-').replace(/^-|-$/g, '') || artifact.type}.${content.split('.').pop()}`;
    a.click();
    return;
  }
  const ext = artifact.type === 'code' && artifact.language ? languageExt(artifact.language) : EXT[artifact.type];
  const name = `${artifact.title.replace(/[^\w.-]+/g, '-').replace(/^-|-$/g, '') || 'artifact'}.${ext}`;
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function languageExt(lang: string): string {
  const map: Record<string, string> = { javascript: 'js', typescript: 'ts', python: 'py', rust: 'rs', ruby: 'rb', shell: 'sh', bash: 'sh', markdown: 'md', csharp: 'cs', kotlin: 'kt', golang: 'go' };
  return map[lang.toLowerCase()] ?? lang.toLowerCase();
}

export function HighlightedCode({ code, language }: { code: string; language?: string }) {
  const html = useMemo(() => {
    try {
      return language && hljs.getLanguage(language) ? hljs.highlight(code, { language }).value : hljs.highlightAuto(code).value;
    } catch {
      return escapeHtml(code);
    }
  }, [code, language]);
  return (
    <pre className="hljs-pre">
      <code dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  );
}

export function ArtifactView({
  artifact,
  version: versionProp,
  onClose,
  expanded,
  onToggleExpand,
  showChatLink,
  onOpenWorkspace,
}: {
  artifact: Artifact;
  version?: number;
  onClose?(): void;
  expanded?: boolean;
  onToggleExpand?(): void;
  showChatLink?: boolean;
  /** Opens the artifact in its full workspace (with its chat beside it). */
  onOpenWorkspace?(): void;
}) {
  const latest = artifact.versions.length - 1;
  const [version, setVersion] = useState(versionProp ?? latest);
  useEffect(() => setVersion(versionProp ?? artifact.versions.length - 1), [artifact.id, artifact.versions.length, versionProp]);
  const content = artifact.versions[Math.min(version, latest)]?.content ?? '';
  const doc = artifactDocument(artifact.type, content);
  const previewable = !!doc || artifact.type === 'markdown' || artifact.type === 'slides';
  const media = isMedia(artifact.type);
  const [tab, setTab] = useState<'preview' | 'code'>(previewable ? 'preview' : 'code');
  useEffect(() => setTab(previewable ? 'preview' : 'code'), [artifact.id, previewable]);

  return (
    <>
      <div className="panel-head">
        <div className="artifact-icon" style={{ width: 32, height: 32, borderRadius: 8 }}>
          <ArtifactIcon type={artifact.type} size={16} />
        </div>
        <div className="panel-title" title={artifact.title}>
          {artifact.title}
          <div className="muted" style={{ fontSize: 12, fontWeight: 400 }}>
            {TYPE_LABEL[artifact.type]}
            {artifact.language ? ` · ${artifact.language}` : ''}
          </div>
        </div>
        {artifact.versions.length > 1 && (
          <div className="version-nav">
            <button className="icon-btn sm" disabled={version === 0} onClick={() => setVersion((v) => v - 1)} aria-label="Previous version">
              <ChevronLeft size={15} />
            </button>
            v{version + 1}/{artifact.versions.length}
            <button className="icon-btn sm" disabled={version >= latest} onClick={() => setVersion((v) => v + 1)} aria-label="Next version">
              <ChevronRight size={15} />
            </button>
          </div>
        )}
        {previewable && !media && (
          <div className="segmented">
            <button className={tab === 'preview' ? 'active' : ''} onClick={() => setTab('preview')}>
              Preview
            </button>
            <button className={tab === 'code' ? 'active' : ''} onClick={() => setTab('code')}>
              <Code size={13} /> Code
            </button>
          </div>
        )}
        {!media && <CopyButton text={() => content} label="Copy content" />}
        {onOpenWorkspace && (
          <button className="icon-btn sm" title="Open in workspace: edit, comment and see versions" aria-label="Open in workspace" onClick={onOpenWorkspace}>
            <SquareArrowOutUpRight size={14} />
          </button>
        )}
        <button className="icon-btn sm" title="Download" aria-label="Download" onClick={() => download(artifact, content)}>
          <Download size={14} />
        </button>
        {showChatLink && (
          <a className="icon-btn sm" title="Open the chat that made this" aria-label="Open chat" href={href({ page: 'chat', id: artifact.chatId })}>
            <ExternalLink size={14} />
          </a>
        )}
        {onToggleExpand && (
          <button className="icon-btn sm" title={expanded ? 'Restore' : 'Expand'} aria-label={expanded ? 'Restore' : 'Expand'} onClick={onToggleExpand}>
            {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        )}
        {onClose && (
          <button className="icon-btn sm" title="Close" aria-label="Close" onClick={onClose}>
            <X size={15} />
          </button>
        )}
      </div>
      <div className="panel-body">
        {tab === 'preview' && doc && (
          <iframe
            key={`${artifact.id}-${version}`}
            title={artifact.title}
            sandbox="allow-scripts allow-popups allow-forms allow-modals allow-downloads"
            srcDoc={doc}
          />
        )}
        {media && <MediaView type={artifact.type} url={content} title={artifact.title} />}
        {tab === 'preview' && artifact.type === 'markdown' && <Markdown text={content} />}
        {tab === 'preview' && artifact.type === 'slides' && <SlidesView content={content} compact />}
        {tab === 'code' && !media && <HighlightedCode code={content} language={artifact.type === 'code' ? artifact.language : artifact.type === 'react' ? 'jsx' : artifact.type === 'svg' ? 'xml' : artifact.type === 'slides' ? 'markdown' : artifact.type} />}
      </div>
    </>
  );
}
