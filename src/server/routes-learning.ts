// Routes for what Mitzi learns from experience: the outcome ledger and distilling it into lessons.
import type { ProjectFactKind, TaskOutcome } from '../shared/types.js';
import type { OutcomeLearner, OutcomeLog } from './outcomes.js';
import type { ProjectKnowledge } from './project-knowledge.js';
import type { LessonHygiene } from './lesson-hygiene.js';
import { learningMetrics } from './metrics.js';
import type { Store } from './store.js';
import { fail, HttpError, Route, str } from './util.js';

export interface LearningDeps {
  store: Store;
  outcomes: OutcomeLog;
  learner: OutcomeLearner;
  projectKnowledge: ProjectKnowledge;
  hygiene: LessonHygiene;
}

export function registerLearningRoutes(route: Route, deps: LearningDeps): void {
  const { store, outcomes, learner, projectKnowledge, hygiene } = deps;
  const getBot = (id: string) => store.bots.get(id) ?? fail(404, 'Bot not found');
  const getProject = (id: string) => store.projects.get(id) ?? fail(404, 'Project not found');

  /** Recorded outcomes, newest first, filtered by bot, project or chat. */
  route('GET', '/api/outcomes', ({ query }) => {
    const limit = Math.min(500, Math.max(1, Number(query.get('limit')) || 100));
    const filter = (o: TaskOutcome) =>
      (!query.get('botId') || o.botId === query.get('botId')) && (!query.get('projectId') || o.projectId === query.get('projectId')) && (!query.get('chatId') || o.chatId === query.get('chatId'));
    return outcomes.all(filter).reverse().slice(0, limit);
  });

  /** Learning metrics from the ledger: rates overall, week by week and per model, and lessons in effect. */
  route('GET', '/api/insights/outcomes', ({ query }) => {
    const botId = query.get('botId');
    const days = Math.min(365, Math.max(1, Number(query.get('days')) || 90));
    const since = Date.now() - days * 86_400_000;
    const bots = store.bots.all().filter((b) => !botId || b.id === botId);
    return learningMetrics(
      outcomes.all((o) => o.ts >= since && (!botId || o.botId === botId)),
      bots.flatMap((b) => b.lessons ?? []),
      bots.flatMap((b) => b.retiredLessons ?? []),
    );
  });

  /** Distills lessons from a bot's outcomes now instead of waiting for the background job. */
  route('POST', '/api/bots/:id/learn', async ({ params }) => {
    const bot = store.bots.get(params.id) ?? fail(404, 'Bot not found');
    const lessons = await learner.learn(bot.id);
    return { lessons, pending: learner.pending(bot.id).length };
  });

  // ---- Lesson hygiene ----------------------------------------------------------------------

  /** How each lesson is doing (tasks with it vs without), and the lessons retired so far. */
  route('GET', '/api/bots/:id/lessons/health', ({ params }) => {
    const bot = getBot(params.id);
    return { scores: hygiene.scores(bot), retired: [...(bot.retiredLessons ?? [])].reverse() };
  });
  route('POST', '/api/bots/:id/lessons/tidy', async ({ params }) => {
    const bot = getBot(params.id);
    const result = await hygiene.tidy(bot.id, true);
    return { ...result, lessons: store.bots.get(bot.id)?.lessons ?? [] };
  });
  route('POST', '/api/bots/:id/lessons/:lessonId/restore', ({ params }) => hygiene.restore(getBot(params.id).id, params.lessonId)?.lessons ?? []);

  // ---- What Mitzi learned about a project's repository ------------------------------------

  route('GET', '/api/projects/:id/learned', ({ params }) => projectKnowledge.facts(getProject(params.id).id));
  route('POST', '/api/projects/:id/learned', ({ params, body }) => {
    const project = getProject(params.id);
    const text = str(body?.text).trim();
    if (!text) throw new HttpError(400, 'Say what to remember about this project');
    projectKnowledge.add(project.id, text, (str(body?.kind) || 'convention') as ProjectFactKind, 'user', 3);
    return projectKnowledge.facts(project.id);
  });
  route('DELETE', '/api/projects/:id/learned/:factId', ({ params }) => projectKnowledge.remove(getProject(params.id).id, params.factId));
  route('POST', '/api/projects/:id/learned/consolidate', async ({ params }) => {
    const project = getProject(params.id);
    await projectKnowledge.consolidate(project.id);
    return projectKnowledge.facts(project.id);
  });
  /** The learned facts as an addition to the folder's MITZI.md (or AGENTS.md / CLAUDE.md), for the user to accept. */
  route('GET', '/api/projects/:id/learned/instructions', ({ params }) => {
    const p = projectKnowledge.proposal(getProject(params.id).id) ?? fail(400, 'This project has no folder');
    return { path: p.path, exists: p.exists, current: p.current, content: p.content, added: p.added };
  });
  route('POST', '/api/projects/:id/learned/instructions', ({ params }) => projectKnowledge.applyProposal(getProject(params.id).id));
}
