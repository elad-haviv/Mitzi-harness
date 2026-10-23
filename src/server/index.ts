import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MITZI_HOME } from '../config.js';
import { createApp } from './http.js';

export interface ServerOptions {
  port?: number;
  host?: string;
  /** Listen on the local network too, so phones and other computers can open Mitzi. */
  lan?: boolean;
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
  const host = opts.host ?? (opts.lan ? '0.0.0.0' : '127.0.0.1');
  const port = opts.port ?? 4545;
  const token = opts.token ?? loadToken();
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  let origin = `http://localhost:${port}`;
  let lanUrls: string[] = [];
  const handle = createApp({
    dataDir: opts.dataDir ?? join(MITZI_HOME, 'data'),
    webDir: opts.webDir ?? fileURLToPath(new URL('../web/', import.meta.url)),
    token,
    allowedHosts,
    origin: () => origin,
    lanUrls: () => lanUrls,
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
  origin = `http://localhost:${actualPort}`;
  if (opts.lan) {
    for (const ip of lanAddresses()) allowedHosts.push(`${ip}:${actualPort}`);
    lanUrls = lanAddresses().map((ip) => `http://${ip}:${actualPort}/?token=${token}`);
  }
  return {
    lanUrls,
    url: `http://localhost:${actualPort}/?token=${token}`,
    port: actualPort,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        void handle.dispose();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** This computer's addresses on the local network (IPv4, private ranges first). */
export function lanAddresses(): string[] {
  const all = Object.values(networkInterfaces())
    .flat()
    .filter((a): a is NonNullable<typeof a> => !!a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
  const home = (ip: string) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  return [...all.filter(home), ...all.filter((ip) => !home(ip))];
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
