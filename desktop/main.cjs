// Mitzi's desktop window. `mitzi ui` starts the local server and then runs this with Electron,
// passing the server's URL. The window only shows that local page; everything else opens in the
// user's browser.
const { app, BrowserWindow, Menu, nativeTheme, screen, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const url = process.argv.find((a) => /^http:\/\/(localhost|127\.0\.0\.1):\d+\//.test(a));
if (!url) {
  console.error('Usage: electron main.cjs http://localhost:PORT/?token=…');
  process.exit(2);
}
const origin = new URL(url).origin;
const home = process.env.MITZI_HOME || path.join(os.homedir(), '.mitzi');
const stateFile = path.join(home, 'window.json');
const icon = path.join(__dirname, 'icon.png');

app.setName('Mitzi');
// Keep Electron's own profile (cache, cookies) next to Mitzi's data.
app.setPath('userData', path.join(home, 'desktop'));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win;

  const loadState = () => {
    try {
      const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      // Only reuse a position that is still on a connected screen.
      const visible = screen.getAllDisplays().some((d) => {
        const b = d.workArea;
        return s.x >= b.x - 50 && s.y >= b.y - 50 && s.x < b.x + b.width - 100 && s.y < b.y + b.height - 100;
      });
      return visible ? s : { width: s.width, height: s.height, maximized: s.maximized };
    } catch {
      return { width: 1280, height: 860 };
    }
  };
  const saveState = () => {
    if (!win || win.isDestroyed()) return;
    try {
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() }));
    } catch {
      // Not critical.
    }
  };

  const openOutside = (target) => {
    if (/^(https?|mailto):/.test(target)) void shell.openExternal(target);
  };

  const create = () => {
    const state = loadState();
    win = new BrowserWindow({
      x: state.x,
      y: state.y,
      width: state.width || 1280,
      height: state.height || 860,
      minWidth: 420,
      minHeight: 480,
      title: 'Mitzi',
      icon,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#1a1917' : '#faf9f6',
      webPreferences: { contextIsolation: true, sandbox: true, spellcheck: true },
    });
    if (state.maximized) win.maximize();
    win.once('ready-to-show', () => win.show());
    win.on('close', saveState);

    // Links to other sites open in the browser; the window stays on Mitzi.
    win.webContents.setWindowOpenHandler(({ url: target }) => {
      openOutside(target);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, target) => {
      if (!target.startsWith(origin)) {
        e.preventDefault();
        openOutside(target);
      }
    });

    // While Mitzi restarts (after an update), the page is briefly unreachable: keep trying.
    win.webContents.on('did-fail-load', (_e, code, _desc, failedUrl, isMainFrame) => {
      if (isMainFrame && code !== -3) setTimeout(() => !win.isDestroyed() && win.loadURL(failedUrl.startsWith(origin) ? failedUrl : url), 1000);
    });

    // Copy, paste and spelling suggestions on right-click, like a browser.
    win.webContents.on('context-menu', (_e, p) => {
      const items = [];
      for (const s of p.dictionarySuggestions.slice(0, 4)) items.push({ label: s, click: () => win.webContents.replaceMisspelling(s) });
      if (items.length) items.push({ type: 'separator' });
      if (p.linkURL && !p.linkURL.startsWith(origin)) items.push({ label: 'Open link in browser', click: () => openOutside(p.linkURL) }, { type: 'separator' });
      if (p.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' }, { role: 'selectAll' });
      else if (p.selectionText) items.push({ role: 'copy' });
      if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
    });

    void win.loadURL(url);
  };

  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
    // The microphone (live mode) and clipboard are allowed for Mitzi's own page only.
    session.defaultSession.setPermissionRequestHandler((wc, permission, done) => {
      const allowed = ['media', 'clipboard-sanitized-write', 'clipboard-read', 'fullscreen', 'notifications'];
      done(wc.getURL().startsWith(origin) && allowed.includes(permission));
    });
    if (process.platform === 'darwin' && app.dock) app.dock.setIcon(icon);
    create();
  });

  // Closing the window quits Mitzi (the command that opened it stops the server).
  app.on('window-all-closed', () => app.quit());
}
