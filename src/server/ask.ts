// Asking the user: the bot pauses to put one or a few questions to the user, with choices to click or a free
// answer, and continues with what they said.
import type { AskQuestion } from '../shared/types.js';
import { Tool, ToolError } from '../tools/types.js';

/** The user's answers, one list per question (the options picked, or their own words); null when they skipped. */
export type AskAnswers = string[][] | null;

export type Asker = (questions: AskQuestion[], callId: string | undefined, signal?: AbortSignal) => Promise<AskAnswers>;

const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 6;

/** Checks and tidies the questions a model wrote. */
export function cleanQuestions(raw: unknown): AskQuestion[] {
  if (!Array.isArray(raw) || !raw.length) throw new ToolError('Give at least one question');
  if (raw.length > MAX_QUESTIONS) throw new ToolError(`Ask at most ${MAX_QUESTIONS} questions at a time`);
  return raw.map((q: any, i) => {
    const question = typeof q?.question === 'string' ? q.question.trim() : '';
    if (!question) throw new ToolError(`Question ${i + 1} has no text`);
    const options = (Array.isArray(q.options) ? q.options : [])
      .map((o: any) => (typeof o === 'string' ? { label: o } : o))
      .filter((o: any) => typeof o?.label === 'string' && o.label.trim())
      .map((o: any) => ({ label: o.label.trim().slice(0, 80), ...(typeof o.description === 'string' && o.description.trim() ? { description: o.description.trim().slice(0, 200) } : {}) }));
    if (options.length > MAX_OPTIONS) throw new ToolError(`Question ${i + 1}: give at most ${MAX_OPTIONS} options`);
    return {
      question: question.slice(0, 500),
      ...(typeof q.header === 'string' && q.header.trim() ? { header: q.header.trim().slice(0, 24) } : {}),
      ...(options.length ? { options } : {}),
      ...(q.multiSelect === true && options.length > 1 ? { multiSelect: true } : {}),
    };
  });
}

/** The answers as the tool result the model reads. */
export function formatAnswers(questions: AskQuestion[], answers: AskAnswers): string {
  if (!answers) return 'The user skipped the question(s) without answering. Use your best judgment, and say what you assumed.';
  return questions.map((q, i) => `${q.question}\n→ ${answers[i]?.length ? answers[i].join(', ') : '(no answer)'}`).join('\n\n');
}

export function askTool(ask: Asker): Tool<{ questions: unknown }> {
  return {
    name: 'AskUser',
    // Asking changes nothing, so it never needs approval.
    kind: 'read',
    description:
      'Ask the user to decide something or fill in something you need, and wait for the answer. Each question can offer ' +
      'options to click (2–6 short labels, with an optional description; the user can always answer in their own words ' +
      'instead), or none for an open answer. Use multiSelect when several options can apply. Ask only when the answer ' +
      'really changes what you do and you can’t reasonably assume it; group related questions into one call (up to 4). ' +
      'Put a recommended option first and add "(recommended)" to its label.',
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: 'The full question, ending with a question mark' },
              header: { type: 'string', description: 'A very short label for it (a word or two)' },
              options: {
                type: 'array',
                items: { type: 'object', properties: { label: { type: 'string' }, description: { type: 'string' } }, required: ['label'] },
              },
              multiSelect: { type: 'boolean' },
            },
            required: ['question'],
          },
        },
      },
      required: ['questions'],
    },
    summarize: (a) => {
      const qs = Array.isArray(a.questions) ? (a.questions as AskQuestion[]) : [];
      return qs.length === 1 ? String(qs[0]?.question ?? '') : `${qs.length} questions`;
    },
    async run(a, ctx) {
      const questions = cleanQuestions(a.questions);
      return formatAnswers(questions, await ask(questions, ctx.callId, ctx.signal));
    },
  };
}
