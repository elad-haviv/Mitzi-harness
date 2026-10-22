import { COMPACT_PROMPT, renderForTranscript } from '../agent.js';
import type { LlmClient, Message, ToolSpec } from '../openrouter.js';
import { buildSystemPrompt } from '../prompt.js';
import type { Artifact, Bot, Doc, Chat, ContextBreakdown, ContextSection, ModelInfo, Project, RecalledMemory, SkillInfo, UiSettings } from '../shared/types.js';
import { docPrompt } from './docs.js';
import { skillsPrompt } from './extensions/skills.js';

const DEFAULT_CONTEXT_LENGTH = 128_000;

/** Rough token estimate (~4 characters per token), used where no provider count exists. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface ChatSetup {
  chat: Chat;
  project?: Project;
  bot: Bot;
  /** Memories recalled for the latest user message. */
  recalled: RecalledMemory[];
  /** Skills the model can load (when the Skill tool is available). */
  skills: SkillInfo[];
  artifacts: Artifact[];
  settings: UiSettings;
  toolNames: string[];
  /** The document a doc chat works on. */
  doc?: Doc;
}

interface PromptSection {
  label: string;
  kind: ContextSection['kind'];
  text: string;
}

const ARTIFACT_GUIDE = `# Artifacts
Use the Artifact tool for substantial, self-contained content the user will likely reuse, edit or view on its own: \
documents and reports (markdown), code files or scripts over ~20 lines (code), complete web pages (html), interactive \
components (react), graphics (svg) and diagrams (mermaid). Don't use artifacts for short answers, small snippets or \
conversational replies. After creating or changing one, briefly say what you did; don't repeat its content in chat. \
Prefer "update" for small edits to an existing artifact.
- html: a complete HTML document. Scripts may load from https://cdnjs.cloudflare.com or https://cdn.jsdelivr.net.
- react: a single component file with a default export. React and its hooks are available (import from "react" is fine) \
and Tailwind CSS classes work. No other packages can be imported.
- svg: one <svg> element with a viewBox. mermaid: diagram source only, without code fences.
- code: set language. markdown: GitHub-flavored markdown.`;

function basePrompt(setup: ChatSetup): string {
  const date = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const lines = [
    `You are ${setup.bot.name}, an AI assistant.`,
    setup.bot.systemPrompt.trim(),
    'Format responses with GitHub-flavored Markdown: headings for long answers, lists and tables where they help, and fenced code blocks with a language tag. ' +
      'Match length to the question: brief for simple questions, thorough for complex ones. If something is ambiguous, ask.',
    `Today is ${date}. You are running as the model ${setup.chat.model}.`,
  ];
  if (setup.chat.webSearch) lines.push('Web search results may be provided; cite sources with markdown links.');
  return lines.filter(Boolean).join('\n\n');
}

