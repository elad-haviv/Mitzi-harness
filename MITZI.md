# Mitzi development notes

- Build everything: `npm run build` (tsc → `dist/`, then Vite → `dist/web`). Tests: `npm test`.
- Run one test file: `npx tsc -p . && node --test dist/tests/server.test.js`; filter with `--test-name-pattern`.
- Type-check the web app: `npx tsc -p web`. Run the app: `node dist/index.js web` (browser) or `ui` (window).
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
- Extensions: MCP servers live in `store.mcpServers` (files are 0600; they hold tokens). `McpManager` connects lazily
  and turns MCP tools into agent tools named `mcp__<server>__<tool>`. Plugins follow the Claude Code layout;
  `syncPlugins` turns their agents into bots and `.mcp.json` entries into servers, so call it after any plugin change.
- `/api/oauth/callback` is the one route without the app token: the OAuth `state` authenticates it.
- Command templates run their own !`…` snippets before the user's arguments are substituted; keep it that way.
- Providers (`src/providers.ts`): `RoutingClient` implements `LlmClient` and routes on the model id's prefix
  (`openai:gpt-5` → the provider with id `openai`; no known prefix → OpenRouter). Anthropic uses its native API
  (`src/anthropic.ts`, which converts OpenAI-style messages); everything else is OpenAI-compatible. Code that
  calls models takes an `LlmClient`, never a concrete client.
- Media (`src/server/media.ts`): generated files are saved under `<data>/media` with random 32-hex names and served
  at `/media/<file>` without the token (img/video tags can't send headers). Tool results carry a
  `MEDIA: <url> <mime>` line, which the web UI renders inline.
- Artifact workspace (`src/server/workspace.ts`): every artifact belongs to a chat, and its workspace page embeds that
  chat. Messages sent from the workspace carry `focus` (the artifact id); the runner stores it as
  `chat.focusArtifactId`, adds the artifact's latest content and open comments to the system prompt, and offers the
  ArtifactComment tool. Record user edits with `userEdit()` so versions stay attributed. Media tools save their output
  as image/video/audio artifacts. Old Docs (`data/docs`) are migrated into markdown artifacts at startup.
- Media models for Settings come from `MediaService.models()`, which lists each provider's models and classifies
  them by kind; `supports()` says which provider kinds MediaService can call for each kind of media.
- Ratings: `POST /api/chats/:id/messages/:index/rating` stores the rating and distills a lesson with the fast
  model in the background. Lessons live on `bot.lessons` and are included in the system prompt.
- Scheduled tasks (`src/server/scheduler.ts`): schedules are computed in local time. Runs go through
  `ChatRunner.run` with `headless`, whose approver never waits for a person.
- Starters (`src/server/starters.ts`): `GET /api/bots/:id/starters` writes them with the fast model from the bot's
  memories and recent chats, caching per bot until either changes (and for at least 10 minutes). With no history,
  or if generation fails, the bot's own `starters` are returned with `personalized: false`.
- Folders and repositories (`src/server/folders.ts`): `/api/fs/dirs` lists folders for the picker; opening a folder or
  cloning a repository creates (or reuses) a project whose `folder` is set, so chats get the coding tools. git always
  runs through `src/server/git.ts` (no prompts). Clone tokens live in `data/repo-tokens` (0600) and are passed to
  git through `GIT_CONFIG_*` environment variables, never the remote URL.
- Importing (`src/server/importer.ts`, `src/shared/importFormats.ts`): the browser unzips a data export
  (`web/src/unzip.ts`), converts it with the shared format readers, and posts conversations in batches; imported chats
  carry `chat.imported` so importing twice doesn't duplicate. Pasted memory summaries are split by the fast model
  (falling back to one memory per line) and saved with `remember`.
- The logo is the 🐱 emoji (`LOGO` in `web/src/state.tsx` and `src/server/http.ts`); the default bot uses it as its icon.
- Launcher (`src/launcher.ts`): `mitzi ui` and `mitzi web` fork `index.js __serve` with `MITZI_SUPERVISED=1` and wait
  for its IPC `ready` message. A child that exits with `RESTART_CODE` (75) is started again; exit 98 means the port is
  taken. `ui` opens `desktop/main.cjs` in Electron (an optional dependency), then a Chrome/Edge `--app` window, then the
  browser. Closing the window stops the server. The window and the web page both reconnect after a restart.
- Updates (`src/updater.ts`, `src/server/routes-update.ts`): installs are git checkouts. Updating fast-forwards the
  tracked branch, runs `npm install` only when the package files changed, rebuilds, and on any failure resets to the
  previous commit and rebuilds. `MITZI_APP_DIR` points it at another checkout (the tests use this).
- Teams (`src/server/team.ts`): bots with `tools.team` (on unless false) get the Delegate tool, listing the other
  bots. `ChatRunner.runTeammate` runs each assignment as a fresh Agent in the same chat (teammate's prompt, model,
  tools and memory, no Delegate of its own), in parallel, sharing the lead's permissions. Progress streams as
  `delegate` events keyed by the Delegate call id; teammates' usage is added to the chat.
- Streaming text (`web/src/components/Markdown.tsx`): `useSmoothText` reveals text at the stream's average rate, and
  streaming Markdown renders per top-level block so only the last block re-parses each frame.
