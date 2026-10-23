// The interface language. Strings are looked up by their English text; {0}, {1}… are filled from the arguments.
// The language is read once at startup (switching reloads the page), so labels in module-level tables work too.
import { he } from './locales/he';

export const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'he', name: 'עברית' },
] as const;
export type Lang = (typeof LANGUAGES)[number]['code'];

const KEY = 'mitzi.lang';

function initial(): Lang {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'en' || saved === 'he') return saved;
  } catch {
    // Storage blocked: fall back to the browser's language.
  }
  return typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('he') ? 'he' : 'en';
}

export const lang: Lang = initial();
export const rtl = lang === 'he';
const dict: Record<string, string> | undefined = lang === 'he' ? he : undefined;

/** The text in the interface language. */
export function tr(text: string, ...args: unknown[]): string {
  const s = dict?.[text] ?? text;
  return args.length ? s.replace(/\{(\d+)\}/g, (_, i: string) => String(args[Number(i)] ?? '')) : s;
}

/** "1 chat" / "3 chats": `one` and `other` are English texts with {0} for the number. */
export function plural(n: number, one: string, other: string): string {
  return tr(n === 1 ? one : other, n);
}

/** For dates and numbers: the interface language's locale. */
export const locale: string | undefined = lang === 'he' ? 'he-IL' : undefined;

export function setLanguage(next: Lang): void {
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // Without storage the choice can't be kept.
  }
  location.reload();
}

if (typeof document !== 'undefined') {
  document.documentElement.lang = lang;
  document.documentElement.dir = rtl ? 'rtl' : 'ltr';
}
