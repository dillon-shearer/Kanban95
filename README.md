# Kanban95

Retro Win95-styled desktop kanban that launches, tests, retries and merges AI agent work per ticket. Fire and forget.

The board holds no provider API keys. Claude Code and Codex CLI authenticate themselves; the board only mints scoped, revocable session tokens of its own. Everything runs on `127.0.0.1`.

Spec: `PLAN.md`. Design: `docs/ARCHITECTURE.md`, schema `docs/DATA.md`, security model `docs/SECURITY.md`, agent tool reference `docs/MCP.md`, how each agent CLI is launched `docs/CLIS.md`, how a ticket moves from Launch to merged `docs/LIFECYCLE.md`, what agents receive and how they behave `docs/AGENTS.md`, how to drive the board `docs/OPERATOR.md`. Conventions for agents working here: `CLAUDE.md`.

## Requirements (Windows is the primary platform)

- Node 24+ (`.node-version` is set; `fnm use` picks it up). `npm install` refuses older Node.
- Rust stable with the MSVC toolchain (Visual Studio 2022 Build Tools, "Desktop development with C++").
- WebView2 runtime (ships with Windows 11).
- To launch agents: Claude Code and/or Codex CLI, logged in with their own commands; a model per CLI and phase, saved in Settings → Models (`~/.kanban95/models.json`, `docs/LIFECYCLE.md` → Run settings); for Claude Code, its one-time `--dangerously-skip-permissions` warning accepted once by hand (`docs/CLIS.md`).

## Run

**One click: `Kanban95.cmd`.** Double-click it to open the board on this repo, or drop a project folder (a git repository) onto it to open the board on that project; `Kanban95.cmd C:\path\to\project` does the same from a terminal, and a desktop shortcut to it works too. It finds Node 24 even when an older Node is first on PATH (through fnm), runs `npm install` the first time, builds and starts the window. Its console window shows the daemon's log; closing the board window ends both.

By hand (Node 24 must be the `node` on PATH, because the shell starts the daemon with it; otherwise the shell shows an error dialog naming the Node it found and the download link):

```
npm install
npm run build     # compiles daemon/ to daemon/dist
npm test          # daemon and UI tests (builds first; the UI tests drive headless Edge or Chrome, or KANBAN95_BROWSER, and download the 80 MB speech model once into daemon/test/.cache/)
npm run docs:mcp  # regenerate docs/MCP.md from the MCP tool table (a test fails if it drifts)
npm run dev       # builds, then cargo-runs the Tauri shell, which spawns the daemon and opens the window on the cwd
npm run dev -- C:\path\to\project   # the same, on another repo
```

The daemon alone: `node daemon/dist/server.js [repo]` prints `KANBAN95 port=<n>`; the UI is at `http://127.0.0.1:<n>/`. It creates `<repo>/.kanban95/board.db` and `<repo>/.kanban95/templates/` (default repo: the cwd). It exits when its stdin closes, so run it from a parent that holds the pipe (the shell does).

## Layout

`daemon/` TypeScript daemon (HTTP, SQLite, REST, grants, MCP, prompt rendering, worktrees, agent launch in a pty streamed over websocket, the ticket lifecycle, merge queue and janitor). `templates/` default agent prompts, copied into `<repo>/.kanban95/templates/` on first start and editable there. `ui/` static Win95 UI (window manager, board, ticket, terminals, brain, settings, inbox, voice input), no build step, 98.css, xterm.js and transformers.js vendored in `ui/vendor/`. `shell/` Tauri 2 shell. `docs/` living documentation and the phase log in `docs/handoffs/log/`.
