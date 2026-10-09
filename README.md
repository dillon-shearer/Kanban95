# Kanban95

A Windows 95-styled desktop kanban that runs AI coding agents for you. Write tickets (or talk them through with a planner agent), press **Run**, and walk away: the board takes the tickets a few at a time (three by default, set in Settings), smallest first, starts Claude Code or Codex CLI for each in its own git worktree, has a second agent test the work against the acceptance criteria, retries failures, and merges what passes. It calls you only when it is stuck, with a ding, a red card and an Inbox entry saying what to do.

![The board](docs/img/board.png)

## Why

Running one coding agent is easy; running five at once on one repository is not. They overwrite each other's files, mark their own work done, need someone to check each result, and leave branches and temp files behind. Kanban95 is the supervisor that does that work:

- **One worktree per ticket**, so agents never share files, and one merge queue, so merges land one at a time.
- **A tester for every ticket**, a different session from the worker, which must report a pass before the ticket can be done.
- **Scoped, revocable grants**: each agent can act only on its own ticket, only through the board's tools, and only while its session lives.
- **Your keys stay yours.** The board holds no provider API key; the agent CLIs log in themselves. Everything runs on `127.0.0.1`.
- **Self-cleaning.** Worktrees, branches, session files and grants are removed when a ticket merges, and a janitor sweeps up after crashes.

New to worktrees, MCP or agent tooling? Start with [docs/LEARNING.md](docs/LEARNING.md).

## Quickstart

You need Windows 11, [Node 24+](https://nodejs.org/), [Rust](https://rustup.rs/) with the MSVC build tools (Visual Studio 2022 Build Tools, "Desktop development with C++"), and Claude Code and/or Codex CLI installed and logged in.

```
git clone https://github.com/dillon-shearer/Kanban95.git
cd Kanban95
.\Kanban95.cmd C:\path\to\your\project
```

The project must be a git repository. `Kanban95.cmd` finds Node 24 (through fnm if an older Node is first on PATH), installs, builds and opens the board, keeping its console open for the session. To start without a console window, double-click `Kanban95.vbs` instead: it runs `Kanban95.cmd` hidden and shows a dialog with the end of its output (full log in `%TEMP%\kanban95-start-<random>.log`, kept only when the start fails) if Node 24 is missing or the install or build fails. Either one opens the board on Kanban95 itself when double-clicked, and on a project folder dropped onto it.

On macOS, double-click `Kanban95.command` in Finder (a Terminal window opens and stays for the session) or run `./Kanban95.command /path/to/project`: the same Node 24 lookup through fnm, install, build and start. Then, once:

1. **Start → Settings → Agents**: pick a CLI, model and effort per phase and press **Save** (writes `~/.kanban95/models.json`; nothing launches without it).
2. For Claude Code, accept its one-time `--dangerously-skip-permissions` warning by hand ([docs/CLIS.md](docs/CLIS.md) → First-run prompts).

[docs/OPERATOR.md](docs/OPERATOR.md) walks through a full cycle from brainstorm to merge.

## Documentation

| doc | what it covers |
|---|---|
| [docs/LEARNING.md](docs/LEARNING.md) | a guided tour for newcomers: worktrees, MCP tools, grants, and why the board uses them |
| [docs/OPERATOR.md](docs/OPERATOR.md) | driving the board: brainstorm, operator terminals, launch, the Inbox, settings, voice input |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | shell, daemon and UI; REST, events, launch, packaging, repo map |
| [docs/LIFECYCLE.md](docs/LIFECYCLE.md) | the ticket state machine, retries, the merge queue, the janitor |
| [docs/AGENTS.md](docs/AGENTS.md) | what an agent receives, how each role is expected to behave, the skills plugin |
| [docs/MCP.md](docs/MCP.md) | every agent tool, who may call it, its arguments (generated) |
| [docs/CLIS.md](docs/CLIS.md) | how Claude Code and Codex are started: flags, first-run prompts, reach by role |
| [docs/SECURITY.md](docs/SECURITY.md) | grants, audit, the shell secret, the webview, the threat model |
| [docs/DATA.md](docs/DATA.md) | the per-repo SQLite schema, migrations, and every file the board writes |
| [CLAUDE.md](CLAUDE.md) | conventions for agents working on this repo |

## Install without Rust

`npm run installer` (from a source checkout, Rust required) builds a per-user NSIS installer at `shell/target/release/bundle/nsis/Kanban95_<version>_x64-setup.exe`. It needs no admin prompt and installs a Start menu entry; the installed app needs only Node 24+ on PATH and the WebView2 runtime, and shows a download dialog when Node is missing. `Kanban95.exe` opens the board on the folder passed as its argument, else on its working directory. Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) → Packaging.

## Developing Kanban95

```
npm install
npm run build        # compiles daemon/ to daemon/dist
npm test             # tsc, then every daemon and UI test: the tester's one full run per ticket; the UI tests drive headless Edge or Chrome (or KANBAN95_BROWSER) and download the 80 MB speech model once into daemon/test/.cache/
npm run test:changed -- main   # only the tests the changes against main (committed or not) can affect, no tsc: what the worker runs
npm run test:shell   # the Tauri shell's tests (cargo test)
npm run docs:mcp     # regenerate docs/MCP.md from the MCP tool table; a test fails if it drifts
npm run dev -- C:\path\to\project   # build, then cargo-run the shell on that repo (default: the cwd)
```

`npm run dev` and the shell start the daemon with the `node` on PATH, which must be Node 24. The daemon alone: set `KANBAN95_SECRET` to a random string of 32+ characters, run `node daemon/dist/server.js [repo]`, and open `http://127.0.0.1:<port>/?k95=<secret>` with the port it prints ([docs/SECURITY.md](docs/SECURITY.md) → Shell secret). It exits when its stdin closes, so run it from a parent that holds the pipe.

Layout: `daemon/` the TypeScript daemon (HTTP, SQLite, REST, MCP, grants, prompts, worktrees, agent ptys, lifecycle, merge queue, janitor). `ui/` the static Win95 UI, no build step, with 98.css, xterm.js and transformers.js vendored. `shell/` the Tauri 2 shell. `templates/` the default agent prompts. `skills/` a Claude Code plugin with the agent skills. `docs/` the documentation above.
