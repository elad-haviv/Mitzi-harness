import { createServer, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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