export function promptSections(setup: ChatSetup): PromptSection[] {
  const { chat, project, bot, recalled, artifacts, toolNames } = setup;
  const sections: PromptSection[] = [];

  if (project?.folder) {
    sections.push({
      label: 'Coding agent',
      kind: 'system',
      text: buildSystemPrompt({ cwd: project.folder, model: chat.model, mode: project.permissionMode, surface: 'web' }),
    });
    if (!bot.builtIn) sections.push({ label: `${bot.name} instructions`, kind: 'system', text: `# Role\nYou are ${bot.name}.\n${bot.systemPrompt}` });
  } else {
    sections.push({ label: 'System prompt', kind: 'system', text: basePrompt(setup) });
  }

  if (project?.instructions.trim()) {
    sections.push({
      label: 'Project instructions',
      kind: 'project',
      text: `# Project: ${project.name}\nFollow these project instructions:\n${project.instructions.trim()}`,
    });
  }
  if (project?.files.length) {
    sections.push({
      label: `Project knowledge (${project.files.length} file${project.files.length === 1 ? '' : 's'})`,
      kind: 'project',
      text:
        '# Project knowledge\nReference documents the user added to this project:\n\n' +
        project.files.map((f) => `<document name="${f.name}">\n${f.content}\n</document>`).join('\n\n'),
    });
  }

  if (toolNames.includes('Memory')) {
    const date = (m: RecalledMemory) => (m.occurredAt ? ` (${m.occurredAt.slice(0, 10)})` : '');
    const group = (type: RecalledMemory['type'], title: string) => {
      const items = recalled.filter((m) => m.type === type);
      return items.length ? `${title}:\n${items.map((m) => `- [${m.id}] ${m.text}${date(m)}`).join('\n')}` : '';
    };
    const body = [group('observation', 'What you have come to believe'), group('world', 'Facts'), group('experience', 'Your past experiences with the user')]
      .filter(Boolean)
      .join('\n\n');
    sections.push({
      label: `Recalled memories (${recalled.length})`,
      kind: 'memory',
      text:
        '# Memory\nYou have a long-term memory bank that persists across conversations. These memories were recalled as relevant ' +
        "to the user's latest message. Use them naturally, without announcing that you remember, and trust newer information " +
        'when it conflicts with them.\n\n' +
        (body || '(Nothing relevant recalled.)'),
    });
  }

  const lessons = (bot.lessons ?? []).slice(-12);
  if (lessons.length) {
    sections.push({
      label: `Lessons from feedback (${lessons.length})`,
      kind: 'memory',
      text:
        '# Lessons from feedback\nThe user rated some of your earlier answers. Keep doing what they liked and avoid what they disliked:\n' +
        lessons.map((l) => `- ${l.value > 0 ? '(liked)' : '(disliked)'} ${l.text}`).join('\n'),
    });
  }

  if (setup.doc && toolNames.includes('DocEdit')) {
    sections.push({ label: `Document: ${setup.doc.title}`, kind: 'project', text: docPrompt(setup.doc) });
  }

  if (toolNames.includes('Skill') && setup.skills.length) {
    sections.push({ label: `Skills (${setup.skills.length})`, kind: 'tools', text: skillsPrompt(setup.skills) });
  }

  if (toolNames.includes('Artifact')) {
    const list = artifacts.length
      ? `\n\nArtifacts in this chat:\n${artifacts.map((a) => `- ${a.id}: "${a.title}" (${a.type}, v${a.versions.length})`).join('\n')}`
      : '';
    sections.push({ label: 'Artifact guide', kind: 'system', text: ARTIFACT_GUIDE + list });
  }
  return sections;
}

export function systemPrompt(setup: ChatSetup): string {
  return promptSections(setup)
    .map((s) => s.text)
    .join('\n\n');
}

/** The messages actually sent to the model: the summary (if any) plus the uncompacted tail. */
export function contextMessages(chat: Chat): Message[] {
  const tail = chat.messages.slice(chat.contextStart).map(({ ts: _ts, model: _model, memories: _memories, command: _command, rating: _rating, ...m }) => m as Message);
  if (!chat.summary) return tail;
  return [
    { role: 'user', content: `Earlier parts of this conversation were summarized to save context:\n\n${chat.summary}` },
    { role: 'assistant', content: 'Understood. I have the context from the summary.' },
    ...tail,
  ];
}

