// The document workspace: documents edited together with a bot through its companion chat.
import type { Doc, DocComment, DocSummary, DocVersion } from '../shared/types.js';
import { Tool, ToolError } from '../tools/types.js';
import { newId, now, Store } from './store.js';

const MAX_VERSIONS = 60;
/** User edits within this window fold into one version. */
const USER_VERSION_WINDOW_MS = 5 * 60_000;

export function summarizeDoc(doc: Doc): DocSummary {
  const { content, versions: _v, comments, ...rest } = doc;
  const plain = content.replace(/[#>*_`~\-[\]()!|]/g, ' ').replace(/\s+/g, ' ').trim();
  return {
    ...rest,
    openComments: comments.filter((c) => !c.resolved).length,
    words: plain ? plain.split(' ').length : 0,
    excerpt: plain.slice(0, 160),
  };
}

/** Records the document's current state as a version. */
export function snapshot(doc: Doc, author: DocVersion['author'], note?: string): void {
  const last = doc.versions.at(-1);
  if (last && last.content === doc.content && last.title === doc.title) return;
  // Autosaves while the user types collapse into the latest version.
  if (last && author === 'user' && last.author === 'user' && Date.now() - Date.parse(last.createdAt) < USER_VERSION_WINDOW_MS) {
    Object.assign(last, { content: doc.content, title: doc.title, createdAt: now() });
    return;
  }
  doc.versions.push({ id: newId(), title: doc.title, content: doc.content, author, note, createdAt: now() });
  if (doc.versions.length > MAX_VERSIONS) doc.versions.splice(1, doc.versions.length - MAX_VERSIONS);
}

export function newComment(quote: string, text: string, author: DocComment['author']): DocComment {
  return { id: newId(), quote: quote.slice(0, 2000), text, author, resolved: false, replies: [], createdAt: now() };
}

export function docPrompt(doc: Doc): string {
  const open = doc.comments.filter((c) => !c.resolved);
  const comments = open.length
    ? open
        .map((c) => {
          const thread = [`- [${c.id}] ${c.author === 'user' ? 'User' : 'You'} on "${c.quote.slice(0, 300)}": ${c.text}`];
          for (const r of c.replies) thread.push(`  - ${r.author === 'user' ? 'User' : 'You'}: ${r.text}`);
          return thread.join('\n');
        })
        .join('\n')
    : '(none)';
  return `# Document workspace
You are co-editing the document "${doc.title}" with the user. It is shown beside this chat, and the user can edit it directly \
at any time, so always work from the version below. Change it with DocEdit (targeted replacements; preferred) or DocRewrite \
(whole document, for restructuring or a first draft). Use DocComment to reply to or resolve the user's comments, or to leave a \
note on a passage. When the user asks for changes, make them in the document rather than pasting text into the chat, then \
summarize what you changed in a sentence or two. Write in GitHub-flavored Markdown.

<document title="${doc.title.replace(/"/g, "'")}">
${doc.content || '(empty)'}
</document>

Open comments:
${comments}`;
}

interface DocEditArgs {
  old_str: string;
  new_str: string;
  replace_all?: boolean;
}

/** Tools that edit the chat's document. `onChange` is told after each change. */
export function docTools(store: Store, docId: string, onChange: (doc: Doc) => void): Tool[] {
  const load = () => store.docs.get(docId) ?? (() => { throw new ToolError('The document no longer exists'); })();
  const save = (doc: Doc, note: string) => {
    doc.updatedAt = now();
    snapshot(doc, 'assistant', note);
    store.docs.put(doc);
    onChange(doc);
  };

  const edit: Tool<DocEditArgs> = {
    name: 'DocEdit',
    kind: 'read',
    description:
      'Replace text in the document. old_str must match the current document exactly (including whitespace and markdown) and be ' +
      'unique unless replace_all is set. Use an empty new_str to delete. To insert, include a nearby anchor in old_str and repeat it in new_str.',
    parameters: {
      type: 'object',
      properties: { old_str: { type: 'string' }, new_str: { type: 'string' }, replace_all: { type: 'boolean' } },
      required: ['old_str', 'new_str'],
    },
    summarize: (a) => (a.old_str ?? '').split('\n')[0].slice(0, 60),
    run: async (a) => {
      const doc = load();
      if (!a.old_str) throw new ToolError('old_str is empty; use DocRewrite to write the whole document');
      const count = doc.content.split(a.old_str).length - 1;
      if (!count) throw new ToolError('old_str was not found in the document. Copy it exactly from the latest document text.');
      if (count > 1 && !a.replace_all) throw new ToolError(`old_str appears ${count} times; add surrounding text to make it unique, or set replace_all`);
      doc.content = a.replace_all ? doc.content.split(a.old_str).join(a.new_str ?? '') : doc.content.replace(a.old_str, () => a.new_str ?? '');
      save(doc, 'Edited');
      return `Edited the document (${count} replacement${count === 1 ? '' : 's'}).`;
    },
  };

  const rewrite: Tool<{ content: string; title?: string }> = {
    name: 'DocRewrite',
    kind: 'read',
    description: 'Replace the whole document with new markdown content, optionally renaming it. Use for first drafts and large restructures.',
    parameters: { type: 'object', properties: { content: { type: 'string' }, title: { type: 'string' } }, required: ['content'] },
    summarize: (a) => a.title ?? 'Whole document',
    run: async (a) => {
      const doc = load();
      doc.content = String(a.content ?? '');
      if (a.title?.trim()) doc.title = a.title.trim().slice(0, 200);
      save(doc, 'Rewrote');
      return `Rewrote the document (${doc.content.length} characters).`;
    },
  };

  const comment: Tool<{ action: 'add' | 'reply' | 'resolve'; id?: string; text?: string; quote?: string }> = {
    name: 'DocComment',
    kind: 'read',
    description:
      'Work with document comments. "reply" answers a comment thread (id, text); "resolve" closes one you have addressed (id, optional text ' +
      'as a final reply); "add" leaves a new comment on a passage (quote: exact text from the document, text).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'reply', 'resolve'] },
        id: { type: 'string' },
        text: { type: 'string' },
        quote: { type: 'string' },
      },
      required: ['action'],
    },
    summarize: (a) => `${a.action}${a.text ? `: ${a.text.slice(0, 50)}` : ''}`,
    run: async (a) => {
      const doc = load();
      if (a.action === 'add') {
        if (!a.text?.trim() || !a.quote?.trim()) throw new ToolError('add needs quote and text');
        if (!doc.content.includes(a.quote)) throw new ToolError('quote must be exact text from the document');
        const c = newComment(a.quote, a.text.trim(), 'assistant');
        doc.comments.push(c);
        store.docs.put(doc);
        onChange(doc);
        return `Added comment ${c.id}.`;
      }
      const c = doc.comments.find((x) => x.id === a.id);
      if (!c) throw new ToolError(`No comment with id ${a.id}`);
      if (a.text?.trim()) c.replies.push({ author: 'assistant', text: a.text.trim(), createdAt: now() });
      else if (a.action === 'reply') throw new ToolError('reply needs text');
      if (a.action === 'resolve') c.resolved = true;
      store.docs.put(doc);
      onChange(doc);
      return a.action === 'resolve' ? `Resolved comment ${c.id}.` : `Replied to comment ${c.id}.`;
    },
  };

  return [edit, rewrite, comment] as Tool[];
}
