# Mitzi development notes

- Build everything: `npm run build` (tsc → `dist/`, then Vite → `dist/web`). Tests: `npm test`.
- Run one test file: `npx tsc -p . && node --test dist/tests/server.test.js`; filter with `--test-name-pattern`.
- Type-check the web app: `npx tsc -p web`. Run the app: `node dist/index.js ui`.
- The server and CLI have no runtime dependencies: Node built-ins only. The React app's packages are
  devDependencies because Vite bundles them.
- ESM with NodeNext resolution: relative imports in `src/` must end in `.js`.
- Tools implement `Tool` in `src/tools/types.ts`. Throw `ToolError` for errors the model should see. A tool's
  `kind` decides whether the permission layer asks first. Web-only tools (Artifact, Memory) live in `src/server/tools.ts`.
- Every assistant `tool_calls` entry must be followed by a `tool` message with the same id. `Agent.run` fills in
  "Skipped" results when a turn stops early; keep that invariant.
- Chats keep their full history in `messages`. `contextStart` and `summary` decide what the model actually sees
  (`contextMessages` in `src/server/context.ts`). Never drop messages to save context; compact instead.
- The browser talks to `/api/*` with an `x-mitzi-token` header, and the server checks the Host header. Keep
  both checks: they stop other websites from driving the local agent.
- Tests use mock OpenRouter servers (`src/tests/helpers.ts`, `src/tests/server.test.ts`) and never the network.
- Memory: every bot owns a bank (`src/server/memory/`). The runner recalls before each turn (stored on the user
  message as `memories`, stripped before API calls) and retains the finished exchange in the background. Retrieval
  strategies in `search.ts` are pure functions; keep them testable. `MemoryBackend` has two implementations,
  built-in and Hindsight; keep them interchangeable.
- The default bot (`DEFAULT_BOT_ID = 'mitzi'`, `builtIn: true`) always exists and can't be deleted; chats without a
  bot use it.
