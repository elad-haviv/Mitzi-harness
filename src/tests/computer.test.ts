import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { after, test } from 'node:test';
import { Agent, TOOL_IMAGES_NOTE } from '../agent.js';
import { loadConfig } from '../config.js';
import { OpenRouterClient } from '../openrouter.js';
import { Permissions } from '../permissions.js';
import { ComputerBackend, ComputerService, computerTool, imageSize, parseKeys, X11Backend } from '../server/computer.js';
import { mockOpenRouter, silentUI, tempDir, textChunks, toolCallChunks } from './helpers.js';

process.env.MITZI_HOME = tempDir();
const servers: { close(): void }[] = [];
after(() => servers.forEach((s) => s.close()));

/** A 1280×800 JPEG header: enough for imageSize. */
const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffc0001108032005000301220002110103110100', 'hex');

class FakeBackend implements ComputerBackend {
  calls: unknown[][] = [];
  async unavailable() {
    return undefined;
  }
  async screenSize() {
    return { width: 2560, height: 1600 };
  }
  async screenshot() {
    return JPEG;
  }
  async move(x: number, y: number) {
    this.calls.push(['move', x, y]);
  }
  async click(x: number, y: number, button: string, count: number) {
    this.calls.push(['click', x, y, button, count]);
  }
  async drag(from: [number, number], to: [number, number]) {
    this.calls.push(['drag', from, to]);
  }
  async scroll(x: number, y: number, direction: string, amount: number) {
    this.calls.push(['scroll', x, y, direction, amount]);
  }
  async type(text: string) {
    this.calls.push(['type', text]);
  }
  async key(keys: string[]) {
    this.calls.push(['key', keys]);
  }
}

let saved = 0;
const save = () => ({ url: `/media/${String(++saved).padStart(32, '0')}.jpg` });

test('computer: key combinations and image sizes', () => {
  assert.deepEqual(parseKeys('Ctrl+Shift+T'), ['ctrl', 'shift', 't']);
  assert.deepEqual(parseKeys('cmd + space'), ['cmd', 'space']);
  assert.deepEqual(parseKeys('Return'), ['enter']);
  assert.deepEqual(parseKeys('alt+F4'), ['alt', 'f4']);
  assert.throws(() => parseKeys('hyper+x'), /Unknown modifier/);
  assert.throws(() => parseKeys('ctrl+banana'), /Unknown key/);
  assert.deepEqual(imageSize(JPEG), { width: 1280, height: 800 });
  assert.deepEqual(imageSize(Buffer.from('89504e470d0a1a0a0000000d494844520000003000000020', 'hex')), { width: 48, height: 32 });
});

test('computer: actions need a screenshot first and are scaled to the screen', async () => {
  const backend = new FakeBackend();
  const service = new ComputerService(backend, save);
  await assert.rejects(service.act({ action: 'click', x: 1, y: 1 }), /screenshot first/);
  const shot = await service.act({ action: 'screenshot' });
  assert.match(shot.text, /1280×800/);
  assert.match(shot.image ?? '', /^\/media\//);
  await service.act({ action: 'click', x: 100, y: 50 });
  await service.act({ action: 'double_click', x: 640, y: 400 });
  await service.act({ action: 'drag', x: 0, y: 0, to_x: 10, to_y: 20 });
  await service.act({ action: 'key', key: 'ctrl+l' });
  await service.act({ action: 'type', text: 'hello' });
  await service.act({ action: 'scroll', direction: 'down' });
  await assert.rejects(service.act({ action: 'click', x: 2000, y: 1 }), /outside/);
  assert.deepEqual(backend.calls, [
    ['click', 200, 100, 'left', 1],
    ['click', 1280, 800, 'left', 2],
    ['drag', [0, 0], [20, 40]],
    ['key', ['ctrl', 'l']],
    ['type', 'hello'],
    ['scroll', 1280, 800, 'down', 3],
  ]);
  const tool = computerTool(service);
  assert.equal(tool.sensitive?.({ action: 'screenshot' }, {} as any), undefined);
  assert.match(tool.sensitive?.({ action: 'click', x: 1, y: 1 }, {} as any) ?? '', /mouse/);
});

test('computer: screenshots reach the model as images, and only the latest few are sent', async () => {
  const script = [];
  for (let i = 0; i < 5; i++) script.push(toolCallChunks(`call_${i}`, 'Computer', { action: 'screenshot' }));
  script.push(textChunks('Done looking.'));
  const mock = await mockOpenRouter(script);
  servers.push(mock.server);
  const cwd = tempDir();
  const config = loadConfig(cwd, { apiKey: 'k', baseUrl: mock.url, model: 'test/vision' });
  const agent = new Agent({
    client: new OpenRouterClient({ apiKey: 'k', baseUrl: mock.url, maxRetries: 0 }),
    config,
    tools: [computerTool(new ComputerService(new FakeBackend(), save))],
    permissions: new Permissions('yolo', []),
    ui: silentUI,
    cwd,
    inlineImage: (url) => `data:image/jpeg;base64,${Buffer.from(url).toString('base64')}`,
  });
  await agent.run('look at my screen');
  // After each tool result comes a user message with the screenshot.
  const roles = agent.messages.map((m) => m.role);
  assert.deepEqual(roles.slice(0, 5), ['user', 'assistant', 'tool', 'user', 'assistant']);
  const imageMsg = agent.messages[3];
  assert.ok(Array.isArray(imageMsg.content));
  assert.equal((imageMsg.content as any)[0].text, TOOL_IMAGES_NOTE);
  assert.match((imageMsg.content as any)[1].image_url.url, /^\/media\//);
  // What the model saw: inlined images, at most three of them.
  const last = mock.requests.at(-1);
  const images = last.messages.flatMap((m: any) => (Array.isArray(m.content) ? m.content.filter((p: any) => p.type === 'image_url') : []));
  assert.equal(images.length, 3);
  assert.ok(images.every((p: any) => p.image_url.url.startsWith('data:image/jpeg;base64,')));
  assert.equal(last.messages.filter((m: any) => /Earlier screenshots were left out/.test(String(m.content))).length, 2);
});

const hasX = (() => {
  try {
    execFileSync('which', ['Xvfb', 'xdotool', 'import']);
    return true;
  } catch {
    return false;
  }
})();

test('computer: the X11 backend drives a real (virtual) display', { skip: !hasX && 'needs Xvfb, xdotool and ImageMagick' }, async () => {
  const display = ':87';
  const xvfb = spawn('Xvfb', [display, '-screen', '0', '1920x1080x24'], { stdio: 'ignore' });
  const before = process.env.DISPLAY;
  process.env.DISPLAY = display;
  try {
    // Wait for the display to come up (slower when the whole suite runs at once).
    for (let i = 0; i < 100; i++) {
      try {
        execFileSync('xdotool', ['getdisplaygeometry'], { env: { ...process.env, DISPLAY: display }, stdio: 'ignore' });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const backend = new X11Backend();
    assert.equal(await backend.unavailable(), undefined);
    assert.deepEqual(await backend.screenSize(), { width: 1920, height: 1080 });
    const service = new ComputerService(backend, save);
    const shot = await service.act({ action: 'screenshot' });
    assert.match(shot.text, /1280×720/);
    await service.act({ action: 'move', x: 640, y: 360 });
    const where = execFileSync('xdotool', ['getmouselocation', '--shell'], { env: { ...process.env, DISPLAY: display } }).toString();
    assert.match(where, /X=960\nY=540/);
  } finally {
    process.env.DISPLAY = before;
    xvfb.kill();
  }
});
