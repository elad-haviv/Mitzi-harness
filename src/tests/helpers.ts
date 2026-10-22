import { createServer, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '../tools/index.js';
import type { UI } from '../ui.js';

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mitzi-test-'));
}

export function makeCtx(cwd: string): ToolContext {
  return { cwd, readFiles: new Map(), todos: [] };
}

export const silentUI: UI = {
  startThinking() {},
  stopThinking() {},
  text() {},
  reasoning() {},
  toolCall() {},
  toolResult() {},
  todos() {},
  info() {},
  warn() {},
  error() {},
  endTurn() {},
};

/** A fake OpenRouter: each request is answered with the next scripted list of SSE chunks. */
export async function mockOpenRouter(script: object[][]): Promise<{ url: string; requests: any[]; server: Server }> {
  const requests: any[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      requests.push(JSON.parse(body));
      const chunks = script.shift();
      if (!chunks) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'script exhausted' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': OPENROUTER PROCESSING\n\n');
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/api/v1`, requests, server };
}

export const textChunks = (text: string) => [
  { choices: [{ delta: { content: text.slice(0, 3) } }] },
  { choices: [{ delta: { content: text.slice(3) }, finish_reason: 'stop' }] },
  { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.001 } },
];

export const toolCallChunks = (id: string, name: string, args: object) => {
  const json = JSON.stringify(args);
  const mid = Math.floor(json.length / 2);
  return [
    { choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: json.slice(0, mid) } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: json.slice(mid) } }] }, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28, cost: 0.002 } },
  ];
};

/** Source of a tiny MCP server: echo (read-only), shout, fail. Speaks JSON-RPC over stdio. */
export const MCP_SERVER_SOURCE = `
const tools = [
  { name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { readOnlyHint: true } },
  { name: 'shout', description: 'Uppercase text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'fail', description: 'Always fails', inputSchema: { type: 'object' } },
];
export function handle(msg) {
  if (msg.method === 'initialize') return { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'test-server', version: '1.0.0' } } };
  if (msg.method === 'tools/list') return { jsonrpc: '2.0', id: msg.id, result: { tools } };
  if (msg.method === 'tools/call') {
    const { name, arguments: a } = msg.params;
    if (name === 'fail') return { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'boom' }], isError: true } };
    return { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: name === 'shout' ? String(a.text).toUpperCase() : 'echo: ' + a.text }] } };
  }
  if (msg.id !== undefined) return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } };
  return undefined;
}
`;

/** Writes the test MCP server as a runnable stdio script; returns its path. */
export function writeStdioMcpServer(dir: string): string {
  const { writeFileSync } = fs;
  const lib = join(dir, 'mcp-lib.mjs');
  const main = join(dir, 'mcp-server.mjs');
  writeFileSync(lib, MCP_SERVER_SOURCE);
  writeFileSync(
    main,
    `import { createInterface } from 'node:readline';
import { handle } from './mcp-lib.mjs';
console.log('starting test server');
createInterface({ input: process.stdin }).on('line', (line) => {
  const reply = handle(JSON.parse(line));
  if (reply) process.stdout.write(JSON.stringify(reply) + '\\n');
});`,
  );
  return main;
}
