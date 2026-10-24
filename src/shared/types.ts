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
  /** Skill ids turned off. */
  disabledSkills: string[];
  /** Also load skills from ~/.claude/skills. */
  useClaudeSkills: boolean;
  /** Models for media generation and voice, as "provider:model" ids (empty = not set up). */
  media: MediaSettings;
  /** Compact automatically when a request fills this % of the model's context window. */
  autoCompactPercent: number;
  /** User turns kept verbatim when compacting. */
  keepRecentTurns: number;
  /** Look for new versions in the background. */
  autoCheckUpdates: boolean;
  /** Show the browser window while bots use it (otherwise it runs out of sight). */
  browserHeaded?: boolean;
  /** Bots may see the screen and use the mouse and keyboard (off unless turned on). */
  computerUse?: boolean;
  /** Spending limits, in US dollars. */
  budget?: BudgetSettings;
  /** The models the "Auto" model chooses between. */
  routing?: RoutingSettings;
  /** Approval level for chats that don't set their own. */
  approval?: ApprovalLevel;
  /** Chatting with Mitzi through Telegram, Discord, Slack, WhatsApp or email. */
  channels?: Partial<Record<ChannelKind, ChannelSettings>>;
  /** Offer the tool-call sequence of a matching playbook as a hint (off by default: traces can bloat prompts and go stale). */
  toolTraceHints?: boolean;
  /** Telegram settings from before `channels` (moved there on start). */
  telegram?: TelegramSettings;
}

/** A read-only link to a snapshot of a chat or artifact. */
export interface Share {
  /** The secret part of the link: /s/<id>. */
  id: string;
  kind: 'chat' | 'artifact';
  targetId: string;
  title: string;
  /** The page as it was when shared. */
  html: string;
  createdAt: string;
  expiresAt?: string;
  views: number;
}

export interface TelegramSettings {
  enabled: boolean;
  /** The bot's token from @BotFather (masked in public settings). */
  token: string;
  /** Sent to the bot as "/start <code>" to pair a Telegram chat. */
  pairingCode: string;
  links: TelegramLink[];
  /** Send workflow approvals and finished scheduled tasks to paired chats. */
  notify: boolean;
}

/** Messaging services Mitzi can be reached through. */
export const CHANNEL_KINDS = ['telegram', 'discord', 'slack', 'whatsapp', 'email'] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

export interface ChannelSettings {
  enabled: boolean;
  /** The service's credentials and options, by field key (secrets are never sent back). */
  config: Record<string, string>;
  /** Sent to Mitzi there to pair a conversation. */
  pairingCode: string;
  links: ChannelLink[];
  /** Send workflow approvals and finished scheduled tasks to paired conversations. */
  notify: boolean;
}

/** A conversation on a messaging service paired with Mitzi, and the Mitzi chat it talks in. */
export interface ChannelLink {
  /** The conversation's id there: a chat, a channel, a phone number or an email address. */
  address: string;
  name: string;
  mitziChatId?: string;
  linkedAt: string;
}

/** A setting a messaging service needs, as the settings page shows it. */
export interface ChannelField {
  key: string;
  label: string;
  /** Kept on this computer and never shown again once saved. */
  secret?: boolean;
  placeholder?: string;
  optional?: boolean;
}

/** A messaging service as the settings page sees it. */
export interface ChannelView {
  kind: ChannelKind;
  label: string;
  /** How to set it up, step by step (simple Markdown). */
  steps: string[];
  fields: ChannelField[];
  /** Field values: secrets only say whether they're set. */
  values: Record<string, string | boolean>;
  /** How to pair, e.g. "Send /start 123456 to your bot". */
  pairHint: string;
  /** Where the service should send its events, for services that call Mitzi (needs a public address). */
  webhookPath?: string;
  /** Doesn't work on this computer, and why (e.g. needs a newer Node.js). */
  unsupported?: string;
  running: boolean;
  username?: string;
  error?: string;
  enabled: boolean;
  pairingCode: string;
  notify: boolean;
  links: ChannelLink[];
}

/** A Telegram chat paired with Mitzi (settings from before messaging channels; moved to `channels`). */
export interface TelegramLink {
  chatId: number;
  name: string;
  mitziChatId?: string;
  linkedAt: string;
}

/** The model id that picks a fast or strong model for each message. */
export const AUTO_MODEL = 'auto';