export function contextBreakdown(setup: ChatSetup, specs: ToolSpec[], contextLength: number | undefined): ContextBreakdown {
  const { chat, settings } = setup;
  const sections: ContextSection[] = promptSections(setup).map((s) => ({ label: s.label, kind: s.kind, tokens: estimateTokens(s.text) }));
  if (specs.length) sections.push({ label: `Tool definitions (${specs.length})`, kind: 'tools', tokens: estimateTokens(JSON.stringify(specs)) });
  if (chat.summary) sections.push({ label: 'Summary of earlier messages', kind: 'summary', tokens: estimateTokens(chat.summary) });
  const history = chat.messages.slice(chat.contextStart);
  // Images cost roughly a thousand tokens each with most providers.
  const historyTokens = history.reduce((n, m) => {
    const images = Array.isArray(m.content) ? m.content.filter((p) => p.type === 'image_url').length : 0;
    return n + estimateTokens(renderForTranscript(m)) + images * 1000;
  }, 0);
  sections.push({ label: `Conversation (${history.length} messages)`, kind: 'history', tokens: historyTokens });
  const window = contextLength ?? DEFAULT_CONTEXT_LENGTH;
  return {
    model: chat.model,
    contextLength,
    lastPromptTokens: chat.lastPromptTokens,
    estimatedTokens: sections.reduce((n, s) => n + s.tokens, 0),
    sections,
    autoCompactAt: settings.autoCompactPercent > 0 ? Math.floor((window * settings.autoCompactPercent) / 100) : undefined,
    compactedMessages: chat.contextStart,
    summary: chat.summary,
  };
}

/**
 * Folds older messages into the chat's running summary, keeping the most recent
 * `keepRecentTurns` user turns verbatim. Returns false when there is nothing to fold.
 */
export async function compactChat(
  chat: Chat,
  client: LlmClient,
  model: string,
  keepRecentTurns: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const userTurns: number[] = [];
  for (let i = chat.contextStart; i < chat.messages.length; i++) if (chat.messages[i].role === 'user') userTurns.push(i);
  const cut = keepRecentTurns > 0 ? userTurns[userTurns.length - keepRecentTurns] : chat.messages.length;
  if (cut === undefined || cut <= chat.contextStart) return false;

  const transcript = chat.messages.slice(chat.contextStart, cut).map(renderForTranscript).join('\n\n');
  const previous = chat.summary ? `\n\n<previous-summary>\n${chat.summary}\n</previous-summary>\nMerge the previous summary into yours.` : '';
  const result = await client.chat({
    model,
    messages: [{ role: 'user', content: `${COMPACT_PROMPT}${previous}\n\n<conversation>\n${transcript}\n</conversation>` }],
    signal,
  });
  if (!result.content.trim()) throw new Error('The model returned an empty summary');
  chat.summary = result.content.trim();
  chat.contextStart = cut;
  chat.lastPromptTokens = 0;
  if (result.usage) {
    chat.usage.promptTokens += result.usage.prompt_tokens ?? 0;
    chat.usage.completionTokens += result.usage.completion_tokens ?? 0;
    chat.usage.cost += result.usage.cost ?? 0;
    chat.usage.requests++;
  }
  return true;
}

export async function generateTitle(client: LlmClient, model: string, firstMessage: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const res = await client.chat({
      model,
      maxTokens: 60,
      signal,
      messages: [
        {
          role: 'user',
          content: `Write a short title (at most 6 words) for a conversation that starts with the message below. Reply with the title only, no quotes or punctuation at the end.\n\n<message>\n${firstMessage.slice(0, 2000)}\n</message>`,
        },
      ],
    });
    const title = res.content.trim().split('\n')[0].replace(/^["'#*\s]+|["'*.\s]+$/g, '');
    return title ? title.slice(0, 80) : undefined;
  } catch {
    return undefined;
  }
}

/** Caches the combined model list of all configured providers. */
export class ModelCatalog {
  private cache?: { at: number; models: ModelInfo[] };

  constructor(private readonly client: () => LlmClient) {}

  invalidate(): void {
    this.cache = undefined;
  }

  async list(): Promise<ModelInfo[]> {
    if (this.cache && Date.now() - this.cache.at < 3_600_000) return this.cache.models;
    const models = await this.client().listModels();
    this.cache = { at: Date.now(), models };
    return models;
  }

  async contextLength(model: string): Promise<number | undefined> {
    try {
      const id = model.replace(/:online$/, '');
      return (await this.list()).find((m) => m.id === id)?.contextLength;
    } catch {
      return undefined;
    }
  }
}
