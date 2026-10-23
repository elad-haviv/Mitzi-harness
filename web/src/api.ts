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
  ArtifactType,
  Lesson,
  MediaKind,
  MediaSettings,
  ProviderKind,
  ProviderView,
  Rating,
  ScheduledTask,
  DirListing,
  RepoStatus,
  ImportSource,
  ImportedConversation,
  ChatMessage,
  ChatMode,
  FeedbackLoop,
  Goal,
  Plan,
  Todo,
  Workflow,
  WorkflowEvent,
  WorkflowNodeType,
  SearchHit,
  SearchKind,
  BudgetStatus,
} from '../../src/shared/types';

export type * from '../../src/shared/types';
import type { UpdateEvent, UpdateInfo } from '../../src/updater';
export type { UpdateEvent, UpdateInfo, UpdateStep } from '../../src/updater';
export { DEFAULT_BOT_ID, TEXT_ARTIFACT_TYPES } from '../../src/shared/types';

export type ProjectView = Project & { chatCount: number };
export type WorkflowView = Workflow & { running: boolean };
export interface NodeSpec {
  label: string;
  description: string;
  outputs: string[];
  defaults: Record<string, unknown>;
}
export interface UsageTotalsView {
  prompt: number;
  completion: number;
  cost: number;
  requests: number;
}
export interface UsageGroup {
  key: string;
  name?: string;
  totals: UsageTotalsView;
}
export interface UsageReport {
  days: number;
  totals: UsageTotalsView;
  allTime: UsageTotalsView;
  daily: (UsageTotalsView & { day: string })[];
  byModel: UsageGroup[];
  byKind: UsageGroup[];
  byProject: UsageGroup[];
  byBot: UsageGroup[];
  topChats: UsageGroup[];
}
export interface LearningPoint {
  n: number;
  id: string;
  at: string;
  botId: string;
  task: string;
  attempts: number;
  firstRating: number;
  finalRating: number;
  accepted: boolean;
  lesson?: string;
}
export interface LearningCurve {
  points: LearningPoint[];
  summary: { loops: number; accepted: number; lessons: number; avgAttempts: number; avgFirstRating: number; earlyFirstRating: number; lateFirstRating: number };
}
export type UpdateStatus = UpdateInfo & { updating: boolean; canRestart: boolean };
export type UpdateStreamEvent = UpdateEvent | { type: 'restarting' } | { type: 'restart-required' };
export type ChatListItem = ChatSummary & { running?: boolean };
export type ArtifactListItem = Artifact & { chatTitle?: string };
/** An artifact with what its workspace needs. */
export type ArtifactWork = Artifact & { chatTitle?: string; running: boolean };
export type TaskView = ScheduledTask & { running: boolean; description: string };
export interface ProviderPresetView {
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  keyUrl?: string;
  keyless: boolean;
  chat: boolean;
}
export type MediaModels = Record<Exclude<keyof MediaSettings, 'voice'>, { id: string; name: string; provider: string }[]>;

