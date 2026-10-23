// Routes for working on tasks: chat modes, plans, goals, /btw side questions, usage statistics and
// feedback loops (rate, redo with directions, learn).
import type { ServerResponse } from 'node:http';
import type { Config } from '../config.js';
import type { RoutingClient } from '../providers.js';
import { AUTO_MODEL, Chat, ChatMessage, DEFAULT_BOT_ID, FeedbackIteration, FeedbackLoop, Lesson, UsageEvent } from '../shared/types.js';
import { addSubgoal, BUILTIN_COMMANDS, DEFAULT_GOAL_TURNS, newGoal, parseBuiltin } from './agentic.js';
import { contextMessages } from './context.js';
import type { MemoryService } from './memory/index.js';
import { ChatRunner, GOAL_CONTROLS, summarizeChat } from './runner.js';
import { newId, now, Store } from './store.js';
import { dayOf, groupBy, total, UsageLog, withUsage } from './usage.js';
import { fail, HttpError, Route, STREAMED, str } from './util.js';

export interface WorkDeps {
  store: Store;
  runner: ChatRunner;
  client: () => RoutingClient;
  config: () => Config;
  memory: MemoryService;
  usage: UsageLog;
}

const MAX_LESSONS = 30;

function text(m: ChatMessage | undefined): string {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  return (m.content ?? []).map((p) => (p.type === 'text' ? p.text : '')).join(' ');
}

const LOOP_LESSON_PROMPT = `An AI assistant needed several attempts at a task before the user was happy. From the user's ratings \
and directions, distill one short, reusable lesson the assistant should apply to similar tasks in future, so it gets them right \
the first time. Generalize beyond this one task, but stay true to what the user said.

Reply with only the lesson as one or two sentences in the imperative ("When asked for…, …").

<task>
{task}
</task>

<attempts>
{attempts}
</attempts>`;

/** Writes the message that asks the bot to redo a task with the user's directions. */
export function redoMessage(it: Pick<FeedbackIteration, 'rating' | 'meant' | 'did' | 'directions'>): string {
  const parts = [`Your last attempt wasn't what I wanted (I rated it ${it.rating}/5). Please redo it.`];
  if (it.meant?.trim()) parts.push(`What I meant: ${it.meant.trim()}`);
  if (it.did?.trim()) parts.push(`What you did instead: ${it.did.trim()}`);
  if (it.directions?.trim()) parts.push(`Directions for the redo: ${it.directions.trim()}`);
  return parts.join('\n\n');
}

