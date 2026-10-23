// Project knowledge that is too big to send whole: the project's files, and text files in folders linked to it,
// are split into chunks; each message gets the chunks most relevant to it, and a tool searches for more.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import type { Project } from '../shared/types.js';
import { Tool, ToolError } from '../tools/types.js';
import { tokenize } from './memory/search.js';

/** Up to this much knowledge (characters) goes into every chat whole; more is searched per message. */
export const INLINE_LIMIT = 60_000;
/** Excerpts added to each message's context when knowledge is searched. */
export const EXCERPT_BUDGET = 14_000;
const CHUNK = 1_400;

const FOLDER_FILES = 3_000;
const FOLDER_BYTES = 40 * 1024 * 1024;
const FILE_BYTES = 2 * 1024 * 1024;
const RESCAN_MS = 30_000;
const TEXT = /^\.(md|markdown|mdx|txt|text|rst|adoc|org|csv|tsv|json|jsonl|ya?ml|toml|ini|xml|html?|tex|srt|vtt|log|[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sql|sh|ps1|css|scss|vue|svelte)$/i;
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.venv', 'venv', '__pycache__', 'target', '.cache']);

export interface KnowledgeDoc {
  name: string;
  content: string;
  /** The linked folder it came from, if any. */
  folder?: string;
}

export interface Excerpt {
  name: string;
  /** Where in the document: the heading above the chunk, or a position. */
  where: string;
  text: string;
  score: number;
}

interface Chunk {
  name: string;
  where: string;
  text: string;
  tokens: string[];
}

interface Index {
  stamp: string;
  docs: KnowledgeDoc[];
  chunks: Chunk[];
  df: Map<string, number>;
  avgLen: number;
}

/** Splits a document at headings and paragraphs into chunks of about CHUNK characters, each labeled with its heading. */
export function chunk(name: string, content: string): { name: string; where: string; text: string }[] {
  const out: { name: string; where: string; text: string }[] = [];
  let heading = '';
  let buf = '';
  let part = 0;
  const flush = () => {
    if (buf.trim()) out.push({ name, where: heading || `part ${++part}`, text: buf.trim() });
    buf = '';
  };
  for (const para of content.split(/\n\s*\n/)) {
    const h = /^(#{1,6})\s+(.+)$/m.exec(para) ?? /^--- (Page|Slide) (\d+) ---$/m.exec(para);
    if (h) flush();
    if (h) heading = h[1].startsWith('#') ? h[2].trim() : `${h[1]} ${h[2]}`;
    // A paragraph longer than a chunk is cut into pieces.
    for (let i = 0; i < para.length; i += CHUNK) {
      const piece = para.slice(i, i + CHUNK);
      if (buf.length + piece.length > CHUNK) flush();
      buf += (buf ? '\n\n' : '') + piece;
    }
  }
  flush();
  return out;
}

/** Text files under a folder, skipping dependencies and build output, within the size limits. */
export function scanFolder(root: string): KnowledgeDoc[] {
  const docs: KnowledgeDoc[] = [];
  let bytes = 0;
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (docs.length >= FOLDER_FILES || bytes >= FOLDER_BYTES) return;
      if (e.name.startsWith('.') && e.name !== '.github') continue;
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) walk(path);
      } else if (e.isFile() && TEXT.test(extname(e.name))) {
        try {
          const size = statSync(path).size;
          if (size > FILE_BYTES) continue;
          const content = readFileSync(path, 'utf8');
          if (content.includes('\u0000')) continue;
          bytes += size;
          docs.push({ name: relative(root, path).replace(/\\/g, '/'), content, folder: root });
        } catch {
          // Unreadable; skip it.
        }
      }
    }
  };
  walk(root);
  return docs;
}

export class KnowledgeIndex {
  private readonly indexes = new Map<string, Index>();
  private readonly folders = new Map<string, { at: number; docs: KnowledgeDoc[] }>();

  /** A folder's files, rescanned at most every RESCAN_MS. */
  private folder(path: string): KnowledgeDoc[] {
    const cached = this.folders.get(path);
    if (cached && Date.now() - cached.at < RESCAN_MS) return cached.docs;
    const docs = scanFolder(path);
    this.folders.set(path, { at: Date.now(), docs });
    return docs;
  }

