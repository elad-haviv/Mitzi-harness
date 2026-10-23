// Checking for and installing updates from inside the app. After an update the process exits with
// RESTART_CODE and the launcher starts the new version; the page reconnects by itself.
import { applyUpdate, checkForUpdates, UpdateEvent, UpdateInfo, updating } from '../updater.js';
import type { Store } from './store.js';
import { HttpError, Route, STREAMED } from './util.js';

const RESTART_CODE = 75;
const RECHECK_MS = 12 * 3600_000;

export function registerUpdateRoutes(route: Route, store: Store): { dispose(): void } {
  let last: UpdateInfo | undefined;
  const check = async () => (last = await checkForUpdates());
  const supervised = process.env.MITZI_SUPERVISED === '1';

  // Check in the background a little after startup, then twice a day.
  const timers: NodeJS.Timeout[] = [];
  if (supervised) {
    const auto = () => store.settings.autoCheckUpdates && void check().catch(() => {});
    timers.push(setTimeout(auto, 15_000), setInterval(auto, RECHECK_MS));
    for (const t of timers) t.unref();
  }

  route('GET', '/api/update', async ({ query }) => {
    if (query.get('refresh') === '1' || !last) await check();
    return { ...last!, updating: updating(), canRestart: supervised };
  });

  // Restarts Mitzi (the launcher starts it again). Only possible under `mitzi ui` / `mitzi web`.
  route('POST', '/api/restart', () => {
    if (!supervised) throw new HttpError(400, 'Restart Mitzi from the terminal');
    setTimeout(() => process.exit(RESTART_CODE), 300);
    return { ok: true };
  });

  route('POST', '/api/update/apply', async ({ req, res }) => {
    if (updating()) throw new HttpError(409, 'An update is already running');
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    req.socket.setTimeout(0);
    const send = (e: UpdateEvent | { type: 'restarting' } | { type: 'restart-required' }) => !res.writableEnded && res.write(`data: ${JSON.stringify(e)}\n\n`);
    const ok = await applyUpdate(send);
    last = undefined;
    if (ok) {
      if (supervised) {
        send({ type: 'restarting' });
        res.end();
        // Let the response reach the browser, then hand over to the new version.
        setTimeout(() => process.exit(RESTART_CODE), 400);
        return STREAMED;
      }
      send({ type: 'restart-required' });
    }
    res.end();
    return STREAMED;
  });

  return { dispose: () => timers.forEach((t) => clearTimeout(t)) };
}
