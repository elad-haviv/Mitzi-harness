// Types shared by the server and the web client. Type-only: no runtime code.
import type { PermissionMode } from '../config.js';
import type { ContentPart, Message } from '../openrouter.js';
import type { Todo } from '../tools/types.js';

export type { ContentPart, Message, PermissionMode, Todo };

export interface UiSettings {
  memoryEnabled: boolean;
  /** Compact automatically when a request fills this % of the model's context window. */
  autoCompactPercent: number;
  /** User turns kept verbatim when compacting. */
  keepRecentTurns: number;
}

export interface PublicSettings extends UiSettings {
  hasApiKey: boolean;
  /** Where the key comes from; an env var can't be changed from the UI. */
  apiKeySource: 'env' | 'config' | null;
  defaultModel: string;
  smallModel?: string;
}

export interface SettingsUpdate extends Partial<UiSettings> {
  apiKey?: string;
  defaultModel?: string;
  smallModel?: string;
}

export interface ProjectFile {
  id: string;
  name: string;
  content: string;
  size: number;
  addedAt: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  /** Custom instructions added to every chat in the project. */
  instructions: string;
  /** Knowledge files whose content is included in every chat's context. */
  files: ProjectFile[];
  /** Local folder; when set, chats get coding tools (Read, Edit, Bash…) scoped to it. */
  folder?: string;
  permissionMode: PermissionMode;
  createdAt: string;
  updatedAt: string;
}

export interface BotTools {
  artifacts: boolean;
  web: boolean;
  memory: boolean;
}

export interface Bot {
  id: string;
  name: string;
  emoji: string;
  description: string;
  systemPrompt: string;
  model?: string;
  temperature?: number;
  tools: BotTools;
  starters: string[];
  createdAt: string;
  updatedAt: string;
}

export interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
  cost: number;
  requests: number;
}

/** A stored message: the API message plus display metadata. */
export type ChatMessage = Message & { ts?: number; model?: string };

export interface Chat {
  id: string;
  title: string;
  projectId?: string;
  botId?: string;
  model: string;
  webSearch: boolean;
  pinned: boolean;
  /** Full history, shown in the UI. */
  messages: ChatMessage[];
  /** Messages before this index were folded into `summary` and are no longer sent to the model. */
  contextStart: number;
  summary?: string;
  /** Tool permission rules the user chose to "always allow" in this chat. */
  allowedRules: string[];
  usage: UsageTotals;
  lastPromptTokens: number;
  createdAt: string;
  updatedAt: string;
}

export type ChatSummary = Omit<Chat, 'messages' | 'summary'> & { messageCount: number };

export type ArtifactType = 'markdown' | 'code' | 'html' | 'react' | 'svg' | 'mermaid';

export interface ArtifactVersion {
  content: string;
  createdAt: string;
  /** Tool call that produced this version, so chat messages can link to it. */
  callId?: string;
}

export interface Artifact {
  id: string;
  chatId: string;
  projectId?: string;
  title: string;
  type: ArtifactType;
  language?: string;
  versions: ArtifactVersion[];
  createdAt: string;
  updatedAt: string;
}

export interface Memory {
  id: string;
  content: string;
  /** Unset for global memories. */
  projectId?: string;
  source: 'user' | 'assistant';
  createdAt: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  contextLength?: number;
  promptPrice?: number;
  completionPrice?: number;
  tools: boolean;
  vision: boolean;
}

export interface ContextSection {
  label: string;
  tokens: number;
  kind: 'system' | 'project' | 'memory' | 'summary' | 'history' | 'tools';
}

export interface ContextBreakdown {
  model: string;
  contextLength?: number;
  /** Actual prompt size reported by the provider for the last request. */
  lastPromptTokens: number;
  /** Estimate of what the next request will send. */
  estimatedTokens: number;
  sections: ContextSection[];
  autoCompactAt?: number;
  compactedMessages: number;
  summary?: string;
}

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; id: string; name: string; summary: string; args: unknown }
  | { type: 'tool_result'; id: string; output: string; isError: boolean }
  | { type: 'permission'; requestId: string; callId?: string; tool: string; summary: string; preview?: string; alwaysRule: string }
  | { type: 'permission_resolved'; requestId: string }
  | { type: 'artifact'; artifact: Artifact }
  | { type: 'todos'; todos: Todo[] }
  | { type: 'status'; message: string }
  | { type: 'warn'; message: string }
  | { type: 'compacted'; contextStart: number }
  | { type: 'chat'; chat: ChatSummary }
  | { type: 'error'; message: string }
  | { type: 'done' };

export interface Attachment {
  name: string;
  /** Text content, or a data: URL for images. */
  content: string;
  kind: 'text' | 'image';
}
