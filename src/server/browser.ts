// Browser use: bots drive a real Chrome/Edge (through playwright-core) to read and act on web pages.
// The browser keeps its own profile under MITZI_HOME, so sign-ins persist between sessions.
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { chromiumBinary } from '../browsers.js';
import { Tool, ToolError } from '../tools/types.js';
import type { MediaService } from './media.js';

type Pw = typeof import('playwright-core');
type Context = Awaited<ReturnType<Pw['chromium']['launchPersistentContext']>>;
type Page = Context['pages'] extends () => (infer P)[] ? P : never;

const IDLE_MS = 10 * 60_000;

export interface PageView {
  url: string;
  title: string;
  /** Interactive elements as "[ref] role "name"". */
  elements: string[];
  text: string;
}

/** Finds a Chromium to drive: MITZI_BROWSER, then Chrome/Edge, then a Playwright download. */
export function browserExecutable(): string | undefined {
  const env = process.env.MITZI_BROWSER;
  if (env && existsSync(env)) return env;
  const installed = chromiumBinary();
  if (installed) return installed;
  const pw = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (pw && existsSync(join(pw, 'chromium'))) return join(pw, 'chromium');
  return undefined;
}

function playwright(): Pw | undefined {
  try {
    return createRequire(import.meta.url)('playwright-core') as Pw;
  } catch {
    return undefined;
  }
}

export class BrowserService {
  private context?: Promise<Context>;
  private page?: Page;
  private idle?: NodeJS.Timeout;

  constructor(
    private readonly profileDir: string,
    private readonly media: MediaService,
    private readonly headed: () => boolean,
  ) {}

  /** Why browsing isn't possible, if it isn't. */
  unavailable(): string | undefined {
    if (!playwright()) return 'The browser add-on (playwright-core) isn’t installed. Run npm install in Mitzi’s folder.';
    if (!browserExecutable()) return 'No Chrome, Edge or Chromium was found. Install Chrome, or set MITZI_BROWSER to a Chromium-based browser.';
    return undefined;
  }

  private async open(): Promise<Page> {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => void this.close(), IDLE_MS);
    this.idle.unref();
    if (!this.context) {
      const pw = playwright();
      const executablePath = browserExecutable();
      if (!pw || !executablePath) throw new ToolError(this.unavailable()!);
      mkdirSync(this.profileDir, { recursive: true });
      this.context = pw.chromium
        .launchPersistentContext(this.profileDir, {
          executablePath,
          headless: !this.headed(),
          viewport: { width: 1280, height: 860 },
          args: process.getuid?.() === 0 ? ['--no-sandbox'] : [],
        })
        .catch((err) => {
          this.context = undefined;
          throw new ToolError(`Couldn't start the browser: ${err.message}`);
        });
      (await this.context).on('close', () => {
        this.context = undefined;
        this.page = undefined;
      });
    }
    const ctx = await this.context;
    if (!this.page || this.page.isClosed()) this.page = ctx.pages().find((p) => !p.isClosed()) ?? (await ctx.newPage());
    return this.page;
  }

  async close(): Promise<void> {
    const ctx = this.context;
    this.context = undefined;
    this.page = undefined;
    await (await ctx?.catch(() => undefined))?.close().catch(() => {});
  }

  /** What the page shows: title, address, interactive elements with refs, and text. */
  async view(page: Page): Promise<PageView> {
    await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
    return page.evaluate(() => {
      document.querySelectorAll('[data-mitzi-ref]').forEach((e) => e.removeAttribute('data-mitzi-ref'));
      const selector =
        'a[href], button, input:not([type=hidden]), textarea, select, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=option], [contenteditable=true], [onclick]';
      const elements: string[] = [];
      let n = 0;
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (r.width < 2 || r.height < 2 || style.visibility === 'hidden' || style.display === 'none') continue;
        if (r.bottom < -200 || r.top > innerHeight * 2.5) continue;
        el.setAttribute('data-mitzi-ref', String(++n));
        const tag = el.tagName.toLowerCase();
        const type = (el as HTMLInputElement).type;
        const role =
          el.getAttribute('role') ??
          (tag === 'a' ? 'link' : tag === 'input' ? (['submit', 'button', 'reset'].includes(type) ? 'button' : ['checkbox', 'radio'].includes(type) ? type : 'textbox') : tag === 'textarea' ? 'textbox' : tag);
        const value = (el as HTMLInputElement).value;
        const name = (el.getAttribute('aria-label') || el.innerText || (role === 'button' ? value : '') || (el as HTMLInputElement).placeholder || el.title || '')
          .trim()
          .replace(/\s+/g, ' ')
          .slice(0, 80);
        elements.push(`[${n}] ${role} "${name}"${role === 'textbox' && value ? ` value="${String(value).slice(0, 40)}"` : ''}`);
        if (elements.length >= 150) break;
      }
      const text = (document.body?.innerText ?? '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 5000);
      return { url: location.href, title: document.title, elements, text };
    });
  }

  /** A screenshot saved as a media file, for the user to see. */
  async snapshotImage(page: Page): Promise<string | undefined> {
    try {
      const bytes = await page.screenshot({ type: 'jpeg', quality: 60 });
      return this.media.save(bytes, 'image/jpeg').url;
    } catch {
      return undefined;
    }
  }

  async act(args: BrowserArgs, signal?: AbortSignal): Promise<{ view: PageView; screenshot?: string }> {
    const page = await this.open();
    const ref = (r: unknown) => {
      if (r === undefined || r === null || r === '') throw new ToolError('Give the element’s ref number from the page listing');
      return page.locator(`[data-mitzi-ref="${String(r).replace(/\D/g, '')}"]`).first();
    };
    const timeout = { timeout: 10_000 };
    if (signal?.aborted) throw new ToolError('Stopped');
    switch (args.action) {
      case 'open': {
        let url = String(args.url ?? '').trim();
        if (!url) throw new ToolError('Give a URL to open');
        if (!/^[a-z]+:\/\//i.test(url)) url = `https://${url}`;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch((err) => {
          throw new ToolError(`Couldn't open ${url}: ${err.message.split('\n')[0]}`);
        });
        break;
      }
      case 'click':
        await ref(args.ref).click(timeout);
        break;
      case 'type':
        await ref(args.ref).fill(String(args.text ?? ''), timeout);
        if (args.submit) await ref(args.ref).press('Enter', timeout);
        break;
      case 'select':
        await ref(args.ref).selectOption(String(args.text ?? ''), timeout);
        break;
      case 'press':
        await page.keyboard.press(String(args.key ?? 'Enter'));
        break;
      case 'scroll':
        await page.mouse.wheel(0, args.direction === 'up' ? -700 : 700);
        break;
      case 'back':
        await page.goBack(timeout).catch(() => {});
        break;
      case 'read':
      case 'screenshot':
        break;
      default:
        throw new ToolError(`Unknown action "${args.action}"`);
    }
    // Let navigation and rendering settle.
    await page.waitForTimeout(600);
    const view = await this.view(page);
    return { view, screenshot: await this.snapshotImage(page) };
  }
}

