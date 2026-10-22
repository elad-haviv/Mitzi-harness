import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MITZI_HOME } from '../config.js';
import { createApp } from './http.js';

export interface ServerOptions {
  port?: number;
  host?: string;
  dataDir?: string;
  webDir?: string;
  token?: string;
}

/** A stable access token, so bookmarked links keep working across restarts. */
function loadToken(): string {
  const path = join(MITZI_HOME, 'ui-token');
  try {
    const token = readFileSync(path, 'utf8').trim();
    if (token.length >= 32) return token;
  } catch {
    // Create one below.
  }
  const token = randomBytes(24).toString('hex');
  mkdirSync(MITZI_HOME, { recursive: true });
  writeFileSync(path, token, { mode: 0o600 });
  return token;
}

export async function startServer(opts: ServerOptions = {}) {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 4545;
  const token = opts.token ?? loadToken();
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  const handle = createApp({
    dataDir: opts.dataDir ?? join(MITZI_HOME, 'data'),
    webDir: opts.webDir ?? fileURLToPath(new URL('../web/', import.meta.url)),
    token,
    allowedHosts,
  });
  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(err?.message ?? err));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const actualPort = (server.address() as AddressInfo).port;
  if (actualPort !== port) allowedHosts.push(`127.0.0.1:${actualPort}`, `localhost:${actualPort}`);
  return {
    url: `http://localhost:${actualPort}/?token=${token}`,
    port: actualPort,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {
    // No browser available; the URL is printed anyway.
  }
}
