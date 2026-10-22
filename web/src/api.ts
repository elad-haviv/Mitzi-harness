import type {
  Artifact,
  Attachment,
  Bot,
  Chat,
  ChatSummary,
  ContextBreakdown,
  Memory,
  ModelInfo,
  Project,
  PublicSettings,
  SettingsUpdate,
  StreamEvent,
} from '../../src/shared/types';

export type * from '../../src/shared/types';

export type ProjectView = Project & { chatCount: number };
export type ChatListItem = ChatSummary & { running?: boolean };
export type ArtifactListItem = Artifact & { chatTitle?: string };

const TOKEN_KEY = 'mitzi.token';

/** Reads the access token from the URL on first load, then from storage. */
function initToken(): string {
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get('token');
  if (fromUrl) {
    try {
      localStorage.setItem(TOKEN_KEY, fromUrl);
    } catch {
      // Storage unavailable: keep it in memory only.
    }
    url.searchParams.delete('token');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
    return fromUrl;
  }
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

const token = initToken();

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'x-mitzi-token': token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`);
  return data as T;
}

/** POSTs and consumes a server-sent event stream until it ends. */
async function stream(path: string, body: unknown, onEvent: (e: StreamEvent) => void): Promise<void> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'x-mitzi-token': token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split('\n')) {
        if (line.startsWith('data: ')) {
          try {
            onEvent(JSON.parse(line.slice(6)));
          } catch {
            // Ignore malformed frames.
          }
        }
      }
    }
  }
}

export const api = {
  hasToken: () => !!token,

  settings: () => request<PublicSettings>('GET', '/api/settings'),
  updateSettings: (u: SettingsUpdate) => request<PublicSettings>('PUT', '/api/settings', u),
  models: () => request<ModelInfo[]>('GET', '/api/models'),

  chats: (projectId?: string) => request<ChatListItem[]>('GET', `/api/chats${projectId ? `?projectId=${projectId}` : ''}`),
  chat: (id: string) => request<Chat & { running: boolean }>('GET', `/api/chats/${id}`),
  createChat: (body: { projectId?: string; botId?: string; model?: string }) => request<Chat>('POST', '/api/chats', body),
  updateChat: (id: string, body: Partial<{ title: string; model: string; pinned: boolean; webSearch: boolean; projectId: string | null }>) =>
    request<ChatSummary>('PATCH', `/api/chats/${id}`, body),
  deleteChat: (id: string) => request('DELETE', `/api/chats/${id}`),
  send: (id: string, body: { content: string; attachments: Attachment[]; editIndex?: number }, onEvent: (e: StreamEvent) => void) =>
    stream(`/api/chats/${id}/messages`, body, onEvent),
  regenerate: (id: string, onEvent: (e: StreamEvent) => void) => stream(`/api/chats/${id}/regenerate`, {}, onEvent),
  stop: (id: string) => request('POST', `/api/chats/${id}/stop`, {}),
  answerPermission: (id: string, requestId: string, answer: 'yes' | 'always' | 'no' | 'feedback', feedback?: string) =>
    request('POST', `/api/chats/${id}/permission`, { requestId, answer, feedback }),
  context: (id: string) => request<ContextBreakdown>('GET', `/api/chats/${id}/context`),
  compact: (id: string) => request<{ compacted: boolean }>('POST', `/api/chats/${id}/compact`, {}),
  uncompact: (id: string) => request('POST', `/api/chats/${id}/uncompact`, {}),

  projects: () => request<ProjectView[]>('GET', '/api/projects'),
  project: (id: string) => request<ProjectView>('GET', `/api/projects/${id}`),
  createProject: (body: { name: string; description?: string }) => request<ProjectView>('POST', '/api/projects', body),
  updateProject: (id: string, body: Partial<{ name: string; description: string; instructions: string; folder: string | null; permissionMode: string }>) =>
    request<ProjectView>('PATCH', `/api/projects/${id}`, body),
  deleteProject: (id: string) => request('DELETE', `/api/projects/${id}`),
  addProjectFile: (id: string, name: string, content: string) => request<ProjectView>('POST', `/api/projects/${id}/files`, { name, content }),
  removeProjectFile: (id: string, fileId: string) => request<ProjectView>('DELETE', `/api/projects/${id}/files/${fileId}`),

  bots: () => request<Bot[]>('GET', '/api/bots'),
  createBot: (body: Partial<Bot>) => request<Bot>('POST', '/api/bots', body),
  updateBot: (id: string, body: Partial<Bot>) => request<Bot>('PATCH', `/api/bots/${id}`, body),
  deleteBot: (id: string) => request('DELETE', `/api/bots/${id}`),

  artifacts: (filter: { chatId?: string; projectId?: string } = {}) => {
    const q = new URLSearchParams(Object.entries(filter).filter(([, v]) => v) as [string, string][]).toString();
    return request<ArtifactListItem[]>('GET', `/api/artifacts${q ? `?${q}` : ''}`);
  },
  artifact: (id: string) => request<Artifact>('GET', `/api/artifacts/${id}`),
  deleteArtifact: (id: string) => request('DELETE', `/api/artifacts/${id}`),

  memories: () => request<Memory[]>('GET', '/api/memories'),
  addMemory: (content: string, projectId?: string) => request<Memory>('POST', '/api/memories', { content, projectId }),
  updateMemory: (id: string, content: string) => request<Memory>('PATCH', `/api/memories/${id}`, { content }),
  deleteMemory: (id: string) => request('DELETE', `/api/memories/${id}`),
};
