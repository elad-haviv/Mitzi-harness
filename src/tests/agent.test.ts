import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Agent } from '../agent.js';
import { loadConfig } from '../config.js';
import { OpenRouterClient, OpenRouterError } from '../openrouter.js';
import { Permissions } from '../permissions.js';
import { ALL_TOOLS } from '../tools/index.js';
import { mockOpenRouter, silentUI, tempDir, textChunks, toolCallChunks } from './helpers.js';

process.env.MITZI_HOME = tempDir();
const servers: { close(): void }[] = [];
after(() => servers.forEach((s) => s.close()));

function makeAgent(url: string, cwd: string, mode: 'yolo' | 'default' = 'yolo') {
  const config = loadConfig(cwd, { apiKey: 'test-key', baseUrl: url, model: 'anthropic/test-model' });
  const client = new OpenRouterClient({ apiKey: config.apiKey, baseUrl: config.baseUrl, maxRetries: 0 });
  const permissions = new Permissions(mode, []);
  return new Agent({ client, config, tools: ALL_TOOLS, permissions, ui: silentUI, cwd });
}

test('client streams text and accumulates usage', async () => {
  const mock = await mockOpenRouter([textChunks('Hello world')]);
  servers.push(mock.server);
  const client = new OpenRouterClient({ apiKey: 'k', baseUrl: mock.url });
  let streamed = '';
  const res = await client.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, { onText: (t) => (streamed += t) });
  assert.equal(res.content, 'Hello world');
  assert.equal(streamed, 'Hello world');
  assert.equal(res.usage?.cost, 0.001);
  assert.equal(mock.requests[0].stream, true);
  assert.deepEqual(mock.requests[0].usage, { include: true });
});

test('client surfaces API errors', async () => {
  const mock = await mockOpenRouter([]);
  servers.push(mock.server);
  const client = new OpenRouterClient({ apiKey: 'k', baseUrl: mock.url, maxRetries: 0 });
  await assert.rejects(client.chat({ model: 'm', messages: [] }), (err: any) => err instanceof OpenRouterError && /script exhausted/.test(err.message));
});

test('agent executes a tool call and continues to a final answer', async () => {
  const cwd = tempDir();
  const mock = await mockOpenRouter([
    toolCallChunks('call_1', 'Write', { file_path: 'hello.txt', content: 'hi there\n' }),
    textChunks('Created the file.'),
  ]);
  servers.push(mock.server);
  const agent = makeAgent(mock.url, cwd);

  await agent.run('make hello.txt');

  assert.equal(readFileSync(join(cwd, 'hello.txt'), 'utf8'), 'hi there\n');
  assert.deepEqual(
    agent.messages.map((m) => m.role),
    ['user', 'assistant', 'tool', 'assistant'],
  );
  assert.equal(agent.messages[1].tool_calls?.[0].function.name, 'Write');
  assert.match(String(agent.messages[2].content), /Created hello.txt/);
  assert.equal(agent.usage.requests, 2);
  assert.ok(Math.abs(agent.usage.cost - 0.003) < 1e-9);

  // Second request carries the tool result and the tool specs; anthropic models get cache breakpoints.
  const second = mock.requests[1];
  assert.equal(second.messages.at(-1).role, 'tool');
  assert.ok(second.tools.some((t: any) => t.function.name === 'Bash'));
  assert.equal(second.messages[0].content[0].cache_control.type, 'ephemeral');
});

test('denied tool calls are reported back to the model', async () => {
  const cwd = tempDir();
  const mock = await mockOpenRouter([toolCallChunks('call_1', 'Bash', { command: 'echo nope' }), textChunks('OK, I will not.')]);
  servers.push(mock.server);
  const agent = makeAgent(mock.url, cwd, 'default');

  await agent.run('run something');

  assert.match(String(agent.messages[2].content), /not granted/);
  assert.equal(agent.messages.at(-1)?.content, 'OK, I will not.');
});

test('invalid tool arguments produce an error result instead of crashing', async () => {
  const cwd = tempDir();
  const bad = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'Read', arguments: '{not json' } }] } }] },
  ];
  const mock = await mockOpenRouter([bad, textChunks('Sorry.')]);
  servers.push(mock.server);
  const agent = makeAgent(mock.url, cwd);

  await agent.run('read');

  assert.match(String(agent.messages[2].content), /not valid JSON/);
});

test('compact replaces history with a summary', async () => {
  const cwd = tempDir();
  const mock = await mockOpenRouter([textChunks('First answer'), textChunks('SUMMARY TEXT')]);
  servers.push(mock.server);
  const agent = makeAgent(mock.url, cwd);
  await agent.run('question');
  await agent.compact();
  assert.equal(agent.messages.length, 2);
  assert.match(String(agent.messages[0].content), /SUMMARY TEXT/);
  assert.match(mock.requests[1].messages[0].content, /First answer/);
});
