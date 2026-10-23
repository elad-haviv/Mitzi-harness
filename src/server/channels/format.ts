// Turning Mitzi's Markdown answers into what each messaging service shows well.

/** Splits text into messages of at most `max` characters, at paragraph or line breaks where possible. */
export function splitMessage(text: string, max = 4000): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.length ? out : [''];
}

/** Runs `inline` over the text outside fenced code blocks, and `code` over each block's contents. */
function outsideCode(md: string, inline: (text: string) => string, code: (body: string) => string): string {
  const blocks: string[] = [];
  const text = md.replace(/```[\w-]*\n?([\s\S]*?)```/g, (_, body: string) => `\u0000${blocks.push(code(body.replace(/\n$/, ''))) - 1}\u0000`);
  return inline(text).replace(/\u0000(\d+)\u0000/g, (_, i: string) => blocks[Number(i)]);
}

/** Markdown to the HTML subset Telegram accepts: bold, italics, code, code blocks, links; headings become bold. */
export function toTelegramHtml(md: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return outsideCode(
    md,
    (text) =>
      esc(text)
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
        .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, '$1<i>$2</i>')
        .replace(/(^|\W)_([^_\n]+)_(?!\w)/g, '$1<i>$2</i>')
        .replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
        .replace(/^(\s*)[-*]\s+/gm, '$1• '),
    (body) => `<pre>${esc(body)}</pre>`,
  );
}

/** Markdown to Slack's mrkdwn: *bold*, _italics_, ~strike~, <url|links>, and escaped &, <, >. */
export function toSlackMrkdwn(md: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return outsideCode(
    md,
    (text) =>
      esc(text)
        .replace(/^#{1,6}\s+(.+)$/gm, '\u0001$1\u0001')
        .replace(/\*\*([^*\n]+)\*\*/g, '\u0001$1\u0001')
        .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, '$1_$2_')
        .replace(/~~([^~\n]+)~~/g, '~$1~')
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>')
        .replace(/^(\s*)[-*]\s+/gm, '$1• ')
        .replace(/\u0001/g, '*'),
    (body) => `\`\`\`${esc(body)}\`\`\``,
  );
}

/** Markdown to WhatsApp's formatting: *bold*, _italics_, ~strike~, ```code```; links become "text (url)". */
export function toWhatsApp(md: string): string {
  return outsideCode(
    md,
    (text) =>
      text
        .replace(/^#{1,6}\s+(.+)$/gm, '\u0001$1\u0001')
        .replace(/\*\*([^*\n]+)\*\*/g, '\u0001$1\u0001')
        .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, '$1_$2_')
        .replace(/~~([^~\n]+)~~/g, '~$1~')
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)')
        .replace(/^(\s*)[-*]\s+/gm, '$1• ')
        .replace(/\u0001/g, '*'),
    (body) => `\`\`\`${body}\`\`\``,
  );
}

/** Markdown as plain text, for email bodies and services without formatting. */
export function toPlainText(md: string): string {
  return outsideCode(
    md,
    (text) =>
      text
        .replace(/^#{1,6}\s+(.+)$/gm, '$1')
        .replace(/\*\*([^*\n]+)\*\*/g, '$1')
        .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, '$1$2')
        .replace(/~~([^~\n]+)~~/g, '$1')
        .replace(/`([^`\n]+)`/g, '$1')
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)')
        .replace(/^(\s*)[-*]\s+/gm, '$1• '),
    (body) => body,
  );
}