export interface RoutingSettings {
  /** Empty: the fast-tasks model. */
  fast: string;
  /** Empty: the default model. */
  strong: string;
  /** Start new chats on Auto. */
  newChats: boolean;
  /** Instead of the strong model, use the model that measurably does that kind of work best (from outcomes and evals). */
  learned?: boolean;
}

/** How Auto routed one message. */
export interface RouteChoice {
  tier: 'fast' | 'strong';
  model: string;
  reason: string;
}

export interface PublicSettings extends UiSettings {
  hasApiKey: boolean;
  hasHindsightKey: boolean;
  /** Where the key comes from; an env var can't be changed from the UI. */
  apiKeySource: 'env' | 'config' | null;
  defaultModel: string;
  smallModel?: string;
  version: string;
  /** Where Mitzi keeps its settings and data. */
  home: string;
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
  /** Knowledge files: included whole in every chat when small, searched per message when large. */
  files: ProjectFile[];
  /** Folders on this computer whose text files are part of the project's knowledge (kept up to date). */
  knowledgeFolders?: string[];
  /** Local folder; when set, chats get coding tools (Read, Edit, Bash…) scoped to it. */
  folder?: string;
  /** Set when the folder was cloned from a remote repository. */
  repo?: { url: string; branch?: string };
  /** Set while the project is archived: it and its chats are out of the way, but kept. */
  archivedAt?: string;
  permissionMode: PermissionMode;
  /** How work in the folder is checked before a work-mode turn ends (detected from the manifests unless set). */
  verify?: { enabled?: boolean; command?: string };
  createdAt: string;
  updatedAt: string;
}

/** One run of a project's checks by the harness. */
export interface VerifyResult {
  command: string;
  passed: boolean;
  /** The end of the output. */
  output: string;
  at: string;
}

export interface AskOption {
  label: string;
  description?: string;
}

/** A question a bot puts to the user: options to click, or an open answer when there are none. */
export interface AskQuestion {
  question: string;
  /** A word or two naming it. */
  header?: string;
  options?: AskOption[];
  /** Several options can be picked. */
  multiSelect?: boolean;
}

export interface BotTools {
  /** Generate images, video, speech, sound effects and music. */
  media?: boolean;
  artifacts: boolean;
  web: boolean;
  memory: boolean;
  /** Load skills on demand. */
  skills: boolean;
  /** Use tools from connectors / MCP servers. */
  connectors: boolean;
  /** Hand parts of a task to other bots and combine their results. */
  team?: boolean;
  /** Split focused parts of a task off to subagents (copies of the bot) that work in parallel. */
  subagents?: boolean;
  /** Run Python for calculations, data analysis and charts. */
  code?: boolean;
  /** Use a real web browser (asks before each action unless allowed for the chat). */
  browser?: boolean;
  /** See the screen and use the mouse and keyboard, when computer control is on in Settings. */
  computer?: boolean;
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
  /** Set for bots that come from a plugin's agents; they're managed by the plugin. */
  pluginId?: string;
  /** Settings for this bot's memory bank (used when tools.memory is on). */
  memory: BankProfile;
  /** What the bot learned from the user's ratings, newest last. */
  lessons?: Lesson[];
  /** Lessons taken out of the prompt, newest last (they can be restored). */
  retiredLessons?: RetiredLesson[];
  /** In work mode, have the fast model review changed files before finishing (costs a little time). */
  selfReview?: boolean;
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
  /** The slash command the user typed, when the content is its expansion. */
  command?: string;
  /** The user's rating of an assistant answer. */
  rating?: Rating;
  /** Time, tokens and cost of the whole response; set on a turn's last assistant message. */
  stats?: ResponseStats;
  /** Set when the chat is on Auto: which model answered, and why. */
  route?: RouteChoice;
  /** The feedback loop this answer belongs to (an attempt the user reviewed or asked to redo). */
  feedbackLoopId?: string;
  /** Said aloud in a realtime voice conversation (the text is its transcript). */
  spoken?: boolean;
  /** The project's checks the harness ran before the response ended (on its last answer). */
  verify?: VerifyResult[];
  /** The outcome recorded for the response (on its last answer). */
  outcomeId?: string;
  /**
   * Set on user messages Mitzi sent for the user: redo directions, plan approval, goal follow-ups, screenshots for the
   * model, failed checks and self-review findings.
   */
  auto?: 'redo' | 'plan' | 'goal' | 'images' | 'verify' | 'critique';
};