/** Adds the access token to a URL for the media endpoints that need it in a plain GET. */
export function authHeaders(): Record<string, string> {
  return { 'x-mitzi-token': token };
}

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
async function stream<E = StreamEvent>(path: string, body: unknown, onEvent: (e: E) => void): Promise<void> {
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
  createChat: (body: { projectId?: string; botId?: string; model?: string; mode?: ChatMode }) => request<Chat>('POST', '/api/chats', body),
  updateChat: (id: string, body: Partial<{ title: string; model: string; pinned: boolean; webSearch: boolean; projectId: string | null; mode: ChatMode }>) =>
    request<ChatSummary>('PATCH', `/api/chats/${id}`, body),
  deleteChat: (id: string) => request('DELETE', `/api/chats/${id}`),
  send: (
    id: string,
    body: { content: string; attachments: Attachment[]; editIndex?: number; focus?: string; auto?: ChatMessage['auto']; feedbackLoopId?: string },
    onEvent: (e: StreamEvent) => void,
  ) =>
    stream(`/api/chats/${id}/messages`, body, onEvent),
  regenerate: (id: string, onEvent: (e: StreamEvent) => void) => stream(`/api/chats/${id}/regenerate`, {}, onEvent),
  stop: (id: string) => request('POST', `/api/chats/${id}/stop`, {}),
  planAction: (id: string, action: 'approve' | 'revise') => request<{ plan: Plan; todos: Todo[]; mode: ChatMode }>('POST', `/api/chats/${id}/plan`, { action }),
  /** /goal pause|resume|clear|status and /subgoal. */
  command: (id: string, text: string) => request<{ goal: Goal | null; message: string; resume: boolean }>('POST', `/api/chats/${id}/command`, { text }),
  /** /btw: a side question, answered without tools and not saved. */
  btw: (id: string, question: string, onEvent: (e: { type: 'start' | 'text' | 'done' | 'error'; text?: string }) => void) => stream(`/api/chats/${id}/btw`, { question }, onEvent),
  review: (id: string, index: number, body: { rating: number; meant?: string; did?: string; directions?: string; redo?: boolean }) =>
    request<{ loop: FeedbackLoop; redo?: string }>('POST', `/api/chats/${id}/messages/${index}/review`, body),
  acceptLoop: (id: string) => request<FeedbackLoop>('POST', `/api/feedback/${id}/accept`, {}),
  feedbackLoops: (botId?: string) => request<(FeedbackLoop & { chatTitle?: string })[]>('GET', `/api/feedback${botId ? `?botId=${botId}` : ''}`),
  deleteLoop: (id: string) => request('DELETE', `/api/feedback/${id}`),
  learning: (botId?: string) => request<LearningCurve>('GET', `/api/insights/learning${botId ? `?botId=${botId}` : ''}`),
  budget: () => request<BudgetStatus>('GET', '/api/budget'),
  search: (q: string, kinds?: SearchKind[]) => request<{ hits: SearchHit[]; semantic: boolean }>('GET', `/api/search?q=${encodeURIComponent(q)}${kinds?.length ? `&kinds=${kinds.join(',')}` : ''}`),
  usage: (q: { days?: number; projectId?: string; chatId?: string; botId?: string } = {}) =>
    request<UsageReport>('GET', `/api/usage?${new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))}`),

  workflows: () => request<WorkflowView[]>('GET', '/api/workflows'),
  workflow: (id: string) => request<WorkflowView>('GET', `/api/workflows/${id}`),
  workflowNodeTypes: () => request<Record<WorkflowNodeType, NodeSpec>>('GET', '/api/workflows/node-types'),
  createWorkflow: (template?: string) => request<WorkflowView>('POST', '/api/workflows', { template }),
  updateWorkflow: (id: string, body: Partial<Pick<Workflow, 'name' | 'description' | 'emoji' | 'nodes' | 'edges' | 'exposeToChat'>>) => request<WorkflowView>('PATCH', `/api/workflows/${id}`, body),
  deleteWorkflow: (id: string) => request('DELETE', `/api/workflows/${id}`),
  runWorkflow: (id: string, input: string, onEvent: (e: WorkflowEvent) => void) => stream<WorkflowEvent>(`/api/workflows/${id}/run`, { input }, onEvent),
  stopWorkflow: (id: string) => request('POST', `/api/workflows/${id}/stop`, {}),
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
  deleteProject: (id: string, deleteChats = false) => request('DELETE', `/api/projects/${id}${deleteChats ? '?chats=delete' : ''}`),
  addProjectFile: (id: string, name: string, content: string) => request<ProjectView>('POST', `/api/projects/${id}/files`, { name, content }),
  removeProjectFile: (id: string, fileId: string) => request<ProjectView>('DELETE', `/api/projects/${id}/files/${fileId}`),

  dirs: (path?: string, hidden = false) => request<DirListing>('GET', `/api/fs/dirs?path=${encodeURIComponent(path ?? '~')}${hidden ? '&hidden=1' : ''}`),
  mkdir: (parent: string, name: string) => request<DirListing>('POST', '/api/fs/mkdir', { parent, name }),
  openFolder: (folder: string) => request<ProjectView>('POST', '/api/projects/open-folder', { folder }),
  cloneRepo: (body: { url: string; branch?: string; token?: string; parent?: string; name?: string }) => request<ProjectView>('POST', '/api/repos/clone', body),
  repoStatus: (projectId: string) => request<RepoStatus | null>('GET', `/api/projects/${projectId}/git`),
  pull: (projectId: string) => request<{ output: string; status?: RepoStatus }>('POST', `/api/projects/${projectId}/pull`, {}),

  importPrompt: () => request<{ prompt: string }>('GET', '/api/import/prompt'),
  parseMemories: (text: string) => request<{ memories: string[]; fallback?: boolean }>('POST', '/api/import/memory/parse', { text }),
  importMemories: (botId: string, memories: string[]) => request<{ imported: number }>('POST', '/api/import/memory', { botId, memories }),
  importChats: (body: { source: ImportSource; botId: string; conversations: ImportedConversation[]; learn: boolean }) =>
    request<{ imported: number; skipped: number; learning: number }>('POST', '/api/import/chats', body),

  updateInfo: (refresh = false) => request<UpdateStatus>('GET', `/api/update${refresh ? '?refresh=1' : ''}`),
  /** Runs the update; events arrive as it goes. */
  applyUpdate: async (onEvent: (e: UpdateStreamEvent) => void) => {
    const res = await fetch('/api/update/apply', { method: 'POST', headers: { 'x-mitzi-token': token } });
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      throw new ApiError(res.status, data?.error ?? `Update failed (${res.status})`);
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += value;
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (frame.startsWith('data: ')) onEvent(JSON.parse(frame.slice(6)));
      }
    }
  },
  /** Resolves once the server answers again (after a restart). */
  waitForServer: async (timeoutMs = 120_000) => {
    const end = Date.now() + timeoutMs;
    await new Promise((r) => setTimeout(r, 1500));
    while (Date.now() < end) {
      try {
        const res = await fetch('/api/settings', { headers: { 'x-mitzi-token': token }, signal: AbortSignal.timeout(2000) });
        if (res.ok) return (await res.json()) as PublicSettings;
      } catch {
        // Still restarting.
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('Mitzi didn’t come back. Check the terminal where it runs.');
  },

  bots: () => request<Bot[]>('GET', '/api/bots'),
  createBot: (body: Partial<Bot>) => request<Bot>('POST', '/api/bots', body),
  updateBot: (id: string, body: Partial<Bot>) => request<Bot>('PATCH', `/api/bots/${id}`, body),
  deleteBot: (id: string) => request('DELETE', `/api/bots/${id}`),
  starters: (id: string, refresh = false) => request<{ starters: string[]; personalized: boolean }>('GET', `/api/bots/${id}/starters${refresh ? '?refresh=1' : ''}`),

  artifacts: (filter: { chatId?: string; projectId?: string } = {}) => {
    const q = new URLSearchParams(Object.entries(filter).filter(([, v]) => v) as [string, string][]).toString();
    return request<ArtifactListItem[]>('GET', `/api/artifacts${q ? `?${q}` : ''}`);
  },
  artifact: (id: string) => request<ArtifactWork>('GET', `/api/artifacts/${id}`),
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

  providers: () => request<{ providers: ProviderView[]; presets: ProviderPresetView[] }>('GET', '/api/providers'),
  addProvider: (body: { kind: ProviderKind; apiKey?: string; baseUrl?: string; name?: string; id?: string }) => request<ProviderView[]>('POST', '/api/providers', body),
  updateProvider: (id: string, body: Partial<{ apiKey: string; baseUrl: string; name: string; enabled: boolean }>) => request<ProviderView[]>('PATCH', `/api/providers/${id}`, body),
  removeProvider: (id: string) => request<ProviderView[]>('DELETE', `/api/providers/${id}`),
  testProvider: (id: string) => request<{ ok: boolean; count: number }>('POST', `/api/providers/${id}/test`, {}),

  branch: (chatId: string, index: number) => request<ChatSummary>('POST', `/api/chats/${chatId}/branch`, { index }),
  rate: (chatId: string, index: number, value: 1 | -1 | 0, comment?: string) =>
    request<{ rating: Rating | null }>('POST', `/api/chats/${chatId}/messages/${index}/rating`, { value, comment }),
  lessons: (botId: string) => request<Lesson[]>('GET', `/api/bots/${botId}/lessons`),
  deleteLesson: (botId: string, id: string) => request<Lesson[]>('DELETE', `/api/bots/${botId}/lessons/${id}`),

  createArtifact: (body: { type: ArtifactType; title: string; content?: string; botId?: string; projectId?: string; language?: string }) =>
    request<ArtifactWork>('POST', '/api/artifacts', body),
  updateArtifact: (id: string, body: { title?: string; content?: string }) => request<ArtifactWork>('PATCH', `/api/artifacts/${id}`, body),
  addComment: (id: string, quote: string, text: string) => request<ArtifactWork>('POST', `/api/artifacts/${id}/comments`, { quote, text }),
  updateComment: (id: string, commentId: string, body: { reply?: string; resolved?: boolean }) => request<ArtifactWork>('PATCH', `/api/artifacts/${id}/comments/${commentId}`, body),
  deleteComment: (id: string, commentId: string) => request<ArtifactWork>('DELETE', `/api/artifacts/${id}/comments/${commentId}`),
  restoreVersion: (id: string, index: number) => request<ArtifactWork>('POST', `/api/artifacts/${id}/versions/${index}/restore`, {}),

  tasks: () => request<TaskView[]>('GET', '/api/tasks'),
  createTask: (body: Partial<ScheduledTask>) => request<TaskView>('POST', '/api/tasks', body),
  updateTask: (id: string, body: Partial<ScheduledTask>) => request<TaskView>('PATCH', `/api/tasks/${id}`, body),
  deleteTask: (id: string) => request('DELETE', `/api/tasks/${id}`),
  runTask: (id: string) => request<TaskView>('POST', `/api/tasks/${id}/run`, {}),
  markTasksSeen: () => request('POST', '/api/tasks/seen', {}),

  mediaModels: () => request<{ models: MediaModels; available: Record<MediaKind, boolean> }>('GET', '/api/media/models'),
  /** Server text-to-speech; resolves to an audio blob. */
  tts: async (text: string, voice?: string): Promise<Blob> => {
    const res = await fetch('/api/tts', { method: 'POST', headers: { 'x-mitzi-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ text, voice }) });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new ApiError(res.status, data?.error ?? `Speech failed (${res.status})`);
    }
    return res.blob();
  },
  /** `language`: what the speaker speaks (BCP 47), when known; otherwise the model detects it. */
  transcribe: (audio: string, language?: string) => request<{ text: string }>('POST', '/api/transcribe', { audio, language }),
};