  /** Everything the project knows: its files, then the linked folders' files. */
  docs(project: Project): KnowledgeDoc[] {
    return [
      ...project.files.map((f) => ({ name: f.name, content: f.content })),
      ...(project.knowledgeFolders ?? []).flatMap((path) => this.folder(path).map((d) => ({ ...d, name: `${path.split(/[\\/]/).filter(Boolean).pop()}/${d.name}` }))),
    ];
  }

  /** Total size, in characters, and the number of documents. */
  size(project: Project): { chars: number; docs: number } {
    const docs = this.docs(project);
    return { chars: docs.reduce((n, d) => n + d.content.length, 0), docs: docs.length };
  }

  /** Whether the knowledge is too big to send whole. */
  isLarge(project: Project): boolean {
    return this.size(project).chars > INLINE_LIMIT;
  }

  private index(project: Project): Index {
    const docs = this.docs(project);
    const stamp = `${project.updatedAt}:${docs.length}:${docs.reduce((n, d) => n + d.content.length, 0)}`;
    const cached = this.indexes.get(project.id);
    if (cached?.stamp === stamp) return cached;
    const chunks = docs.flatMap((d) => chunk(d.name, d.content)).map((c) => ({ ...c, tokens: tokenize(`${c.name} ${c.where} ${c.text}`) }));
    const df = new Map<string, number>();
    for (const c of chunks) for (const t of new Set(c.tokens)) df.set(t, (df.get(t) ?? 0) + 1);
    const index = { stamp, docs, chunks, df, avgLen: chunks.reduce((n, c) => n + c.tokens.length, 0) / (chunks.length || 1) || 1 };
    this.indexes.set(project.id, index);
    return index;
  }

  /** The chunks that best match `query` (BM25), up to `budget` characters, optionally from one document. */
  search(project: Project, query: string, budget = EXCERPT_BUDGET, only?: string): Excerpt[] {
    const index = this.index(project);
    const q = [...new Set(tokenize(query))];
    if (!q.length) return [];
    const n = index.chunks.length;
    const scored: Excerpt[] = [];
    for (const c of index.chunks) {
      if (only && c.name !== only) continue;
      const tf = new Map<string, number>();
      for (const t of c.tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      let score = 0;
      let matched = 0;
      for (const t of q) {
        const f = tf.get(t);
        if (!f) continue;
        matched++;
        const df = index.df.get(t) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        score += (idf * f * 2.2) / (f + 1.2 * (0.25 + (0.75 * c.tokens.length) / index.avgLen));
      }
      // Chunks matching more of the question rank higher than ones repeating one word.
      if (score > 0) scored.push({ name: c.name, where: c.where, text: c.text, score: score * (1 + matched / q.length) });
    }
    scored.sort((a, b) => b.score - a.score);
    const out: Excerpt[] = [];
    let used = 0;
    for (const e of scored) {
      if (used + e.text.length > budget && out.length) break;
      out.push(e);
      used += e.text.length;
    }
    return out;
  }

  /** The ProjectKnowledge tool, for large knowledge: searches the project's documents. */
  tool(project: Project): Tool<{ query: string; document?: string }> {
    return {
      name: 'ProjectKnowledge',
      kind: 'read',
      description:
        `Search this project's knowledge (${this.size(project).docs} documents) for passages about something. ` +
        'Relevant excerpts for each message are already in your context; search when you need more, or something else. ' +
        'Give `document` to search one document only.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to look for, in words likely to appear in the documents' },
          document: { type: 'string', description: 'Optional: a document name, to search only it' },
        },
        required: ['query'],
      },
      summarize: (a) => `${a.query}${a.document ? ` in ${a.document}` : ''}`,
      run: async (a) => {
        if (!String(a.query ?? '').trim()) throw new ToolError('Say what to look for');
        const hits = this.search(project, a.query, 10_000, a.document || undefined);
        if (!hits.length) return `Nothing in the project's knowledge matches "${a.query}". Try other words.`;
        return hits.map((h) => `<excerpt document="${h.name}" section="${h.where}">\n${h.text}\n</excerpt>`).join('\n\n');
      },
    };
  }
}
