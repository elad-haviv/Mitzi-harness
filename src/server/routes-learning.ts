// Routes for what Mitzi learns from experience: the outcome ledger and distilling it into lessons.
import type { TaskOutcome } from '../shared/types.js';
import type { OutcomeLearner, OutcomeLog } from './outcomes.js';
import type { Store } from './store.js';
import { fail, Route } from './util.js';

export interface LearningDeps {
  store: Store;
  outcomes: OutcomeLog;
  learner: OutcomeLearner;
}

export function registerLearningRoutes(route: Route, deps: LearningDeps): void {
  const { store, outcomes, learner } = deps;

  /** Recorded outcomes, newest first, filtered by bot, project or chat. */
  route('GET', '/api/outcomes', ({ query }) => {
    const limit = Math.min(500, Math.max(1, Number(query.get('limit')) || 100));
    const filter = (o: TaskOutcome) =>
      (!query.get('botId') || o.botId === query.get('botId')) && (!query.get('projectId') || o.projectId === query.get('projectId')) && (!query.get('chatId') || o.chatId === query.get('chatId'));
    return outcomes.all(filter).reverse().slice(0, limit);
  });

  /** Distills lessons from a bot's outcomes now instead of waiting for the background job. */
  route('POST', '/api/bots/:id/learn', async ({ params }) => {
    const bot = store.bots.get(params.id) ?? fail(404, 'Bot not found');
    const lessons = await learner.learn(bot.id);
    return { lessons, pending: learner.pending(bot.id).length };
  });
}
