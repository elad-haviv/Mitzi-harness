// Routes for branching, ratings, documents, scheduled tasks, and media and voice.
import type { Config } from '../config.js';
import type { RoutingClient } from '../providers.js';
import { Chat, ChatMessage, DEFAULT_BOT_ID, Doc, Lesson, MediaSettings, ScheduledTask, StreamEvent, TaskRun, TaskSchedule } from '../shared/types.js';
import { newComment, snapshot, summarizeDoc } from './docs.js';
import { MEDIA_OPTIONS, MediaService } from './media.js';
import type { MemoryService } from './memory/index.js';
import { ChatRunner, summarizeChat } from './runner.js';
import { describeSchedule, Scheduler, validateSchedule } from './scheduler.js';
import { newId, now, Store } from './store.js';
import { fail, HttpError, Route, STREAMED, str } from './util.js';

export interface FeatureDeps {
  store: Store;
  runner: ChatRunner;
  client: () => RoutingClient;
  config: () => Config;
  memory: MemoryService;
  media: MediaService;
  /** Creates an empty chat (the same as POST /api/chats). */
  newChat: (fields: Partial<Chat>) => Chat;
}

const MAX_LESSONS = 30;

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
  const getDoc = (id: string) => store.docs.get(id) ?? fail(404, 'Document not found');
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
    const question = messageText(chat.messages.slice(0, index).findLast((m) => m.role === 'user')).slice(0, 4000);
    const answer = chat.messages
      .slice(chat.messages.slice(0, index).findLastIndex((m) => m.role === 'user') + 1, index + 1)
      .filter((m) => m.role === 'assistant')
      .map(messageText)
      .join('\n')
      .slice(0, 6000);
    const prompt = LESSON_PROMPT.replace('{question}', question)
      .replace('{answer}', answer)
      .replace('{rating}', rating.value > 0 ? 'liked (thumbs up)' : 'disliked (thumbs down)')
      .replace('{comment}', rating.comment ? `User's comment: ${rating.comment}` : 'No comment.');
    const config = deps.config();
    const res = await deps.client().chat({ model: config.smallModel ?? chat.model, messages: [{ role: 'user', content: prompt }], maxTokens: 200 });
    const text = res.content.trim().replace(/^["'\s]+|["'\s]+$/g, '');
    // The rating may have changed while the lesson was being written.
    if (!text || /^NONE\b/i.test(text) || chat.messages[index]?.rating !== rating) return;
    const lesson: Lesson = { id: newId(), text: text.slice(0, 400), value: rating.value, chatId: chat.id, createdAt: now() };
    const fresh = store.bots.get(bot.id);
    if (!fresh) return;
    fresh.lessons = [...(fresh.lessons ?? []), lesson].slice(-MAX_LESSONS);
    store.bots.put(fresh);
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

  // ---- Documents ---------------------------------------------------------------

  const createDoc = (title: string, content: string, botId?: string): Doc => {
    const id = newId();
    const chat = deps.newChat({ title: `Doc: ${title}`.slice(0, 120), botId: botId || DEFAULT_BOT_ID, docId: id });
    store.chats.put(chat);
    const doc: Doc = { id, title, content, comments: [], versions: [], chatId: chat.id, createdAt: now(), updatedAt: now() };
    snapshot(doc, 'user', 'Created');
    return store.docs.put(doc);
  };
  const docView = (doc: Doc) => ({ ...doc, running: runner.isRunning(doc.chatId) });

  route('GET', '/api/docs', () =>
    store.docs
      .all()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(summarizeDoc),
  );
  route('POST', '/api/docs', ({ body }) => {
    const fromArtifact = body?.artifactId ? store.artifacts.get(str(body.artifactId)) : undefined;
    if (body?.artifactId && !fromArtifact) throw new HttpError(404, 'Artifact not found');
    const title = str(body?.title).trim() || fromArtifact?.title || 'Untitled document';
    const content = fromArtifact ? (fromArtifact.versions.at(-1)?.content ?? '') : str(body?.content);
    const botId = str(body?.botId) || (fromArtifact ? store.chats.get(fromArtifact.chatId)?.botId : undefined);
    return docView(createDoc(title.slice(0, 200), content, botId));
  });
  route('GET', '/api/docs/:id', ({ params }) => docView(getDoc(params.id)));
  route('PATCH', '/api/docs/:id', ({ params, body }) => {
    const doc = getDoc(params.id);
    if (runner.isRunning(doc.chatId) && typeof body?.content === 'string') throw new HttpError(409, 'The bot is editing the document; wait for it to finish');
    if (typeof body?.title === 'string' && body.title.trim()) doc.title = body.title.trim().slice(0, 200);
    if (typeof body?.content === 'string') doc.content = body.content;
    doc.updatedAt = now();
    snapshot(doc, 'user');
    return docView(store.docs.put(doc));
  });
  route('DELETE', '/api/docs/:id', ({ params }) => {
    const doc = getDoc(params.id);
    runner.stop(doc.chatId);
    store.chats.delete(doc.chatId);
    store.docs.delete(doc.id);
    return { ok: true };
  });
  route('POST', '/api/docs/:id/comments', ({ params, body }) => {
    const doc = getDoc(params.id);
    const text = str(body?.text).trim();
    if (!text) throw new HttpError(400, 'Comment is empty');
    doc.comments.push(newComment(str(body?.quote), text, 'user'));
    return docView(store.docs.put(doc));
  });
  route('PATCH', '/api/docs/:id/comments/:commentId', ({ params, body }) => {
    const doc = getDoc(params.id);
    const c = doc.comments.find((x) => x.id === params.commentId) ?? fail(404, 'Comment not found');
    if (typeof body?.reply === 'string' && body.reply.trim()) c.replies.push({ author: 'user', text: body.reply.trim(), createdAt: now() });
    if (typeof body?.resolved === 'boolean') c.resolved = body.resolved;
    return docView(store.docs.put(doc));
  });
  route('DELETE', '/api/docs/:id/comments/:commentId', ({ params }) => {
    const doc = getDoc(params.id);
    doc.comments = doc.comments.filter((c) => c.id !== params.commentId);
    return docView(store.docs.put(doc));
  });
  route('POST', '/api/docs/:id/versions/:versionId/restore', ({ params }) => {
    const doc = getDoc(params.id);
    if (runner.isRunning(doc.chatId)) throw new HttpError(409, 'Wait for the bot to finish first');
    const v = doc.versions.find((x) => x.id === params.versionId) ?? fail(404, 'Version not found');
    doc.content = v.content;
    doc.title = v.title;
    doc.updatedAt = now();
    doc.versions.push({ id: newId(), title: v.title, content: v.content, author: 'user', note: `Restored version from ${new Date(v.createdAt).toLocaleString()}`, createdAt: now() });
    return docView(store.docs.put(doc));
  });

  // ---- Scheduled tasks -----------------------------------------------------------

  const execute = async (task: ScheduledTask) => {
    const run: TaskRun = { id: newId(), startedAt: now(), status: 'running', seen: false };
    task.runs.push(run);
    store.tasks.put(task);
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
    if (typeof body?.prompt === 'string' && body.prompt.trim()) task.prompt = body.prompt;
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
    if (!task.name || !task.prompt?.trim()) throw new HttpError(400, 'A task needs a name and a prompt');
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

  route('GET', '/api/media/options', () => ({ options: MEDIA_OPTIONS, available: media.available() }));
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
    return { text: await media.transcribe(Buffer.from(m[2], 'base64'), m[1]) };
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
