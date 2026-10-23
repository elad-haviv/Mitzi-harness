import { existsSync } from 'node:fs';

/** Chrome, Edge or Chromium installed on this computer, if any. */
export function chromiumBinary(): string | undefined {
  const candidates =
    process.platform === 'win32'
      ? [
          `${process.env['PROGRAMFILES(X86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
          `${process.env.PROGRAMFILES}\\Microsoft\\Edge\\Application\\msedge.exe`,
          `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium']
        : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/snap/bin/chromium'];
  return candidates.find((p) => p && !p.includes('undefined') && existsSync(p));
}
