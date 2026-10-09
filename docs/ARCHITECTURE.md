# Architecture

Living document. Update it in the same change that alters the shape described here.

## Three parts

```
 shell (Tauri 2, Rust)  ──spawn──▶  daemon (Node 24, TypeScript)  ──serves──▶  ui/ (static HTML/CSS/JS + 98.css)
        │                                   │
        │  stdin pipe (held open)           │  http://127.0.0.1:<random port>
        │  stdout: "KANBAN95 port=<n>"      │  GET /          → ui/index.html
        └──── WebviewWindow(External url) ──┘  GET /health    → {"ok":true}
                                            │  /api/*        → REST over <repo>/.kanban95/board.db (operator UI)
                                            │  POST /mcp     → MCP tools for agents, bearer grant required
                                            │  WS /pty/<key> → an agent's terminal, both ways (xterm.js)
                                            │  WS /events    → board events for the UI (sounds, ticket changes)
                                            │  GET /voice-model/* → the speech model's files (manifest-listed only)
```

- **Shell** (`shell/`): owns the OS window and the daemon's lifetime. No app logic. It runs `node` from PATH on the daemon staged next to its exe (installed) or on `daemon/dist/server.js` in the repo (dev); see Packaging.
- **Daemon** (`daemon/src/`): the only process with state. The repo it serves is `argv[2]`, defaulting to the cwd. Its modules:
  - `attachments.ts` stores, lists and removes the files attached to a ticket under `<repo>/.kanban95/attachments/<id>/`.
  - `boards.ts` is the other boards on this machine: the running registry (`~/.kanban95/running/`), and opening or focusing another project's board for Start → Projects (see Daemon lifetime).
  - `context.ts` builds the variables for a ticket and records the rendered prompt on a `runs` row (`startRun`) before anything is spawned (see Prompts below).
  - `db.ts` opens and migrates the per-repo SQLite file (schema in `docs/DATA.md`).
  - `git.ts` creates and removes the per-ticket worktree and merges the base into it (`syncWorktree`, on submit and in the merge queue).
  - `grants.ts` mints, verifies, revokes bearer grants and writes audit rows (`docs/SECURITY.md`).
  - `janitor.ts` removes worktrees, branches, session dirs, grants and old scrollback nobody needs any more.
  - `launcher.ts` launches an agent (worktree, run row, grant, session dir, argv, pty) and tears it down (see Launch below).
  - `lifecycle.ts` is the ticket state machine: one table of transitions, `apply(board, ticket, event)`, the runner's `tick` and the silence watch that flags an agent whose transcript stopped growing (`docs/LIFECYCLE.md`).
  - `limits.ts` asks each CLI for its account's usage limits and caches them 5 minutes (`docs/OPERATOR.md` → Limits).
  - `mcp.ts` is the agent-facing MCP server at `/mcp`: one table of tools, each with a description, a role access cell and a handler, enforced per grant and audited per call.
  - `mcp-doc.ts` renders `docs/MCP.md` from the `mcp.ts` tool table.
  - `merge.ts` is the one serialized merge queue.
  - `pty.ts` spawns the CLI in a pseudo-terminal with an env allowlist and keeps a 2000-line scrollback.
  - `server.ts` is the HTTP plumbing (bind, origin guard, static files, `/health`, routes `/api/*` to `api.ts`).
  - `settings.ts` reads and writes the operator's `~/.kanban95/models.json`, `settings.json` (schema-checked), `projects.json` (adds the served repo on start) and `preferences.md`, lists the models the installed CLIs know (`knownModels`, for the Settings dropdowns), and resolves a run's CLI, model, effort and executable.
  - `templates.ts` copies the default prompt templates from `templates/` into `<repo>/.kanban95/templates/`, keeps unedited copies in step with the defaults on start (see Prompts below) and renders them.
  - `trust.ts` pre-trusts the repo root for Claude Code before a launch.
  - `voice.ts` downloads, verifies and serves the speech model (see Voice below).
- **UI** (`ui/`): plain files served by the daemon, ES modules, no bundler (see UI below). 98.css, xterm.js and transformers.js are vendored in `ui/vendor/` so nothing loads from a CDN at runtime.

## Port handshake

1. Before spawning, the shell runs `node --version`. Missing or older than 24: a native Yes/No dialog names the problem and the Node download link and offers to open it in the default browser (`ShellExecuteW`, from the shell, not the webview), and the shell exits with code 1.
2. Shell mints a random secret and spawns the daemon with it in `KANBAN95_SECRET` (environment, never argv) and `stdin` and `stdout` piped.
3. Daemon binds `127.0.0.1:0` (kernel-assigned port; `KANBAN95_PORT` fixes it, for debugging), then prints exactly one line to stdout: `KANBAN95 port=<n>`.
4. Shell reads that line, builds `http://127.0.0.1:<n>/?k95=<secret>` and creates the main webview window on it; the daemon trades that for an HttpOnly cookie `k95-<n>` and redirects to `/`. Any other first line is a handshake error; the shell kills the child, shows an error dialog and exits.
5. Shell keeps draining daemon stdout to its own stderr prefixed `[daemon]` so the pipe can never fill and block the daemon.

## Daemon lifetime

