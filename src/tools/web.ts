import { Tool, ToolError, truncateMiddle } from './types.js';

const MAX_CHARS = 50_000;

/** Crude HTML → text: drops scripts/styles/tags and decodes common entities. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

interface WebFetchArgs {
  url: string;
}

export const webFetchTool: Tool<WebFetchArgs> = {
  name: 'WebFetch',
  kind: 'network',
  description: `Fetch a URL over HTTP(S) and return its content as text (HTML is converted to plain text, truncated to ${MAX_CHARS} characters).`,
  parameters: {
    type: 'object',
    properties: { url: { type: 'string', description: 'Fully qualified http(s) URL' } },
    required: ['url'],
  },
  summarize: (a) => a.url,
  async run(args, ctx) {
    let url: URL;
    try {
      url = new URL(args.url);
    } catch {
      throw new ToolError(`Invalid URL: ${args.url}`);
    }
    if (!/^https?:$/.test(url.protocol)) throw new ToolError('Only http and https URLs are supported');
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
    const res = await fetch(url, { signal, headers: { 'User-Agent': 'Mitzi/0.1 (+https://github.com/elad-haviv/Mitzi-harness)' } });
    const type = res.headers.get('content-type') ?? '';
    const body = await res.text();
    const text = type.includes('html') ? htmlToText(body) : body;
    return `HTTP ${res.status} ${res.statusText} (${type || 'unknown type'})\n\n${truncateMiddle(text, MAX_CHARS)}`;
  },
};