/** Time, tokens and cost of one response, including any teammates' work. */
export interface ResponseStats {
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  cost: number;
  requests: number;
}

/** The running tally of /compare picks. */
export interface CompareInsights {
  /** model id → times the user picked it */
  wins: Record<string, number>;
  /** model id → times the user saw both answers and picked the other */
  losses: Record<string, number>;
  comparisons: number;
  skipped: number;
}

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
  /** Set while the chat is archived: hidden from the chat list, but kept and searchable. */
  archivedAt?: string;
  /** Set on chats branched off another chat. */
  branchedFrom?: { chatId: string; title: string };
  /** The artifact the user last worked on in its workspace; the next turn focuses on it. */
  focusArtifactId?: string;
  /** Set on chats created by a scheduled task. */
  taskId?: string;
  /** Set on chats imported from another assistant. */
  imported?: { source: ImportSource; id: string };
  /** Chat answers conversationally; Work takes on tasks: it plans, keeps a task list and works until done. */
  mode?: ChatMode;
  /** How much the bot may do without asking; unset follows the project, then Settings. */
  approval?: ApprovalLevel;
  /** Messages sent while the bot was working, sent one by one when it's done. */
  queue?: QueuedMessage[];
  /** The task list the bot keeps while working. */
  todos?: Todo[];
  /** A goal set with /goal: the bot keeps working, turn after turn, until it's met. */
  goal?: Goal;
  /** The latest plan made with /plan. */
  plan?: Plan;
  createdAt: string;
  updatedAt: string;
}

export type ChatMode = 'chat' | 'work';

/** A message waiting for the bot to finish its current response. */
export interface QueuedMessage {
  id: string;
  content: string;
  attachments?: Attachment[];
  createdAt: string;
}

/**
 * How much a bot may do without asking: a kitten asks before every change, a house cat only before risky ones
 * (deleting, installing, pushing, system changes, acting in connected apps), an alley cat never asks.
 */
export type ApprovalLevel = 'kitten' | 'housecat' | 'alleycat';
export const APPROVAL_LEVELS: ApprovalLevel[] = ['kitten', 'housecat', 'alleycat'];

export interface Subgoal {
  id: string;
  text: string;
  done: boolean;
}

export interface Goal {
  text: string;
  status: 'active' | 'paused' | 'complete' | 'budget';
  subgoals: Subgoal[];
  /** Turns spent on the goal so far, and the most it may take before pausing. */
  turns: number;
  maxTurns: number;
  /** Why the last check decided the goal was or wasn't met. */
  lastCheck?: string;
  createdAt: string;
  completedAt?: string;
}

export interface Plan {
  /** What the user asked to plan. */
  request: string;
  /** The plan, in Markdown. */
  text: string;
  steps: string[];
  status: 'proposed' | 'approved' | 'revised';
  createdAt: string;
  /** Where the plan goes against the bot's lessons or the repository's known facts, checked before approval. */
  notes?: string[];
}

// ---------- Search ----------

export type SearchKind = 'message' | 'artifact' | 'memory';

export interface SearchHit {
  kind: SearchKind;
  /** Chat title, artifact title, or the bot a memory belongs to. */
  title: string;
  snippet: string;
  /** Matches in the snippet, as [start, end) character offsets. */
  marks: [number, number][];
  ts: string;
  chatId?: string;
  /** Index of the matching message in its chat. */
  index?: number;
  artifactId?: string;
  memoryId?: string;
  botId?: string;
  projectId?: string;
  /** Other messages in the same chat that matched too. */
  more?: number;
}

// ---------- Budgets ----------

/** How often a spending limit starts over. 'total' never does. */
export type BudgetPeriod = 'day' | 'week' | 'month' | 'year' | 'total';

export interface BudgetLimit {
  id: string;
  /** US dollars. */
  amount: number;
  period: BudgetPeriod;
  /** When it starts over: the weekday for a week (0 = Sunday), the day of the month (1–28) for a month. */
  resetDay?: number;
  /** For 'total': when counting started. */
  since?: string;
}

export interface BudgetSettings {
  limits?: BudgetLimit[];
  /** From before `limits` (moved into them). */
  daily?: number;
  monthly?: number;
  /** Warn when this share of a limit (percent) is spent. */
  alertPercent: number;
  /** Refuse new requests once a limit is reached (when there's no free model to switch to). */
  hardStop: boolean;
  /** Once a limit is reached, requests go to this (free) model instead of stopping or running up costs. */
  freeModel?: string;
}

