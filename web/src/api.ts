import type {
  Artifact,
  Attachment,
  BankSummary,
  Bot,
  ConnectorPreset,
  MarketplaceInfo,
  McpServerView,
  PluginInfo,
  SkillDetail,
  SkillInfo,
  SlashCommandInfo,
  Chat,
  ChatSummary,
  ContextBreakdown,
  MemoryType,
  MemoryUnit,
  ModelInfo,
  RecalledMemory,
  ReflectResult,
  Project,
  PublicSettings,
  SettingsUpdate,
  StreamEvent,
} from '../../src/shared/types';

export type * from '../../src/shared/types';
export { DEFAULT_BOT_ID } from '../../src/shared/types';

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

  banks: () => request<BankSummary[]>('GET', '/api/banks'),
  bankMemories: (botId: string, filter: { type?: MemoryType; q?: string; limit?: number; offset?: number } = {}) => {
    const q = new URLSearchParams(Object.entries(filter).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)])).toString();
    return request<{ items: MemoryUnit[]; total: number }>('GET', `/api/banks/${botId}/memories${q ? `?${q}` : ''}`);
  },
  remember: (botId: string, content: string) => request('POST', `/api/banks/${botId}/memories`, { content }),
  updateMemory: (botId: string, id: string, text: string) => request('PATCH', `/api/banks/${botId}/memories/${id}`, { text }),
  forget: (botId: string, id: string) => request('DELETE', `/api/banks/${botId}/memories/${id}`),
  recall: (botId: string, query: string) => request<RecalledMemory[]>('POST', `/api/banks/${botId}/recall`, { query }),
  reflect: (botId: string, query: string) => request<ReflectResult>('POST', `/api/banks/${botId}/reflect`, { query }),
  clearBank: (botId: string) => request('DELETE', `/api/banks/${botId}`),
  testHindsight: (url: string, apiKey?: string) => request('POST', '/api/memory/test', { url, apiKey }),

  mcpServers: () => request<McpServerView[]>('GET', '/api/mcp'),
  addMcpServer: (body: Record<string, unknown>) => request<McpServerView>('POST', '/api/mcp', body),
  updateMcpServer: (id: string, body: Record<string, unknown>) => request<McpServerView>('PATCH', `/api/mcp/${id}`, body),
  deleteMcpServer: (id: string) => request('DELETE', `/api/mcp/${id}`),
  reconnectMcpServer: (id: string) => request<McpServerView>('POST', `/api/mcp/${id}/reconnect`, {}),
  startMcpAuth: (id: string) => request<{ url: string }>('POST', `/api/mcp/${id}/auth`, {}),
  signOutMcp: (id: string) => request<McpServerView>('POST', `/api/mcp/${id}/signout`, {}),
  connectors: () => request<(ConnectorPreset & { installed: number })[]>('GET', '/api/connectors'),
  addConnector: (id: string, values: Record<string, string>) => request<McpServerView>('POST', `/api/connectors/${id}`, { values }),

  skills: () => request<SkillInfo[]>('GET', '/api/skills'),
  skill: (id: string) => request<SkillDetail>('GET', `/api/skills/${encodeURIComponent(id)}`),
  createSkill: (body: { name: string; description: string; body: string }) => request<SkillInfo>('POST', '/api/skills', body),
  updateSkill: (id: string, body: { name: string; description: string; body: string }) => request<SkillInfo>('PUT', `/api/skills/${encodeURIComponent(id)}`, body),
  setSkillEnabled: (id: string, enabled: boolean) => request<SkillInfo>('PATCH', `/api/skills/${encodeURIComponent(id)}`, { enabled }),
  deleteSkill: (id: string) => request('DELETE', `/api/skills/${encodeURIComponent(id)}`),
  importSkill: (files: { path: string; content: string }[]) => request<SkillInfo>('POST', '/api/skills/import', { files }),

  plugins: () => request<PluginInfo[]>('GET', '/api/plugins'),
  installPlugin: (source: string) => request<{ plugin?: PluginInfo; marketplace?: MarketplaceInfo }>('POST', '/api/plugins', { source }),
  setPluginEnabled: (id: string, enabled: boolean) => request<PluginInfo>('PATCH', `/api/plugins/${id}`, { enabled }),
  updatePlugin: (id: string) => request<PluginInfo>('POST', `/api/plugins/${id}/update`, {}),
  uninstallPlugin: (id: string) => request('DELETE', `/api/plugins/${id}`),
  marketplaces: () => request<MarketplaceInfo[]>('GET', '/api/marketplaces'),
  addMarketplace: (source: string) => request<MarketplaceInfo>('POST', '/api/marketplaces', { source }),
  refreshMarketplace: (id: string) => request<MarketplaceInfo>('POST', `/api/marketplaces/${id}/refresh`, {}),
  removeMarketplace: (id: string) => request('DELETE', `/api/marketplaces/${id}`),
  installFromMarketplace: (id: string, name: string) => request<PluginInfo>('POST', `/api/marketplaces/${id}/install`, { name }),
  commands: () => request<SlashCommandInfo[]>('GET', '/api/commands'),
};
