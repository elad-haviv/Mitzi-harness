// Routes for branching, ratings, documents, scheduled tasks, and media and voice.
import type { Config } from '../config.js';
import type { RoutingClient } from '../providers.js';
import { Artifact, ArtifactType, Chat, ChatMessage, DEFAULT_BOT_ID, TEXT_ARTIFACT_TYPES, MediaSettings, ScheduledTask, StreamEvent, TaskRun, TaskSchedule } from '../shared/types.js';
import { newComment, userEdit } from './workspace.js';
import { addLessons } from './lessons.js';
import { outcomeIdFor } from './outcomes.js';
import type { EditMiner } from './edits.js';
import { MediaService } from './media.js';
import type { MemoryService } from './memory/index.js';
import { ChatRunner, summarizeChat } from './runner.js';
import { describeSchedule, Scheduler, validateSchedule } from './scheduler.js';
import { newId, now, Store } from './store.js';
import { fail, HttpError, Route, STREAMED, str } from './util.js';
import type { WorkflowEngine } from './workflows.js';

export interface FeatureDeps {
  store: Store;
  runner: ChatRunner;
  client: () => RoutingClient;
  config: () => Config;
  memory: MemoryService;
  media: MediaService;
  /** Creates an empty chat (the same as POST /api/chats). */
  newChat: (fields: Partial<Chat>) => Chat;
  workflows: WorkflowEngine;
  /** Learns from the user's edits to the bot's artifacts. */
  edits?: EditMiner;
}

function messageText(m: ChatMessage | undefined): string {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  return (m.content ?? []).map((p) => (p.type === 'text' ? p.text : '')).join(' ');
}

const LESSON_PROMPT = `The user rated an AI assistant's answer. Distill one short, reusable lesson the assistant should apply in future \
conversations with this user: a preference about content, style, length, format, tone or approach. Generalize beyond this one \
question, but don't invent preferences the rating doesn't support. If there is nothing general to learn (for example, a like \
with no comment on an ordinary answer), reply with NONE.

Reply with only the lesson as one sentence in the imperative ("Prefer…", "Avoid…", "Keep…"), or NONE.

<question>
{question}
</question>

<answer>
{answer}
</answer>

Rating: {rating}
{comment}`;