export interface BudgetLimitStatus extends BudgetLimit {
  spent: number;
  /** When the current period started, and when it starts over (none for 'total'). */
  start: string;
  resetsAt?: string;
  state: 'ok' | 'warn' | 'over';
}

export interface BudgetStatus {
  limits: BudgetLimitStatus[];
  alertPercent: number;
  hardStop: boolean;
  freeModel?: string;
  /** ok, warn (past the alert share of a limit) or over (a limit reached). */
  state: 'ok' | 'warn' | 'over';
  /** The limit the state is about. */
  limit?: BudgetLimitStatus;
  /** A limit is reached and requests are going to the free model. */
  freeMode: boolean;
}

// ---------- Usage ----------

export type UsageKind = 'chat' | 'title' | 'memory' | 'workflow' | 'task' | 'btw' | 'goal' | 'learning' | 'review' | 'eval' | 'other';

/** One model call. */
export interface UsageEvent {
  ts: number;
  model: string;
  prompt: number;
  completion: number;
  cost: number;
  kind: UsageKind;
  chatId?: string;
  projectId?: string;
  botId?: string;
  workflowId?: string;
  taskId?: string;
  /** Set on calls Auto routed. */
  route?: RouteChoice['tier'];
}

// ---------- Feedback loops ----------

/** One reviewed attempt at a task. */
export interface FeedbackIteration {
  /** Index of the reviewed answer in the chat. */
  messageIndex: number;
  /** 1 (not at all) to 5 (exactly right). */
  rating: number;
  meant?: string;
  did?: string;
  directions?: string;
  at: string;
}

/** A task the user reviewed, redid with directions until happy, and what the bot learned from it. */
export interface FeedbackLoop {
  id: string;
  chatId: string;
  botId: string;
  projectId?: string;
  /** The user's request. */
  task: string;
  status: 'open' | 'accepted' | 'abandoned';
  iterations: FeedbackIteration[];
  lesson?: string;
  lessonId?: string;
  createdAt: string;
  updatedAt: string;
  acceptedAt?: string;
}

// ---------- Workflows ----------

export type WorkflowNodeType = 'trigger' | 'ai' | 'http' | 'condition' | 'transform' | 'image' | 'artifact' | 'memory' | 'browse' | 'loop' | 'code' | 'delay' | 'approval' | 'output';

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  label: string;
  x: number;
  y: number;
  config: Record<string, any>;
}

export interface WorkflowEdge {
  id: string;
  from: string;
  to: string;
  /** Which output of a condition: 'true' or 'false'. */
  port?: string;
}

export interface WorkflowStep {
  nodeId: string;
  /** `waiting`: an approval step waiting for the user. */
  status: 'running' | 'waiting' | 'done' | 'error' | 'skipped';
  /** What an approval step asks the user. */
  ask?: string;
  output?: string;
  error?: string;
  startedAt: string;
  ms?: number;
}

export interface WorkflowRun {
  id: string;
  trigger: 'manual' | 'schedule' | 'chat' | 'webhook' | 'folder';
  /** What set it off, when a trigger did: the file's name, or the webhook. */
  source?: string;
  input: string;
  /** `waiting`: paused at an approval step until the user decides. */
  status: 'running' | 'waiting' | 'done' | 'error';
  steps: WorkflowStep[];
  output?: string;
  error?: string;
  cost?: number;
  startedAt: string;
  finishedAt?: string;
}

