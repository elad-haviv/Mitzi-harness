// Types (and a few constants) shared by the server and the web client.
import type { PermissionMode } from '../config.js';
import type { ContentPart, Message } from '../openrouter.js';
import type { Todo } from '../tools/types.js';

export type { ContentPart, Message, PermissionMode, Todo };

export type MemoryBackendKind = 'builtin' | 'hindsight';

export interface UiSettings {
  memoryEnabled: boolean;
  /** Where memory banks live: the built-in engine, or an external Hindsight server. */
  memoryBackend: MemoryBackendKind;
  hindsightUrl: string;
  /** OpenAI-compatible embedding model for semantic recall (built-in engine). Empty disables it. */
  embeddingModel: string;
  /** Token budget for memories recalled into each message. */
  recallTokens: number;
  /** Compact automatically when a request fills this % of the model's context window. */
  autoCompactPercent: number;
  /** User turns kept verbatim when compacting. */
  keepRecentTurns: number;
}

export interface PublicSettings extends UiSettings {
  hasApiKey: boolean;
  hasHindsightKey: boolean;
  /** Where the key comes from; an env var can't be changed from the UI. */
  apiKeySource: 'env' | 'config' | null;
  defaultModel: string;
  smallModel?: string;
}

export interface SettingsUpdate extends Partial<UiSettings> {
  hindsightApiKey?: string;
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

/** Hindsight-style traits shaping how a bank forms and interprets memories, each 1–5. */
export interface Disposition {
  /** 1 = trusting, 5 = skeptical: how much evidence a belief needs. */
  skepticism: number;
  /** 1 = flexible, 5 = literal: whether to infer beyond what was said. */
  literalism: number;
  /** 1 = detached, 5 = empathetic: weight given to feelings and wellbeing. */
  empathy: number;
}

export interface BankProfile {
  /** What this bank should focus on remembering. */
  mission: string;
  disposition: Disposition;
  /** Learn from every conversation automatically. */
  autoRetain: boolean;
}

export const DEFAULT_BOT_ID = 'mitzi';

export interface Bot {
  id: string;
  name: string;
  emoji: string;
  description: string;
  systemPrompt: string;
  model?: string;
  temperature?: number;
  tools: BotTools;
  /** The default bot cannot be deleted. */
  builtIn?: boolean;
  /** Settings for this bot's memory bank (used when tools.memory is on). */
  memory: BankProfile;
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
export type ChatMessage = Message & {
  ts?: number;
  model?: string;
  /** Memories recalled for this (user) message. */
  memories?: RecalledMemory[];
};

export type MemoryType = 'world' | 'experience' | 'observation';

/** One unit in a memory bank: a fact, an experience, or a consolidated observation. */
export interface MemoryUnit {
  id: string;
  type: MemoryType;
  text: string;
  entities: string[];
  /** When the remembered event happened, if known. */
  occurredAt?: string;
  /** When it was learned. */
  mentionedAt: string;
  context?: string;
  source: 'conversation' | 'user' | 'assistant';
  chatId?: string;
  /** Observations: ids of the facts that support it. */
  evidence?: string[];
  /** Observations: 0–1, grows with evidence. */
  confidence?: number;
  updatedAt?: string;
}

export interface RecalledMemory {
  id: string;
  type: MemoryType;
  text: string;
  occurredAt?: string;
  confidence?: number;
  /** Retrieval strategies that found it: semantic, keyword, graph, temporal, core. */
  strategies?: string[];
  score?: number;
}

export interface BankStats {
  world: number;
  experience: number;
  observation: number;
  entities: number;
  /** Retain jobs still being processed. */
  pending: number;
  lastRetainAt?: string;
}

export interface BankSummary {
  bot: Pick<Bot, 'id' | 'name' | 'emoji' | 'builtIn'>;
  enabled: boolean;
  stats?: BankStats;
  error?: string;
}

export interface ReflectResult {
  text: string;
  basedOn: RecalledMemory[];
}

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

/** Memory format from before per-bot banks; migrated into the default bot's bank on startup. */
export interface LegacyMemory {
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
  | { type: 'recall'; memories: RecalledMemory[] }
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
