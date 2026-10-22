# Mitzi

An open-source, Claude-style AI workspace that runs on **any model available through [OpenRouter](https://openrouter.ai)**, including Claude, GPT, Gemini, DeepSeek, Qwen and Llama. It runs locally in your browser and offers chats, projects, artifacts, custom bots, long-term memory, and context management. When a project points at a folder, Mitzi also works as a coding agent that edits files and runs commands there. A terminal version is included.

![Chat with an artifact](docs/screenshots/chat-artifact.png)

## Features

**Chats**
- Responses stream in with Markdown, tables and syntax-highlighted code.
- Attach text files or images. You can paste or drag and drop them into the message box.
- Edit any earlier message, regenerate the last answer, stop a response mid-stream, and copy replies.
- Switch models per chat. The model picker is searchable and shows each model's price, context size, and vision and tool support.
- One-click web search uses OpenRouter's `:online` option.
- Chats get titles automatically. You can pin, rename, search, and move chats between projects.

**Artifacts.** Substantial output opens in a side panel instead of cluttering the chat:
- Supported types: documents, code files, web pages, React components, SVG graphics and Mermaid diagrams.
- Web pages, components, SVG and diagrams render live in a sandboxed frame.
- Each change is kept as a version you can step through. You can also copy, download or expand any artifact.
- The model edits artifacts in place with small targeted updates instead of rewriting them each time.
- All artifacts are collected in a gallery.

**Projects** group chats around shared context:
- *Instructions* are added to every chat in the project.
- *Knowledge files* are reference documents included in every chat's context.
- A *coding workspace* links a local folder. Chats in the project then get Read, Write, Edit, Bash, Glob, Grep and the other coding tools, with a permission prompt (showing a diff) before anything changes.

![Coding agent asking for permission](docs/screenshots/coding-permission.png)

**Bots** are reusable assistants with their own icon, instructions, model, temperature, capabilities and conversation starters. **Mitzi**, the default bot, is always there and handles every chat that doesn't pick another bot. You can customize it but not delete it. Three example bots are included.

**Memory banks.** Every bot has its own long-term memory, modeled on [Hindsight](https://github.com/vectorize-io/hindsight)'s retain → recall → reflect design:
- **Retain:** after each exchange, the bot extracts durable *facts* (about you and your world) and *experiences* (what it did for you). It then consolidates them into *beliefs* (observations) that cite their supporting facts and grow more confident as evidence accumulates. Contradicting facts revise beliefs rather than piling up.
- **Recall:** before every message, relevant memories are retrieved by several strategies at once: keyword (BM25), an entity graph, time expressions ("last week", "in March") and, optionally, semantic embeddings. Reciprocal rank fusion merges the results within a token budget. Each answer shows which memories it used.
- **Reflect:** ask a bank a broad question and it reasons over everything it remembers.
- **Per-bank settings:** each bank has a *mission* (what to focus on) and a *disposition* (skepticism, literalism and empathy, 1–5) that shapes how memories are formed and interpreted.
- **Memory page:** browse, search, edit, forget or teach each bank, test recall, or ask it to reflect. The model can also save, search and forget memories itself.
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

The installer puts Mitzi in `~/.mitzi/app` and adds a `mitzi` command. On Windows it also creates Desktop and Start menu shortcuts. Run the same line again to update. Then start the app with `mitzi ui`.

### From source

```bash
git clone https://github.com/elad-haviv/Mitzi-harness.git
cd Mitzi-harness
npm install
npm run build
npm link          # puts `mitzi` on your PATH

mitzi ui          # opens the app in your browser
```

Add your OpenRouter key in **Settings**. You can get one at <https://openrouter.ai/keys>. Alternatively, set `OPENROUTER_API_KEY` before starting.

`mitzi ui` serves the app at `http://localhost:4545`. It only accepts connections from your own machine and requires a private access token, which is included in the link it prints. Use `--port` to change the port and `--no-open` to skip opening a browser.

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
| `OPENROUTER_API_KEY` | API key (overrides the config file) |
| `MITZI_MODEL` | Default model |
| `OPENROUTER_BASE_URL` | Alternative API base URL |
| `MITZI_HOME` | Data directory (default `~/.mitzi`) |

Memory settings live in the app (Settings → Memory): the engine (built-in or a Hindsight server URL and key), an optional embedding model for semantic recall, and how many tokens of memories each message gets. The built-in engine uses your *fast model* for extraction and consolidation, so each exchange costs one or two small extra requests.

App data (chats, projects, bots, artifacts and memory banks) is stored as JSON files in `~/.mitzi/data`.

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