export interface Workflow {
  id: string;
  name: string;
  description: string;
  emoji: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  /** Bots can run it from chat (as the Workflow tool, or with /workflow). */
  exposeToChat: boolean;
  /** Ways it starts by itself, besides schedules. */
  triggers?: WorkflowTriggers;
  /** Most recent runs, newest first. */
  runs: WorkflowRun[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowTriggers {
  /** POSTing to /hooks/<token> runs the workflow with the request body as input. */
  webhook?: { token: string; enabled: boolean };
  /** New or changed text files in a folder each run the workflow, with the file's text as input. */
  folder?: { path: string; pattern: string; enabled: boolean };
}

export type WorkflowEvent = { type: 'step'; runId: string; step: WorkflowStep } | { type: 'run'; run: WorkflowRun };

export interface Rating {
  value: 1 | -1;
  comment?: string;
  /** What the bot took away from the rating, once distilled. */
  lesson?: string;
  lessonId?: string;
  ratedAt: string;
}

export interface Lesson {
  id: string;
  text: string;
  value: 1 | -1;
  chatId: string;
  createdAt: string;
  /** Where it came from: a thumbs rating, a feedback loop, task outcomes, the user's edits, or a teammate's work. */
  source?: LessonSource;
}

/** A lesson taken out of the prompt: it measurably hurt, or was merged into another or dropped while tidying. */
export type RetiredLesson = Lesson & { retiredAt: string; reason: string };

export type LessonSource = 'rating' | 'feedback' | 'outcome' | 'edit' | 'teammate';

// ---------- Project knowledge ----------

export type ProjectFactKind = 'command' | 'convention' | 'layout' | 'gotcha' | 'preference';

/** Something learned about a repository: how to build and test it, its conventions, this machine's gotchas. */
export interface ProjectFact {
  id: string;
  text: string;
  kind: ProjectFactKind;
  /** observed: from what worked or failed; correction: the user corrected the bot; agent: the bot noted it; user: typed in. */
  source: 'observed' | 'correction' | 'agent' | 'user' | 'consolidated';
  /** 1 (seen once) to 3 (the user said so). */
  priority: number;
  /** How many times it was seen again. */
  evidence: number;
  createdAt: string;
  updatedAt: string;
}

/** What Mitzi learned about one project's folder. */
export interface ProjectMemory {
  /** The project's id. */
  id: string;
  facts: ProjectFact[];
  /** Facts added since the last consolidation. */
  sinceConsolidation: number;
  updatedAt: string;
}

// ---------- Playbooks ----------

/** How a kind of task was done successfully here: steps, commands, files and the check, for next time. */
export interface Playbook {
  id: string;
  botId: string;
  projectId?: string;
  title: string;
  /** What kind of task it's for. */
  when: string;
  steps: string[];
  /** How the work was checked. */
  verification?: string;
  /** The successful tool-call sequence (used only when tool-trace hints are on). */
  trace?: string[];
  /** The outcome it was learned from. */
  outcomeId: string;
  /** Times it was offered in a prompt. */
  uses: number;
  createdAt: string;
  updatedAt: string;
}

// ---------- Evals ----------

/** One of your past tasks replayed with one model. */
export interface EvalItem {
  outcomeId: string;
  task: string;
  model: string;
  status: 'pending' | 'running' | 'done' | 'error' | 'skipped';
  /** The project's checks on the replayed work. */
  testsPassed?: boolean;
  checkCommand?: string;
  toolCalls?: number;
  toolErrors?: number;
  /** 1–5: how well it did the task, judged against the answer you accepted. */
  score?: number;
  notes?: string;
  durationMs?: number;
  cost?: number;
  error?: string;
}

/** A head-to-head of models on your own tasks, each replayed from the repository state it started in. */
export interface EvalRun {
  id: string;
  projectId: string;
  models: string[];
  status: 'running' | 'done' | 'stopped';
  items: EvalItem[];
  createdAt: string;
  finishedAt?: string;
}

// ---------- Outcomes ----------

/** How a failed tool call is to be read: the agent's mistake, the machine's, or the user saying no. */
export type ErrorKind = 'agent' | 'environment' | 'declined' | 'unknown';

export interface OutcomeError {
  tool: string;
  kind: ErrorKind;
  text: string;
  /** The shell command, for Bash. */
  command?: string;
}

/** What happened on one substantive task, derived from the run itself (and amended by later signals). */
export interface TaskOutcome {
  id: string;
  ts: number;
  chatId: string;
  botId: string;
  projectId?: string;
  model: string;
  /** The user's ask. */
  task: string;
  mode: 'chat' | 'work';
  /** 'teammate': a Delegate or subagent assignment (`leadBotId` handed it over). */
  source: 'run' | 'teammate' | 'backfill';
  leadBotId?: string;
  /** 1 for a first try; a redo with directions counts up. */
  attempts: number;
  /** Goal continuations within the run. */
  goalTurns?: number;
  toolCalls: number;
  /** Failed tool calls, the user declining aside. */
  toolErrors: number;
  errors: OutcomeError[];
  errorKinds: ErrorKind[];
  filesTouched: string[];
  /** Shell commands run, and whether they exited cleanly. */
  commands: { command: string; ok: boolean }[];
  /** The last check of the work: the harness's verification, else the bot's own last test run. */
  testsPassed?: boolean;
  /** Whether the harness's first check passed (the bot finished on green by itself). */
  firstCheckPassed?: boolean;
  /** The command the harness checked the work with. */
  checkCommand?: string;
  /** The tool calls in order, briefly ("Edit src/a.ts", "Bash npm test"). */
  trace?: string[];
  /** The user asked for a redo. */
  redone: boolean;
  /** 1–5: a review, or a thumbs up (5) / down (1). */
  rating?: number;
  /** Edits the user made to the bot's output right after. */
  editsAfter?: number;
  /** Lessons in the prompt while the task ran. */
  lessonIds: string[];
  /** The repository's commit when the task started, for replaying it. */
  gitHead?: string;
  durationMs?: number;
  cost?: number;
  /** Lessons have been distilled from it. */
  distilled?: boolean;
}

export type ChatSummary = Omit<Chat, 'messages' | 'summary'> & { messageCount: number };

export type ArtifactType = 'markdown' | 'slides' | 'code' | 'html' | 'react' | 'svg' | 'mermaid' | 'image' | 'video' | 'audio' | 'latex' | 'sheet';

/** Artifacts whose content is text the user and the bot edit (media artifacts hold a file URL). */
export const TEXT_ARTIFACT_TYPES: ArtifactType[] = ['markdown', 'slides', 'code', 'html', 'react', 'svg', 'mermaid', 'latex', 'sheet'];

export interface ArtifactVersion {
  content: string;
  createdAt: string;
  /** Who made this version; versions without one came from the bot. */
  author?: 'user' | 'assistant';
  /** The title at this version, when it changed. */
  title?: string;
  note?: string;
  /** Tool call that produced this version, so chat messages can link to it. */
  callId?: string;
  /** A user version the bot already took a style lesson from. */
  learned?: boolean;
}

export interface Artifact {
  id: string;
  chatId: string;
  projectId?: string;
  title: string;
  type: ArtifactType;
  language?: string;
  versions: ArtifactVersion[];
  /** Comments on passages, for text artifacts. */
  comments?: ArtifactComment[];
  /** An image's latest markup by the user (annotations drawn over it), sent to the bot as a guide for edits. */
  markup?: { url: string; createdAt: string };
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
  /** Model id as Mitzi uses it: OpenRouter ids as-is, other providers as "provider:model". */
  id: string;
  name: string;
  /** Display name of the provider that serves it. */
  provider?: string;
  contextLength?: number;
  promptPrice?: number;
  completionPrice?: number;
  tools: boolean;
  vision: boolean;
}

export type ProviderKind =
  | 'openrouter'
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'xai'
  | 'groq'
  | 'mistral'
  | 'deepseek'
  | 'together'
  | 'ollama'
  | 'lmstudio'
  | 'elevenlabs'
  | 'custom';

export interface ProviderConfig {
  /** Prefix for this provider's model ids, e.g. "openai" in "openai:gpt-5". */
  id: string;
  kind: ProviderKind;
  name: string;
  apiKey?: string;
  baseUrl?: string;
  enabled: boolean;
}

/** A provider as the browser sees it: the key is never sent back. */
export interface ProviderView extends Omit<ProviderConfig, 'apiKey'> {
  hasKey: boolean;
  keySource?: 'env' | 'config';
  /** Error from the last attempt to list its models. */
  error?: string;
  modelCount?: number;
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
  /** /compare: the race has started; the UI shows two columns. */
  | { type: 'compare_start'; modelA: string; modelB: string; prompt: string }
  /** /compare: streamed chunk for one side. */
  | { type: 'compare_text'; side: 'A' | 'B'; text: string }
  /** /compare: one side finished (or failed). */
  | { type: 'compare_end'; side: 'A' | 'B'; error?: string }
  /** /compare: both sides are done; the UI should show the A/B/skip picker. */
  | { type: 'compare_pick'; modelA: string; modelB: string }
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; id: string; name: string; summary: string; args: unknown }
  | { type: 'tool_result'; id: string; output: string; isError: boolean }
  /** Progress of a bot working on a task handed to it with the Delegate tool (callId is that call's id). */
  | { type: 'delegate'; callId: string; botId: string; event: 'start' | 'text' | 'tool' | 'done' | 'error'; text: string }
  | { type: 'permission'; requestId: string; callId?: string; tool: string; summary: string; preview?: string; alwaysRule: string; why?: string }
  | { type: 'permission_resolved'; requestId: string }
  /** The bot asks the user something and waits for the answer (POST /api/chats/:id/answer). */
  | { type: 'question'; requestId: string; callId?: string; questions: AskQuestion[] }
  | { type: 'question_resolved'; requestId: string }
  | { type: 'artifact'; artifact: Artifact }
  | { type: 'todos'; todos: Todo[] }
  | { type: 'goal'; goal: Goal | null }
  | { type: 'plan'; plan: Plan }
  | { type: 'stats'; stats: ResponseStats }
  | { type: 'route'; route: RouteChoice }
  | { type: 'browser'; url: string; title: string; screenshot?: string }
  | { type: 'status'; message: string }
  /** The harness ran the project's checks. */
  | { type: 'verify'; result: VerifyResult }
  | { type: 'recall'; memories: RecalledMemory[] }
  | { type: 'warn'; message: string }
  | { type: 'compacted'; contextStart: number }
  | { type: 'chat'; chat: ChatSummary }
  | { type: 'error'; message: string }
  /** The chat's queued messages changed. */
  | { type: 'queue'; queue: QueuedMessage[] }
  /** First event when following a run that already started. */
  | { type: 'run'; startedAt: number }
  | { type: 'done' };

export interface Attachment {
  name: string;
  /** Text content, or a data: URL for images. */
  content: string;
  kind: 'text' | 'image';
}

// ---------- Extensions: MCP servers, connectors, skills, plugins ----------

export type McpTransport = 'stdio' | 'http' | 'sse';
/** When MCP tool calls need approval: always, only for tools not marked read-only, or never. */
export type McpTrust = 'ask' | 'readonly' | 'allow';

export interface McpOAuthState {
  clientId: string;
  clientSecret?: string;
  accessToken?: string;
  refreshToken?: string;
  /** Epoch ms. */
  expiresAt?: number;
  tokenEndpoint?: string;
  resource?: string;
  scope?: string;
}

export interface McpServerConfig {
  id: string;
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
  trust: McpTrust;
  disabledTools: string[];
  source: 'user' | 'connector' | 'plugin';
  connectorId?: string;
  pluginId?: string;
  oauth?: McpOAuthState;
  createdAt: string;
  updatedAt: string;
}

export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  readOnly?: boolean;
  enabled: boolean;
}

export type McpStatus = 'disabled' | 'connecting' | 'connected' | 'error' | 'needs-auth';

/** A server as the browser sees it: secrets masked, plus live status. */
export interface McpServerView extends Omit<McpServerConfig, 'oauth'> {
  status: McpStatus;
  error?: string;
  tools: McpToolInfo[];
  serverName?: string;
  oauthConnected: boolean;
}

export interface ConnectorField {
  key: string;
  label: string;
  /** env var, HTTP header, extra command arguments, or a bearer token header. */
  kind: 'env' | 'header' | 'args' | 'bearer';
  placeholder?: string;
  help?: string;
  secret?: boolean;
  required?: boolean;
}

export interface ConnectorPreset {
  id: string;
  name: string;
  description: string;
  emoji: string;
  category: string;
  transport: McpTransport;
  url?: string;
  command?: string;
  args?: string[];
  fields: ConnectorField[];
  /** Signs in through the service's OAuth page. */
  oauth?: boolean;
  /** Runtime the user needs installed (stdio connectors). */
  requires?: string;
  docsUrl?: string;
  /** Default trust for a new connection. */
  trust?: McpTrust;
}

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  source: 'user' | 'plugin' | 'claude';
  pluginId?: string;
  dir: string;
  enabled: boolean;
  files: string[];
}

