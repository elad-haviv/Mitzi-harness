// The artifact workspace: an artifact edited together with the bot in the chat it belongs to,
// with comments on passages and a version history.
import { Artifact, ArtifactComment, Chat, Doc, TEXT_ARTIFACT_TYPES } from '../shared/types.js';
import { Tool, ToolError } from '../tools/types.js';
import { newId, now, Store } from './store.js';

const MAX_VERSIONS = 80;
/** User edits within this window fold into one version. */
const USER_VERSION_WINDOW_MS = 5 * 60_000;

/** Records an edit by the user as a version (autosaves while typing collapse into one). */
export function userEdit(artifact: Artifact, content: string, title?: string): void {
  const last = artifact.versions.at(-1);
  if (last && last.content === content && (!title || title === artifact.title)) return;
  if (title) artifact.title = title;
  if (last && last.author === 'user' && !last.note && Date.now() - Date.parse(last.createdAt) < USER_VERSION_WINDOW_MS) {
    Object.assign(last, { content, title: artifact.title, createdAt: now() });
  } else {
    artifact.versions.push({ content, title: artifact.title, author: 'user', createdAt: now() });
    // Keep the first version and the most recent ones.
    if (artifact.versions.length > MAX_VERSIONS) artifact.versions.splice(1, artifact.versions.length - MAX_VERSIONS);
  }
  artifact.updatedAt = now();
}

export function newComment(quote: string, text: string, author: ArtifactComment['author']): ArtifactComment {
  return { id: newId(), quote: quote.slice(0, 2000), text, author, resolved: false, replies: [], createdAt: now() };
}

/** The system-prompt section for the artifact open in the workspace. */
export function focusPrompt(artifact: Artifact): string {
  const content = artifact.versions.at(-1)?.content ?? '';
  const open = (artifact.comments ?? []).filter((c) => !c.resolved);
  const comments = open.length
    ? open
        .map((c) => {
          const thread = [`- [${c.id}] ${c.author === 'user' ? 'User' : 'You'} on "${c.quote.slice(0, 300)}": ${c.text}`];
          for (const r of c.replies) thread.push(`  - ${r.author === 'user' ? 'User' : 'You'}: ${r.text}`);
          return thread.join('\n');
        })
        .join('\n')
    : '(none)';
  if (!TEXT_ARTIFACT_TYPES.includes(artifact.type)) {
    return `# Workspace\nThe user has the ${artifact.type} "${artifact.title}" (artifact ${artifact.id}) open beside this chat. To make a variation, generate a new one.`;
  }
  return `# Workspace
The user has the artifact "${artifact.title}" (id ${artifact.id}, type ${artifact.type}) open beside this chat and is working \
on it with you. They can also edit it directly, so always work from the version below. When they ask for changes, make them \
in this artifact with the Artifact tool ("update" for targeted edits, preferred; "rewrite" with id ${artifact.id} for \
restructuring or a first draft, including when it's empty and they ask you to "create" or "make" it) instead of pasting \
content into the chat or creating a new artifact, then say in a sentence or two what you changed. Addressing comments \
means editing this artifact. Only create a separate artifact when they explicitly ask for another one. Use ArtifactComment to reply to \
or resolve the user's comments once you've addressed them, or to leave a note on a passage.

<artifact id="${artifact.id}" type="${artifact.type}" title="${artifact.title.replace(/"/g, "'")}">
${content || '(empty)'}
</artifact>

Open comments:
${comments}`;
}

/** Lets the bot reply to, resolve and add comments on the chat's artifacts. */
export function commentTool(store: Store, chatId: string, onChange: (a: Artifact) => void): Tool<{ action: 'add' | 'reply' | 'resolve'; artifact_id: string; comment_id?: string; text?: string; quote?: string }> {
  return {
    name: 'ArtifactComment',
    kind: 'read',
    description:
      'Work with comments on an artifact. "reply" answers a comment thread (comment_id, text); "resolve" closes one you have ' +
      'addressed (comment_id, optional text as a final reply); "add" leaves a new comment on a passage (quote: exact text from the artifact, text).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'reply', 'resolve'] },
        artifact_id: { type: 'string' },
        comment_id: { type: 'string' },
        text: { type: 'string' },
        quote: { type: 'string' },
      },
      required: ['action', 'artifact_id'],
    },
    summarize: (a) => `${a.action}${a.text ? `: ${a.text.slice(0, 50)}` : ''}`,
    async run(a) {
      const artifact = store.artifacts.get(a.artifact_id);
      if (!artifact || artifact.chatId !== chatId) throw new ToolError(`No artifact with id "${a.artifact_id}" in this chat.`);
      artifact.comments ??= [];
      if (a.action === 'add') {
        if (!a.text?.trim() || !a.quote?.trim()) throw new ToolError('add needs quote and text');
        if (!(artifact.versions.at(-1)?.content ?? '').includes(a.quote)) throw new ToolError('quote must be exact text from the artifact');
        const c = newComment(a.quote, a.text.trim(), 'assistant');
        artifact.comments.push(c);
        store.artifacts.put(artifact);
        onChange(artifact);
        return `Added comment ${c.id}.`;
      }
      const c = artifact.comments.find((x) => x.id === a.comment_id);
      if (!c) throw new ToolError(`No comment with id ${a.comment_id}`);
      if (a.text?.trim()) c.replies.push({ author: 'assistant', text: a.text.trim(), createdAt: now() });
      else if (a.action === 'reply') throw new ToolError('reply needs text');
      if (a.action === 'resolve') c.resolved = true;
      store.artifacts.put(artifact);
      onChange(artifact);
      return a.action === 'resolve' ? `Resolved comment ${c.id}.` : `Replied to comment ${c.id}.`;
    },
  };
}

/** Turns documents from before they were artifacts into markdown artifacts in their chats. */
export function migrateDocs(store: Store): void {
  for (const doc of store.legacyDocs.all() as Doc[]) {
    const chat = store.chats.get(doc.chatId) as (Chat & { docId?: string }) | undefined;
    if (chat) {
      delete chat.docId;
      store.chats.put(chat);
    }
    if (chat && !store.artifacts.get(doc.id)) {
      const versions = doc.versions.length
        ? doc.versions.map((v) => ({ content: v.content, title: v.title, author: v.author, note: v.note, createdAt: v.createdAt }))
        : [{ content: doc.content, author: 'user' as const, createdAt: doc.createdAt }];
      if (versions.at(-1)!.content !== doc.content) versions.push({ content: doc.content, title: doc.title, author: 'user', note: undefined, createdAt: doc.updatedAt });
      store.artifacts.put({
        id: doc.id,
        chatId: chat.id,
        projectId: chat.projectId,
        title: doc.title,
        type: 'markdown',
        versions,
        comments: doc.comments,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
      });
    }
    store.legacyDocs.delete(doc.id);
  }
}
