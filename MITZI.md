# Mitzi development notes

- Build: `npm run build` (tsc → `dist/`). Tests: `npm test` (builds, then `node --test "dist/tests/*.test.js"`).
- Run a single test file: `npx tsc -p . && node --test dist/tests/tools.test.js`; filter by name with `--test-name-pattern`.
- No runtime dependencies: use Node built-ins only (fetch, readline, child_process, node:test).
- ESM with NodeNext resolution: relative imports must end in `.js`.
- Tools implement `Tool` in `src/tools/types.ts` and are registered in `src/tools/index.ts`. Throw `ToolError` for
  errors the model should see; `kind` decides whether the permission layer prompts.
- Every assistant `tool_calls` entry must be followed by a `tool` message with the same id. `Agent.run` fills in
  "Skipped" results when a turn is stopped early; keep that invariant when changing the loop.
- Tests talk to a mock OpenRouter server (`src/tests/helpers.ts`), never the network.
