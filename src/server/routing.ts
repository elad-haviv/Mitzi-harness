// "Auto" model: each message goes to a fast, cheap model or a strong one, depending on what it asks for.
// The choice is made locally from the message and the chat's state, so it costs nothing and adds no delay.
import type { ContentPart } from '../openrouter.js';
import { AUTO_MODEL, type ModelInfo, type RouteChoice, type RoutingSettings } from '../shared/types.js';

export { AUTO_MODEL };

export interface RouteInput {
  /** The user's message, attachments included. */
  content: string | ContentPart[];
  /** Work mode, an active goal or a /plan request: multi-step work. */
  working: boolean;
  planning: boolean;
  /** How the previous answer in the chat was routed. */
  previous?: RouteChoice['tier'];
}

export interface RouteModels {
  fast: string;
  strong: string;
}

/** The two models Auto picks from: the routing settings, else the fast-tasks and default models. */
export function routeModels(routing: RoutingSettings | undefined, config: { model: string; smallModel?: string }): RouteModels {
  const strong = routing?.strong || (config.model === AUTO_MODEL ? '' : config.model);
  const fast = routing?.fast || config.smallModel || strong;
  return { fast, strong: strong || fast };
}

/** The model a chat uses outside a turn (context size, compaction…): Auto counts as its strong model. */
export function concreteModel(model: string, models: RouteModels): string {
  return model === AUTO_MODEL ? models.strong : model;
}

// Requests that deserve the strong model, in English and Hebrew.
const DEMANDING =
  /\b(analy[sz]e|analysis|debug|refactor|architect\w*|design|prove|proof|derive|algorithm|optimi[sz]e|strateg\w*|trade-?offs?|compare|evaluate|critique|review|step[- ]by[- ]step|in detail|thorough\w*|implement|research|business plan|essay|report|contract|legal|diagnos\w*|calculate|math\w*|equation)\b|(write|build|create|make)\s+(me\s+)?(a|an|the)\s+(\w+\s+)?(program|function|script|app|website|class|component|query|essay|report|story|plan|proposal|presentation)|נתח|ניתוח|תכנן|תכנית|השווה|הוכח|אסטרטגי|באגים|דבג|כתוב (קוד|תוכנית|מאמר|דוח)|מפורט/i;
const SMALL_TALK = /^(hi|hey|hello|thanks?|thank you|ok(ay)?|cool|great|nice|yes|no|sure|good (morning|night)|שלום|היי|תודה|אוקיי|כן|לא|בוקר טוב|לילה טוב)\b/i;
const FOLLOW_UP = /^(continue|go on|keep going|more|again|fix (it|that|this)|try again|and\??|why\??|תמשיך|המשך|עוד|תתקן)\b/i;

/** Picks the tier for one message, with a short reason the user can see. */
export function chooseRoute(input: RouteInput): { tier: RouteChoice['tier']; reason: string } {
  if (input.planning) return { tier: 'strong', reason: 'Planning' };
  if (input.working) return { tier: 'strong', reason: 'Multi-step work' };
  const parts = typeof input.content === 'string' ? [{ type: 'text' as const, text: input.content }] : input.content;
  const all = parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
  // Attachments arrive wrapped in <attachment> tags; the message itself is what's around them.
  const attached = [...all.matchAll(/<attachment[^>]*>([\s\S]*?)<\/attachment>/g)].reduce((n, m) => n + m[1].length, 0);
  const text = all.replace(/<attachment[\s\S]*?<\/attachment>/g, ' ').trim();
  if (attached > 6000) return { tier: 'strong', reason: 'Long document attached' };
  if (/```|^\s{4}\S|\b(function|def|class|const|import|SELECT|#include)\b.*[({;=]/m.test(text)) return { tier: 'strong', reason: 'Code in the message' };
  if (DEMANDING.test(text)) return { tier: 'strong', reason: 'Asks for in-depth work' };
  if (text.length > 700) return { tier: 'strong', reason: 'Long, detailed message' };
  if (input.previous === 'strong' && text.length < 80 && FOLLOW_UP.test(text)) return { tier: 'strong', reason: 'Follow-up to in-depth work' };
  if ((text.match(/\?/g) ?? []).length >= 3) return { tier: 'strong', reason: 'Several questions at once' };
  if (SMALL_TALK.test(text) && text.length < 60) return { tier: 'fast', reason: 'Small talk' };
  return { tier: 'fast', reason: text.length < 200 ? 'Quick question' : 'Everyday request' };
}

/** The route for a message, as a concrete model: images go to a model that can see them. */
export function route(input: RouteInput, models: RouteModels, catalog: ModelInfo[]): RouteChoice {
  let { tier, reason } = chooseRoute(input);
  const images = Array.isArray(input.content) && input.content.some((p) => p.type === 'image_url');
  const info = (id: string) => catalog.find((m) => m.id === id);
  if (images && tier === 'fast' && info(models.fast)?.vision === false && info(models.strong)?.vision !== false) {
    tier = 'strong';
    reason = 'Has images';
  }
  return { tier, reason, model: models[tier] };
}
