// Computer control: bots look at the screen and use the mouse and keyboard, with what each system has built in
// (macOS: screencapture, sips and osascript; Windows: PowerShell; Linux: ImageMagick and xdotool on X11).
// Screenshots go to the model scaled down; the coordinates it answers with are scaled back to the screen.
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Tool, ToolError } from '../tools/types.js';

/** The largest screenshot sent to the model; bigger screens are scaled down to fit. */
export const SHOT_MAX = { width: 1280, height: 800 };

export type MouseButton = 'left' | 'right' | 'middle';

/** One way of driving the screen. Coordinates are the screen's own (points on macOS, pixels elsewhere). */
export interface ComputerBackend {
  /** Why it can't work here, if it can't. */
  unavailable(): Promise<string | undefined>;
  screenSize(): Promise<{ width: number; height: number }>;
  /** A JPEG of the whole (main) screen, fitted within `max`. */
  screenshot(max: { width: number; height: number }): Promise<Buffer>;
  move(x: number, y: number): Promise<void>;
  click(x: number, y: number, button: MouseButton, count: number): Promise<void>;
  drag(from: [number, number], to: [number, number]): Promise<void>;
  scroll(x: number, y: number, direction: 'up' | 'down' | 'left' | 'right', amount: number): Promise<void>;
  type(text: string): Promise<void>;
  /** A key or combination, normalized: modifiers first, e.g. ["ctrl", "shift", "t"]. */
  key(keys: string[]): Promise<void>;
}

function run(file: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout: 20_000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(new ToolError(`${file} failed: ${(stderr || err.message).trim().slice(0, 400)}`));
      else resolve(stdout);
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}

const which = (name: string) => run(process.platform === 'win32' ? 'where' : 'which', [name]).then(() => true, () => false);

