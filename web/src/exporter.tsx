// Turns a chat or an artifact into one self-contained web page: for "Download as web page", and for share links.
// Everything the page needs is inside it (styles, images as data URLs); live artifacts (web pages, React,
// diagrams) run in sandboxed frames.
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { renderToStaticMarkup } from 'react-dom/server';
import lightCss from 'highlight.js/styles/github.css?raw';
import darkCss from 'highlight.js/styles/github-dark.css?raw';
import type { Artifact, Chat, ChatMessage, ContentPart } from './api';
import { artifactDocument } from './components/Artifacts';
import { withoutShownMedia } from '../../src/shared/mediaText';

const rehype = [[rehypeHighlight, { detect: true, ignoreMissing: true }]] as any;
const MEDIA = new Set(['image', 'video', 'audio']);

function Md({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={rehype}>
      {text}
    </ReactMarkdown>
  );
}

const textOf = (m: ChatMessage) => (typeof m.content === 'string' ? m.content : (m.content ?? []).map((p: ContentPart) => (p.type === 'text' ? p.text : '')).join('\n'));
const imagesOf = (m: ChatMessage) => (Array.isArray(m.content) ? m.content.filter((p): p is Extract<ContentPart, { type: 'image_url' }> => p.type === 'image_url').map((p) => p.image_url.url) : []);

/** The user's message without the attachment bodies (their names are kept). */
function userText(m: ChatMessage): { text: string; files: string[] } {
  const files: string[] = [];
  const text = textOf(m)
    .replace(/<attachment name="([^"]*)">[\s\S]*?<\/attachment>/g, (_, name: string) => (files.push(name), ''))
    .trim();
  return { text, files };
}

/** An artifact as page content: rendered text, highlighted code, media, or a sandboxed live preview. */
function ArtifactBlock({ artifact, content }: { artifact: Artifact; content: string }) {
  if (MEDIA.has(artifact.type)) {
    return artifact.type === 'image' ? <img src={content} alt={artifact.title} /> : artifact.type === 'video' ? <video src={content} controls /> : <audio src={content} controls />;
  }
  if (artifact.type === 'markdown' || artifact.type === 'slides') return <Md text={content} />;
  const doc = artifactDocument(artifact.type, content);
  if (doc) return <iframe className="live" title={artifact.title} sandbox="allow-scripts allow-popups" srcDoc={doc} />;
  return <Md text={`\`\`\`\n${content}\n\`\`\``} />;
}

function Page({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <main>
      <header>
        <h1>{title}</h1>
        <p className="sub">{subtitle}</p>
      </header>
      {children}
      <footer>Shared from Mitzi 🐱</footer>
    </main>
  );
}

const CSS = `
:root{--bg:#faf8f5;--fg:#1f1d1a;--muted:#6f6a63;--line:#e7e2da;--bubble:#efebe4;--card:#fff;--accent:#c2570c}
@media (prefers-color-scheme:dark){:root{--bg:#191817;--fg:#ece8e2;--muted:#a19b93;--line:#34312d;--bubble:#2a2825;--card:#22201e;--accent:#f0883e}}
*{box-sizing:border-box}html{background:var(--bg)}body{margin:0;color:var(--fg);font:16px/1.65 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:780px;margin:0 auto;padding:40px 20px 60px}header{margin-bottom:28px;border-bottom:1px solid var(--line)}h1{font-size:28px;margin:0 0 4px;line-height:1.25}.sub{color:var(--muted);margin:0 0 18px;font-size:14px}
.turn{margin:22px 0}.user{display:flex;flex-direction:column;align-items:flex-end}.user .bubble{background:var(--bubble);border-radius:18px;padding:10px 16px;max-width:85%;white-space:pre-wrap}
.who{font-size:12px;color:var(--muted);margin-bottom:4px}.files{font-size:12.5px;color:var(--muted);margin-bottom:6px}.user img{max-width:240px;border-radius:12px;margin-bottom:6px}
.assistant .body>*:first-child{margin-top:0}pre{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;overflow:auto;font-size:13.5px;line-height:1.5}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em}:not(pre)>code{background:var(--bubble);padding:1px 5px;border-radius:5px}
table{border-collapse:collapse;display:block;overflow:auto}th,td{border:1px solid var(--line);padding:6px 10px}a{color:var(--accent)}img,video{max-width:100%;border-radius:10px}
blockquote{margin:0;padding-left:14px;border-left:3px solid var(--line);color:var(--muted)}
details.artifact{border:1px solid var(--line);border-radius:12px;background:var(--card);margin:12px 0;padding:0 14px}details.artifact>summary{cursor:pointer;padding:10px 0;font-weight:600}
details.artifact[open]>summary{border-bottom:1px solid var(--line);margin-bottom:12px}.artifact-body{padding-bottom:12px}
iframe.live{width:100%;height:520px;border:1px solid var(--line);border-radius:10px;background:#fff}.thinking{color:var(--muted);font-size:14px}
footer{margin-top:48px;padding-top:16px;border-top:1px solid var(--line);color:var(--muted);font-size:13px;text-align:center}
`;

