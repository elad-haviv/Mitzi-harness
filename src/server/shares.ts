// Share links: read-only snapshots of a chat or artifact at /s/<secret>, which anyone with the link can open
// (while it hasn't expired). The page is served in a sandbox, so it can't reach Mitzi itself.
import { randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { Share } from '../shared/types.js';
import { now, Store } from './store.js';
import { HttpError, Route, str } from './util.js';

const MAX_PAGE = 20 * 1024 * 1024;

/** Opaque origin, no forms posting home, and only the page's own inline styles and sandboxed frames. */
const CSP = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; base-uri 'none'; form-action 'none'";

const view = ({ html: _html, ...s }: Share) => ({ ...s, url: `/s/${s.id}` });

export function registerShareRoutes(route: Route, store: Store): void {
  route('GET', '/api/shares', ({ query }) =>
    store.shares
      .all()
      .filter((s) => !query.get('targetId') || s.targetId === query.get('targetId'))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(view),
  );
  route('POST', '/api/shares', ({ body }) => {
    const kind = body?.kind === 'artifact' ? 'artifact' : body?.kind === 'chat' ? 'chat' : fail('Share a chat or an artifact');
    const targetId = str(body?.targetId);
    if (kind === 'chat' ? !store.chats.get(targetId) : !store.artifacts.get(targetId)) throw new HttpError(404, `That ${kind} doesn’t exist`);
    const html = str(body?.html);
    if (!/^<!doctype html>/i.test(html)) throw new HttpError(400, 'The page is missing');
    if (Buffer.byteLength(html) > MAX_PAGE) throw new HttpError(413, 'The page is larger than 20 MB');
    const days = Number(body?.expiresInDays);
    const share: Share = {
      id: randomBytes(16).toString('base64url'),
      kind,
      targetId,
      title: str(body?.title).slice(0, 200) || 'Shared from Mitzi',
      html,
      createdAt: now(),
      ...(days > 0 ? { expiresAt: new Date(Date.now() + Math.min(days, 365) * 86_400_000).toISOString() } : {}),
      views: 0,
    };
    return view(store.shares.put(share));
  });
  route('DELETE', '/api/shares/:id', ({ params }) => {
    store.shares.delete(params.id);
    return { ok: true };
  });
}

function fail(message: string): never {
  throw new HttpError(400, message);
}

/** GET /s/<id>: the shared page, without the access token. */
export function serveShare(store: Store, id: string, res: ServerResponse): void {
  const share = /^[\w-]{10,64}$/.test(id) ? store.shares.get(id) : undefined;
  const expired = share?.expiresAt && Date.parse(share.expiresAt) < Date.now();
  if (!share || expired) {
    res.writeHead(share ? 410 : 404, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP });
    res.end(`<!doctype html><meta charset="utf-8"><title>Not available</title><body style="font:16px system-ui;display:grid;place-items:center;height:90vh;color:#555"><p>🐱 This link ${expired ? 'has expired' : 'doesn’t exist, or was turned off'}.</p></body>`);
    return;
  }
  share.views++;
  store.shares.put(share);
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  });
  res.end(share.html);
}