export function registerFeatureRoutes(route: Route, deps: FeatureDeps): { scheduler: Scheduler } {
  const { store, runner, media } = deps;
  const getChat = (id: string) => store.chats.get(id) ?? fail(404, 'Chat not found');
  const getTask = (id: string) => store.tasks.get(id) ?? fail(404, 'Scheduled task not found');

  // ---- Branching ---------------------------------------------------------------

  route('POST', '/api/chats/:id/branch', ({ params, body }) => {
    const source = getChat(params.id);
    const index = Number(body?.index);
    if (!Number.isInteger(index) || index < 0 || index >= source.messages.length) throw new HttpError(400, 'Pick a message to branch from');
    // Include the whole assistant turn (its tool calls and results) the chosen message belongs to.
    let end = index + 1;
    while (end < source.messages.length && source.messages[end].role !== 'user') end++;
    const messages: ChatMessage[] = structuredClone(source.messages.slice(0, end)).map(({ rating: _r, ...m }) => m as ChatMessage);
    const chat = deps.newChat({
      title: `${source.title} (branch)`.slice(0, 120),
      projectId: source.projectId,
      botId: source.botId,
      model: source.model,
      webSearch: source.webSearch,
      messages,
      allowedRules: [...source.allowedRules],
      contextStart: Math.min(source.contextStart, messages.length),
      summary: source.contextStart <= messages.length ? source.summary : undefined,
      branchedFrom: { chatId: source.id, title: source.title },
    });
    // Copy the artifacts the branch refers to, so changes in one chat don't affect the other.
    const callIds = new Set(messages.flatMap((m) => (m.role === 'assistant' ? (m.tool_calls ?? []).map((c) => c.id) : [])));
    for (const a of store.artifacts.all()) {
      if (a.chatId !== source.id) continue;
      const versions = a.versions.filter((v) => !v.callId || callIds.has(v.callId));
      if (!versions.length || !a.versions.some((v) => v.callId && callIds.has(v.callId))) continue;
      const id = newId();
      store.artifacts.put({ ...structuredClone(a), id, chatId: chat.id, versions: structuredClone(versions), createdAt: now(), updatedAt: now() });
      // Tool results name the artifact id; point the branch's copies at the new artifact.
      for (const m of chat.messages) {
        if (m.role === 'tool' && typeof m.content === 'string' && m.content.includes(a.id)) m.content = m.content.split(a.id).join(id);
      }
    }
    store.chats.put(chat);
    return summarizeChat(chat);
  });

  // ---- Ratings -----------------------------------------------------------------

  const learn = async (chat: Chat, index: number) => {
    const message = chat.messages[index];
    const rating = message?.rating;
    const bot = runner.botFor(chat);
    if (!rating) return;
    const question = messageText(chat.messages.slice(0, index).findLast((m) => m.role === 'user' && m.auto !== 'images')).slice(0, 4000);
    const answer = chat.messages
      .slice(chat.messages.slice(0, index).findLastIndex((m) => m.role === 'user' && m.auto !== 'images') + 1, index + 1)
      .filter((m) => m.role === 'assistant')
      .map(messageText)
      .join('\n')
      .slice(0, 6000);
    const prompt = LESSON_PROMPT.replace('{question}', question)
      .replace('{answer}', answer)
      .replace('{rating}', rating.value > 0 ? 'liked (thumbs up)' : 'disliked (thumbs down)')
      .replace('{comment}', rating.comment ? `User's comment: ${rating.comment}` : 'No comment.');
    const config = deps.config();
    const res = await deps.client().chat({ model: config.smallModel ?? runner.modelOf(chat), messages: [{ role: 'user', content: prompt }], maxTokens: 200 });
    const text = res.content.trim().replace(/^["'\s]+|["'\s]+$/g, '');
    // The rating may have changed while the lesson was being written.
    if (!text || /^NONE\b/i.test(text) || chat.messages[index]?.rating !== rating) return;
    const [lesson] = addLessons(store, bot.id, [text.slice(0, 400)], { value: rating.value, chatId: chat.id, source: 'rating' });
    if (!lesson) return;
    rating.lesson = lesson.text;
    rating.lessonId = lesson.id;
    store.chats.put(chat);
    if (store.settings.memoryEnabled && bot.tools.memory) {
      await deps.memory
        .backend()
        .remember(deps.memory.bankFor(bot), `Feedback from the user: ${lesson.text}`, 'user')
        .catch(() => {});
    }
  };

  const dropLesson = (chat: Chat, lessonId?: string) => {
    if (!lessonId) return;
    const bot = store.bots.get(runner.botFor(chat).id);
    if (bot?.lessons?.some((l) => l.id === lessonId)) {
      bot.lessons = bot.lessons.filter((l) => l.id !== lessonId);
      store.bots.put(bot);
    }
  };

  route('POST', '/api/chats/:id/messages/:index/rating', async ({ params, body }) => {
    const chat = getChat(params.id);
    const index = Number(params.index);
    const message = chat.messages[index];
    if (message?.role !== 'assistant') throw new HttpError(400, 'Only answers can be rated');
    const value = Number(body?.value);
    dropLesson(chat, message.rating?.lessonId);
    if (value !== 1 && value !== -1) {
      delete message.rating;
      store.chats.put(chat);
      return { rating: null };
    }
    message.rating = { value, comment: str(body?.comment).trim().slice(0, 2000) || undefined, ratedAt: now() };
    store.chats.put(chat);
    // A thumbs rating counts as a 5 or a 1 on the outcome of the response it ends.
    const outcomeId = outcomeIdFor(chat.messages, index);
    if (outcomeId) runner.outcomes?.amend(outcomeId, { rating: value > 0 ? 5 : 1 });
    const wait = body?.wait === true;
    const job = learn(chat, index).catch((err) => console.warn(`Couldn't learn from a rating: ${err.message}`));
    if (wait) await job;
    return { rating: message.rating };
  });

  route('GET', '/api/bots/:id/lessons', ({ params }) => (store.bots.get(params.id) ?? fail(404, 'Bot not found')).lessons ?? []);
  route('DELETE', '/api/bots/:id/lessons/:lessonId', ({ params }) => {
    const bot = store.bots.get(params.id) ?? fail(404, 'Bot not found');
    bot.lessons = (bot.lessons ?? []).filter((l) => l.id !== params.lessonId);
    store.bots.put(bot);
    return bot.lessons;
  });

  // ---- Artifact workspace -----------------------------------------------------------

  const getArtifact = (id: string) => store.artifacts.get(id) ?? fail(404, 'Artifact not found');
  const artifactView = (a: Artifact) => ({ ...a, chatTitle: store.chats.get(a.chatId)?.title, running: runner.isRunning(a.chatId) });
  const editable = (a: Artifact) => {
    if (runner.isRunning(a.chatId)) throw new HttpError(409, 'The bot is working on it; wait for it to finish');
  };

  // A new artifact starts its own chat, which is where you work on it with the bot.
  route('POST', '/api/artifacts', ({ body }) => {
    const type = str(body?.type) as ArtifactType;
    if (!TEXT_ARTIFACT_TYPES.includes(type)) throw new HttpError(400, 'Choose a document, presentation, web page, component, code, graphic or diagram');
    const title = str(body?.title).trim().slice(0, 200) || 'Untitled';
    const project = body?.projectId ? store.projects.get(str(body.projectId)) : undefined;
    const chat = store.chats.put(deps.newChat({ title, botId: str(body?.botId) || DEFAULT_BOT_ID, projectId: project?.id }));
    const artifact: Artifact = {
      id: newId(),
      chatId: chat.id,
      projectId: project?.id,
      title,
      type,
      language: type === 'code' ? str(body?.language) || undefined : undefined,
      versions: [{ content: str(body?.content), title, author: 'user', note: 'Created', createdAt: now() }],
      comments: [],
      createdAt: now(),
      updatedAt: now(),
    };
    return artifactView(store.artifacts.put(artifact));
  });
  route('PATCH', '/api/artifacts/:id', ({ params, body }) => {
    const a = getArtifact(params.id);
    editable(a);
    if (!TEXT_ARTIFACT_TYPES.includes(a.type) && typeof body?.content === 'string') throw new HttpError(400, `A ${a.type} can't be edited as text`);
    const title = typeof body?.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 200) : undefined;
    const content = typeof body?.content === 'string' ? body.content : (a.versions.at(-1)?.content ?? '');
    userEdit(a, content, title);
    store.artifacts.put(a);
    deps.edits?.artifactEdited(a);
    return artifactView(a);
  });
  route('POST', '/api/artifacts/:id/comments', ({ params, body }) => {
    const a = getArtifact(params.id);
    const text = str(body?.text).trim();
    if (!text) throw new HttpError(400, 'Comment is empty');
    (a.comments ??= []).push(newComment(str(body?.quote), text, 'user'));
    return artifactView(store.artifacts.put(a));
  });
  route('PATCH', '/api/artifacts/:id/comments/:commentId', ({ params, body }) => {
    const a = getArtifact(params.id);
    const c = a.comments?.find((x) => x.id === params.commentId) ?? fail(404, 'Comment not found');
    if (typeof body?.reply === 'string' && body.reply.trim()) c.replies.push({ author: 'user', text: body.reply.trim(), createdAt: now() });
    if (typeof body?.resolved === 'boolean') c.resolved = body.resolved;
    return artifactView(store.artifacts.put(a));
  });
  route('DELETE', '/api/artifacts/:id/comments/:commentId', ({ params }) => {
    const a = getArtifact(params.id);
    a.comments = (a.comments ?? []).filter((c) => c.id !== params.commentId);
    return artifactView(store.artifacts.put(a));
  });
  route('POST', '/api/artifacts/:id/versions/:index/restore', ({ params }) => {
    const a = getArtifact(params.id);
    editable(a);
    const v = a.versions[Number(params.index)] ?? fail(404, 'Version not found');
    a.versions.push({ content: v.content, title: v.title ?? a.title, author: 'user', note: `Restored version ${Number(params.index) + 1}`, createdAt: now() });
    if (v.title) a.title = v.title;
    a.updatedAt = now();
    return artifactView(store.artifacts.put(a));
  });

  // ---- Scheduled tasks -----------------------------------------------------------

  const execute = async (task: ScheduledTask) => {
    const run: TaskRun = { id: newId(), startedAt: now(), status: 'running', seen: false };
    task.runs.push(run);
    store.tasks.put(task);
    const workflow = task.workflowId ? store.workflows.get(task.workflowId) : undefined;
    if (workflow) {
      const result = await deps.workflows.run(workflow, task.prompt, 'schedule').catch((err: Error) => ({ status: 'error' as const, error: err.message, output: '', id: undefined }));
      const fresh = store.tasks.get(task.id);
      const r = fresh?.runs.find((x) => x.id === run.id);
      if (fresh && r) {
        Object.assign(r, { finishedAt: now(), status: result.status === 'error' ? 'error' : 'ok', error: result.error, preview: (result.output ?? '').slice(0, 300), workflowRunId: result.id });
        store.tasks.put(fresh);
      }
      return;
    }
    let chat = task.reuseChat && task.chatId ? store.chats.get(task.chatId) : undefined;
    if (!chat) {
      const stamp = new Date().toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      chat = store.chats.put(
        deps.newChat({
          title: task.reuseChat ? task.name : `${task.name} · ${stamp}`,
          botId: task.botId,
          projectId: task.projectId && store.projects.get(task.projectId) ? task.projectId : undefined,
          model: task.model,
          taskId: task.id,
        }),
      );
      if (task.reuseChat) task.chatId = chat.id;
    }
    const errors: string[] = [];
    const emit = (e: StreamEvent) => e.type === 'error' && errors.push(e.message);
    const finish = (fields: Partial<TaskRun>) => {
      const fresh = store.tasks.get(task.id);
      const r = fresh?.runs.find((x) => x.id === run.id);
      if (!fresh || !r) return;
      Object.assign(r, { finishedAt: now(), chatId: chat!.id, ...fields });
      if (task.reuseChat) fresh.chatId = chat!.id;
      store.tasks.put(fresh);
    };
    try {
      if (runner.isRunning(chat.id)) throw new Error('The previous run is still going');
      const prompt = `${task.prompt}\n\n(This is the scheduled task "${task.name}", running automatically on ${new Date().toString()}.)`;
      await runner.run(chat.id, { kind: 'message', content: prompt, attachments: [] }, emit, new AbortController().signal, {
        headless: { autoApprove: task.autoApprove },
        taskId: task.id,
      });
      const answer = messageText(store.chats.get(chat.id)?.messages.findLast((m) => m.role === 'assistant' && messageText(m).trim()));
      finish(errors.length ? { status: 'error', error: errors.join('\n'), preview: answer.slice(0, 300) } : { status: 'ok', preview: answer.slice(0, 300) });
    } catch (err: any) {
      finish({ status: 'error', error: err.message });
    }
  };
  const scheduler = new Scheduler(store, execute);

  const taskView = (t: ScheduledTask) => ({ ...t, running: scheduler.isRunning(t.id), description: safeDescribe(t.schedule) });
  const applyTask = (task: ScheduledTask, body: any) => {
    if (typeof body?.name === 'string' && body.name.trim()) task.name = body.name.trim().slice(0, 120);
    if (typeof body?.prompt === 'string') task.prompt = body.prompt;
    if (body?.schedule) {
      const s = body.schedule as TaskSchedule;
      const schedule: TaskSchedule = {
        kind: s.kind,
        at: typeof s.at === 'string' ? s.at : undefined,
        everyMinutes: s.everyMinutes !== undefined ? Math.round(Number(s.everyMinutes)) : undefined,
        time: typeof s.time === 'string' ? s.time : undefined,
        days: Array.isArray(s.days) ? [...new Set(s.days.map(Number))].sort() : undefined,
        cron: typeof s.cron === 'string' ? s.cron.trim() : undefined,
      };
      try {
        validateSchedule(schedule);
      } catch (err: any) {
        throw new HttpError(400, err.message);
      }
      task.schedule = schedule;
    }
    if (body?.botId !== undefined) task.botId = str(body.botId) || undefined;
    if (body?.projectId !== undefined) task.projectId = str(body.projectId) || undefined;
    if (body?.model !== undefined) task.model = str(body.model).trim() || undefined;
    if (typeof body?.enabled === 'boolean') task.enabled = body.enabled;
    if (typeof body?.autoApprove === 'boolean') task.autoApprove = body.autoApprove;
    if (typeof body?.reuseChat === 'boolean') task.reuseChat = body.reuseChat;
    if (body?.workflowId !== undefined) {
      const id = str(body.workflowId);
      if (id && !store.workflows.get(id)) throw new HttpError(400, 'That workflow no longer exists');
      task.workflowId = id || undefined;
    }
    // A workflow's input may be empty; a prompt for a bot may not.
    if (!task.name || (!task.workflowId && !task.prompt?.trim())) throw new HttpError(400, 'A task needs a name and a prompt');
    if (!task.schedule) throw new HttpError(400, 'A task needs a schedule');
    task.updatedAt = now();
    return taskView(store.tasks.put(scheduler.plan(task)));
  };

  route('GET', '/api/tasks', () =>
    store.tasks
      .all()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(taskView),
  );
  route('POST', '/api/tasks', ({ body }) =>
    applyTask({ id: newId(), name: '', prompt: '', enabled: true, autoApprove: false, reuseChat: false, runs: [], createdAt: now() } as unknown as ScheduledTask, body),
  );
  route('PATCH', '/api/tasks/:id', ({ params, body }) => applyTask(getTask(params.id), body));
  route('DELETE', '/api/tasks/:id', ({ params }) => {
    getTask(params.id);
    store.tasks.delete(params.id);
    return { ok: true };
  });
  route('POST', '/api/tasks/:id/run', ({ params }) => {
    const task = getTask(params.id);
    if (scheduler.isRunning(task.id)) throw new HttpError(409, 'This task is already running');
    deps.client(); // fail fast without a provider
    void scheduler.runNow(task);
    return taskView(task);
  });
  route('POST', '/api/tasks/seen', () => {
    for (const t of store.tasks.all()) {
      if (t.runs.some((r) => !r.seen && r.status !== 'running')) {
        for (const r of t.runs) if (r.status !== 'running') r.seen = true;
        store.tasks.put(t);
      }
    }
    return { ok: true };
  });

  // ---- Media and voice -----------------------------------------------------------

  route('GET', '/api/media/models', async () => ({ models: await media.models(), available: media.available() }));
  route('POST', '/api/tts', async ({ body, res }) => {
    const text = str(body?.text).trim();
    if (!text) throw new HttpError(400, 'Nothing to read');
    if (!store.settings.media.speechModel) throw new HttpError(400, 'No speech model is set up');
    const { bytes, mimeType } = await media.speech(text.slice(0, 4000), str(body?.voice) || undefined);
    res.writeHead(200, { 'content-type': mimeType, 'content-length': bytes.length, 'cache-control': 'no-store' });
    res.end(bytes);
    return STREAMED;
  });
  route('POST', '/api/transcribe', async ({ body }) => {
    const m = /^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/s.exec(str(body?.audio));
    if (!m) throw new HttpError(400, 'Send the recording as a base64 data URL');
    const language = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(str(body?.language)) ? str(body.language) : undefined;
    return { text: await media.transcribe(Buffer.from(m[2], 'base64'), m[1], language) };
  });

  return { scheduler };
}

function safeDescribe(s: TaskSchedule): string {
  try {
    return describeSchedule(s);
  } catch {
    return 'Invalid schedule';
  }
}

/** Validates a media settings update. */
export function mediaUpdate(input: unknown, current: MediaSettings): MediaSettings {
  const next = { ...current };
  if (!input || typeof input !== 'object') return next;
  for (const key of Object.keys(current) as (keyof MediaSettings)[]) {
    const v = (input as Record<string, unknown>)[key];
    if (typeof v === 'string') next[key] = v.trim();
  }
  return next;
}