function document(title: string, body: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>${CSS}${lightCss}@media (prefers-color-scheme:dark){${darkCss}}</style></head><body>${body}</body></html>`;
}

/** Generated media (/media/…) become data URLs, so the page works on its own. */
async function inline(url: string): Promise<string> {
  if (!url.startsWith('/media/')) return url;
  try {
    const blob = await (await fetch(url)).blob();
    if (blob.size > 15 * 1024 * 1024) return url;
    return await new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.readAsDataURL(blob);
    });
  } catch {
    return url;
  }
}

const latest = (a: Artifact) => a.versions[a.versions.length - 1]?.content ?? '';

/** The whole page for an artifact (its latest version). */
export async function artifactPage(artifact: Artifact): Promise<string> {
  const content = MEDIA.has(artifact.type) ? await inline(latest(artifact)) : latest(artifact);
  const body = renderToStaticMarkup(
    <Page title={artifact.title} subtitle={`${new Date(artifact.updatedAt).toLocaleDateString(undefined, { dateStyle: 'long' })}`}>
      <ArtifactBlock artifact={artifact} content={content} />
    </Page>,
  );
  return document(artifact.title, body);
}

/** The whole page for a chat: the conversation, with the artifacts it made where they were made. */
export async function chatPage(chat: Chat, artifacts: Artifact[], opts: { botName?: string; thinking?: boolean } = {}): Promise<string> {
  const media = new Map<string, string>();
  for (const a of artifacts) if (MEDIA.has(a.type)) media.set(a.id, await inline(latest(a)));
  // Where each artifact was made: the tool call that created its first version.
  const made = new Map(artifacts.map((a) => [a.versions[0]?.callId, a]));
  const shown = new Set<string>();
  // Media files the page already shows as artifacts; the bot's text sometimes embeds them again.
  const mediaUrls = artifacts.filter((a) => MEDIA.has(a.type)).flatMap((a) => a.versions.map((v) => v.content));
  const turns = chat.messages.map((m, i) => {
    if (m.role === 'user' && m.auto === 'images') return null;
    if (m.role === 'user') {
      const { text, files } = userText(m);
      if (!text && !files.length && !imagesOf(m).length) return null;
      return (
        <div key={i} className="turn user">
          {files.length > 0 && <div className="files">📎 {files.join(', ')}</div>}
          {imagesOf(m).map((src, j) => (
            <img key={j} src={src} alt="Attached" />
          ))}
          {text && <div className="bubble">{text}</div>}
        </div>
      );
    }
    if (m.role !== 'assistant') return null;
    const text = withoutShownMedia(textOf(m), mediaUrls).trim();
    const created = (m.tool_calls ?? []).map((c) => made.get(c.id)).filter((a): a is Artifact => !!a && !shown.has(a.id));
    created.forEach((a) => shown.add(a.id));
    if (!text && !created.length) return null;
    return (
      <div key={i} className="turn assistant">
        <div className="who">{opts.botName ?? 'Mitzi'}</div>
        <div className="body">
          {opts.thinking && m.reasoning && (
            <details className="thinking">
              <summary>Thought process</summary>
              <Md text={m.reasoning} />
            </details>
          )}
          {text && <Md text={text} />}
          {created.map((a) => (
            <details key={a.id} className="artifact" open>
              <summary>{a.title}</summary>
              <div className="artifact-body">
                <ArtifactBlock artifact={a} content={media.get(a.id) ?? latest(a)} />
              </div>
            </details>
          ))}
        </div>
      </div>
    );
  });
  const body = renderToStaticMarkup(
    <Page title={chat.title} subtitle={`A conversation with ${opts.botName ?? 'Mitzi'} · ${new Date(chat.createdAt).toLocaleDateString(undefined, { dateStyle: 'long' })}`}>
      {turns}
    </Page>,
  );
  return document(chat.title, body);
}