export interface SkillDetail extends SkillInfo {
  body: string;
}

export interface PluginComponents {
  skills: number;
  commands: number;
  agents: number;
  mcpServers: number;
  /** Hooks are listed but not run by Mitzi. */
  hooks: boolean;
}

export interface PluginSource {
  kind: 'git' | 'local' | 'marketplace';
  url?: string;
  path?: string;
  ref?: string;
  marketplace?: string;
}

export interface PluginInfo {
  id: string;
  name: string;
  description: string;
  version?: string;
  author?: string;
  homepage?: string;
  source: PluginSource;
  enabled: boolean;
  /** Restricts skills to these directories (marketplace entries with an explicit skill list). */
  skillPaths?: string[];
  components: PluginComponents;
  installedAt: string;
  updatedAt: string;
}

export interface MarketplacePlugin {
  name: string;
  description?: string;
  category?: string;
  version?: string;
  author?: string;
  homepage?: string;
  installed: boolean;
}

export interface MarketplaceInfo {
  id: string;
  name: string;
  description?: string;
  source: string;
  plugins: MarketplacePlugin[];
  updatedAt: string;
}

export interface SlashCommandInfo {
  name: string;
  description?: string;
  argumentHint?: string;
  /** Plugin name, or "user". */
  source: string;
}