async function withTempFile<T>(ext: string, fn: (path: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'mitzi-shot-'));
  try {
    return await fn(join(dir, `screen.${ext}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Width and height of a PNG or JPEG. */
export function imageSize(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return undefined;
  for (let i = 2; i + 9 < buf.length; ) {
    if (buf[i] !== 0xff) return undefined;
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    // Start-of-frame markers (not DHT, JPG or DAC) hold the size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return undefined;
}

const MODIFIERS: Record<string, string> = { ctrl: 'ctrl', control: 'ctrl', shift: 'shift', alt: 'alt', option: 'alt', opt: 'alt', cmd: 'cmd', command: 'cmd', meta: 'cmd', super: 'cmd', win: 'cmd', windows: 'cmd' };
const KEY_NAMES: Record<string, string> = { return: 'enter', enter: 'enter', esc: 'escape', escape: 'escape', tab: 'tab', space: 'space', backspace: 'backspace', delete: 'delete', del: 'delete', up: 'up', down: 'down', left: 'left', right: 'right', arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right', home: 'home', end: 'end', pageup: 'pageup', pagedown: 'pagedown', pgup: 'pageup', pgdn: 'pagedown' };

/** "Ctrl+Shift+T" → ["ctrl", "shift", "t"]; "cmd" stands for ⌘ on a Mac and the Windows/Super key elsewhere. */
export function parseKeys(combo: string): string[] {
  const parts = combo.split(/\s*\+\s*/).map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (!parts.length) throw new ToolError('Say which key to press, e.g. "enter" or "ctrl+c"');
  const mods = parts.slice(0, -1).map((m) => {
    const mod = MODIFIERS[m];
    if (!mod) throw new ToolError(`Unknown modifier "${m}". Use ctrl, shift, alt or cmd.`);
    return mod;
  });
  const last = parts[parts.length - 1];
  const key = MODIFIERS[last] ?? KEY_NAMES[last] ?? (/^f([1-9]|1[0-2])$/.test(last) || last.length === 1 ? last : undefined);
  if (!key) throw new ToolError(`Unknown key "${last}". Use a single character, a function key (f1–f12), or one of: ${[...new Set(Object.values(KEY_NAMES))].join(', ')}.`);
  return [...new Set(mods), key];
}

// ——— Linux (X11) ———

const XDOTOOL_KEYS: Record<string, string> = { enter: 'Return', escape: 'Escape', tab: 'Tab', space: 'space', backspace: 'BackSpace', delete: 'Delete', up: 'Up', down: 'Down', left: 'Left', right: 'Right', home: 'Home', end: 'End', pageup: 'Prior', pagedown: 'Next', ctrl: 'ctrl', shift: 'shift', alt: 'alt', cmd: 'super' };
const XBUTTON: Record<MouseButton, string> = { left: '1', middle: '2', right: '3' };

export class X11Backend implements ComputerBackend {
  async unavailable() {
    if (!process.env.DISPLAY) return process.env.WAYLAND_DISPLAY ? 'Computer control needs an X11 session; it can’t control a Wayland desktop. Log in with “Ubuntu on Xorg” (or your desktop’s X11 option).' : 'No display was found (DISPLAY isn’t set).';
    const missing = [];
    if (!(await which('xdotool'))) missing.push('xdotool');
    if (!(await which('import'))) missing.push('imagemagick');
    return missing.length ? `Install ${missing.join(' and ')} to use computer control (e.g. sudo apt install ${missing.join(' ')}).` : undefined;
  }
  async screenSize() {
    const [width, height] = (await run('xdotool', ['getdisplaygeometry'])).trim().split(/\s+/).map(Number);
    return { width, height };
  }
  screenshot(max: { width: number; height: number }) {
    return withTempFile('jpg', async (path) => {
      await run('import', ['-silent', '-window', 'root', '-resize', `${max.width}x${max.height}>`, '-quality', '75', path]);
      return readFileSync(path);
    });
  }
  async move(x: number, y: number) {
    await run('xdotool', ['mousemove', String(x), String(y)]);
  }
  async click(x: number, y: number, button: MouseButton, count: number) {
    await run('xdotool', ['mousemove', String(x), String(y), 'click', '--repeat', String(count), '--delay', '80', XBUTTON[button]]);
  }
  async drag(from: [number, number], to: [number, number]) {
    await run('xdotool', ['mousemove', String(from[0]), String(from[1]), 'mousedown', '1', 'mousemove', '--sync', String(to[0]), String(to[1]), 'mouseup', '1']);
  }
  async scroll(x: number, y: number, direction: 'up' | 'down' | 'left' | 'right', amount: number) {
    const button = { up: '4', down: '5', left: '6', right: '7' }[direction];
    await run('xdotool', ['mousemove', String(x), String(y), 'click', '--repeat', String(amount), '--delay', '30', button]);
  }
  async type(text: string) {
    await run('xdotool', ['type', '--delay', '12', '--', text]);
  }
  async key(keys: string[]) {
    await run('xdotool', ['key', '--', keys.map((k) => XDOTOOL_KEYS[k] ?? (/^f\d+$/.test(k) ? k.toUpperCase() : k)).join('+')]);
  }
}

// ——— macOS ———

const MAC_KEYCODES: Record<string, number> = { enter: 36, tab: 48, space: 49, backspace: 51, escape: 53, delete: 117, home: 115, end: 119, pageup: 116, pagedown: 121, left: 123, right: 124, down: 125, up: 126, f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111 };
const MAC_MODS: Record<string, string> = { ctrl: 'control down', shift: 'shift down', alt: 'option down', cmd: 'command down' };

/** Mouse events through CoreGraphics, from JavaScript for Automation. */
const jxaMouse = (body: string) => `ObjC.import('CoreGraphics');
function ev(type, x, y, button, clicks) {
  const e = $.CGEventCreateMouseEvent(null, type, $.CGPointMake(x, y), button);
  if (clicks) $.CGEventSetIntegerValueField(e, 1, clicks);
  $.CGEventPost(0, e);
}
function pause(s) { delay(s); }
${body}`;
const MAC_BUTTONS: Record<MouseButton, [number, number, number]> = { left: [1, 2, 0], right: [3, 4, 1], middle: [25, 26, 2] };

export class MacBackend implements ComputerBackend {
  async unavailable() {
    return undefined;
  }
  private jxa(script: string) {
    return run('osascript', ['-l', 'JavaScript', '-e', script]).catch((err: Error) => {
      throw new ToolError(/not allowed|assistive|1002|-25211/i.test(err.message) ? 'macOS blocked the mouse or keyboard. Allow the app running Mitzi (e.g. Terminal) in System Settings → Privacy & Security → Accessibility, then try again.' : err.message);
    });
  }
  async screenSize() {
    const out = await this.jxa(`ObjC.import('CoreGraphics'); const b = $.CGDisplayBounds($.CGMainDisplayID()); JSON.stringify([b.size.width, b.size.height])`);
    const [width, height] = JSON.parse(out);
    return { width, height };
  }
  screenshot(max: { width: number; height: number }) {
    return withTempFile('jpg', async (path) => {
      await run('screencapture', ['-x', '-m', '-t', 'jpg', path]);
      // Retina screens are captured at twice their size in points; fit it.
      await run('sips', ['--resampleHeightWidthMax', String(Math.max(max.width, max.height)), '-s', 'formatOptions', '75', path]);
      const bytes = readFileSync(path);
      if (bytes.length < 2000) throw new ToolError('The screenshot came out empty. Allow the app running Mitzi in System Settings → Privacy & Security → Screen Recording, then restart it.');
      return bytes;
    });
  }
  async move(x: number, y: number) {
    await this.jxa(jxaMouse(`ev(5, ${x}, ${y}, 0);`));
  }
  async click(x: number, y: number, button: MouseButton, count: number) {
    const [down, up, b] = MAC_BUTTONS[button];
    let body = `ev(5, ${x}, ${y}, 0); pause(0.05);`;
    for (let i = 1; i <= count; i++) body += `ev(${down}, ${x}, ${y}, ${b}, ${i}); ev(${up}, ${x}, ${y}, ${b}, ${i});`;
    await this.jxa(jxaMouse(body));
  }
  async drag(from: [number, number], to: [number, number]) {
    let body = `ev(5, ${from[0]}, ${from[1]}, 0); ev(1, ${from[0]}, ${from[1]}, 0); pause(0.05);`;
    for (let i = 1; i <= 10; i++) body += `ev(6, ${from[0] + ((to[0] - from[0]) * i) / 10}, ${from[1] + ((to[1] - from[1]) * i) / 10}, 0); pause(0.02);`;
    body += `ev(2, ${to[0]}, ${to[1]}, 0);`;
    await this.jxa(jxaMouse(body));
  }
  async scroll(x: number, y: number, direction: 'up' | 'down' | 'left' | 'right', amount: number) {
    const dy = direction === 'up' ? amount : direction === 'down' ? -amount : 0;
    const dx = direction === 'left' ? amount : direction === 'right' ? -amount : 0;
    await this.jxa(jxaMouse(`ev(5, ${x}, ${y}, 0); $.CGEventPost(0, $.CGEventCreateScrollWheelEvent(null, 1, 2, ${dy * 3}, ${dx * 3}));`));
  }
  async type(text: string) {
    // keystroke handles plain ASCII; anything else is pasted (and the clipboard put back).
    if (/^[\x20-\x7e\n\t]*$/.test(text)) {
      await run('osascript', ['-e', 'on run argv', '-e', 'tell application "System Events" to keystroke (item 1 of argv)', '-e', 'end run', text]);
      return;
    }
    const saved = await run('pbpaste', []).catch(() => '');
    await run('pbcopy', [], text);
    await run('osascript', ['-e', 'tell application "System Events" to keystroke "v" using command down']);
    await new Promise((r) => setTimeout(r, 300));
    await run('pbcopy', [], saved);
  }
  async key(keys: string[]) {
    const key = keys[keys.length - 1];
    const mods = keys.slice(0, -1).map((m) => MAC_MODS[m]);
    const using = mods.length ? ` using {${mods.join(', ')}}` : '';
    const code = MAC_KEYCODES[key];
    const action = code !== undefined ? `key code ${code}` : MAC_MODS[key] ? `key code ${{ ctrl: 59, shift: 56, alt: 58, cmd: 55 }[key as 'ctrl']}` : `keystroke ${JSON.stringify(key)}`;
    await run('osascript', ['-e', `tell application "System Events" to ${action}${using}`]);
  }
}

// ——— Windows ———

const WIN_VK: Record<string, number> = { enter: 0x0d, tab: 0x09, space: 0x20, backspace: 0x08, escape: 0x1b, delete: 0x2e, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22, left: 0x25, up: 0x26, right: 0x27, down: 0x28, ctrl: 0x11, shift: 0x10, alt: 0x12, cmd: 0x5b };

const PS_PRELUDE = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class MitziInput {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint f, UIntPtr extra);
  [DllImport("user32.dll")] public static extern short VkKeyScan(char c);
}
'@
[MitziInput]::SetProcessDPIAware() | Out-Null
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
function Down($b) { [MitziInput]::mouse_event(@{l=2;r=8;m=32}[$b], 0, 0, 0, [UIntPtr]::Zero) }
function Up($b) { [MitziInput]::mouse_event(@{l=4;r=16;m=64}[$b], 0, 0, 0, [UIntPtr]::Zero) }
function Key($vk, $up) { [MitziInput]::keybd_event([byte]$vk, 0, $(if ($up) { 2 } else { 0 }), [UIntPtr]::Zero) }
`;

const psString = (s: string) => `'${s.replace(/'/g, "''")}'`;

export class WindowsBackend implements ComputerBackend {
  async unavailable() {
    return undefined;
  }
  private ps(script: string) {
    return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], PS_PRELUDE + script);
  }
  async screenSize() {
    const out = await this.ps(`$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; "$($b.Width) $($b.Height)"`);
    const [width, height] = out.trim().split(/\s+/).map(Number);
    return { width, height };
  }
  screenshot(max: { width: number; height: number }) {
    return withTempFile('jpg', async (path) => {
      await this.ps(`$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$full = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($full); $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$scale = [Math]::Min(1, [Math]::Min(${max.width} / $b.Width, ${max.height} / $b.Height))
$small = New-Object System.Drawing.Bitmap ([int]($b.Width * $scale)), ([int]($b.Height * $scale))
$g2 = [System.Drawing.Graphics]::FromImage($small); $g2.InterpolationMode = 'HighQualityBicubic'; $g2.DrawImage($full, 0, 0, $small.Width, $small.Height)
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$params = New-Object System.Drawing.Imaging.EncoderParameters 1
$params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 75L
$small.Save(${psString(path)}, $codec, $params)`);
      return readFileSync(path);
    });
  }
  async move(x: number, y: number) {
    await this.ps(`[MitziInput]::SetCursorPos(${x}, ${y}) | Out-Null`);
  }
  async click(x: number, y: number, button: MouseButton, count: number) {
    const b = button[0];
    await this.ps(`[MitziInput]::SetCursorPos(${x}, ${y}) | Out-Null; Start-Sleep -Milliseconds 50
1..${count} | ForEach-Object { Down '${b}'; Up '${b}'; Start-Sleep -Milliseconds 60 }`);
  }
  async drag(from: [number, number], to: [number, number]) {
    let script = `[MitziInput]::SetCursorPos(${from[0]}, ${from[1]}) | Out-Null; Down 'l'; Start-Sleep -Milliseconds 50\n`;
    for (let i = 1; i <= 10; i++) script += `[MitziInput]::SetCursorPos(${Math.round(from[0] + ((to[0] - from[0]) * i) / 10)}, ${Math.round(from[1] + ((to[1] - from[1]) * i) / 10)}) | Out-Null; Start-Sleep -Milliseconds 20\n`;
    await this.ps(`${script}Up 'l'`);
  }
  async scroll(x: number, y: number, direction: 'up' | 'down' | 'left' | 'right', amount: number) {
    const flag = direction === 'up' || direction === 'down' ? 0x0800 : 0x1000;
    const delta = (direction === 'up' || direction === 'right' ? 120 : -120) * amount;
    await this.ps(`[MitziInput]::SetCursorPos(${x}, ${y}) | Out-Null; [MitziInput]::mouse_event(${flag}, 0, 0, ${delta}, [UIntPtr]::Zero)`);
  }
  async type(text: string) {
    // SendKeys treats + ^ % ~ ( ) { } [ ] as commands; braces make them literal.
    const escaped = text.replace(/[+^%~(){}[\]]/g, (c) => `{${c}}`).replace(/\r?\n/g, '{ENTER}');
    await this.ps(`[System.Windows.Forms.SendKeys]::SendWait(${psString(escaped)})`);
  }
  async key(keys: string[]) {
    const vk = (k: string) => WIN_VK[k] ?? (/^f\d+$/.test(k) ? 0x6f + Number(k.slice(1)) : `([MitziInput]::VkKeyScan([char]${psString(k)}) -band 0xff)`);
    const codes = keys.map(vk);
    await this.ps(`${codes.map((c) => `Key ${c} $false`).join('; ')}; ${[...codes].reverse().map((c) => `Key ${c} $true`).join('; ')}`);
  }
}

export function systemBackend(): ComputerBackend | undefined {
  if (process.platform === 'darwin') return new MacBackend();
  if (process.platform === 'win32') return new WindowsBackend();
  if (process.platform === 'linux') return new X11Backend();
  return undefined;
}

export interface ComputerArgs {
  action: 'screenshot' | 'click' | 'double_click' | 'right_click' | 'move' | 'drag' | 'scroll' | 'type' | 'key' | 'wait';
  x?: number;
  y?: number;
  to_x?: number;
  to_y?: number;
  text?: string;
  key?: string;
  direction?: 'up' | 'down' | 'left' | 'right';
  amount?: number;
  seconds?: number;
}

/** Drives a backend in screenshot coordinates: the size of the last screenshot sent to the model. */
export class ComputerService {
  private shot?: { width: number; height: number };
  private screen?: { width: number; height: number };
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly backend: ComputerBackend | undefined,
    private readonly save: (bytes: Buffer, mimeType: string) => { url: string },
  ) {}

  async unavailable(): Promise<string | undefined> {
    if (!this.backend) return `Computer control doesn’t work on ${process.platform}.`;
    return this.backend.unavailable();
  }

  /** One action at a time, whichever chat asks: there is only one mouse. */
  act(a: ComputerArgs, signal?: AbortSignal): Promise<{ text: string; image?: string }> {
    const next = this.queue.then(() => this.doAct(a, signal));
    this.queue = next.catch(() => {});
    return next;
  }

  private async doAct(a: ComputerArgs, signal?: AbortSignal): Promise<{ text: string; image?: string }> {
    const why = await this.unavailable();
    if (why) throw new ToolError(why);
    const b = this.backend!;
    if (signal?.aborted) throw new ToolError('Stopped');
    if (a.action !== 'screenshot' && a.action !== 'wait' && !this.shot) throw new ToolError('Take a screenshot first, so you know where things are.');
    const point = (x?: number, y?: number): [number, number] => {
      if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) throw new ToolError(`${a.action} needs x and y, in screenshot pixels`);
      const shot = this.shot!;
      const screen = this.screen!;
      if (x < 0 || y < 0 || x > shot.width || y > shot.height) throw new ToolError(`(${x}, ${y}) is outside the ${shot.width}×${shot.height} screenshot`);
      return [Math.round((x * screen.width) / shot.width), Math.round((y * screen.height) / shot.height)];
    };
    let done: string;
    switch (a.action) {
      case 'screenshot':
        return this.capture('Screenshot taken.');
      case 'wait': {
        const s = Math.min(Math.max(Number(a.seconds) || 1, 0.1), 10);
        await new Promise((r) => setTimeout(r, s * 1000));
        return this.capture(`Waited ${s}s.`);
      }
      case 'click':
      case 'double_click':
      case 'right_click': {
        const [x, y] = point(a.x, a.y);
        await b.click(x, y, a.action === 'right_click' ? 'right' : 'left', a.action === 'double_click' ? 2 : 1);
        done = `${{ click: 'Clicked', double_click: 'Double-clicked', right_click: 'Right-clicked' }[a.action]} at (${a.x}, ${a.y}).`;
        break;
      }
      case 'move': {
        const [x, y] = point(a.x, a.y);
        await b.move(x, y);
        done = `Moved the pointer to (${a.x}, ${a.y}).`;
        break;
      }
      case 'drag':
        await b.drag(point(a.x, a.y), point(a.to_x, a.to_y));
        done = `Dragged from (${a.x}, ${a.y}) to (${a.to_x}, ${a.to_y}).`;
        break;
      case 'scroll': {
        const dir = a.direction ?? 'down';
        if (!['up', 'down', 'left', 'right'].includes(dir)) throw new ToolError('direction is up, down, left or right');
        const [x, y] = a.x === undefined ? [Math.round(this.screen!.width / 2), Math.round(this.screen!.height / 2)] : point(a.x, a.y);
        await b.scroll(x, y, dir, Math.min(Math.max(Math.round(Number(a.amount) || 3), 1), 20));
        done = `Scrolled ${dir}.`;
        break;
      }
      case 'type':
        if (typeof a.text !== 'string' || !a.text) throw new ToolError('type needs text');
        await b.type(a.text);
        done = `Typed ${a.text.length} characters.`;
        break;
      case 'key':
        await b.key(parseKeys(String(a.key ?? '')));
        done = `Pressed ${a.key}.`;
        break;
      default:
        throw new ToolError(`Unknown action "${(a as { action: string }).action}"`);
    }
    // Let the screen settle, then show the result.
    await new Promise((r) => setTimeout(r, 500));
    return this.capture(done);
  }

  private async capture(done: string): Promise<{ text: string; image: string }> {
    const b = this.backend!;
    const [screen, bytes] = await Promise.all([b.screenSize(), b.screenshot(SHOT_MAX)]);
    const size = imageSize(bytes);
    if (!size) throw new ToolError('The screenshot couldn’t be read');
    this.screen = screen;
    this.shot = size;
    const { url } = this.save(bytes, 'image/jpeg');
    return { text: `${done} The screenshot is ${size.width}×${size.height}; give coordinates in its pixels.`, image: url };
  }
}