- **Job object**: the shell's first act is to put itself in a Windows job with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. The daemon and WebView2's `msedgewebview2.exe` processes inherit it, and only the shell holds the job handle, so when the shell process ends for any reason (window close, crash, `taskkill /f`, logoff, shutdown) Windows kills every process in the tree.
- **WebView2 profile per board**: the window's user data folder is `%LOCALAPPDATA%\dev.kanban95.shell\boards\<FNV-1a of the canonical repo path>`. A profile has one `msedgewebview2.exe` browser process, started by the first shell to open it and therefore in that shell's job; with one shared profile, closing the first board killed every other board's webview. The UI keeps no browser storage, so a profile holds nothing of value. When `WEBVIEW2_USER_DATA_FOLDER` is set, the shell passes that folder instead (WebView2 would prefer the variable anyway; passing it keeps Tauri from creating an unused folder).
- **Restart once**: a supervisor thread polls the daemon every 250 ms. Exit code 75 means the daemon asked to be restarted (Start → Restart board): it is restarted as below every time, without spending the one unexpected restart. Any other exit is unexpected. The first unexpected exit starts a new daemon with a fresh secret, moves the navigation lock to its new port and navigates the window to `/?k95=<secret>` there (a new origin; the UI keeps no browser storage, so window places and the startup layout come back from `.kanban95/ui.json`). A second exit, or a failed restart, shows a native error dialog and closes the board. No loop. `cargo test --manifest-path shell/Cargo.toml` covers this with stand-in daemons that exit at once.
- **Restart board**: `POST /api/restart`. When the daemon runs from a repo checkout (its install root has `daemon/src`), it first runs `npm run build` there (120 s timeout); a failed build answers `409` with the compiler output and the board keeps running the code it has. Then it answers `202 {restarting: true, shell}`, shuts down as `close()` does (agents killed through the normal path; while closing, their exits do not flag their tickets, so `recover` resumes them on the next start), and exits with code 75. An installed `app/` has no `daemon/src`, so nothing is built. The shell spawns the daemon with `KANBAN95_SHELL=1`; started by hand without it, the reply says `shell: false` and the process simply exits. Shell changes are not picked up: they need `cargo build` and a full relaunch.
- **Stale daemon**: at start the daemon records `git rev-parse HEAD` of the repo (`board.startCommit`; unset in a repo with no commits, and then nothing below runs). After each successful merge the queue runs `git diff --name-only <startCommit> HEAD -- daemon/ shell/ package.json package-lock.json`; a non-empty list sets `board.stale` to `'shell'` when a path is under `shell/`, else `'daemon'`, and emits `changed(null)`. `GET /api/runner` returns it as `stale: false | 'daemon' | 'shell'`; the UI shows the status-bar line and the tray's Restart badge from it (`docs/OPERATOR.md` → Restart board). A restart records a new commit, so it clears.
- **Kill on exit**: on Tauri's `RunEvent::Exit` the shell takes the child out of the supervisor's slot (which stops the supervisor) and calls `kill()` then `wait()` on it.
- **Running registry**: once it has its port, the daemon writes `~/.kanban95/running/<pid>.json` (`{pid, repo, port, started}`, `docs/DATA.md`), and `close()` removes it, as does the process's `exit` handler. Closing the window kills the daemon outright (Kill on exit, the job object), so neither runs and the entry stays behind: every reader (`running()` in `boards.ts`) deletes an entry whose pid is dead, and `GET /api/projects` marks a project running only for a live one.
- **Another project's board** (Start → Projects): `POST /api/projects/open` starts a board on a listed project that is not running. A child of the daemon would live in this board's kill-on-close job, which allows no breakaway (libuv's `detached` does not ask for it), and die with it; so on Windows the new process is created through WMI (`Win32_Process.Create` from one PowerShell call), outside the job, with this daemon's environment and hidden (the dev shell is a console program: its console stays hidden, its window shows). From a checkout it runs `shell/target/debug/kanban95-shell.exe <path>` as built, not `Kanban95.vbs`: `cargo run` relinks that exe every time (Working on the board → Windows) and fails while this board holds it open. Installed, it runs the `.exe` next to `app/`; on macOS, `Kanban95.command <path>`. `POST /api/projects/focus` brings a running board's window to the front: one PowerShell call finds the top-level window titled `<folder name> — Kanban95` and calls `SwitchToThisWindow`, which restores a minimized window and is not held back by the foreground lock (`AppActivate` and `SetForegroundWindow` only flash the taskbar button from a process that did not get the last input). Two projects with the same folder name share a title; the first window found wins. macOS: nothing is focused and the status bar says so.
- **Stdin EOF**: the daemon holds `process.stdin` open and exits with code 0 when it ends. The shell never writes to it; the pipe simply closes when the shell process dies, including on a crash. An orphaned daemon is therefore not possible. Consequence: if you start the daemon by hand with stdin closed (`< /dev/null`, `stdio: 'ignore'`), it exits immediately after printing the port. That is intended.

## Packaging

`npm run installer` builds a per-user NSIS installer (no admin prompt) at `shell/target/release/bundle/nsis/Kanban95_<version>_x64-setup.exe`:

1. `npm run build` compiles the daemon.
2. `shell/stage.mjs` copies what the daemon needs at runtime into `shell/target/app/` in the repo's own layout (`daemon/dist`, `daemon/migrations`, `daemon/voice-model.json`, `ui/`, `templates/`, the package files) and runs `npm ci --omit=dev --ignore-scripts` there. `--ignore-scripts` is safe because node-pty ships Windows prebuilds; the workspace link `node_modules/@kanban95` is deleted (a junction back to `daemon/` the bundler would walk forever).
3. `tauri build --config shell/tauri.bundle.json` builds the release shell and bundles `target/app/` as the resource `app/`. `shell/tauri.conf.json` keeps `bundle.active: false` so `cargo build` and `npm run dev` stay unbundled.

Installed, the shell finds `app/daemon/dist/server.js` next to its exe and runs it with `node` from PATH, so **the installed app needs Node 24 on PATH**; without it the first run shows the download dialog (Port handshake, step 1). The board's repo is the shell's first argument, defaulting to the working directory, the same as in dev.

**Node single-executable applications (SEA), investigated, not implemented.** Node 24 can embed one script into a copy of `node.exe` (`node --experimental-sea-config`, then `postject` injects the blob). For this daemon that is not trivial:

- Inside a SEA, `require` resolves only built-in modules. The daemon is ESM over `node_modules` (MCP SDK, ws, zod, node-pty and their dependencies), so it would first need a bundler producing one CommonJS file: a new dependency and a build step.
- node-pty is a native addon (`pty.node`, `conpty.node`, `conpty.dll`, `winpty-agent.exe`). Native code cannot load from the blob; it would have to be shipped as files beside the exe or extracted to a temp dir and `process.dlopen`ed, and conpty starts its helpers by path.
- `ui/`, `templates/` and `migrations/` are read from disk at runtime; they would become SEA assets (`sea.getAsset`) or stay as files, which is most of the staging above anyway.
- Injecting a blob invalidates `node.exe`'s Authenticode signature; it has to be stripped and the result re-signed, or SmartScreen warns on every machine.
- The sidecar would be the full Node runtime (~80 MB) per release, rebuilt for every Node security update.

Upgrade path, cheaper than SEA: ship the official `node.exe` (Node 24 LTS) as a Tauri `bundle.externalBin` sidecar and spawn it on `app/daemon/dist/server.js` instead of `node` from PATH. That removes the Node prerequisite (and the dialog) without bundling or re-signing, at ~80 MB per installer and an installer rebuild per Node security release.

## Network boundary

- `validateConfig` rejects any bind host other than `127.0.0.1`. There is no flag, env var or config key that can widen it; a different host is a code change, and the tests fail on it.
- Every daemon response carries `Content-Security-Policy: default-src 'self' http://127.0.0.1:<port> ws://127.0.0.1:<port>; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'` and `X-Content-Type-Options: nosniff`. `data:` images are 98.css's inline SVG icons; `'wasm-unsafe-eval'` lets the speech model's WebAssembly compile (it allows no JavaScript eval); inline styles are for xterm.js, which writes its theme into a `<style>` element. Inline and remote scripts stay blocked, and `connect-src` falls back to the daemon's own HTTP and websocket origin, so the page cannot reach any other host; `frame-ancestors 'none'` keeps other pages from framing it. The window is loaded from the daemon's origin, so this header is the CSP that governs the UI; Tauri's own `app.security.csp` only applies to pages Tauri serves itself, which this app has none of.
- Static serving only answers `GET`/`HEAD`, only for files inside `ui/` with a known extension. Path traversal (`..`, encoded dots, backslashes) resolves outside `ui/` and is refused.
- The webview is an "external" URL to Tauri and the shell declares no capabilities, so every Tauri command is refused for it (tested in `shell/`). The UI talks to the daemon over plain HTTP, the `/events` websocket and a websocket per terminal. The shell cancels navigation off the daemon's origin and answers permission requests itself: microphone yes, everything else no. It also follows the page's fullscreen (Start → Full screen, F11): wry leaves WebView2's `ContainsFullScreenElementChanged` unhandled, so the shell handles it and sets the window borderless fullscreen; without that the page's fullscreen only fills the window. See `SECURITY.md` → Webview.

## REST (operator UI only, same-origin)

Every `/api/*` request needs the `k95` cookie holding the shell secret, or gets `401`; so do the `/events` and `/pty` websockets (`docs/SECURITY.md` → Shell secret).

| method | path | notes |
|---|---|---|
| GET, POST | `/api/tickets` | list / create. Body fields: `title` (required), `body`, `criteria`, `status`, `cli`, `model`, `effort`, `retry`, `needs_human`, `blocked_on_deps`, `depends_on: number[]` |
| GET, PATCH, DELETE | `/api/tickets/:id` | same fields on PATCH; `null` clears `cli`/`model`/`effort`; a PATCH that moves the ticket to `backlog` first ends its live sessions (`runs.outcome` = `reset`, grants revoked, ptys killed); DELETE ends them too and also removes `.kanban95/attachments/<id>/` |
| GET | `/api/tickets/:id/notes` `/runs` `/audit` | rows for that ticket, oldest first |
| GET, POST | `/api/tickets/:id/attachments` | list `[{name, path, size}]` (`path` absolute) / upload: the raw file bytes as the body, its name in `?name=`. The name is cleaned to a safe basename (anything outside letters, digits and ` ._()+-` becomes `_`); one with `/`, `\` or `..` is refused `400`, a body over 10 MB `413`. A clash is stored as `<stem>-1<ext>`, never overwritten. `201` with the stored entry |
| GET, DELETE | `/api/tickets/:id/attachments/:name` | serve / remove one. PNG, JPEG, GIF, WebP and BMP are served inline with their image type; anything else as an `application/octet-stream` download, so an uploaded page never runs on the board's origin |
| GET | `/api/brain?q=&limit=` | FTS5 ranked search (title and tags weigh more than body), limit at most 100; no `q` lists newest. Each row carries `ticket_status`, its source ticket's status (null when none or deleted) |
| GET | `/api/grants` | all grants, never the hash |
| DELETE | `/api/grants/:id` | revoke and kill the session's pty; 404 if not live |
| POST | `/api/tickets/:id/launch` `/api/tickets/:id/answer` `/api/tickets/:id/merge` `/api/tickets/:id/resume` | lifecycle events (`docs/LIFECYCLE.md`); `409` when the state machine has no such transition |
| POST | `/api/restart` | Restart board: rebuild when running from a checkout, then exit 75 (Daemon lifetime → Restart board). `409` with the build output, or when already shutting down. Audited as `board.restart` |
| POST | `/api/tickets/housekeeping` | creates a housekeeping ticket and launches it (the Housekeeping button) |
| GET | `/api/tickets/:id/diff` | `{diff}`: the worktree against its fork point, uncommitted tracked changes included; `null` without a worktree |
| GET | `/api/inbox` | what flagged tickets wait on: unanswered `question` notes, and the newest `failure` note when no newer question is open (`kind`, `body`, `role`, `created_at`, and the ticket's `title`, `status`, `merged_at`) |
| POST | `/api/brain` | add a note: `title`, `body` (at most 1500 characters), optional `tags` |
| PATCH | `/api/brain/<id>` | edit a note in place: any of `title`, `body`, `tags`; 404 for an unknown id |
| DELETE | `/api/brain/<id>` | delete a note; 404 for an unknown id |
| GET | `/api/sessions` | live agent sessions: `id` (the `/pty/<id>` key), `ticket_id`, `run_id`, `grant_id`, `role`, `phase`, `model` |
| DELETE | `/api/sessions/:id` | the operator's X on a terminal: ends the session (`runs.outcome` = `closed`, grant revoked, pty killed); a ticket session also flags its ticket (`exit` with an operator note). 404 when not live. Audited as `sessions.end` |
| POST | `/api/brainstorm` | starts a brainstorm session (planner, repo root); optional `{ mission }`, the operator's draft, goes into its brief as `{{mission}}`; returns it in the `/api/sessions` shape |
| POST | `/api/operator` | `{ mission }` (non-empty): starts an operator terminal (operator grant, repo root, the mission in its brief); returns it in the `/api/sessions` shape |
| GET, PUT | `/api/config/models` `/api/config/settings` | `~/.kanban95/models.json` / `settings.json`: GET returns `{path, value}` as written (`null` when absent), PUT checks the whole file against its schema (`400` naming the field) and writes it |
| GET, PUT | `/api/ui` | `<repo>/.kanban95/ui.json`, the UI's state (`ui/state.js`) as one object, `{}` when absent; PUT replaces it whole and refuses a non-object or more than 64 KB with `400`. Not audited |
| GET, PUT | `/api/notepad` | `<repo>/.kanban95/notepad.md` as plain text: `{value}`, `''` when absent; PUT refuses a non-string with `400` and more than 256 KB with `413`. Not audited |
| POST | `/api/push` | the status bar's Push: the base to its upstream, run in the merge queue, audited `board.push`; answers the runner state, or `502` with git's message (`docs/LIFECYCLE.md` → Push) |
| GET, PUT | `/api/runner` | the Run toggle: `{on, why?, concurrency, running, left, backlog, waits: [{id, on}], stale, unpushed}` (`stale`: Daemon lifetime → Stale daemon; `unpushed`: commits on the base its upstream lacks, counted on start, `docs/LIFECYCLE.md` → Push); PUT takes `{"on"?: boolean, "concurrency"?: 1-10}`, either or both, audited `runner.set` (`docs/LIFECYCLE.md` → The runner) |
| GET | `/api/project` | this board's project: `{path, name, colour}`, the repo path, its folder name and its wallpaper colour from `~/.kanban95/projects.json` (`#008080` when unlisted) |
| GET, PUT | `/api/projects` | `~/.kanban95/projects.json`: `{path, value}`, `value` the whole `[{path, colour}]` list both ways; GET adds `running`, `{<path>: true \| false}` for every listed path from the running registry, apart from `value` so a PUT can send `value` back unchanged. PUT refuses (`400`, file unchanged) a path that is not an existing git repo, one listed twice, a colour that is not `#rgb`/`#rrggbb` or a hue 0 to 360, and a list without this board's own repo. Audited as `config.write` |
| POST | `/api/projects/open` | `{path}`: start a board on that project (Daemon lifetime → Another project's board). `202 {name}`; `400` for a path not in `projects.json`; `409` when it is already running or nothing could be started. Audited as `projects.open` |
| POST | `/api/projects/focus` | `{path}`: bring that running board's window to the front. `200 {name, focused}`, `focused: false` when no window was found (or on macOS); `400` for a path not in `projects.json`; `409` when it is not running |
| GET, PUT | `/api/config/preferences` | `~/.kanban95/preferences.md` as plain text: `{path, value}`, `value` is `''` when absent; PUT refuses a non-string or more than 16 KB with `400` |
| GET | `/api/templates` | `{vars, templates: [{name, path, text, stale}]}`: every prompt template's current text in `<repo>/.kanban95/templates/` and the allowed `{{variables}}` (`VARS`), for Settings → Prompts. `stale` is true when the copy differs from the current shipped default |
| PUT | `/api/templates/:name` | `{text}` replaces that template whole; a `{{var}}` outside `VARS` is refused with `400` naming it, an unknown name with `404`. Returns `{name, path, text, stale}` |
| POST | `/api/templates/:name/reset` | Overwrites the repo's copy with the shipped `templates/<name>.md` and records its sha256 in `.shipped.json`. Returns `{name, path, text, stale}` |
| GET | `/api/models` | `{claude: string[], codex: string[]}`: the model names each installed CLI knows (Codex's `~/.codex/models_cache.json`, Claude's `--help` and executable), for the Settings → Models dropdowns |
| GET, DELETE | `/api/trust` | Claude Code's trust entry for this repo root: status, or clear it (`docs/CLIS.md` → First-run prompts) |
| GET | `/api/limits?refresh=` | `{rows: [{cli, window, used, limit, resets_at}], errors: {claude?, codex?}, fetched_at}`. `used` of `limit` (percent of 100); `resets_at` is ISO for Codex, Claude's own text (`Oct 8, 7:59pm (America/New_York)`) for Claude. Cached 5 min; `refresh` asks the CLIs now. A CLI that fails is in `errors` with why, never its output |
| GET | `/api/voice` | speech model: id, source, revision, license, files with size and SHA-256, `downloaded`, `received` (bytes so far while downloading) |
| POST | `/api/voice/download` | downloads and verifies the model; `502` naming the file on any failure |

Errors are `{ "error": "..." }`: 400 for bad input, a constraint violation or a dependency cycle, 404, 405, 409 for a lifecycle refusal, 413 for bodies over 1 MiB (10 MB for an attachment upload). Every POST/PUT/PATCH/DELETE writes an audit row, including failed ones.

## MCP (agents only, bearer grant)

`POST /mcp` is a stateless Streamable HTTP MCP endpoint (no session id, JSON responses). `handleMcp` reads `Authorization: Bearer <token>`, resolves it with `grants.verify`, answers `401` with no audit row when that fails, and otherwise builds a per-request `McpServer` whose twelve tools close over the grant. One wrapper around every tool checks the role cell, runs the handler, and writes exactly one audit row (`ok`, `denied` or `error`) with the grant id and the ticket the call was about. Worker and tester grants are bound to one ticket and may omit `ticket_id`; naming another ticket is a scope denial. Tool list, role matrix and argument tables are in `docs/MCP.md`, generated from the same table the server enforces (`npm run docs:mcp`); a test fails when the file drifts.

## Prompts

1. `startRun(db, repo, {ticketId, template, cli, model, effort, worktree?, base?})` loads `<repo>/.kanban95/templates/<template>.md`. A placeholder outside `VARS` throws here, naming it.
2. `buildContext` reads the ticket, the brain (FTS5 `OR` of the ticket's title and body words, top 8, bodies for the top 2 and an index line for the rest, 2500-char budget cut between rows), the failure notes of the last cycle, the retry count, the base branch, the operator's `preferences.md`, the absolute paths of the ticket's attachments (appended to `{{ticket}}`), the role's tool list from the MCP table, and for a tester `git diff --stat` of the change plus its code diff without markdown, `docs/` and lockfiles, capped at 32 000 characters (`docs/AGENTS.md` → `{{diff}}`).
3. The template is filled in a single pass and the result inserted into `runs.prompt_rendered`. Same ticket and same database give byte-identical output: every query has a total order and nothing reads the clock.

The template is read from disk on every render, so operator edits (by hand or in Settings → Prompts → Templates) apply without a restart.

The copies follow the shipped defaults unless edited. Each copy or reset records the default's sha256 in `<repo>/.kanban95/templates/.shipped.json`. On daemon start (`initTemplates`), a copy whose sha256 still equals its record is unedited, so a changed default replaces it and the record moves on. An edited copy is never overwritten, nor is one with no record (a board from before the record, or a corrupt `.shipped.json`); a copy with no record that already equals the default is recorded. `GET /api/templates` marks any copy that differs from the current default `stale`, and Settings → Prompts shows it next to Reset. Template-to-role and template-to-phase mapping is the `TEMPLATES` table in `templates.ts`; agent-facing behaviour is in `docs/AGENTS.md`.

## Repo map

```
package.json      npm workspace root: build / test / dev scripts
daemon/           src/ (see Daemon above):
                    api.ts
                    attachments.ts
                    boards.ts
                    context.ts
                    db.ts
                    git.ts
                    grants.ts
                    janitor.ts
                    launcher.ts
                    lifecycle.ts
                    limits.ts
                    mcp.ts
                    mcp-doc.ts
                    merge.ts
                    pty.ts
                    server.ts
                    settings.ts
                    templates.ts
                    trust.ts
                    voice.ts
                  voice-model.json (the pinned speech model)
                  migrations/*.sql (the repo's board.db)
                  migrations/global/*.sql (the global brain, ~/.kanban95/brain.db)
                  test/ (test/cdp.ts drives headless Edge/Chrome, test/ui.ts is the shared daemon-plus-browser setup of the ui-<area>.test.ts files, which vitest.config.ts runs as a second group after the rest; test/changed.ts is `npm run test:changed`; test/.cache/ is gitignored)
                  tsconfig.json, vitest.config.ts; compiled to dist/ (gitignored)
ui/               index.html, app.js (data layer and windows), wm.js (window manager), voice.js (mic and transcription), app.css, icons/*.svg (desktop icons), sounds/{ding,chord}.wav, vendor/{98.css and fonts, xterm/, transformers/}
templates/        default prompt templates (brainstorm, operator, plan, execute, test, housekeeping), copied into each repo and kept in step while unedited
skills/           the Claude Code plugin `kanban95` (.claude-plugin/plugin.json and one folder per skill; docs/AGENTS.md)
Kanban95.cmd      double-click launcher: finds Node 24, installs, builds, runs the shell on a repo
Kanban95.vbs      runs Kanban95.cmd with no console window; a dialog shows its output if it fails
Kanban95.command  macOS launcher: the same steps as Kanban95.cmd
shell/            Cargo.toml, build.rs, tauri.conf.json, tauri.bundle.json (installer overlay), stage.mjs (stages the installed daemon), src/main.rs, icons/icon.ico
docs/             this file, LEARNING.md (guided tour for newcomers), OPERATOR.md (driving the board), img/ (its screenshots), LIFECYCLE.md (state machine, merge queue, janitor), CLIS.md (how each CLI is launched), DATA.md (schema), AGENTS.md (what agents receive and how they behave), SECURITY.md (grants, audit, network), MCP.md (generated tool reference)
<repo>/.kanban95/ board.db (gitignored), .gitignore, sessions/ (gitignored), attachments/ (gitignored), templates/*.md (committed, operator-editable) and templates/.shipped.json (the defaults' hashes, committed with them); created by the daemon on first start. config.json (optional, committed)
~/.kanban95/      brain.db (the global brain, shared by every board; written by brain_add and the Brain window)
                  everything else is written only from Settings, the download dialog and, for projects.json and running/, the daemon:
                    models.json (model catalog, read at each launch)
                    models/ (the downloaded speech model)
                    preferences.md (operator's standing instructions for agents)
                    projects.json (every repo with a board and its wallpaper colour; the daemon adds its own repo on start)
                    running/ (one <pid>.json per live daemon: its repo and port)
                    settings.json (CLI paths, sounds, voice)
```

## Launch

`launch({ db, repo, port }, { ticketId, template, cli, model, effort })` in `daemon/src/launcher.ts`, also exposed as `start().launch(...)`. In order:

1. `createWorktree` → `.worktrees/t-<id>` on `ticket/<id>` from the repo's current branch, reused if it exists; refused if the base branch has uncommitted tracked changes.
2. `startRun` renders the template and inserts the `runs` row (a bad template stops here, nothing is minted).
3. `mint` a grant with the template's role (`TEMPLATES[template].role`).
4. Session dir `.kanban95/sessions/<run-id>/`, owner-only, with `prompt.md` and (Claude Code) `mcp.json`, plus `settings.json` for a Claude worker or tester (`docs/CLIS.md`).
5. `buildArgv` with the role (flags and reach per role in `docs/CLIS.md`); for Claude Code, `preTrustClaude` makes sure the repo root is trusted; then `spawnPty` with `cwd` = worktree and the env allowlist.
6. The session is kept in `sessions` (by run id) until its pty exits. On exit, for any reason: `runs.ended_at` and `runs.scrollback` are written, the grant is revoked, the session dir is removed, the lifecycle's exit hook runs (`runs.outcome`, and the `exit` event if the agent never reported), `session.done` resolves.

The lifecycle owns Launch: `POST /api/tickets/:id/launch` and the transitions after it call `launch` with the run settings from `~/.kanban95/models.json` (and the CLI path from `settings.json`, when set).

A **brainstorm** (`POST /api/brainstorm`) and an **operator terminal** (`POST /api/operator`) share steps 3 to 6 through one function, `launchRoot`, but have no ticket: no worktree, no `runs` row, a grant with no ticket, `cwd` = the repo root, the plan-phase settings. A brainstorm runs the `brainstorm.md` brief on a planner grant (no file writes). An operator terminal runs `operator.md` with the operator's typed `{{mission}}` on an `operator` grant: the worker's CLI flags, and over MCP what the operator could do by hand on the board (every planner tool, plus editing, moving, noting and re-modelling any ticket; never `report_test`). It only starts from the operator's click in the UI, its model and effort come from `.kanban95/config.json` `operator` when set, and its grant is revoked when its pty exits, like every session's (`docs/SECURITY.md` → Operator terminal). Either one's session key is minus its grant id (there is no run id), so its session dir is `.kanban95/sessions/-<grant>/` and its terminal `/pty/-<grant>`. A session dir is owner-only when it holds a bearer (Claude Code's `mcp.json`); a Codex session's dir holds only `prompt.md`, which Codex's read-only sandbox (another Windows account) must be able to read.

Any failure after the run row is written revokes the grant and removes the session dir before the error is rethrown. Revoking the grant over REST kills the pty, which runs the same teardown. `close()` stops new spawns, kills every live pty, waits for their teardown and for the merge queue to drain, then closes the database. On start the daemon runs the janitor sweep and the lifecycle's recovery (`docs/LIFECYCLE.md` → Restart), and the sweep again every 24 hours.

### Terminal websocket

`/pty/<key>` (the run id, or minus the grant id for a brainstorm or operator terminal) with a websocket upgrade, same-origin only. The server first sends the scrollback so far, then every pty output chunk as a text frame, and closes when the pty exits. The client sends JSON: `{"data": "..."}` is written to the pty as typed input, `{"resize": [cols, rows]}` resizes it (1 to 999 each). Anything else is ignored. Several clients may watch one run.

## Events

`/events` is a same-origin websocket that only sends. `{"sound": "ding" | "chord", "ticket": n}` when a ticket merges or needs the operator (a `ding` with `ticket: null` when the runner stops itself); `{"ticket": n}` whenever something about ticket `n` changed (any lifecycle transition, an operator REST mutation, an agent's successful MCP call, a session of that ticket ending); `{"ticket": null}` when the set of live sessions changed without a ticket (a brainstorm or operator terminal started or ended) or the runner changed. The UI never polls the board: it refetches what an event names.

## UI

`ui/`, plain ES modules, no build step. How to use it: `docs/OPERATOR.md`.

- `icons/`: the desktop and taskbar icons, self-drawn 32x32 SVGs (the taskbar shows them at 16px) served from the daemon's origin (`img-src 'self'`). The wallpaper is CSS gradients in `app.css`, no image, over a base colour in `--k95-wall` on `body` (default teal): `app.js` sets it from `GET /api/project` at boot and after Settings → Projects saves, and sets `document.title` to `<folder name> — Kanban95`. Tauri 2 does not copy `document.title` to the OS window, so the shell titles its window the same from its repo argument (`title()` in `shell/src/main.rs`).
- `wm.js`: the window manager.
  - Windows are 98.css `.window`s positioned on `#desktop`, dragged by the title bar (pointer events), resized by CSS (`resize: both`), minimized to a taskbar button, maximized to fill `#desktop` (the `max` class overrides the inline geometry, which stays as the restore geometry; drag and resize are off), clamped so a title bar is always reachable.
  - The taskbar is modern Windows in Win95 dress: after Start, `#pinned` holds one-click launchers for the desktop icons' entries (Quick Launch; built by `desktopIcons()` in `app.js`), then `#tasks` holds one icon-only button per open window. `open()`'s `icon` names the button's picture (`icons/<icon>.svg`, default `window`), the title is its tooltip and `aria-label`: `board`, `inbox`, `brain`, `settings`, `notepad`, `limits`, `ticket`, and for terminals `termIcon(s)` in `app.js` (`execute`, `test`, `brainstorm` for a brainstorm or a plan phase, `operator`). Past the bar's width `#tasks` scrolls (arrow buttons at its ends and the mouse wheel), and focusing a window scrolls its button into view. Each button has a menu (right-click, Shift+F10, Menu key; `open()`'s `items` add entries, such as a terminal's Open ticket), a Ctrl/Shift+click selection whose menu acts on every selected window, and pointer drag to reorder (session only, not saved).
  - Windows opened with `persist` (Board, Brain, Inbox, Settings, Notepad) keep position, size and maximized state in `.kanban95/ui.json` (through `state.js`) as `k95.win.<window id>`, with the desktop size in screen px it was saved at (`dw`, `dh`; the startup layout's entries carry them too): `open` scales a saved place to the current desktop.
  - On a window `resize` (the shell's window, full screen) every window's inline geometry is scaled by the change in desktop size, so nothing leaves a bar of empty desktop; screen px, not CSS px, so a zoom change is not a resize.
  - Windows opened with `tile` (every terminal) take a slot instead, and slots are sticky: `retile()` gives each tiled window that has none the lowest slot number no other tiled window holds (0-based, up to the last `SLOTS` count, 12), and it keeps that number for life, also while minimized or maximized (restore puts it back); nothing else moves when a terminal opens, closes, minimizes or ends. The grid is the first `SLOTS` row (`[up to n, columns, rows]`: 1 → 1×1, 2 → 2×1, 3 → 3×1, 4 → 2×2, 6 → 3×2, 9 → 3×3, 12 → 4×3) whose n exceeds the highest held number, slots numbered in reading order, so it grows only when every slot is taken and shrinks when the top slots free. The region runs from the desktop's left edge to the left edge of the leftmost shown `ACTION` window (Board, Inbox, Notepad), full height; the whole desktop when none is shown or the region is under `MIN_REGION` px. A tiled window whose geometry changed between pointerdown and pointerup (dragged or resized, not maximized) is free (`slot: null, free: true`): it stays where it was left and `place()` is not involved; a title-bar double-click on a free, non-maximized window clears `free` and re-tiles, so it takes the lowest empty slot (on any other window the double-click maximizes). `retile()` runs (debounced 50 ms) when a tiled or action window opens, closes, is minimized, restored, maximized, dragged or let go, on a desktop resize and on a zoom change; a 13th terminal opens at `place()` and waits for a slot to empty. Ended terminals keep their slot until closed (Start → Close ended terminals in `app.js`). To change the arrangement edit `SLOTS` (and `ACTION`).
  - A window with nothing saved and no `tile` opens at `place()`: of the desktop corners and a half-window grid, the spot overlapping the least area of the open, non-minimized windows (top-most, then left-most on a tie).
  - `raise(id)` brings a window to the front, out of minimized, without making it the focused one: a terminal whose state turns `human` (its ticket needs the operator) is raised.
  - `snapshot(ids)` returns the open windows among `ids` with that geometry, bottom-most first: `app.js` builds the startup layout on these (`k95.layout` in `ui.json`, which says which windows `boot` opens; `seed(key, r)` gives each its layout place for that one `open`, used only when the window has no remembered place and never saved, so a window the operator moved opens at its own place and an unmoved one follows the layout; no stored layout means `defaultLayout()`, the action column: Board top right, Inbox bottom right and Notepad left of the Inbox at its height, half the desktop's width together, sized from the desktop at every start and clear of the desktop icons; Reset `forget`s the layout windows' places).
  - A window's place is saved only when its geometry changed, so a click inside an unmoved window does not pin it.
  - Also modal dialogs (`<dialog>`) and pop-up menus.
  - `setZoom(f)` sets the UI zoom (`settings.json` `zoom`, Ctrl+=/−/0 in `app.js`) as CSS `zoom` on `body`, so dialogs and menus appended to it scale too, and re-clamps every window. Inside the zoom, offsets, inline styles and saved geometry are CSS px before zoom, while `clientX`/`clientY` and `getBoundingClientRect` are screen px: divide those by `scale()` before writing them to a style (drag, menus, the card ghost, the Start menu). xterm measures its cells after zoom, so terminals keep their `fontSize` and only refit.
- `app.js`: the data layer and every window.
  - It loads tickets, sessions, the Inbox and both settings files once, then listens on `/events`: a `{ticket}` frame refetches that ticket, then the live sessions and the Inbox, and asks each open window to redraw; each window decides whether the event concerns it (a ticket window only for its own ticket; form tabs never, so typing is not lost).
  - A new session opens its terminal window automatically, behind the focused window; a terminal whose run the board ended (`submit`, `pass`, `fail`, or `conflict` and `restart`, which start a new run of the same ticket) closes itself after a moment; one the agent exited on its own, or that was revoked or died, stays open, marked ended.
  - When `refreshTicket` finds a ticket in Backlog it closes all of that ticket's terminals, ended or not: a reset stopped its agents. Add any new lifecycle event that runs `end_session` to that list in `openTerminal`, or its stale window will sit in front of the new run and the ticket will look stuck.
  - A terminal's title bar is coloured by `termState(s, ended)` in `app.js`, first match wins: ended, the ticket's `needs_human`, then brainstorm/operator, then the phase. It sets `data-state` on the window; the palette is the `.k95-win[data-state=…]` rules in `app.css`, whose unfocused (`.inactive`) gradient is the same two colours mixed toward grey. `refreshTicket` repaints that ticket's open terminals, so a flag recolours them in place.
- Board drag uses pointer events, not HTML5 drag and drop. Only operator moves are accepted (Backlog → In Progress; anything → Backlog, which also clears flags and retries; the daemon stops a live agent on that move and the ticket's terminal windows close); an illegal drop snaps back and the status bar names the allowed columns. Clicking a column's legend folds it to a 24px strip (label and count vertical, no cards; the grid's `grid-template-columns` gives the others the width). A strip keeps `data-status`, so drops onto it work; its count turns red when it holds a needs-human ticket. The folded set is `k95.collapsed` in `.kanban95/ui.json`; with nothing saved, Done starts folded (a saved empty set unfolds it).
- The Board's Filter, Sort and Group (`view` in `ui/app.js`, `k95.view` in `.kanban95/ui.json`) only change what a redraw shows: `shown(t)` decides a card, `sorted` orders each column (ties by id), `columnBody` adds the tag headings. A card the filter hides or a folded column holds is out of the selection (`picked()` drops it, Ctrl+A skips it), and Shift+click ranges follow the drawn order (`order`). With Group by tag a card with two tags is drawn under both.
- `state.js`: the UI's state across restarts, `.kanban95/ui.json` via `GET`/`PUT /api/ui`. `load()` once in `boot` before any window opens, then `get`/`set` on an in-memory object; a `set` writes the whole object 500 ms after the last change, and a pending write is flushed (`keepalive` fetch) on `pagehide`. Nothing in `ui/` uses browser storage: the daemon's port, so the page's origin, changes every start.
- `voice.js`: the mic button and `transcribe(blob)` (see Voice).

Vendored from npm, no CDN: 98.css 0.1.21; `@xterm/xterm` 6.0.0 and `@xterm/addon-fit` 0.11.0 (`xterm.mjs`, `addon-fit.mjs`, `xterm.css`); `@huggingface/transformers` 4.3.0 (`transformers.min.js`, which bundles the ONNX runtime's JavaScript) with the matching `onnxruntime-web` 1.31.0-dev.20260914 WebAssembly runtime (`ort-wasm-simd-threaded.asyncify.{mjs,wasm}`, 27 MB, used for both WebGPU and WASM). Licenses sit next to each (onnxruntime-web is MIT and ships no license file).

## Voice

A mic button sits beside every text field (added by a `MutationObserver`, so new windows get one too; fields marked `data-mic="off"`, such as model ids and paths, do not) and in every terminal's title bar. Push to talk by default, click-to-toggle in Settings. `MediaRecorder` records; `transcribe(blob)` dispatches on the configured backend, of which `local` is the only one: transformers.js runs `automatic-speech-recognition` with the pinned Whisper model, on WebGPU when the webview has an adapter and WASM otherwise, after `AudioContext` decodes the audio to 16 kHz mono. Text goes to the field's caret, or to the pty as `{data}` without Enter. A daemon-side or provider backend would be another entry in `voice.js`'s `backends` table; nothing else changes.

The model is pinned in `daemon/voice-model.json`: `onnx-community/whisper-base.en` at one Hugging Face revision, seven files (configs, tokenizer, q8 encoder and merged decoder, 79.6 MB), each with size and SHA-256. The UI shows that manifest before anything is fetched; on OK, `POST /api/voice/download` fetches each file from `<source>/resolve/<revision>/<path>`, refuses more bytes than pinned, checks size and hash, and renames it into `~/.kanban95/models/whisper-base.en/`; a mismatch deletes the file and fails the download. transformers.js is set to local models only (`/voice-model/<id>/…`, which serves manifest-listed files and nothing else), no browser cache, and no WASM preload cache (its preload imports the runtime from a `blob:` URL, which the CSP refuses).

Checked on Windows 11, WebView2 154 inside the Tauri window: `navigator.gpu` gives an adapter and the model runs on **WebGPU**; the bundled fixture transcribes correctly, about 7 s for the first call (model load included) and 3 s after. In headless Edge (no adapter) it runs on WASM.

## Working on the board

Gotchas collected while the board was built. Each one cost a phase some time.

**Node and the daemon**
- Agents need no Node setup: their pty `PATH` starts with the daemon's Node 24, and a new worktree has already run `npm ci` (`worktree_setup`, `docs/LIFECYCLE.md` → Worktree setup). Run `npm test` in the worktree as it is. Never junction main's `node_modules` into a worktree.
- Outside the board, `node` on PATH may still be an older Node. On Node 22 `import.meta.main` is `undefined`, so the daemon prints nothing and the shell fails with `bad daemon handshake ""`, and tests fail with `no such module: fts5`. `Kanban95.cmd` finds Node 24 through fnm; in a bare shell run `fnm env --use-on-cd | Out-String | Invoke-Expression` first, or put the Node 24 install dir first on PATH. `fnm exec` cannot start `npm` (a `.cmd` shim), and Node 24 throws on `process.exit(true)`.
- The daemon's first stdout line is the handshake. Anything printed before it breaks the shell; log to stderr.
- A daemon started with stdin closed exits right after printing its port (Daemon lifetime). Spawn it with a held-open stdin pipe.
- `DatabaseSync.exec` with several statements leaves a transaction open if a middle one throws. `migrate` and `api.ts`'s `transaction()` use explicit `BEGIN` / `COMMIT` / `ROLLBACK`; do the same anywhere else.
- `audit.ticket_id` is a foreign key: attributing an audit row to a ticket that does not exist throws. Check existence or pass `null`.
- `apply` is synchronous and may spawn agents (`execFileSync git`, a pty) inside an MCP request. Effects run after the transaction commits, so a failing effect (a launch) re-enters `apply` with `exit`.
- With the runner off (no `runner.json`, the default in tests) the board starts no agent by itself: a held dependent stays held when its dependency merges and a conflict below the retry cap waits with no agent (`apply`'s `auto`, docs/LIFECYCLE.md → Stop holds every automatic launch). A test that expects either to run on its own must turn the runner on, and keep something running (a `hang` ticket) if a flagged ticket would otherwise let it stop itself.
- `sessions` in `launcher.ts` is module-level, shared by every `start()` in one process: one daemon per process.
- A merge that touches `daemon/` or `shell/` takes effect only after a board restart (`Kanban95.cmd` rebuilds); `ui/` changes show at once.

**MCP**
- `TOOLS` in `mcp.ts` is the only place a tool is defined. After changing its `access` or `description`, run `npm run docs:mcp` or the doc test fails. `MOVE_TARGETS` and `WORKER_FIELDS` feed both enforcement and the matrix text.
- A handler refuses by throwing the module-private `Deny`; anything else thrown is audited as `error` and its message goes back to the agent verbatim.
- `enableJsonResponse: true` returns each tool result as one JSON body. A tool that needs progress notifications would need that switched off for its server.
- The MCP SDK pulls in express, hono and ajv transitively. Nothing imports them; `node:http` is the only server.

**Templates**
- Operator edits to `<repo>/.kanban95/templates/` survive restarts. A changed default in `templates/` reaches a repo's copy on the next daemon start only if the copy is unedited and recorded in `.shipped.json` (Prompts above); anything else stays and shows as differing in Settings → Prompts, where Reset brings it back in step. A template that adds a `{{var}}` reaches copies only after the board restarts on the build that knows it, which is the order this gives for free.
- Running the daemon on this repo creates `./.kanban95/templates/` (untracked, not ignored: in a target repo they are meant to be committed).

**Windows**
- node-pty prints `Error: AttachConsole failed` to stderr on `kill()`. It is harmless (the process is gone). `useConptyDll: true` silences it at about 3 s per spawn, so it is off. A one-off node script using node-pty does not exit by itself after the pty ends: call `process.exit`.
- A test must close its database before `rmSync`, or it gets `EPERM`.
- The repo is LF (`.gitattributes`), except `.cmd` files, which are CRLF because cmd.exe misreads labels with LF. Python on Windows writes CRLF in text mode: open files with `newline=''` when scripting edits.
- A stale `shell/target` from another checkout path fails the Tauri build reading permission files; `cargo clean` fixes it.
- Do not redirect `USERPROFILE` for the Tauri shell: WebView2 fails to start. Killing the shell with `kill()` alone can leave `msedgewebview2.exe` children; the job object (Daemon lifetime) handles a normal exit.
- Probing a second shell beside a live board: set `KANBAN95_HOME` to a scratch dir (or the probe's repo lands in the operator's `projects.json`) and `WEBVIEW2_USER_DATA_FOLDER` to another (else the probe gets its own per-repo profile under `%LOCALAPPDATA%`, see Daemon lifetime, to delete afterwards), find your processes by walking `ParentProcessId` from your shell's pid, and kill only those, never by name. `taskkill /F /PID <shell>` without `/T` is enough. `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<n>` exposes the webview to DevTools (`http://127.0.0.1:<n>/json/list`).
- `cargo run` / `cargo build` of the shell always relinks `kanban95-shell.exe`: tauri-build tells cargo to watch `shell/capabilities`, which does not exist (on purpose), and a missing watched path reruns the build script every time. On Windows the relink fails with `Access is denied` while any board runs from that exe, so a second `Kanban95.cmd` from the same checkout fails; Start → Projects starts the built exe directly instead.
- A process started by the daemon stays in its shell's kill-on-close job, also with `detached: true`. To outlive the board, create it through WMI (`boards.ts` `startDetached`); it gets a fresh environment unless one is passed in `Win32_ProcessStartup.EnvironmentVariables`.
- In PowerShell, `$null` passed to a P/Invoke `string` parameter arrives as `""`: `FindWindowW($null, title)` looks for a class named `""` and finds nothing. Pass `[NullString]::Value`.
- Never rebuild or run the installer while the operator's board is live: a rebuild replaces `daemon/dist` under the running daemon, and NSIS closes the app. Test on a second instance.

**Tests**
- Imports between `src/` files use `.js` extensions; tests import `../src/x.ts`.
- Node's `fetch` strips a caller-set `Host` header; a test that needs a foreign `Host` uses `node:http.request`.
- An unclosed MCP SDK client keeps vitest alive; close every client in `afterAll`.
- Every test file runs with a throwaway home (`daemon/test/home.ts`), and `daemon/test/real-home-guard.ts` fails the run if the real home was touched by this run: it points `TEMP`/`TMP` at a fresh `k95-run-*` dir before the workers start and fails only on trust entries under it, so another worktree's run at the same time cannot fail yours (`docs/SECURITY.md` → Operator files the board writes). Keep it that way.
- Headless Edge resizes its window to `--window-size` minus chrome; `cdp.ts` sets the viewport with `Emulation.setDeviceMetricsOverride` to get an exact size.
- `/events` carries several frame shapes; anything listening must ignore frames it does not know.
- The silence watch (`watchSilence`, `docs/LIFECYCLE.md` → Silent agents) arms its first timer when `start()` runs. A test that shortens `SILENCE` does it in a `beforeAll` of its own describe, which runs before the outer `beforeEach` starts the daemon, and restores it in `afterAll`; anywhere else a shortened limit flags every fake agent that stays up.
- `daemon/vitest.config.ts` sorts test files into projects by their imports: `pty` (imports `../src/launcher.ts`; 30 s per test and hook), `unit` (no retry: a unit failure is real), then `browser` (imports `./cdp.ts`, which every `ui-*.test.ts` does; `retry: 1`, and each retried test prints a `RETRIED x1:` line), then `restart` (alone, last). A new file needs no config entry. The browser files run as a second group, one at a time: each starts its own daemon and headless Edge, and together they time out unrelated tests and lock each other's profile dirs (`rmSync` EPERM at `afterAll`). `maxWorkers: 4`: `lifecycle.test.ts` (80 to 100 s) is the critical path of the first group, so more workers only add ptys fighting for the CPU. `tsc` is incremental (`dist/.tsbuildinfo`).
- Two test commands (`docs/AGENTS.md` → Verification): `npm test` (`tsc` and the full suite) is run once per ticket, by the tester, as the merge gate; `npm run test:changed -- <base>` (`daemon/test/changed.ts`, no `tsc`) runs only the tests the worktree's changes against `<base>` can affect, and is what the worker runs, and the tester while it iterates. vitest's module graph cannot see `ui/`, `templates/`, `skills/` or docs, so `changed.ts` maps those paths to tests (`ui/` → every test importing `./cdp.ts`); a new test that reads such a file needs a row there. `test:changed` needs `daemon/dist` current for `server.test.ts`: run `npm run build` too.
- The suite still uses real ptys, headless browsers and git. A browser test that fails twice, or a pty or unit test that fails once, is a real failure; rerun the file alone only to tell your change from load.
- A UI test that needs a window place, layout or folded column set in advance calls `setUi(key, value)` (`test/ui.ts`): it sets it in the open page's `state.js` cache, so the live page sees it at once and a reload right after keeps it (the pagehide flush). Writing `ui.json` or `PUT /api/ui` from the test while a page is open loses to that page's next write of its own copy. A UI test may start a second daemon in the same browser: each daemon's cookie is `k95-<port>` (cookies ignore the port, so one shared name would let the second login replace the first), and the first board is still logged in afterwards (`ui-state.test.ts`).
- With nothing saved, Done starts folded (a folded column renders no cards, so `column(id)` is null for a Done ticket): a UI test that needs a Done card presets `k95.collapsed` with `setUi` and reloads. Terminals tile into the `SLOTS` region, so test `place()` with a plain `wm.open` window.
- `cdp.ts` starts the browser with `--mute-audio`. Headless still plays sound, and the UI tests' merges and questions send the board's ding and chord with the test home's default settings (sounds on): unmuted, every test run chimed on the operator's speakers with nothing on the board to explain it.
- Killing a pty before the fake agent printed its first line crashes the vitest worker natively on Windows (exit `0xC0000374`, heap corruption in node-pty): wait for the fake's first output, then `kill()` and await `done` (`end()` in `launcher.test.ts` and `operator.test.ts`).
- A ticket worktree gets its own dependencies: run `npm install` (or `npm ci`) in the worktree with Node 24 on PATH. Never junction or symlink the main checkout's `node_modules`, or anything else of the main checkout's, into a worktree. `git worktree remove --force` followed such a junction (and `node_modules/@kanban95/daemon` inside it) and emptied the main checkout's `daemon/`. The janitor now unlinks every link in a worktree before removing it and refuses when a link into the main checkout will not let go (`docs/LIFECYCLE.md` → Janitor), but a link is still a way to break main from a worktree: any tool that writes or deletes through it reaches main's files.
- The UI is CSS-zoomed on `body` (operator's `zoom` setting). Pointer coordinates and `getBoundingClientRect` are screen px, offsets and inline styles CSS px before zoom: divide by `scale()` from `wm.js` before writing a screen value to a style. A UI test that changes the zoom resets it with Ctrl+0, since it persists in the test home's `settings.json`.
- Terminals tile (`retile` in `wm.js`, 50 ms debounced) and save no place: a UI test asserts terminal geometry inside `until()`, and an emulated viewport change is seen by the page a moment later, so wait for the windows to have scaled, not just for the desktop size. A terminal smaller than `.k95-win`'s 220×120 minimum spills out of its slot: test grids in a region wide enough for them.
- Moving an element in the DOM (`after`, `before`) drops its pointer capture. A reorder drag listens on `window`, as `dragCard` and `dragTask` do.
- Several tickets run at once and every branch merges into the same files. Put a new test in its own `daemon/test/<feature>.test.ts`; a new UI test goes in a `ui-<area>.test.ts` and imports `./ui.ts` for the daemon and browser. In the other hot files (`daemon/src/api.ts` route table, `ui/app.js`, `docs/*.md`) add new routes and UI blocks next to related ones rather than at the end, and new doc content as its own section.
- `api.ts` and `mcp.ts` import each other. A value from `api.ts` read while `mcp.ts` loads (inside the `TOOLS` table, not inside a `run`) is in its temporal dead zone when the built daemon starts from `dist/server.js`: `server.test.ts` times out with "Cannot access X before initialization" while the vitest files that import `api.ts` first pass. Put such constants in a leaf module (`db.ts` holds the brain ones).

## How the board was built

Planned on 2026-10-07 as nine phases, each a handoff prompt run by a fresh agent that wrote a log entry for the next. Phases 0 to 2 (scaffold, daemon core and grants, MCP) were built by hand with Claude Code; from phase 3 (templates) on the board built itself, ticket by ticket. Phase 8 (2026-10-08) shipped the agent skills, finished `docs/`, and ran two dogfood cycles: a throwaway sample repo brainstormed into five dependent tickets that all merged with no `needs_human` flag (the walkthrough and its manual touches are in `docs/OPERATOR.md` → Dogfood walkthrough), then this repo, whose improvements are now brainstormed and launched on its own board.

What changed when the build plan was retired:

- The build plan (the spec) and the phase handoffs with their log are deleted. Everything still true moved into the living docs: the design principles and conventions into `CLAUDE.md`; decisions into the doc of the part they shape (`SECURITY.md`, `CLIS.md`, `LIFECYCLE.md`, `AGENTS.md`); the gotchas from the phase log into Working on the board above, `SECURITY.md` and `CLIS.md`. Per-phase deviations that the docs already describe as the current design were not repeated.
- New knowledge goes where it applies: a behaviour change into its living doc in the same ticket, a gotcha a future ticket would trip on into the brain (`brain_add`) and, when it is about the code itself, into Working on the board. There is no phase log any more; the board's notes, runs and brain are the record.
- Housekeeping now has only the living docs, plans and proposals to judge: with no build plan or handoff left, a run on a clean repo should report nothing to change.
