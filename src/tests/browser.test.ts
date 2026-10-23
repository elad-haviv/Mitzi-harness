import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { BrowserService, browserTool, formatView } from '../server/browser.js';
import type { MediaService } from '../server/media.js';
import { tempDir } from './helpers.js';

const dir = tempDir();
const saved: string[] = [];
const media = { save: (_b: Buffer, mime: string) => (saved.push(mime), { url: `/media/${saved.length}.jpg`, path: '', mimeType: mime }) } as unknown as MediaService;
const service = new BrowserService(join(dir, 'profile'), media, () => false);
after(() => service.close());

test('the browser opens pages, lists elements by ref, types and clicks', { skip: service.unavailable() }, async () => {
  const site = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    if (req.url?.startsWith('/search')) return res.end(`<title>Results</title><h1>Results for ${new URL(req.url, 'http://x').searchParams.get('q')}</h1>`);
    res.end('<title>Shop</title><form action="/search"><input name="q" placeholder="Search products"><button>Go</button></form><a href="/about">About us</a><div style="display:none"><button>Hidden</button></div>');
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
  try {
    const views: any[] = [];
    const tool = browserTool(service, (v) => views.push(v));
    const ctx = { cwd: dir, readFiles: new Map(), todos: [] };
    const opened = await tool.run({ action: 'open', url }, ctx);
    assert.match(opened, /Page: Shop/);
    assert.match(opened, /\[1\] textbox "Search products"/);
    assert.match(opened, /\[2\] button "Go"/);
    assert.match(opened, /\[3\] link "About us"/);
    assert.doesNotMatch(opened, /Hidden/);
    const typed = await tool.run({ action: 'type', ref: 1, text: 'teapot', submit: true }, ctx);
    assert.match(typed, /Page: Results/);
    assert.match(typed, /Results for teapot/);
    assert.equal(views.at(-1).title, 'Results');
    assert.ok(views.at(-1).screenshot, 'each action shows the page to the user');
    const back = await tool.run({ action: 'back' }, ctx);
    assert.match(back, /Page: Shop/);
    await assert.rejects(tool.run({ action: 'click' }, ctx), /ref number/);
    assert.match(formatView({ url, title: '', elements: [], text: 'x' }), /\(untitled\)/);
  } finally {
    site.close();
  }
});
