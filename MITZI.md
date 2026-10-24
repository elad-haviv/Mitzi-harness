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
- Usage (`src/server/usage.ts`): every `RoutingClient.chat` call is recorded in `<data>/usage/*.jsonl`, tagged through
  `AsyncLocalStorage` (`withUsage`) with what it was for (chat, title, memory, workflow, goal…). A run's `sink` adds up
  its own calls into the response's `stats`, saved on its last assistant message. Background jobs pass `sink: undefined`
  so they don't count toward the answer.
- Work mode, plans and goals (`src/server/agentic.ts`, routes in `routes-work.ts`): `/plan` runs with read-only tools
  plus SubmitPlan; approving sets `chat.mode = 'work'` and the plan's steps as `chat.todos`. `/goal` loops inside one run:
  after each turn `checkGoal` asks the fast model, and an `auto: 'goal'` user message continues it. Messages Mitzi sends
  for the user carry `auto`; `contextMessages` strips it with the other UI-only fields.
- Feedback loops (`store.feedback`): reviews create or extend a loop per task; `redoMessage` builds the next attempt's
  message, and accepting a loop with more than one attempt distills a lesson into `bot.lessons` and memory.
- Workflows (`src/server/workflows.ts`): steps run in dependency order (`order` refuses loops); a step runs when an
  incoming edge's source finished on the matching port. AI steps go through `ChatRunner.runOnce`, which declines tools
  that would ask unless the step allows them. Exposed workflows become the Workflow tool via `runner.extraTools`.
- Browser (`src/server/browser.ts`): playwright-core (optional dependency) drives `browserExecutable()`, with a persistent
  profile in `MITZI_HOME/browser-profile`. Each action returns a text view with numbered elements (`data-mitzi-ref`), and
  a screenshot is emitted to the chat as a `browser` event.
- Verification habit (`src/server/verify.ts`): in work mode, when a turn changed files (successful Write/Edit) in a
  project folder, the runner runs the project's checks (`project.verify.command`, else detected from package.json,
  Makefile, Cargo.toml, go.mod or pytest config) through the permission layer as a Bash call. While they fail it adds
  an `auto: 'verify'` message and the bot keeps working, up to `MAX_VERIFY_ROUNDS` more times. Results are saved on the
  response's last answer as `verify` and streamed as `verify` events.
- Outcome ledger (`src/server/outcomes.ts`): every run that used tools (or ran in work mode) records a `TaskOutcome` in
  `<data>/outcomes/*.jsonl`: tool errors classified by `classifyError` (agent / environment / declined / unknown),
  files written, commands, checks, attempts, and the lesson ids in the prompt. Later signals (reviews, redos, thumbs,
  edits) are appended as amendments via `OutcomeLog.amend`; the outcome id is saved on the response's last answer
  (`outcomeId`, found with `outcomeIdFor`). Feedback loops from before the ledger are backfilled once. `OutcomeLearner`
  distills lessons from outcomes with a signal (`hasSignal`) after `BATCH` new ones per bot and hourly; environment errors
  are shown to the model separately and never become lessons. Lessons go through `addLessons` (`src/server/lessons.ts`)
  and carry a `source`.
- Edit mining (`src/server/edits.ts`): `EditMiner` learns style lessons (`source: 'edit'`) from silent corrections. An
  artifact the user edits after the bot is diffed (`lineDiff`) against the bot's last version once the user pauses
  (`MITZI_EDIT_LEARN_DELAY_MS`, default 90s); files the bot wrote in a project folder are snapshotted after the run and
  compared at the start of the next turn. Each edit also bumps `editsAfter` on the chat's latest outcome.
- Project knowledge (`src/server/project-knowledge.ts`): facts about a project's repository live in
  `store.projectMemory` (keyed by project id), separate from the bots' memory banks. They're learned passively from
  outcomes (`factsFromOutcome`: checks that passed, commands that worked in two tasks, environment failures), from user
  corrections (`looksLikeCorrection`, then the fast model), from the bot's ProjectNote tool, and typed in on the project
  page. `core()` facts go into every prompt for the project, query-free. Consolidation merges them with the fast model.
  `proposal()` turns them into a "Learned by Mitzi" section (between `MD_START`/`MD_END` markers) of the folder's
  MITZI.md/AGENTS.md/CLAUDE.md; the file is only written when the user accepts.
- Teammate debriefs: `runTeammate` records each Delegate/subagent assignment as an outcome with `source: 'teammate'`
  under the teammate's bot (`leadBotId` names the lead). Lessons distilled only from teammate outcomes get
  `source: 'teammate'` and show in the prompt of every bot on the team ("Team lessons").
- Self-review (`src/server/critique.ts`): bots with `selfReview` get one fast-model review of their Write/Edit changes
  (against the task, lessons and project facts) before a work-mode turn ends; findings come back as an
  `auto: 'critique'` message and the bot works once more. Runs before the verification habit, tagged usage kind `review`.
- Lesson hygiene (`src/server/lesson-hygiene.ts`): `scoreLessons` compares how tasks went (`wentWell`) with each lesson in
  the prompt against the bot's tasks without it. After `MIN_USES`, lessons more than `RETIRE_MARGIN` below the baseline
  retire to `bot.retiredLessons` (restorable). Past `TIDY_AT` lessons, the fast model merges duplicates and drops vague or
  contradicted ones. Runs after each outcome distillation and on the learner's hourly pass.
- Learning metrics (`src/server/metrics.ts`, `GET /api/insights/outcomes`): first-try acceptance, finished-on-green
  (first harness check passed), final check pass rate, agent and environment errors per task, week by week with the
  lessons in effect (`lessonsAt`), and per model. Shown on Insights → Learning above the feedback-loop charts.
- Playbooks (`src/server/playbooks.ts`): an outcome that `cleanRun` accepts (project task, real edits, no agent
  mistakes, checks not failing, no redo) is turned into a playbook by the fast model (`store.playbooks`). Tasks that
  match one (`similarity` on key words) get it in the prompt; `settings.toolTraceHints` also adds the tool-call trace
  (`TaskOutcome.trace`). A later redo, low rating or user edit on the source outcome removes the playbook
  (`OutcomeLog.amendListeners`).
- Plan critique: after `/plan` proposes a plan, `checkPlan` asks the fast model where it goes against the bot's lessons
  or the project's facts; findings are saved as `plan.notes` and shown on the plan before approval.