// ---------- Media, voice ----------

export interface MediaSettings {
  imageModel: string;
  videoModel: string;
  /** Text-to-speech, used for read-aloud, live mode and generated speech. */
  speechModel: string;
  voice: string;
  soundModel: string;
  musicModel: string;
  /** Speech-to-text for live mode in browsers without built-in recognition. */
  transcribeModel: string;
  /** Speech-to-speech for realtime voice conversations (OpenAI Realtime). Empty: live mode uses the models above. */
  realtimeModel?: string;
}

export type MediaKind = 'image' | 'video' | 'speech' | 'sound' | 'music';

// ---------- Documents (before they became artifacts; migrated on startup) ----------

export interface ArtifactComment {
  id: string;
  /** The passage the comment is about. */
  quote: string;
  text: string;
  author: 'user' | 'assistant';
  resolved: boolean;
  replies: { author: 'user' | 'assistant'; text: string; createdAt: string }[];
  createdAt: string;
}

export interface DocVersion {
  id: string;
  title: string;
  content: string;
  author: 'user' | 'assistant';
  note?: string;
  createdAt: string;
}

/** @deprecated Documents are markdown artifacts now. */
export interface Doc {
  id: string;
  title: string;
  /** Markdown. */
  content: string;
  comments: ArtifactComment[];
  versions: DocVersion[];
  /** The chat used to work on the document with a bot. */
  chatId: string;
  createdAt: string;
  updatedAt: string;
}