export function registerWorkRoutes(route: Route, deps: WorkDeps): void {
  const { store, runner, usage } = deps;
  const getChat = (id: string) => store.chats.get(id) ?? fail(404, 'Chat not found');

  route('GET', '/api/commands/builtin', () => BUILTIN_COMMANDS.map((c) => ({ ...c, source: 'mitzi' })));

  // ---- Plans -------------------------------------------------------------------------

  route('POST', '/api/chats/:id/plan', ({ params, body }) => {
    const chat = getChat(params.id);
    if (!chat.plan) throw new HttpError(400, 'There is no plan to approve');
    const action = str(body?.action);
    if (action === 'approve') {
      chat.plan.status = 'approved';
      chat.mode = 'work';
      chat.todos = chat.plan.steps.map((content) => ({ content, status: 'pending' as const }));
    } else if (action === 'revise') {
      chat.plan.status = 'revised';
    } else throw new HttpError(400, 'Approve or revise the plan');
    store.chats.put(chat);
    return { plan: chat.plan, todos: chat.todos ?? [], mode: chat.mode };
  });

  // ---- Goals: /goal pause|resume|clear|status, /subgoal ---------------------------------

  route('POST', '/api/chats/:id/command', ({ params, body }) => {
    const chat = getChat(params.id);
    const cmd = parseBuiltin(str(body?.text));
    if (!cmd || cmd.name === 'plan' || cmd.name === 'btw') throw new HttpError(400, 'Not a goal command');
    const goal = chat.goal;
    let message: string;
    let resume = false;
    if (cmd.name === 'goal') {
      const arg = cmd.args.toLowerCase();
      if (!GOAL_CONTROLS.has(arg)) throw new HttpError(400, 'Send a new goal as a message');
      if (arg === '' || arg === 'status') {
        message = goal ? `Goal (${goal.status}): ${goal.text}` : 'No goal set. Start one with /goal <what you want achieved>.';
      } else if (!goal) {
        throw new HttpError(400, 'There is no goal. Start one with /goal <what you want achieved>.');
      } else if (arg === 'pause' || arg === 'stop') {
        goal.status = 'paused';
        runner.stop(chat.id);
        message = 'Goal paused. Resume it with /goal resume.';
      } else if (arg === 'resume') {
        if (goal.status === 'complete') throw new HttpError(400, 'That goal is already complete');
        goal.status = 'active';
        // Out of turns: resuming grants another round.
        if (goal.turns >= goal.maxTurns) goal.maxTurns = goal.turns + DEFAULT_GOAL_TURNS;
        resume = !runner.isRunning(chat.id);
        message = 'Goal resumed.';
      } else {
        chat.goal = undefined;
        message = 'Goal cleared.';
      }
    } else {
      const arg = cmd.args;
      const done = /^done\s+(\S+)$/i.exec(arg);
      if (!arg) throw new HttpError(400, 'Say what the milestone is: /subgoal <milestone>');
      // A milestone without a goal starts one around it.
      const g = goal ?? (chat.goal = { ...newGoal(arg), status: 'paused' });
      if (done) {
        const sub = g.subgoals.find((s) => s.id === done[1]);
        if (!sub) throw new HttpError(404, `No milestone ${done[1]}`);
        sub.done = true;
        message = `Milestone ${sub.id} done.`;
      } else {
        const sub = addSubgoal(g, arg);
        message = goal ? `Milestone ${sub.id} added.` : `Milestone added to a new goal. Start working on it with /goal resume.`;
      }
    }
    store.chats.put(chat);
    return { goal: chat.goal ?? null, message, resume };
  });

  // ---- /btw: a side question about the chat, answered without tools and not saved ---------

  route('POST', '/api/chats/:id/btw', async ({ params, body, res }) => {
    const chat = getChat(params.id);
    const question = str(body?.question).trim();
    if (!question) throw new HttpError(400, 'Ask a question after /btw');
    const client = deps.client();
    send(res, 'start');
    try {
      const history = contextMessages(chat).filter((m) => m.role === 'user' || (m.role === 'assistant' && typeof m.content === 'string' && m.content));
      await withUsage({ kind: 'btw', chatId: chat.id, projectId: chat.projectId, botId: chat.botId ?? DEFAULT_BOT_ID }, () =>
        client.chat(
          {
            // A side question is quick: on Auto it goes to the fast model.
            model: chat.model === AUTO_MODEL ? runner.routeModels().fast : chat.model,
            messages: [
              { role: 'system', content: 'Answer a quick side question about this conversation. You have no tools; answer from what is already in the conversation and your own knowledge. Be brief.' },
              ...history.map((m) => (m.role === 'assistant' ? { role: 'assistant' as const, content: m.content } : m)),
              { role: 'user', content: `(Side question; answer briefly and don't continue the main task.) ${question}` },
            ],
            maxTokens: 1200,
          },
          { onText: (t) => send(res, 'text', t) },
        ),
      );
      send(res, 'done');
    } catch (err) {
      send(res, 'error', (err as Error).message);
    }
    res.end();
    return STREAMED;
  });

  // ---- Usage ---------------------------------------------------------------------------

  route('GET', '/api/usage', ({ query }) => {
    const days = Math.min(365, Math.max(1, Number(query.get('days')) || 30));
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    since.setDate(since.getDate() - (days - 1));
    const filter = (e: UsageEvent) =>
      (!query.get('projectId') || e.projectId === query.get('projectId')) && (!query.get('chatId') || e.chatId === query.get('chatId')) && (!query.get('botId') || e.botId === query.get('botId'));
    const events = usage.all(since.getTime()).filter(filter);
    const byDay = new Map(groupBy(events, (e) => dayOf(e.ts)).map((g) => [g.key, g.totals]));
    const daily = [];
    for (let d = new Date(since); d <= new Date(); d.setDate(d.getDate() + 1)) {
      const key = dayOf(d.getTime());
      daily.push({ day: key, ...(byDay.get(key) ?? { prompt: 0, completion: 0, cost: 0, requests: 0 }) });
    }
    const name = {
      chat: (id: string) => store.chats.get(id)?.title ?? 'Deleted chat',
      project: (id: string) => store.projects.get(id)?.name ?? 'Deleted project',
      bot: (id: string) => {
        const b = store.bots.get(id);
        return b ? `${b.emoji} ${b.name}` : 'Deleted bot';
      },
    };
    return {
      days,
      totals: total(events),
      allTime: total(usage.all().filter(filter)),
      daily,
      byModel: groupBy(events, (e) => e.model).slice(0, 12),
      byKind: groupBy(events, (e) => e.kind),
      byProject: groupBy(events, (e) => e.projectId ?? (e.chatId ? '' : undefined)).map((g) => ({ ...g, name: g.key ? name.project(g.key) : 'No project' })).slice(0, 12),
      byBot: groupBy(events, (e) => e.botId).map((g) => ({ ...g, name: name.bot(g.key) })).slice(0, 12),
      topChats: groupBy(events, (e) => e.chatId).map((g) => ({ ...g, name: name.chat(g.key) })).slice(0, 10),
      auto: autoReport(events),
    };
  });

  /** How Auto routed answers, and roughly what sending the easy ones to the fast model saved. */
  const autoReport = (events: UsageEvent[]) => {
    const routed = events.filter((e) => e.route && (e.kind === 'chat' || e.kind === 'task'));
    if (!routed.length) return undefined;
    const answers = (tier: 'fast' | 'strong') => routed.filter((e) => e.route === tier);
    const { strong } = runner.routeModels();
    // What the fast model's calls would have cost on the strong model, at its listed prices.
    const saved = answers('fast').reduce((n, e) => n + Math.max(0, (usage.priceOf(strong, e.prompt, e.completion) ?? e.cost) - e.cost), 0);
    return { fast: total(answers('fast')), strong: total(answers('strong')), saved };
  };

  // ---- Feedback loops ----------------------------------------------------------------------

  const getLoop = (id: string) => store.feedback.get(id) ?? fail(404, 'Feedback loop not found');

  /** Distills what the bot should do differently next time, once the user is happy. */
  const learnFromLoop = async (loop: FeedbackLoop, chat: Chat) => {
    const attempts = loop.iterations
      .map((it, i) => {
        const answer = text(chat.messages[it.messageIndex]).slice(0, 1500);
        const notes = [it.meant && `User meant: ${it.meant}`, it.did && `It did: ${it.did}`, it.directions && `Directions: ${it.directions}`].filter(Boolean).join('\n');
        return `Attempt ${i + 1} (rated ${it.rating}/5):\n${answer}${notes ? `\n${notes}` : ''}`;
      })
      .join('\n\n');
    const prompt = LOOP_LESSON_PROMPT.replace('{task}', loop.task.slice(0, 3000)).replace('{attempts}', attempts);
    const res = await withUsage({ kind: 'learning', chatId: chat.id, botId: loop.botId }, () =>
      deps.client().chat({ model: deps.config().smallModel ?? runner.modelOf(chat), messages: [{ role: 'user', content: prompt }], maxTokens: 250 }),
    );
    const lessonText = res.content.trim().replace(/^["'\s]+|["'\s]+$/g, '').slice(0, 500);
    if (!lessonText) return;
    const bot = store.bots.get(loop.botId);
    if (!bot) return;
    const lesson: Lesson = { id: newId(), text: lessonText, value: 1, chatId: chat.id, createdAt: now() };
    bot.lessons = [...(bot.lessons ?? []), lesson].slice(-MAX_LESSONS);
    store.bots.put(bot);
    loop.lesson = lessonText;
    loop.lessonId = lesson.id;
    store.feedback.put(loop);
    if (store.settings.memoryEnabled && bot.tools.memory) {
      await withUsage({ kind: 'memory', chatId: chat.id, botId: bot.id }, () =>
        deps.memory.backend().retain(deps.memory.bankFor(bot), {
          content: `Lesson learned from the user's feedback on "${loop.task.slice(0, 200)}": ${lessonText}`,
          context: 'Feedback loop',
          timestamp: now(),
          chatId: chat.id,
        }),
      ).catch(() => {});
    }
  };

  /**
   * Reviews an answer: rate it 1–5, optionally with what you meant, what it did and directions.
   * `redo` returns the message to send for the next attempt; a rating of 4+ without a redo accepts the result.
   */
  route('POST', '/api/chats/:id/messages/:index/review', async ({ params, body }) => {
    const chat = getChat(params.id);
    const index = Number(params.index);
    const answer = chat.messages[index];
    if (answer?.role !== 'assistant') throw new HttpError(400, 'Only answers can be reviewed');
    const rating = Math.round(Number(body?.rating));
    if (!(rating >= 1 && rating <= 5)) throw new HttpError(400, 'Rate from 1 to 5');
    const redo = body?.redo === true;
    const userIndex = chat.messages.slice(0, index).findLastIndex((m) => m.role === 'user' && m.auto !== 'redo' && m.auto !== 'goal');
    let loop = answer.feedbackLoopId ? store.feedback.get(answer.feedbackLoopId) : undefined;
    if (!loop) {
      loop = {
        id: newId(),
        chatId: chat.id,
        botId: runner.botFor(chat).id,
        projectId: chat.projectId,
        task: text(chat.messages[userIndex]).replace(/<attachment[\s\S]*?<\/attachment>/g, '').trim().slice(0, 4000) || '(task)',
        status: 'open',
        iterations: [],
        createdAt: now(),
        updatedAt: now(),
      };
      answer.feedbackLoopId = loop.id;
    }
    const iteration: FeedbackIteration = {
      messageIndex: index,
      rating,
      meant: str(body?.meant).trim().slice(0, 2000) || undefined,
      did: str(body?.did).trim().slice(0, 2000) || undefined,
      directions: str(body?.directions).trim().slice(0, 2000) || undefined,
      at: now(),
    };
    // Reviewing the same answer again replaces its review.
    loop.iterations = [...loop.iterations.filter((it) => it.messageIndex !== index), iteration].sort((a, b) => a.messageIndex - b.messageIndex);
    loop.updatedAt = now();
    const accept = !redo && rating >= 4;
    if (accept) {
      loop.status = 'accepted';
      loop.acceptedAt = now();
    } else if (loop.status === 'accepted' && redo) {
      loop.status = 'open';
      loop.acceptedAt = undefined;
    }
    store.feedback.put(loop);
    store.chats.put(chat);
    if (accept && loop.iterations.length > 1) {
      const job = learnFromLoop(loop, chat).catch((err) => console.warn(`Couldn't learn from feedback: ${err.message}`));
      if (body?.wait === true) await job;
    }
    return { loop: store.feedback.get(loop.id), redo: redo ? redoMessage(iteration) : undefined };
  });

  route('POST', '/api/feedback/:id/accept', async ({ params, body }) => {
    const loop = getLoop(params.id);
    const chat = getChat(loop.chatId);
    loop.status = 'accepted';
    loop.acceptedAt = now();
    loop.updatedAt = now();
    store.feedback.put(loop);
    const job = loop.iterations.length > 1 ? learnFromLoop(loop, chat).catch(() => {}) : Promise.resolve();
    if (body?.wait === true) await job;
    return store.feedback.get(loop.id);
  });

  route('GET', '/api/feedback', ({ query }) => {
    const botId = query.get('botId');
    return store.feedback
      .all()
      .filter((l) => !botId || l.botId === botId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((l) => ({ ...l, chatTitle: store.chats.get(l.chatId)?.title }));
  });
  route('DELETE', '/api/feedback/:id', ({ params }) => {
    const loop = getLoop(params.id);
    store.feedback.delete(loop.id);
    return { ok: true };
  });

  /** Learning curves: attempts needed and first-try ratings over time, per bot or overall. */
  route('GET', '/api/insights/learning', ({ query }) => {
    const botId = query.get('botId');
    const loops = store.feedback
      .all()
      .filter((l) => (!botId || l.botId === botId) && l.iterations.length)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const accepted = loops.filter((l) => l.status === 'accepted');
    const points = loops.map((l, i) => ({
      n: i + 1,
      id: l.id,
      at: l.createdAt,
      botId: l.botId,
      task: l.task.slice(0, 120),
      attempts: l.iterations.length,
      firstRating: l.iterations[0].rating,
      finalRating: l.iterations.at(-1)!.rating,
      accepted: l.status === 'accepted',
      lesson: l.lesson,
    }));
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    const half = Math.floor(points.length / 2);
    return {
      points,
      summary: {
        loops: loops.length,
        accepted: accepted.length,
        lessons: loops.filter((l) => l.lesson).length,
        avgAttempts: avg(accepted.map((l) => l.iterations.length)),
        avgFirstRating: avg(points.map((p) => p.firstRating)),
        // Earlier vs later half: is the bot getting it right sooner?
        earlyFirstRating: avg(points.slice(0, half).map((p) => p.firstRating)),
        lateFirstRating: avg(points.slice(half).map((p) => p.firstRating)),
      },
    };
  });
}

function send(res: ServerResponse, type: string, text?: string): void {
  if (!res.headersSent) res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
  if (!res.writableEnded) res.write(`data: ${JSON.stringify({ type, text })}\n\n`);
}
