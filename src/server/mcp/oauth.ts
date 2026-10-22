// OAuth 2.1 for remote MCP servers, per the MCP authorization spec: protected resource
// metadata (RFC 9728) → authorization server metadata (RFC 8414) → dynamic client
// registration (RFC 7591) → authorization code + PKCE, with refresh tokens.
import { createHash, randomBytes } from 'node:crypto';
import type { McpOAuthState } from '../../shared/types.js';

interface ServerMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
}

interface PendingAuth {
  serverId: string;
  verifier: string;
  clientId: string;
  clientSecret?: string;
  tokenEndpoint: string;
  redirectUri: string;
  resource: string;
  scope?: string;
  createdAt: number;
}

const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function getJson(url: string): Promise<any | undefined> {
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    return res.ok ? await res.json() : undefined;
  } catch {
    return undefined;
  }
}

/** Finds the authorization server for an MCP endpoint, given the 401's WWW-Authenticate header if any. */
export async function discover(serverUrl: string, wwwAuthenticate = '') {
  const u = new URL(serverUrl);
  const path = u.pathname.replace(/\/$/, '');
  const hinted = /resource_metadata="([^"]+)"/.exec(wwwAuthenticate)?.[1];
  const scopeHint = /scope="([^"]+)"/.exec(wwwAuthenticate)?.[1];
  const prmUrls = hinted ? [hinted] : [...(path ? [`${u.origin}/.well-known/oauth-protected-resource${path}`] : []), `${u.origin}/.well-known/oauth-protected-resource`];
  let prm: any;
  for (const url of prmUrls) if ((prm = await getJson(url))) break;

  const issuer = new URL(prm?.authorization_servers?.[0] ?? u.origin);
  const ipath = issuer.pathname.replace(/\/$/, '');
  const asUrls = ipath
    ? [`${issuer.origin}/.well-known/oauth-authorization-server${ipath}`, `${issuer.origin}/.well-known/openid-configuration${ipath}`, `${issuer.origin}${ipath}/.well-known/openid-configuration`]
    : [`${issuer.origin}/.well-known/oauth-authorization-server`, `${issuer.origin}/.well-known/openid-configuration`];
  let meta: ServerMetadata | undefined;
  for (const url of asUrls) if ((meta = await getJson(url))?.authorization_endpoint) break;
  // Servers predating metadata discovery use these default paths.
  meta ??= { authorization_endpoint: `${issuer.origin}/authorize`, token_endpoint: `${issuer.origin}/token`, registration_endpoint: `${issuer.origin}/register` };

  return {
    metadata: meta,
    resource: (prm?.resource as string | undefined) ?? `${u.origin}${u.pathname}`,
    scope: scopeHint ?? (Array.isArray(prm?.scopes_supported) ? prm.scopes_supported.join(' ') : undefined),
  };
}

export class OAuthFlows {
  private readonly pending = new Map<string, PendingAuth>();

  /** Prepares an authorization request; returns the URL to open in the browser. */
  async start(opts: { serverId: string; serverUrl: string; redirectUri: string; wwwAuthenticate?: string; existing?: McpOAuthState }): Promise<string> {
    const { metadata, resource, scope } = await discover(opts.serverUrl, opts.wwwAuthenticate);

    let clientId = opts.existing?.clientId;
    let clientSecret = opts.existing?.clientSecret;
    if (!clientId) {
      if (!metadata.registration_endpoint) {
        throw new Error("This server doesn't support automatic client registration. Add an access token in the connector's headers instead.");
      }
      const res = await fetch(metadata.registration_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          client_name: 'Mitzi',
          redirect_uris: [opts.redirectUri],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`Client registration failed (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
      const reg = (await res.json()) as { client_id: string; client_secret?: string };
      clientId = reg.client_id;
      clientSecret = reg.client_secret;
    }

    const verifier = b64url(randomBytes(32));
    const state = b64url(randomBytes(24));
    this.pending.set(state, {
      serverId: opts.serverId,
      verifier,
      clientId,
      clientSecret,
      tokenEndpoint: metadata.token_endpoint,
      redirectUri: opts.redirectUri,
      resource,
      scope,
      createdAt: Date.now(),
    });
    for (const [k, p] of this.pending) if (Date.now() - p.createdAt > 15 * 60_000) this.pending.delete(k);

    const url = new URL(metadata.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', opts.redirectUri);
    url.searchParams.set('code_challenge', b64url(createHash('sha256').update(verifier).digest()));
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    url.searchParams.set('resource', resource);
    if (scope) url.searchParams.set('scope', scope);
    return url.toString();
  }

  /** Exchanges the authorization code from the redirect for tokens. */
  async finish(state: string, code: string): Promise<{ serverId: string; oauth: McpOAuthState }> {
    const p = this.pending.get(state);
    if (!p) throw new Error('This sign-in link has expired. Start again from Mitzi.');
    this.pending.delete(state);
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: p.redirectUri,
      client_id: p.clientId,
      code_verifier: p.verifier,
      resource: p.resource,
    });
    if (p.clientSecret) body.set('client_secret', p.clientSecret);
    const tokens = await tokenRequest(p.tokenEndpoint, body);
    return {
      serverId: p.serverId,
      oauth: {
        clientId: p.clientId,
        clientSecret: p.clientSecret,
        tokenEndpoint: p.tokenEndpoint,
        resource: p.resource,
        scope: tokens.scope ?? p.scope,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
      },
    };
  }
}

async function tokenRequest(endpoint: string, body: URLSearchParams) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Token request failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
  const json = JSON.parse(text) as { access_token: string; refresh_token?: string; expires_in?: number; scope?: string };
  if (!json.access_token) throw new Error('The token response had no access token');
  return json;
}

/** Uses the refresh token to get a new access token. */
export async function refreshTokens(oauth: McpOAuthState): Promise<McpOAuthState> {
  if (!oauth.refreshToken || !oauth.tokenEndpoint) throw new Error('No refresh token');
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: oauth.refreshToken, client_id: oauth.clientId });
  if (oauth.resource) body.set('resource', oauth.resource);
  if (oauth.clientSecret) body.set('client_secret', oauth.clientSecret);
  const tokens = await tokenRequest(oauth.tokenEndpoint, body);
  return {
    ...oauth,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? oauth.refreshToken,
    expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
  };
}
