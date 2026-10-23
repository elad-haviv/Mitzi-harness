# Mitzi

An open-source, Claude-style AI workspace that runs on **any model available through [OpenRouter](https://openrouter.ai)**, or directly on **OpenAI, Anthropic, Google Gemini, xAI, Groq, Mistral, DeepSeek, Together, Ollama, LM Studio** or any OpenAI-compatible API with your own keys. It runs locally in your browser and offers chats, projects, artifacts, documents, custom bots, long-term memory, scheduled tasks, image/video/audio generation, voice conversations, and context management. When a project points at a folder, Mitzi also works as a coding agent that edits files and runs commands there. A terminal version is included.

![Chat with an artifact](docs/screenshots/chat-artifact.png)

## Features

**Chats**
- **Search everything** with Ctrl+K (⌘K on a Mac): chats down to the exact message, artifacts and memories, with the matching words highlighted. Choosing a result jumps to the message. With an embedding model set (Settings → Memory), results also match by meaning.
- Responses stream in smoothly, at an even pace rather than in bursts, with Markdown, tables and syntax-highlighted code.
- Attach documents (PDF, Word, Excel, PowerPoint), text and code files, or images. You can paste or drag and drop them into the message box. Documents are read in your browser: Word keeps its headings, lists and tables, Excel sheets arrive as CSV, slides keep their speaker notes. Project knowledge accepts the same documents.
- **Budgets and alerts**: set a daily or monthly spending limit (Settings → Usage & budget). Mitzi warns you when you near it (at 80% by default), and can stop new requests, scheduled tasks and workflows included, once a limit is reached.
- **Auto model**: pick *Auto* in the model picker and Mitzi chooses a model for each message: a quick, cheap one for everyday questions and a strong one for code, analysis, long documents and multi-step work. Each answer shows which model it used and why, and Insights shows the split and the estimated savings. Choose the two models in Settings → Models.
- Edit any earlier message, regenerate the last answer, stop a response mid-stream, and copy replies.
- **Approval levels, cat style**: 🐱 *Kitten* asks before every change, 🐈 *House cat* works on its own and asks only before risky actions (deleting, installing, pushing, system changes, writing outside the project, acting in connected apps), and 🐈‍⬛ *Alley cat* never asks. Pick one per chat from the chat box (Shift+Tab cycles), and the default in Settings → General.
- **Work in several chats at once**: chats keep working in the background when you switch away, and coming back picks the response up live, thought process and stopwatch included. Open chats show as tabs (with a spinner while working and 🐾 when one needs your approval), and you get a notice when a background chat finishes.
- **Queue and interrupt**: keep typing while Mitzi works. Enter queues the message (it goes when the current response is done, even in the background), and *Send now* or Ctrl/⌘+Enter stops the response and sends it right away. Queued messages show above the chat box, where you can drag them into a different order (or move one with the arrow keys), send one now or take it back.
- **Hebrew interface**: switch the language in Settings → General (it follows your browser's language at first). The whole interface is translated and mirrored right to left; code stays left to right, and answers, names and what you type each follow their own language, so English and Hebrew mix naturally. Suggested starters come in the interface's language too.
- **Your prompt stays in sight**: once you scroll past your latest message (say, while reading a long answer), it stays pinned at the top of the chat; click it to jump back.
- **Questions from Mitzi**: when Mitzi needs you to decide something, it asks in a card with choices to click (one, or several) or room to answer in your own words, and carries on with your answer; *Skip* lets it decide. On Telegram the choices come as buttons, and a reply answers too.
- **Subagents**: a bot can split focused parts of a task off to copies of itself. Each starts with a clean context and the same tools, they work at the same time, and their progress shows live in the chat before the bot combines their results (turn it off per bot under Capabilities).
- **Large project knowledge**: add as many documents as you like, or link folders on your computer (kept up to date). When knowledge is too big to send whole, each message gets the passages most relevant to it, and Mitzi can search the rest with the ProjectKnowledge tool.
- **Python sandbox**: bots can run Python (Pyodide, in a worker thread) for calculations, data analysis and charts. numpy, pandas, matplotlib and more load on first import; variables carry over within a chat; charts and saved images appear in the chat. Code works in the chat’s own folder, or in the project’s folder when it has one (then it counts as an edit for approvals).
- **More workflow steps**: *For each* (split the input into items and run a prompt or text on each, a few at a time), *Code* (JavaScript or Python over the input), *Wait*, and *Approval*, which pauses the run until you approve or reject it in the editor and continues down the matching path.
- **Workflow gallery and builder**: start from ten ready-made workflows (research briefs, translations, meeting follow-ups, approvals, API and CSV crunching, a morning briefing…), or describe what you want and Mitzi builds the workflow for you to check and run.
- **Workflow triggers**: a secret webhook address runs a workflow with whatever is posted to it (from scripts, other apps, or email services that forward to a webhook), and a watched folder runs it for each new or changed text file. Runs waiting for your approval show a badge on Workflows.
- **Messaging: Telegram, Discord, Slack, WhatsApp and email**: chat with Mitzi from wherever you are. Set a service up in Settings → Messaging (each one lists its steps) and pair a conversation with a one-time code; only paired conversations get answers. Answers stream in where the service can edit messages, approvals and Mitzi’s questions come as buttons (or numbered replies, by email), voice notes are transcribed, photos and text files come through, and /new, /stop and /workflow work (`!new` and so on in Slack). Workflow approvals and finished scheduled tasks come to you there too. Telegram, Discord and Slack connect from your computer, so they work anywhere; WhatsApp needs a public address for its webhook (a tunnel); email reads only new mail in a mailbox of Mitzi’s own and leaves strangers’ mail unread. Discord and Slack need Node.js 22.
- **Sharing**: share a chat or an artifact as a read-only link (expiring after a day, a week, a month, or never), or download it as a single web page with everything inside. Share pages open sandboxed, can be turned off any time, and stop working when the chat is deleted.
- **Mitzi on your phone**: start with `mitzi web --lan` and scan the QR code (in the terminal, or Settings → Phone & notifications) on the same Wi-Fi. Add it to your home screen to use it like an app. System notifications tell you when a chat finishes or needs your approval while you’re elsewhere.
- **Realtime voice**: pick a realtime model (OpenAI `gpt-realtime` or `gpt-realtime-mini`, or Google's Gemini Live models such as Gemini 2.5 Flash Native Audio, with your Google API key) in Settings → Media & voice, and the voice button starts a spoken conversation that answers as you talk and lets you interrupt. Audio goes straight between your browser and the provider with a short-lived, single-use key (your API key stays on your computer); what both of you said is saved to the chat. Without a realtime model, the voice button uses the turn-by-turn live mode.
- **Computer control** (off by default): turn it on in Settings → General and bots can take screenshots and use the mouse and keyboard to work in your apps, on macOS, Windows and Linux (X11, with xdotool and ImageMagick). Each step asks first unless the chat is on Alley cat; screenshots go to the chat’s model, so pick one that can see images. Only the latest few screenshots are sent, to keep requests small.
- Switch models per chat. The model picker is searchable and shows each model's price, context size, and vision and tool support.
- One-click web search uses OpenRouter's `:online` option.
- Chats get titles automatically. Rename, pin, delete or move a chat to a project from its **⋯** menu in the sidebar (or right-click it), and search them.
- **Group the chat list** by date, project, bot or model; click a group's name to fold it.
- **Branch** a chat from any answer: the new chat has the conversation up to that point (and copies of its artifacts), and the original stays as it was.
- **Read aloud** any answer, with your browser's voices or a natural voice from OpenAI, ElevenLabs, Google Gemini or any text-to-speech model on OpenRouter. If the speech model fails, Mitzi tells you why and reads with the browser's voice instead.
- **Rate answers** with 👍 / 👎 and an optional comment. The bot distills each rating into a lesson ("Keep explanations short and lead with an example"), keeps it in mind in later chats and saves it to its memory bank. Lessons are listed, and can be removed, in the bot's settings.

![A rating becomes a lesson](docs/screenshots/rating-lesson.png)

**Providers.** Add as many providers as you like in Settings → Providers. Each provider's models appear in the model picker, grouped by provider, with ids like `openai:gpt-5`, `anthropic:claude-sonnet-4-5` or `google:gemini-2.5-pro`; OpenRouter ids stay as they are (`anthropic/claude-sonnet-4.5`). Anthropic is called through its native Messages API (with prompt caching); the others through their OpenAI-compatible APIs. Keys can also come from environment variables (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, …).

Every job can use a different provider: for example chat with a model on OpenRouter, speech with Google's Gemini voices and transcription with Groq. Settings → Models shows which model and provider each job uses.

![Providers](docs/screenshots/providers.png)

**Live conversation.** Press the waveform button in the message box to talk hands-free: Mitzi listens, answers out loud, and listens again. You can interrupt it mid-answer. It works in any language: with a transcription model (e.g. Whisper or GPT-4o Transcribe) set, Mitzi detects the language you speak, so you can switch languages mid-conversation. Without one, it uses the browser's speech recognition, which hears one language at a time: Mitzi guesses it from your chat (Hebrew, Arabic, Russian, Japanese and other non-Latin scripts) or uses the one you pick in live mode or Settings → Media & voice. Answers are read aloud with a voice that speaks their language, and right-to-left text displays right to left. While you talk, Mitzi appears as an animated cat: its ears perk up as it listens, its eyes widen as you speak, it looks around while it thinks, its mouth moves as it answers (with the sound itself in realtime voice), and it naps when paused.

**Media generation.** Bots can create images (OpenAI GPT Image, Google Imagen and Gemini "Nano Banana", or image models on OpenRouter), short videos (OpenAI Sora, Google Veo), speech, sound effects and music (ElevenLabs). In Settings → Media & voice, each kind has the same searchable model picker as chat models, filled from your providers' own model lists. Results play inline in the chat and are saved as artifacts.

![Image generation](docs/screenshots/image-generation.png)


**Scheduled tasks.** Prompts that run on their own: once, every N minutes, daily, weekly or on a cron schedule. Each run is answered by the bot you choose (optionally in a project) and saved as a chat, either a new one per run or one continuing chat. The sidebar shows a badge when new results arrive. Tasks run while Mitzi is open; missed runs catch up when it starts. Tools that normally ask for permission are skipped in unattended runs unless you allow them for that task.

![Scheduled tasks](docs/screenshots/scheduled-tasks.png)

**Artifacts.** Substantial output opens in a side panel instead of cluttering the chat:
- Types: documents, presentations, web pages, React components, code files, SVG graphics, Mermaid diagrams, and generated images, video and audio.
- Web pages, components, SVG and diagrams render live in a sandboxed frame; presentations show as slides with a full-screen presenter mode.
- The model edits artifacts in place with small targeted updates instead of rewriting them each time.
- All artifacts are collected in a gallery. Start a new document, presentation, web page, component, script or diagram there from a short brief, and the bot makes the first version.

**Workspace.** Open any artifact to work on it in the style of Gemini Canvas or Claude's docs: the artifact on the left, its chat on the right.
- Edit it yourself (a Read/Write view for documents and slides, Preview/Code for web pages and components), or ask the bot for changes.
- Select any passage to comment on it or ask about it. "Address all" has the bot work through your comments: it makes the changes, replies and resolves each thread.
- Every change, yours or the bot's, is a version you can view and restore.

![Workspace](docs/screenshots/docs.png)

![Presentation](docs/screenshots/presentation.png)

**Projects** group chats around shared context:
- *Instructions* are added to every chat in the project.
- *Knowledge files* are reference documents included in every chat's context.
- A *coding workspace* links a local folder. Chats in the project then get Read, Write, Edit, Bash, Glob, Grep and the other coding tools, with a permission prompt (showing a diff) before anything changes.
- **Pick where to work from the message box:** the project button next to the model picker sets a new chat's project, or moves an existing chat. From the same menu:
  - **Open a folder…** browses the folders on your computer and starts working there (Mitzi makes a project for the folder, or reuses the one it has).
  - **Connect a repository…** clones a GitHub, GitLab or any git repository (`owner/repo`, an https or SSH URL, a branch, and an access token for private ones) and opens it as a project. The project page shows its branch, local changes and commits to push or pull, with a **Pull latest** button. Tokens are stored only on your computer and never written into the repository's config.

![Coding agent asking for permission](docs/screenshots/coding-permission.png)

**Modes.** The new-chat screen (and every chat's header) switches between **Chat**, for talking things through; **Work**, for handing over a task, where Mitzi plans, keeps a task list in the side panel and keeps going until it's done; and **Workflow**, which opens your workflows.

**Plans, goals and side questions** (slash commands, like in Claude Code and Codex):
- `/plan <task>`: Mitzi looks around with tools that can't change anything and proposes a plan. **Approve and start** switches to Work mode with the plan's steps as the task list; **Change it** re-plans with your notes.
- `/goal <goal>`: Mitzi keeps working, turn after turn, until a check (by the fast model) says the goal is met, or it runs out of turns (20; `/goal resume` grants more). `/goal pause`, `/goal resume`, `/goal clear` and `/goal` control it; a bar above the message box shows its progress.
- `/subgoal <milestone>` adds milestones to the goal (`/subgoal done 2` checks one off); Mitzi checks them off as it works.
- `/btw <question>` asks a quick side question about the conversation, even while Mitzi is working. It answers beside the chat without tools, and nothing is added to the conversation.

**Stopwatch and usage.** While Mitzi responds, a stopwatch shows how long it has been working (and how long it has been thinking). Every answer then shows its time, tokens and cost. The context meter in the message box opens a summary of the context window; **Show details** opens the full breakdown.

**Side panel.** The panel button in a chat's header opens tabs for the **task list** (with the plan and goal), the chat's **artifacts**, the **browser**, the **context** window and the chat's **usage**, response by response.

**Insights.** Usage and costs over 7, 30 or 90 days, by day, model, project, bot, activity and chat (prices come from your providers, or from the model list when a provider doesn't report them). Project pages show their own usage. The **Learning** tab charts how your bots learn from feedback.

**Feedback loops.** Under any answer, **Review** rates how well it did the task, from 1 to 5. If it missed, say what you meant, what it did instead, and how to redo it; Mitzi redoes the task with your directions, as many times as it takes. When you accept a result, the bot turns your directions into a lesson for similar tasks (and saves it to its memory). Insights → Learning shows the attempts each task needed and first-try ratings over time, so you can see whether it's getting things right sooner.

**Workflows.** Automations built on a canvas, in the style of n8n: steps that ask a bot (optionally with its tools), read a web page, call an API, branch on a condition, build text, generate an image, save an artifact or remember something, connected by dragging from one step to the next. Run one with live step-by-step status and a log of each step's output, put it on a schedule, or turn on **Use in chats** so bots can run it when you ask (they ask first).

**Browser use.** Bots can drive a real browser (your Chrome or Edge, through Playwright): open pages, read them, click, fill in forms. You see each page in the chat's side panel as it works, and it asks before each step unless you allow it for the chat. The browser keeps its own profile, so sites you sign in to stay signed in; Settings → General can show its window so you can watch or take over. It never types passwords or payment details.

**Bot teams.** A bot can hand parts of a task to your other bots. Ask Mitzi to research something and write it up, and it can give the research to your Researcher bot and the draft to your Writer bot. They work at the same time, each with its own instructions, model, tools and memory, and Mitzi combines their results. The chat shows each teammate's task and progress, and you can open each one's answer. Turn this off per bot with its **Team** capability.

**Bots** are reusable assistants with their own icon, instructions, model, temperature, capabilities and conversation starters. Once a bot knows you, the starters on the new-chat screen are written from its memories and your recent conversations ("Make a study plan for my biology exam on Nov 12"), and refresh as you keep talking. **Mitzi** 🐱, the default bot, is always there and handles every chat that doesn't pick another bot. You can customize it but not delete it. Three example bots are included.

**Memory banks.** Every bot has its own long-term memory, modeled on [Hindsight](https://github.com/vectorize-io/hindsight)'s retain → recall → reflect design:
- **Retain:** after each exchange, the bot extracts durable *facts* (about you and your world) and *experiences* (what it did for you). It then consolidates them into *beliefs* (observations) that cite their supporting facts and grow more confident as evidence accumulates. Contradicting facts revise beliefs rather than piling up.
- **Recall:** before every message, relevant memories are retrieved by several strategies at once: keyword (BM25), an entity graph, time expressions ("last week", "in March") and, optionally, semantic embeddings. Reciprocal rank fusion merges the results within a token budget. Each answer shows which memories it used.
- **Reflect:** ask a bank a broad question and it reasons over everything it remembers.
- **Per-bank settings:** each bank has a *mission* (what to focus on) and a *disposition* (skepticism, literalism and empathy, 1–5) that shapes how memories are formed and interpreted.
- **Memory page:** browse, search, edit, forget or teach each bank, test recall, or ask it to reflect. The model can also save, search and forget memories itself.
- **Import from other AIs:** like Gemini's memory import. Mitzi gives you a prompt to run in ChatGPT, Claude or Gemini; paste the answer back and Mitzi splits it into separate memories for you to review, edit and save to any bot. You can also import your **chat history** from a ChatGPT or Claude data export (the .zip, unpacked in your browser): conversations appear in your chat list and can be continued, and Mitzi can learn about you from the most recent ones in the background.
- **Hindsight server (optional):** you can point Mitzi at a real Hindsight server instead of the built-in engine (Settings → Memory).

![Memory bank](docs/screenshots/memory-bank.png)

**Connectors (MCP).** Give any bot tools from your apps through the [Model Context Protocol](https://modelcontextprotocol.io):
- **Directory:** one-click connectors for Notion, Linear, Atlassian, Sentry, Vercel, Supabase, Stripe, GitHub, Hugging Face, Context7 and DeepWiki, plus local ones (Filesystem, Browser/Playwright, Brave Search, Git, Fetch, Sequential Thinking).
- **Custom servers:** add any MCP server over stdio (a local command), Streamable HTTP, or the older SSE transport.
- **Sign-in:** remote servers that use OAuth sign in through the browser, following the MCP authorization spec (discovery, dynamic client registration, PKCE, token refresh).
- **Permissions:** per connector, choose *ask every time*, *allow read-only tools*, or *always allow*, and turn individual tools on or off.

![Connectors](docs/screenshots/connectors.png)

**Skills.** These are packaged instructions in Claude's `SKILL.md` format. Bots see each skill's name and description, and load the full instructions (and any supporting files) only when a task needs them. You can write skills in the app, import a skill folder, or install them with plugins. Skills in `~/.claude/skills` are picked up too.

**Plugins.** Mitzi installs **Claude Code plugins and marketplaces** as they are:
- **What a plugin contributes:** a plugin's skills, slash commands (`commands/*.md`, including `$ARGUMENTS` and `` !`shell` `` context in coding projects), agents (which become bots) and MCP servers (`.mcp.json`, which become connectors) all work. Hooks are listed but not run.
- **Sources:** install from GitHub (`owner/repo`), any git URL, or a local folder.
- **Marketplaces:** add one, for example `anthropics/claude-plugins-official`, `anthropics/claude-code` or `anthropics/skills`, and browse and install from it.
- **Slash commands:** type `/` in the chat box to pick one.

![Plugins](docs/screenshots/plugins.png)

**Context management**
- A meter in the message box shows how full the model's context window is.
- The context panel breaks the window down: system prompt, project knowledge, memory, tool definitions, summary and conversation.
- When a chat nears the model's limit, older messages are summarized automatically, keeping the most recent turns word for word. You can also compact manually or restore the full history.
- You always see the complete conversation. Only the model receives the summary.

![Context window panel](docs/screenshots/context-window.png)

**Also included:** light and dark themes, a layout that works on phones, and a cheaper "fast model" setting for titles and summaries.

## Install

You need [Node.js 20+](https://nodejs.org) and [git](https://git-scm.com).

**macOS / Linux**, in Terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/elad-haviv/Mitzi-harness/feature/web-ui/install.sh | bash
```

**Windows**, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/elad-haviv/Mitzi-harness/feature/web-ui/install.ps1 | iex
```

The installer puts Mitzi in `~/.mitzi/app` and adds a `mitzi` command. On Windows it also creates Desktop and Start menu shortcuts. Then start the app with `mitzi ui`. Mitzi checks for updates by itself and offers them in the app (**Settings → Updates**); you can also run `mitzi update` or the install line again.

### From source

```bash
git clone https://github.com/elad-haviv/Mitzi-harness.git
cd Mitzi-harness
npm install
npm run build
npm link          # puts `mitzi` on your PATH

mitzi ui          # opens the app in its own window
mitzi web         # or in your browser
```

Add your OpenRouter key in **Settings**. You can get one at <https://openrouter.ai/keys>. Alternatively, set `OPENROUTER_API_KEY` before starting.

`mitzi ui` opens Mitzi in a desktop window. It uses Electron, which npm installs as an optional dependency; if Electron isn't available, it opens a Chrome or Edge app window, and failing that, your browser. Closing the window stops Mitzi. `mitzi web` runs the same app in your browser instead.

Both serve the app at `http://localhost:4545`. It only accepts connections from your own machine and requires a private access token, which is included in the link it prints. Use `--port` to change the port and `--no-open` to start without opening anything.

When an update is available, the sidebar says so. **Settings → Updates** lists what's new and installs it; Mitzi restarts by itself and the window reconnects. If an update fails, Mitzi goes back to the version you had.

<p>
  <img src="docs/screenshots/project.png" width="49%" alt="A project with instructions and knowledge files">
  <img src="docs/screenshots/bots.png" width="49%" alt="Custom bots">
</p>

## Terminal mode

The same agent also runs in your terminal, in the style of Claude Code:

```bash
mitzi                                   # interactive session in the current directory
mitzi "explain how auth works here"     # start with a message
mitzi -p "summarize the last commit"    # print mode: answer to stdout, then exit
git diff | mitzi -p "review this diff"  # piped input
mitzi -c                                # continue the last session here
mitzi --mode plan                       # read-only planning
mitzi --allow Edit --allow "Bash(npm test)"
```

Slash commands are `/model`, `/models`, `/mode`, `/compact`, `/cost`, `/todos`, `/clear`, `/sessions`, `/init` and `/exit`. Start a line with `!` to run a shell command yourself. Permission modes: `default` asks before edits and commands, `acceptEdits` allows edits without asking, `plan` is read-only, and `yolo` never asks.

## Configuration

Settings live in `~/.mitzi/config.json`, and the app and the CLI share it. The app's Settings page edits the most common options. Project-level overrides go in `./.mitzi/config.json`.

```json
{
  "apiKey": "sk-or-…",
  "model": "anthropic/claude-sonnet-4.5",
  "smallModel": "google/gemini-2.5-flash",
  "allowedTools": ["WebFetch", "Bash(npm test)"]
}
```

| Environment variable | Purpose |
|---|---|
| `OPENROUTER_API_KEY` | OpenRouter API key (overrides the config file) |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`, `DEEPSEEK_API_KEY`, `TOGETHER_API_KEY`, `ELEVENLABS_API_KEY` | Keys for other providers; each one adds that provider |
| `MITZI_MODEL` | Default model |
| `OPENROUTER_BASE_URL` | Alternative API base URL |
| `MITZI_HOME` | Data directory (default `~/.mitzi`) |

Memory settings live in the app (Settings → Memory): the engine (built-in or a Hindsight server URL and key), an optional embedding model for semantic recall, and how many tokens of memories each message gets. The built-in engine uses your *fast model* for extraction and consolidation, so each exchange costs one or two small extra requests.

Providers added in the app are saved under `providers` in `~/.mitzi/config.json`. The CLI uses them too: `mitzi -m openai:gpt-5`.

App data (chats, projects, bots, artifacts, documents, scheduled tasks and memory banks) is stored as JSON files in `~/.mitzi/data`; generated media are in `~/.mitzi/data/media`.

> React and Mermaid artifacts load their runtime from public CDNs (unpkg, jsdelivr and the Tailwind CDN), so they need an internet connection. Web page, SVG, document and code artifacts work offline.

## Development

```bash
npm run build      # compile the server and CLI, then build the web app into dist/web
npm test           # server, agent and tool tests against a mock OpenRouter (no network)
npm run typecheck

# Live-reloading UI: run the API and the Vite dev server side by side
node dist/index.js ui --no-open     # API on :4545
npm run dev:web                     # UI on :5173, proxies /api to :4545
```

| Path | Purpose |
|---|---|
| `src/agent.ts` | Agent loop: model ↔ tools, usage, compaction |
| `src/openrouter.ts` | Streaming OpenRouter client (SSE, tool calls, retries) |
| `src/tools/` | Coding tools (Read, Write, Edit, Bash, Glob, Grep, LS, WebFetch, TodoWrite) |
| `src/permissions.ts` | Permission modes, allow rules, pluggable approvers |
| `src/server/` | Local web server: REST + SSE API, storage, prompt and context assembly, artifact tool |
| `src/server/mcp/` | MCP client (stdio, Streamable HTTP, SSE), OAuth, connection manager |
| `src/server/extensions/` | Skills, plugins and marketplaces, slash commands, connector directory |
| `src/server/memory/` | Memory banks: built-in engine (retain, recall, reflect), retrieval strategies, Hindsight adapter |
| `src/shared/types.ts` | Types shared by the server and the web app |
| `web/src/` | React app: chat view, artifacts, projects, bots, memory, settings |
| `src/index.ts`, `src/repl.ts` | CLI entry point and terminal REPL |

## License

MIT
