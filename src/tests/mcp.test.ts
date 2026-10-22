import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { HttpTransport, McpClient, resultText, SseTransport, StdioTransport } from '../server/mcp/client.js';
import { mcpToolName, maskSecrets, mergeSecrets, MASK } from '../server/mcp/manager.js';
import { OAuthFlows, refreshTokens } from '../server/mcp/oauth.js';
import { tempDir, writeStdioMcpServer } from './helpers.js';

const dir = tempDir();
const script = writeStdioMcpServer(dir);
const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

async function handler(): Promise<(msg: any) => any> {
  return (await import(pathToFileURL(join(dir, 'mcp-lib.mjs')).href)).handle;
}

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => resolve(raw));
  });
}

async function listen(fn: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(fn);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test('stdio: connects, lists tools and calls them', async () => {
  const client = new McpClient(new StdioTransport({ command: process.execPath, args: [script] }));
  await client.connect();
  assert.equal(client.serverInfo?.name, 'test-server');
  const tools = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name),
    ['echo', 'shout', 'fail'],
  );
  assert.equal(resultText(await client.callTool('echo', { text: 'hi' })), 'echo: hi');
  const failed = await client.callTool('fail', {});
  assert.equal(failed.isError, true);
  await assert.rejects(client.request('nope/method'), /Method not found/);
  await client.close();
});

test('stdio: reports a missing command', async () => {
  const client = new McpClient(new StdioTransport({ command: 'definitely-not-a-real-command-xyz', args: [] }));
  await assert.rejects(client.connect(5000), /not found|ENOENT|exited/);
});

test('streamable HTTP: JSON and SSE responses, session header', async () => {
  const handle = await handler();
  const seenSessions: (string | undefined)[] = [];
  const url = await listen(async (req, res) => {
    if (req.method === 'DELETE') return void res.writeHead(204).end();
    const msg = JSON.parse(await body(req));
    seenSessions.push(req.headers['mcp-session-id'] as string | undefined);
    const reply = handle(msg);
    if (!reply) {
      res.writeHead(202).end();
      return;
    }
    const headers: Record<string, string> = msg.method === 'initialize' ? { 'mcp-session-id': 'sess-1' } : {};
    // Answer tool calls as an event stream, everything else as plain JSON.
    if (msg.method === 'tools/call') {
      res.writeHead(200, { 'content-type': 'text/event-stream', ...headers });
      res.end(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
    } else {
      res.writeHead(200, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(reply));
    }
  });
  const client = new McpClient(new HttpTransport({ url, token: async () => 'tok' }));
  await client.connect();
  assert.equal((await client.listTools()).length, 3);
  assert.equal(resultText(await client.callTool('shout', { text: 'hey' })), 'HEY');
  assert.equal(seenSessions[0], undefined);
  assert.ok(seenSessions.slice(1).every((s) => s === 'sess-1'));
  await client.close();
});

test('legacy SSE transport', async () => {
  const handle = await handler();
  let stream: ServerResponse | undefined;
  const url = await listen(async (req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: endpoint\ndata: /messages?session=1\n\n');
      stream = res;
      return;
    }
    const reply = handle(JSON.parse(await body(req)));
    res.writeHead(202).end();
    if (reply) stream!.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
  });
  const client = new McpClient(new SseTransport({ url: `${url}/sse` }));
  await client.connect();
  assert.equal(resultText(await client.callTool('echo', { text: 'old' })), 'echo: old');
  await client.close();
  stream?.end();
});

test('OAuth: discovery, dynamic registration, PKCE code exchange and refresh', async () => {
  let base = '';
  const registered: any[] = [];
  let tokenRequests: URLSearchParams[] = [];
  let lastChallenge = '';
  base = await listen(async (req, res) => {
    const url = new URL(req.url!, base);
    const json = (status: number, data: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(data));
    };
    if (url.pathname === '/mcp') {
      return json(401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="read write"` });
    }
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp') return json(200, { resource: `${base}/mcp`, authorization_servers: [`${base}/auth`] });
    if (url.pathname === '/.well-known/oauth-authorization-server/auth') {
      return json(200, { issuer: `${base}/auth`, authorization_endpoint: `${base}/auth/authorize`, token_endpoint: `${base}/auth/token`, registration_endpoint: `${base}/auth/register` });
    }
    if (url.pathname === '/auth/register') {
      registered.push(JSON.parse(await body(req)));
      return json(201, { client_id: 'client-123' });
    }
    if (url.pathname === '/auth/token') {
      const form = new URLSearchParams(await body(req));
      tokenRequests.push(form);
      if (form.get('grant_type') === 'authorization_code') {
        const verifier = form.get('code_verifier')!;
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        if (challenge !== lastChallenge) return json(400, { error: 'invalid_grant' });
        return json(200, { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 });
      }
      return json(200, { access_token: 'access-2', expires_in: 3600 });
    }
    json(404, {});
  });

  const probe = await fetch(`${base}/mcp`, { method: 'POST' });
  const www = probe.headers.get('www-authenticate')!;
  const flows = new OAuthFlows();
  const authUrl = new URL(await flows.start({ serverId: 's1', serverUrl: `${base}/mcp`, redirectUri: 'http://localhost:4545/api/oauth/callback', wwwAuthenticate: www }));
  assert.equal(authUrl.origin + authUrl.pathname, `${base}/auth/authorize`);
  assert.equal(authUrl.searchParams.get('client_id'), 'client-123');
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authUrl.searchParams.get('resource'), `${base}/mcp`);
  assert.equal(authUrl.searchParams.get('scope'), 'read write');
  assert.deepEqual(registered[0].redirect_uris, ['http://localhost:4545/api/oauth/callback']);
  lastChallenge = authUrl.searchParams.get('code_challenge')!;

  const { serverId, oauth } = await flows.finish(authUrl.searchParams.get('state')!, 'the-code');
  assert.equal(serverId, 's1');
  assert.equal(oauth.accessToken, 'access-1');
  assert.equal(tokenRequests[0].get('code'), 'the-code');
  await assert.rejects(flows.finish(authUrl.searchParams.get('state')!, 'again'), /expired/);

  tokenRequests = [];
  const refreshed = await refreshTokens(oauth);
  assert.equal(refreshed.accessToken, 'access-2');
  assert.equal(refreshed.refreshToken, 'refresh-1');
  assert.equal(tokenRequests[0].get('grant_type'), 'refresh_token');
});

test('tool naming and secret masking', () => {
  assert.equal(mcpToolName('My Server!', 'get-item'), 'mcp__my_server__get-item');
  const long = mcpToolName('x'.repeat(40), 'y'.repeat(60));
  assert.ok(long.length <= 64 && /^[a-zA-Z0-9_-]+$/.test(long));
  const masked = maskSecrets({ API_KEY: 'secret', REGION: 'eu', Authorization: 'Bearer x' });
  assert.deepEqual(masked, { API_KEY: MASK, REGION: 'eu', Authorization: MASK });
  assert.deepEqual(mergeSecrets({ API_KEY: MASK, REGION: 'us' }, { API_KEY: 'secret', REGION: 'eu' }), { API_KEY: 'secret', REGION: 'us' });
});
