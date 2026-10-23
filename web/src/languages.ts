// Spoken languages: the choices offered for voice, and a guess at a text's language from its script.

export const LANGUAGES: { code: string; name: string }[] = [
  { code: 'en-US', name: 'English' },
  { code: 'he-IL', name: 'עברית (Hebrew)' },
  { code: 'ar-SA', name: 'العربية (Arabic)' },
  { code: 'es-ES', name: 'Español' },
  { code: 'fr-FR', name: 'Français' },
  { code: 'de-DE', name: 'Deutsch' },
  { code: 'it-IT', name: 'Italiano' },
  { code: 'pt-BR', name: 'Português' },
  { code: 'nl-NL', name: 'Nederlands' },
  { code: 'ru-RU', name: 'Русский (Russian)' },
  { code: 'uk-UA', name: 'Українська (Ukrainian)' },
  { code: 'pl-PL', name: 'Polski' },
  { code: 'tr-TR', name: 'Türkçe' },
  { code: 'el-GR', name: 'Ελληνικά (Greek)' },
  { code: 'hi-IN', name: 'हिन्दी (Hindi)' },
  { code: 'ja-JP', name: '日本語 (Japanese)' },
  { code: 'ko-KR', name: '한국어 (Korean)' },
  { code: 'zh-CN', name: '中文 (Chinese)' },
  { code: 'th-TH', name: 'ไทย (Thai)' },
  { code: 'vi-VN', name: 'Tiếng Việt' },
  { code: 'id-ID', name: 'Bahasa Indonesia' },
  { code: 'sv-SE', name: 'Svenska' },
];

export function languageName(code: string): string {
  const base = code.split('-')[0];
  return LANGUAGES.find((l) => l.code === code)?.name ?? LANGUAGES.find((l) => l.code.startsWith(`${base}-`))?.name ?? code;
}

// Scripts that belong to one main language, in order of how specific they are.
const SCRIPTS: [RegExp, string][] = [
  [/[֐-׿]/g, 'he-IL'],
  [/[؀-ۿݐ-ݿ]/g, 'ar-SA'],
  [/[぀-ヿ]/g, 'ja-JP'],
  [/[가-힯ᄀ-ᇿ]/g, 'ko-KR'],
  [/[一-鿿]/g, 'zh-CN'],
  [/[฀-๿]/g, 'th-TH'],
  [/[ऀ-ॿ]/g, 'hi-IN'],
  [/[Ͱ-Ͽ]/g, 'el-GR'],
  [/[Ѐ-ӿ]/g, 'ru-RU'],
];

/**
 * The language a text is written in, when its script gives it away (Hebrew, Arabic, Japanese…).
 * Latin-script languages can't be told apart this way, so they return undefined.
 */
export function guessLanguage(text: string): string | undefined {
  const letters = text.replace(/[\s\d\p{P}\p{S}]/gu, '').length;
  if (!letters) return undefined;
  let best: [string, number] | undefined;
  for (const [re, code] of SCRIPTS) {
    const n = text.match(re)?.length ?? 0;
    if (n && (!best || n > best[1])) best = [code, n];
  }
  // Japanese text mixes kana with Chinese characters; any kana means Japanese.
  if (best?.[0] === 'zh-CN' && /[぀-ヿ]/.test(text)) return 'ja-JP';
  return best && best[1] / letters > 0.3 ? best[0] : undefined;
}

/** The browser voice that best speaks `lang`: the preferred one if it fits, else a local voice for that language. */
export function voiceFor(voices: SpeechSynthesisVoice[], lang: string, preferred?: string): SpeechSynthesisVoice | undefined {
  const base = lang.split('-')[0].toLowerCase();
  const fits = (v: SpeechSynthesisVoice) => v.lang.replace('_', '-').toLowerCase().split('-')[0] === base;
  const chosen = voices.find((v) => v.name === preferred);
  if (chosen && fits(chosen)) return chosen;
  const matching = voices.filter(fits);
  return (
    matching.find((v) => v.lang.replace('_', '-').toLowerCase() === lang.toLowerCase() && v.localService) ??
    matching.find((v) => v.localService) ??
    matching.find((v) => v.lang.replace('_', '-').toLowerCase() === lang.toLowerCase()) ??
    matching[0]
  );
}
