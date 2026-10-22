import type { Artifact, ArtifactType, Memory } from '../shared/types.js';
import { Tool, ToolError } from '../tools/types.js';
import { newId, now, Store } from './store.js';

const ARTIFACT_TYPES: ArtifactType[] = ['markdown', 'code', 'html', 'react', 'svg', 'mermaid'];

interface ArtifactArgs {
  command: 'create' | 'update' | 'rewrite';
  id?: string;
  type?: ArtifactType;
  title?: string;
  language?: string;
  content?: string;
  old_str?: string;
  new_str?: string;
}

export function artifactTool(store: Store, chatId: string, projectId: string | undefined, onChange: (a: Artifact) => void): Tool<ArtifactArgs> {
  return {
    name: 'Artifact',
    kind: 'read',
    description:
      'Create or change an artifact: substantial, self-contained content shown in a panel beside the chat ' +
      '(documents, code files, web pages, React components, SVG graphics, Mermaid diagrams). ' +
      '"create" needs type, title and content and returns the new artifact id. ' +
      '"update" replaces old_str (must match exactly once) with new_str in an existing artifact; use it for small changes. ' +
      '"rewrite" replaces the whole content (and optionally the title).',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['create', 'update', 'rewrite'] },
        id: { type: 'string', description: 'Artifact id (update/rewrite)' },
        type: { type: 'string', enum: ARTIFACT_TYPES, description: 'Artifact type (create)' },
        title: { type: 'string', description: 'Short descriptive title' },
        language: { type: 'string', description: 'Programming language, for type "code"' },
        content: { type: 'string', description: 'Full content (create/rewrite)' },
        old_str: { type: 'string', description: 'Exact text to replace (update)' },
        new_str: { type: 'string', description: 'Replacement text (update)' },
      },
      required: ['command'],
    },
    summarize: (a) => a.title ?? a.id ?? '',
    async run(args, ctx) {
      if (args.command === 'create') {
        if (!args.type || !ARTIFACT_TYPES.includes(args.type)) throw new ToolError(`type must be one of: ${ARTIFACT_TYPES.join(', ')}`);
        if (typeof args.content !== 'string') throw new ToolError('content is required');
        const artifact: Artifact = {
          id: newId(),
          chatId,
          projectId,
          title: args.title?.trim() || 'Untitled',
          type: args.type,
          language: args.language,
          versions: [{ content: args.content, createdAt: now(), callId: ctx.callId }],
          createdAt: now(),
          updatedAt: now(),
        };
        store.artifacts.put(artifact);
        onChange(artifact);
        return `Created artifact "${artifact.title}" with id ${artifact.id}. The user can see it in the artifact panel.`;
      }

      const artifact = args.id ? store.artifacts.get(args.id) : undefined;
      if (!artifact || artifact.chatId !== chatId) throw new ToolError(`No artifact with id "${args.id}" in this chat.`);
      const current = artifact.versions.at(-1)!.content;
      let next: string;
      if (args.command === 'update') {
        if (!args.old_str) throw new ToolError('old_str is required for update');
        const count = current.split(args.old_str).length - 1;
        if (count !== 1) throw new ToolError(count ? `old_str matches ${count} times; include more context.` : 'old_str was not found in the artifact.');
        next = current.replace(args.old_str, () => args.new_str ?? '');
      } else if (args.command === 'rewrite') {
        if (typeof args.content !== 'string') throw new ToolError('content is required for rewrite');
        next = args.content;
        if (args.title?.trim()) artifact.title = args.title.trim();
      } else {
        throw new ToolError('command must be create, update or rewrite');
      }
      artifact.versions.push({ content: next, createdAt: now(), callId: ctx.callId });
      artifact.updatedAt = now();
      store.artifacts.put(artifact);
      onChange(artifact);
      return `Updated artifact ${artifact.id} (now version ${artifact.versions.length}).`;
    },
  };
}

interface MemoryArgs {
  action: 'add' | 'update' | 'delete';
  content?: string;
  id?: string;
  scope?: 'global' | 'project';
}

export function memoryTool(store: Store, projectId: string | undefined): Tool<MemoryArgs> {
  return {
    name: 'Memory',
    kind: 'read',
    description:
      'Manage long-term memories about the user that carry across conversations. Add a memory when the user asks you to ' +
      'remember something, or shares a durable preference or fact that will clearly matter later. Never store secrets. ' +
      'Update or delete memories that are wrong or outdated (ids are listed in the system prompt).' +
      (projectId ? ' Use scope "project" for memories that only matter within the current project.' : ''),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'update', 'delete'] },
        content: { type: 'string', description: 'The memory, as a short standalone sentence' },
        id: { type: 'string', description: 'Memory id (update/delete)' },
        ...(projectId ? { scope: { type: 'string', enum: ['global', 'project'] } } : {}),
      },
      required: ['action'],
    },
    summarize: (a) => `${a.action}${a.content ? `: ${a.content}` : ''}`,
    async run(args) {
      if (args.action === 'add') {
        if (!args.content?.trim()) throw new ToolError('content is required');
        const memory: Memory = {
          id: newId(),
          content: args.content.trim(),
          projectId: args.scope === 'project' ? projectId : undefined,
          source: 'assistant',
          createdAt: now(),
        };
        store.memories.put(memory);
        return `Saved memory ${memory.id}.`;
      }
      const memory = args.id ? store.memories.get(args.id) : undefined;
      if (!memory) throw new ToolError(`No memory with id "${args.id}"`);
      if (args.action === 'delete') {
        store.memories.delete(memory.id);
        return `Deleted memory ${memory.id}.`;
      }
      if (args.action === 'update') {
        if (!args.content?.trim()) throw new ToolError('content is required');
        store.memories.put({ ...memory, content: args.content.trim() });
        return `Updated memory ${memory.id}.`;
      }
      throw new ToolError('action must be add, update or delete');
    },
  };
}
