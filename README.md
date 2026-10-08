# Kanban95

Retro Win95-styled desktop kanban that launches, tests, retries and merges AI agent work per ticket. Fire and forget.

The board holds no provider API keys. Claude Code and Codex CLI authenticate themselves; the board only mints scoped, revocable session tokens of its own. Everything runs on `127.0.0.1`.

Spec: `PLAN.md`. Design: `docs/ARCHITECTURE.md`, schema `docs/DATA.md`, security model `docs/SECURITY.md`, agent tool reference `docs/MCP.md`. Conventions for agents working here: `CLAUDE.md`.

## Requirements (Windows is the primary platform)

- Node 24+ (`.node-version` is set; `fnm use` picks it up). `npm install` refuses older Node.
- Rust stable with the MSVC toolchain (Visual Studio 2022 Build Tools, "Desktop development with C++").
- WebView2 runtime (ships with Windows 11).

## Run

```
npm install
npm run build     # compiles daemon/ to daemon/dist
npm test          # daemon tests (builds first)
npm run docs:mcp  # regenerate docs/MCP.md from the MCP tool table (a test fails if it drifts)
npm run dev       # builds, then cargo-runs the Tauri shell, which spawns the daemon and opens the window
```

The daemon alone: `node daemon/dist/server.js [repo]` prints `KANBAN95 port=<n>`; the UI is at `http://127.0.0.1:<n>/`. It creates `<repo>/.kanban95/board.db` (default repo: the cwd). It exits when its stdin closes, so run it from a parent that holds the pipe (the shell does).

## Layout

`daemon/` TypeScript daemon (HTTP, SQLite, REST, grants, MCP; later pty). `ui/` static Win95 UI, no build step, 98.css vendored in `ui/vendor/`. `shell/` Tauri 2 shell. `docs/` living documentation and the phase log in `docs/handoffs/log/`.