const ACTIONS: ComputerArgs['action'][] = ['screenshot', 'click', 'double_click', 'right_click', 'move', 'drag', 'scroll', 'type', 'key', 'wait'];

export function computerTool(service: ComputerService): Tool<ComputerArgs> {
  return {
    name: 'Computer',
    // It acts as the user on their own computer, so it asks first (screenshots only look).
    kind: 'exec',
    description:
      'See and use the user’s computer: take a screenshot, then click, type, press keys, scroll and drag. Every action ' +
      'returns a fresh screenshot, which you see as an image after the tool results. Coordinates are pixels in the latest ' +
      'screenshot (0,0 is its top-left corner); aim for the middle of what you click. Prefer keyboard shortcuts when they are ' +
      'reliable. Check each screenshot before the next step, and stop to ask the user when something unexpected appears. ' +
      'Never enter passwords or payment details, and don’t confirm purchases, deletions or messages to other people without ' +
      'the user saying so in this conversation.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ACTIONS },
        x: { type: 'number', description: 'For click, double_click, right_click, move, drag (start) and scroll' },
        y: { type: 'number' },
        to_x: { type: 'number', description: 'Where a drag ends' },
        to_y: { type: 'number' },
        text: { type: 'string', description: 'For type' },
        key: { type: 'string', description: 'For key: a key or combination, e.g. "enter", "ctrl+c", "cmd+space" (cmd is ⌘ on a Mac, the Windows key elsewhere)' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'For scroll' },
        amount: { type: 'number', description: 'Scroll steps, 1–20 (default 3)' },
        seconds: { type: 'number', description: 'For wait, up to 10' },
      },
      required: ['action'],
    },
    summarize: (a) =>
      a.action === 'type' ? `type “${(a.text ?? '').slice(0, 40)}${(a.text ?? '').length > 40 ? '…' : ''}”` : a.action === 'key' ? `press ${a.key ?? ''}` : a.action === 'drag' ? `drag (${a.x}, ${a.y}) → (${a.to_x}, ${a.to_y})` : a.x !== undefined ? `${a.action.replace('_', ' ')} at (${a.x}, ${a.y})` : a.action.replace('_', ' '),
    sensitive: (a) => (a.action === 'screenshot' || a.action === 'wait' ? undefined : 'uses your mouse and keyboard'),
    async run(a, ctx) {
      const { text, image } = await service.act(a, ctx.signal);
      if (image) (ctx.images ??= []).push(image);
      return image ? `${text}\nMEDIA: ${image} image/jpeg` : text;
    },
  };
}
