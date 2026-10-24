// Generated media show as their own cards. Models often embed the same file again in their reply as Markdown;
// these helpers take such repeats out so each image appears once.

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The text without Markdown or HTML images (or image links) pointing at any of `urls`. */
export function withoutShownMedia(text: string, urls: Iterable<string>): string {
  let out = text;
  for (const url of urls) {
    if (!url) continue;
    const u = escape(url);
    // [![alt](url)](url) first, then ![alt](url "title"), then <img src="url">.
    out = out
      .replace(new RegExp(`\\[!\\[[^\\]]*\\]\\(\\s*<?${u}>?(?:\\s+"[^"]*")?\\s*\\)\\]\\(\\s*<?${u}>?\\s*\\)`, 'g'), '')
      .replace(new RegExp(`!\\[[^\\]]*\\]\\(\\s*<?${u}>?(?:\\s+"[^"]*")?\\s*\\)`, 'g'), '')
      .replace(new RegExp(`<img\\b[^>]*\\bsrc=["']${u}["'][^>]*>`, 'gi'), '');
  }
  return out === text ? text : out.replace(/\n{3,}/g, '\n\n').trim();
}
