# Mitzi

An agentic coding assistant for your terminal, in the spirit of Claude Code, that can run on **any model available through [OpenRouter](https://openrouter.ai)**: Claude, GPT, Gemini, DeepSeek, Qwen, Llama and the rest.

Mitzi reads your codebase, edits files, runs commands and iterates until the task is done. It asks before it changes anything.

```
✻ Mitzi v0.1.0
model: anthropic/claude-sonnet-4.5  ·  mode: default  ·  cwd: ~/code/my-app

> the date parser in utils breaks on ISO week dates, fix it and add a test

⏺ Grep("parseDate")
  ⎿  src/utils/date.ts
     src/utils/date.test.ts
⏺ Read(src/utils/date.ts)
  ⎿  1  import { … }
     …
? Edit(src/utils/date.ts)
    @@ line 41 @@
    - const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    + const m = /^(\d{4})-(?:W(\d{2})-(\d)|(\d{2})-(\d{2}))$/.exec(s);
  Allow? yes / always allow Edit / no, or type feedback:
```

## Features

- **Agent loop with tool calling**: streams responses and runs tools until the model is done.
- **Claude Code–style tools**: `Read`, `Write`, `Edit` (exact string replacement), `Bash` (the working directory persists between calls), `Glob`, `Grep` (uses ripgrep when it's installed), `LS`, `WebFetch` and `TodoWrite`.
- **Safety rails**: a file must be `Read` before it can be edited or overwritten. Edits are refused when the file changed on disk since it was read. You approve each change in a diff preview.
- **Permission modes**: `default` (asks before edits, commands and network calls), `acceptEdits`, `plan` (read-only, so the model researches and proposes a plan), and `yolo`.
- **Any OpenRouter model**: switch mid-session with `/model`, or browse with `/models`.
- **Cost tracking** from OpenRouter's usage accounting (`/cost`).
- **Prompt caching** for Anthropic models, applied automatically.
- **Project memory**: reads `MITZI.md`, `AGENTS.md` or `CLAUDE.md` from your repo and `~/.mitzi/MITZI.md`. `/init` writes one for you.
- **Sessions** are saved automatically. Resume one with `--continue` or `--resume <id>`.
- **Context compaction**: `/compact` runs manually, and compaction also runs automatically when the context gets large.
- **Print mode** for scripts and CI: `mitzi -p "…"`, with piped stdin supported.
- **No runtime dependencies.** Mitzi needs only Node.js 20+.

## Install

```bash
git clone https://github.com/elad-haviv/Mitzi-harness.git
cd Mitzi-harness
npm install
npm run build
npm link        # puts `mitzi` on your PATH
```

Get an API key at <https://openrouter.ai/keys>:

```bash
export OPENROUTER_API_KEY=sk-or-...
```

## Usage

```bash
mitzi                                   # interactive session in the current directory
mitzi "explain how auth works here"     # interactive, starting with a message
mitzi -m openai/gpt-5 "…"               # pick a model
mitzi -p "summarize the last commit"    # print mode: answer to stdout, then exit
git diff | mitzi -p "review this diff"  # piped input
mitzi -c                                # continue the last session in this directory
mitzi --mode plan                       # read-only planning
mitzi --allow Edit --allow "Bash(npm test)"   # pre-approve specific tools
```

### Slash commands

| Command | |
|---|---|
| `/help` | List commands |
| `/model [id]` | Show or switch the model |
| `/models [filter]` | List OpenRouter models with context size and price |
| `/mode [mode]` | Show or set the permission mode |
| `/compact [focus]` | Summarize the conversation to free context |
| `/cost` | Show tokens and dollars spent this session |
| `/todos` | Show the agent's current task list |
| `/clear` | Start a fresh conversation |
| `/sessions` | List saved sessions for this directory |
| `/init` | Generate a `MITZI.md` for the repo |
| `/exit` | Quit |

Prefix a line with `!` to run a shell command yourself. Its output is attached to your next message. End a line with `\` to keep typing on the next line. Press **Ctrl+C** to interrupt the agent, and press it twice at the prompt to quit.

## Configuration

Settings are merged from lowest to highest priority: built-in defaults, `~/.mitzi/config.json`, `./.mitzi/config.json`, environment variables, then CLI flags.

```json
{
  "model": "anthropic/claude-sonnet-4.5",
  "smallModel": "google/gemini-2.5-flash",
  "permissionMode": "default",
  "allowedTools": ["WebFetch", "Bash(npm test)", "Bash(git status)"],
  "maxTurns": 100,
  "autoCompactTokens": 150000,
  "maxTokens": 16000,
  "showReasoning": false,
  "attribution": true
}
```

- `smallModel` is used for summarizing during compaction.
- `allowedTools` rules are a tool name (`"Edit"`) or a Bash command prefix (`"Bash(npm test)"`). A prefix rule never matches a command that chains other commands with `;`, `&&`, `|`, `$(…)` or redirects.
- `attribution` controls the trailer Mitzi adds to commits it writes, so GitHub shows Mitzi as a co-author while you stay the author. `true` (the default) adds `Co-Authored-By: Mitzi (<model>) <noreply@mitzi.invalid>`; `false` turns it off; a string replaces it, with `{model}` expanded to the current model, e.g. `"Co-Authored-By: mitzi-bot <123+mitzi-bot@users.noreply.github.com>"`. The model is asked to add it, so a weaker model may occasionally forget.
- Environment variables: `OPENROUTER_API_KEY`, `MITZI_MODEL`, `OPENROUTER_BASE_URL`, and `MITZI_HOME` (default `~/.mitzi`).

Tool calling works best with models that support it well. Claude, GPT and Gemini models, and recent DeepSeek and Qwen models, all work well with Mitzi.

## Development

```bash
npm run build      # compile TypeScript to dist/
npm run dev        # recompile on change
npm test           # build, then run the test suite (mock OpenRouter server, no network)
```

The source lives in `src/`:

| File | Purpose |
|---|---|
| `index.ts` | CLI entry: argument parsing, print mode, startup |
| `repl.ts` | Interactive loop and slash commands |
| `agent.ts` | Agent loop: model ↔ tools, compaction, usage |
| `openrouter.ts` | Streaming OpenRouter client (SSE, tool-call deltas, retries) |
| `permissions.ts` | Permission modes, allow rules, approval prompts |
| `prompt.ts` | System prompt and project-instruction discovery |
| `session.ts` | Session persistence |
| `ui.ts` | Terminal rendering |
| `tools/` | One module per group of tools |

## License

MIT