interface BrowserArgs {
  action: 'open' | 'read' | 'click' | 'type' | 'select' | 'press' | 'scroll' | 'back' | 'screenshot';
  url?: string;
  ref?: number | string;
  text?: string;
  key?: string;
  submit?: boolean;
  direction?: 'up' | 'down';
}

export function formatView(v: PageView, full = false): string {
  return [
    `Page: ${v.title || '(untitled)'}\nURL: ${v.url}`,
    v.elements.length ? `Interactive elements (use the number as ref):\n${v.elements.join('\n')}` : 'No interactive elements found.',
    `Text:\n${full ? v.text : v.text.slice(0, 2500)}`,
  ].join('\n\n');
}

/** The Browser tool. `onView` shows the page to the user as the bot works. */
export function browserTool(service: BrowserService, onView: (v: { url: string; title: string; screenshot?: string }) => void): Tool<BrowserArgs> {
  return {
    name: 'Browser',
    // It acts on the web as the user (with their sign-ins), so it asks first.
    kind: 'network',
    description:
      'Use a real web browser: open pages, read them, click, type into fields and submit forms. Every action returns the page ' +
      'with its interactive elements numbered; refer to elements by that number (ref). Use "read" to see the page again ' +
      'with its full text. Prefer WebFetch for simply reading a public page; use the browser for interactive sites, sites ' +
      'that need JavaScript, or when the user asks you to do something on a website. Never enter passwords or payment ' +
      'details; ask the user to do that in the browser window.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['open', 'read', 'click', 'type', 'select', 'press', 'scroll', 'back', 'screenshot'] },
        url: { type: 'string', description: 'For open' },
        ref: { type: 'integer', description: 'Element number, for click, type and select' },
        text: { type: 'string', description: 'Text to type, or the option to select' },
        submit: { type: 'boolean', description: 'Press Enter after typing' },
        key: { type: 'string', description: 'For press, e.g. Enter, Escape, ArrowDown' },
        direction: { type: 'string', enum: ['up', 'down'] },
      },
      required: ['action'],
    },
    summarize: (a) => (a.action === 'open' ? `open ${a.url ?? ''}` : a.action === 'type' ? `type into [${a.ref}]` : a.ref !== undefined ? `${a.action} [${a.ref}]` : a.action),
    async run(a, ctx) {
      const { view, screenshot } = await service.act(a, ctx.signal);
      onView({ url: view.url, title: view.title, screenshot });
      return `${formatView(view, a.action === 'read')}${screenshot && a.action === 'screenshot' ? `\nMEDIA: ${screenshot} image/jpeg` : ''}`;
    },
  };
}