// ---------- Scheduled tasks ----------

export interface TaskSchedule {
  kind: 'once' | 'interval' | 'daily' | 'weekly' | 'cron';
  /** once: ISO date-time. */
  at?: string;
  /** interval: minutes between runs. */
  everyMinutes?: number;
  /** daily / weekly: "HH:MM" local time. */
  time?: string;
  /** weekly: days 0 (Sunday) – 6. */
  days?: number[];
  /** cron: five fields, local time. */
  cron?: string;
}

export interface TaskRun {
  id: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'ok' | 'error';
  chatId?: string;
  error?: string;
  /** First lines of the answer. */
  preview?: string;
  /** Set when the task ran a workflow. */
  workflowRunId?: string;
  seen: boolean;
}

export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  schedule: TaskSchedule;
  botId?: string;
  projectId?: string;
  model?: string;
  enabled: boolean;
  /** Allow tools that would normally ask (nobody is there to approve). */
  autoApprove: boolean;
  /** Continue one chat across runs instead of starting a new chat each time. */
  reuseChat: boolean;
  /** Run this workflow (with the prompt as its input) instead of sending the prompt to a bot. */
  workflowId?: string;
  chatId?: string;
  nextRunAt?: string;
  runs: TaskRun[];
  createdAt: string;
  updatedAt: string;
}

// ---------- Folders and repositories ----------

export interface DirEntry {
  name: string;
  path: string;
  /** Contains a .git folder. */
  git: boolean;
}

export interface DirListing {
  path: string;
  /** Undefined at a filesystem root. */
  parent?: string;
  dirs: DirEntry[];
  /** Shortcuts: home, Desktop, Documents, drives… */
  places: { label: string; path: string }[];
  git: boolean;
}

export interface RepoStatus {
  branch?: string;
  /** Commits not yet pushed / not yet pulled. */
  ahead: number;
  behind: number;
  /** Files changed, added or deleted in the working tree. */
  changed: number;
  remote?: string;
}

// ---------- Importing from other assistants ----------

export type ImportSource = 'chatgpt' | 'claude';

/** A conversation from another assistant's data export, in a common shape. */
export interface ImportedConversation {
  /** The other app's id, so importing twice doesn't duplicate. */
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: { role: 'user' | 'assistant'; text: string; ts?: number }[];
}
