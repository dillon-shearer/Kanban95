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
- **Daemon** (`daemon/src/`): the only process with state. `server.ts` is the HTTP plumbing (bind, origin guard, static files, `/health`, routes `/api/*` to `api.ts`). `db.ts` opens and migrates the per-repo SQLite file (schema in `docs/DATA.md`). `grants.ts` mints, verifies, revokes bearer grants and writes audit rows (`docs/SECURITY.md`). `mcp.ts` is the agent-facing MCP server at `/mcp`: one table of tools, each with a description, a role access cell and a handler, enforced per grant and audited per call. `mcp-doc.ts` renders `docs/MCP.md` from that table. `templates.ts` copies the default prompt templates from `templates/` into `<repo>/.kanban95/templates/` once and renders them; `context.ts` builds the variables for a ticket and records the rendered prompt on a `runs` row (`startRun`) before anything is spawned (see Prompts below). `git.ts` creates and removes the per-ticket worktree. `launcher.ts` launches an agent (worktree, run row, grant, session dir, argv, pty) and tears it down (see Launch below); `pty.ts` spawns the CLI in a pseudo-terminal with an env allowlist and keeps a 2000-line scrollback. `trust.ts` pre-trusts the repo root for Claude Code before a launch. `lifecycle.ts` is the ticket state machine: one table of transitions, `apply(board, ticket, event)` and the runner's `tick` (`docs/LIFECYCLE.md`). `merge.ts` is the one serialized merge queue. `janitor.ts` removes worktrees, branches, session dirs, grants and old scrollback nobody needs any more. `settings.ts` reads and writes the operator's `~/.kanban95/models.json`, `settings.json` (schema-checked) and `preferences.md`, lists the models the installed CLIs know (`knownModels`, for the Settings dropdowns), and resolves a run's CLI, model, effort and executable. `attachments.ts` stores, lists and removes the files attached to a ticket under `<repo>/.kanban95/attachments/<id>/`. `voice.ts` downloads, verifies and serves the speech model (see Voice below). The repo it serves is `argv[2]`, defaulting to the cwd.
- **UI** (`ui/`): plain files served by the daemon, ES modules, no bundler (see UI below). 98.css, xterm.js and transformers.js are vendored in `ui/vendor/` so nothing loads from a CDN at runtime.

## Port handshake

1. Before spawning, the shell runs `node --version`. Missing or older than 24: a native Yes/No dialog names the problem and the Node download link and offers to open it in the default browser (`ShellExecuteW`, from the shell, not the webview), and the shell exits with code 1.
2. Shell mints a random secret and spawns the daemon with it in `KANBAN95_SECRET` (environment, never argv) and `stdin` and `stdout` piped.
3. Daemon binds `127.0.0.1:0` (kernel-assigned port; `KANBAN95_PORT` fixes it, for debugging), then prints exactly one line to stdout: `KANBAN95 port=<n>`.
4. Shell reads that line, builds `http://127.0.0.1:<n>/?k95=<secret>` and creates the main webview window on it; the daemon trades that for an HttpOnly cookie and redirects to `/`. Any other first line is a handshake error; the shell kills the child, shows an error dialog and exits.
5. Shell keeps draining daemon stdout to its own stderr prefixed `[daemon]` so the pipe can never fill and block the daemon.

## Daemon lifetime

- **Job object**: the shell's first act is to put itself in a Windows job with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. The daemon and WebView2's `msedgewebview2.exe` processes inherit it, and only the shell holds the job handle, so when the shell process ends for any reason (window close, crash, `taskkill /f`, logoff, shutdown) Windows kills every process in the tree.
- **Restart once**: a supervisor thread polls the daemon every 250 ms. The first unexpected exit starts a new daemon with a fresh secret, moves the navigation lock to its new port and navigates the window to `/?k95=<secret>` there (a new origin, so the UI's `localStorage`, window positions included, starts empty). A second exit, or a failed restart, shows a native error dialog and closes the board. No loop. `cargo test --manifest-path shell/Cargo.toml` covers this with stand-in daemons that crash at once.
- **Kill on exit**: on Tauri's `RunEvent::Exit` the shell takes the child out of the supervisor's slot (which stops the supervisor) and calls `kill()` then `wait()` on it.
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
- The webview is an "external" URL to Tauri and the shell declares no capabilities, so every Tauri command is refused for it (tested in `shell/`). The UI talks to the daemon over plain HTTP, the `/events` websocket and a websocket per terminal. The shell cancels navigation off the daemon's origin and answers permission requests itself: microphone yes, everything else no. See `SECURITY.md` → Webview.

## REST (operator UI only, same-origin)

Every `/api/*` request needs the `k95` cookie holding the shell secret, or gets `401`; so do the `/events` and `/pty` websockets (`docs/SECURITY.md` → Shell secret).

| method | path | notes |
|---|---|---|
| GET, POST | `/api/tickets` | list / create. Body fields: `title` (required), `body`, `criteria`, `status`, `cli`, `model`, `effort`, `retry`, `needs_human`, `blocked_on_deps`, `depends_on: number[]` |
| GET, PATCH, DELETE | `/api/tickets/:id` | same fields on PATCH; `null` clears `cli`/`model`/`effort`; DELETE also removes `.kanban95/attachments/<id>/` |
| GET | `/api/tickets/:id/notes` `/runs` `/audit` | rows for that ticket, oldest first |
| GET, POST | `/api/tickets/:id/attachments` | list `[{name, path, size}]` (`path` absolute) / upload: the raw file bytes as the body, its name in `?name=`. The name is cleaned to a safe basename (anything outside letters, digits and ` ._()+-` becomes `_`); one with `/`, `\` or `..` is refused `400`, a body over 10 MB `413`. A clash is stored as `<stem>-1<ext>`, never overwritten. `201` with the stored entry |
| GET, DELETE | `/api/tickets/:id/attachments/:name` | serve / remove one. PNG, JPEG, GIF, WebP and BMP are served inline with their image type; anything else as an `application/octet-stream` download, so an uploaded page never runs on the board's origin |
| GET | `/api/brain?q=&limit=` | FTS5 ranked search (title and tags weigh more than body), limit at most 100; no `q` lists newest. Each row carries `ticket_status`, its source ticket's status (null when none or deleted) |
| GET | `/api/grants` | all grants, never the hash |
| DELETE | `/api/grants/:id` | revoke and kill the session's pty; 404 if not live |
| POST | `/api/tickets/:id/launch` `/api/tickets/:id/answer` `/api/tickets/:id/merge` `/api/tickets/:id/resume` | lifecycle events (`docs/LIFECYCLE.md`); `409` when the state machine has no such transition |
| POST | `/api/tickets/housekeeping` | creates a housekeeping ticket and launches it (the Housekeeping button) |
| GET | `/api/tickets/:id/diff` | `{diff}`: the worktree against its fork point, uncommitted tracked changes included; `null` without a worktree |
| GET | `/api/inbox` | what flagged tickets wait on: unanswered `question` notes, and the newest `failure` note when no newer question is open (`kind`, `body`, `role`, `created_at`, and the ticket's `title`, `status`, `merged_at`) |
| POST | `/api/brain` | add a note: `title`, `body` (at most 1500 characters), optional `tags` |
| PATCH | `/api/brain/<id>` | edit a note in place: any of `title`, `body`, `tags`; 404 for an unknown id |
| DELETE | `/api/brain/<id>` | delete a note; 404 for an unknown id |
| GET | `/api/sessions` | live agent sessions: `id` (the `/pty/<id>` key), `ticket_id`, `run_id`, `grant_id`, `role`, `phase`, `model` |
| DELETE | `/api/sessions/:id` | the operator's X on a terminal: ends the session (`runs.outcome` = `closed`, grant revoked, pty killed); a ticket session also flags its ticket (`exit` with an operator note). 404 when not live. Audited as `sessions.end` |
| POST | `/api/brainstorm` | starts a brainstorm session (planner, repo root); returns it in the `/api/sessions` shape |
| POST | `/api/operator` | `{ mission }` (non-empty): starts an operator terminal (operator grant, repo root, the mission in its brief); returns it in the `/api/sessions` shape |
| GET, PUT | `/api/config/models` `/api/config/settings` | `~/.kanban95/models.json` / `settings.json`: GET returns `{path, value}` as written (`null` when absent), PUT checks the whole file against its schema (`400` naming the field) and writes it |
| GET, PUT | `/api/notepad` | `<repo>/.kanban95/notepad.md` as plain text: `{value}`, `''` when absent; PUT refuses a non-string with `400` and more than 256 KB with `413`. Not audited |
| GET, PUT | `/api/runner` | the Run toggle: `{on, why?, running, left, backlog}`; PUT takes `{"on": boolean}`, audited `runner.set` (`docs/LIFECYCLE.md` → The runner) |
| GET, PUT | `/api/config/preferences` | `~/.kanban95/preferences.md` as plain text: `{path, value}`, `value` is `''` when absent; PUT refuses a non-string or more than 16 KB with `400` |
| GET | `/api/models` | `{claude: string[], codex: string[]}`: the model names each installed CLI knows (Codex's `~/.codex/models_cache.json`, Claude's `--help` and executable), for the Settings → Models dropdowns |
| GET, DELETE | `/api/trust` | Claude Code's trust entry for this repo root: status, or clear it (`docs/CLIS.md` → First-run prompts) |
| GET | `/api/voice` | speech model: id, source, revision, license, files with size and SHA-256, `downloaded`, `received` (bytes so far while downloading) |
| POST | `/api/voice/download` | downloads and verifies the model; `502` naming the file on any failure |

Errors are `{ "error": "..." }`: 400 for bad input, a constraint violation or a dependency cycle, 404, 405, 409 for a lifecycle refusal, 413 for bodies over 1 MiB (10 MB for an attachment upload). Every POST/PUT/PATCH/DELETE writes an audit row, including failed ones.

## MCP (agents only, bearer grant)

`POST /mcp` is a stateless Streamable HTTP MCP endpoint (no session id, JSON responses). `handleMcp` reads `Authorization: Bearer <token>`, resolves it with `grants.verify`, answers `401` with no audit row when that fails, and otherwise builds a per-request `McpServer` whose twelve tools close over the grant. One wrapper around every tool checks the role cell, runs the handler, and writes exactly one audit row (`ok`, `denied` or `error`) with the grant id and the ticket the call was about. Worker and tester grants are bound to one ticket and may omit `ticket_id`; naming another ticket is a scope denial. Tool list, role matrix and argument tables are in `docs/MCP.md`, generated from the same table the server enforces (`npm run docs:mcp`); a test fails when the file drifts.

## Prompts

1. `startRun(db, repo, {ticketId, template, cli, model, effort, worktree?, base?})` loads `<repo>/.kanban95/templates/<template>.md`. A placeholder outside `VARS` throws here, naming it.
2. `buildContext` reads the ticket, the brain (FTS5 `OR` of the ticket's title and body words, top 8, bodies for the top 2 and an index line for the rest, 2500-char budget cut between rows), the failure notes of the last cycle, the retry count, the base branch, the operator's `preferences.md`, the absolute paths of the ticket's attachments (appended to `{{ticket}}`), the role's tool list from the MCP table, and for a tester `git diff --no-color --no-ext-diff <base>...HEAD` in the worktree.
3. The template is filled in a single pass and the result inserted into `runs.prompt_rendered`. Same ticket and same database give byte-identical output: every query has a total order and nothing reads the clock.

The template is read from disk on every render, so operator edits apply without a restart. Template-to-role and template-to-phase mapping is the `TEMPLATES` table in `templates.ts`; agent-facing behaviour is in `docs/AGENTS.md`.

## Repo map

```
package.json      npm workspace root: build / test / dev scripts
daemon/           src/{server,api,db,grants,mcp,mcp-doc,templates,context,git,pty,launcher,trust,lifecycle,merge,janitor,settings,attachments,voice}.ts, voice-model.json (the pinned speech model), migrations/*.sql, test/ (test/cdp.ts drives headless Edge/Chrome; test/.cache/ is gitignored), tsconfig.json, vitest.config.ts; compiled to dist/ (gitignored)
ui/               index.html, app.js (data layer and windows), wm.js (window manager), voice.js (mic and transcription), app.css, icons/*.svg (desktop icons), sounds/{ding,chord}.wav, vendor/{98.css and fonts, xterm/, transformers/}
templates/        default prompt templates (brainstorm, operator, plan, execute, test, housekeeping), copied into each repo once
skills/           the Claude Code plugin `kanban95` (.claude-plugin/plugin.json and one folder per skill; docs/AGENTS.md)
Kanban95.cmd      double-click launcher: finds Node 24, installs, builds, runs the shell on a repo
shell/            Cargo.toml, build.rs, tauri.conf.json, tauri.bundle.json (installer overlay), stage.mjs (stages the installed daemon), src/main.rs, icons/icon.ico
docs/             this file, LEARNING.md (guided tour for newcomers), OPERATOR.md (driving the board), img/ (its screenshots), LIFECYCLE.md (state machine, merge queue, janitor), CLIS.md (how each CLI is launched), DATA.md (schema), AGENTS.md (what agents receive and how they behave), SECURITY.md (grants, audit, network), MCP.md (generated tool reference)
<repo>/.kanban95/ board.db (gitignored), .gitignore, sessions/ (gitignored), attachments/ (gitignored), templates/*.md (committed, operator-editable); created by the daemon on first start. config.json (optional, committed)
~/.kanban95/      models.json (model catalog, read at each launch), settings.json (CLI paths, sounds, voice), preferences.md (operator's standing instructions for agents), models/ (the downloaded speech model); written only from Settings or the download dialog
```

## Launch

`launch({ db, repo, port }, { ticketId, template, cli, model, effort })` in `daemon/src/launcher.ts`, also exposed as `start().launch(...)`. In order:

1. `createWorktree` → `.worktrees/t-<id>` on `ticket/<id>` from the repo's current branch, reused if it exists; refused if the base branch has uncommitted tracked changes.
2. `startRun` renders the template and inserts the `runs` row (a bad template stops here, nothing is minted).
3. `mint` a grant with the template's role (`TEMPLATES[template].role`).
4. Session dir `.kanban95/sessions/<run-id>/`, owner-only, with `prompt.md` and (Claude Code) `mcp.json`.
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

- `icons/`: the desktop icons, self-drawn 32x32 SVGs served from the daemon's origin (`img-src 'self'`). The wallpaper is CSS gradients in `app.css`, no image.
- `wm.js`: the window manager. Windows are 98.css `.window`s positioned on `#desktop`, dragged by the title bar (pointer events), resized by CSS (`resize: both`), minimized to a taskbar button, maximized to fill `#desktop` (the `max` class overrides the inline geometry, which stays as the restore geometry; drag and resize are off), clamped so a title bar is always reachable. Taskbar buttons shrink to 60px; past that `#tasks` scrolls (arrow buttons at its ends and the mouse wheel), and focusing a window scrolls its button into view. Windows opened with `persist` (Board, Brain, Inbox, Settings) keep position, size and maximized state in `localStorage`. Also modal dialogs (`<dialog>`) and pop-up menus.
- `app.js`: the data layer and every window. It loads tickets, sessions, the Inbox and both settings files once, then listens on `/events`: a `{ticket}` frame refetches that ticket, then the live sessions and the Inbox, and asks each open window to redraw; each window decides whether the event concerns it (a ticket window only for its own ticket; form tabs never, so typing is not lost). A new session opens its terminal window automatically, behind the focused window; a terminal whose run ended with a reported outcome (`submit`, `pass`, `fail`) closes itself after a moment, one that was revoked or died stays open, marked ended.
- Board drag uses pointer events, not HTML5 drag and drop. Only operator moves are accepted (Backlog → In Progress; anything → Backlog, which also clears flags and retries and stops a live agent); an illegal drop snaps back and the status bar names the allowed columns.
- `voice.js`: the mic button and `transcribe(blob)` (see Voice).

Vendored from npm, no CDN: 98.css 0.1.21; `@xterm/xterm` 6.0.0 and `@xterm/addon-fit` 0.11.0 (`xterm.mjs`, `addon-fit.mjs`, `xterm.css`); `@huggingface/transformers` 4.3.0 (`transformers.min.js`, which bundles the ONNX runtime's JavaScript) with the matching `onnxruntime-web` 1.31.0-dev.20260914 WebAssembly runtime (`ort-wasm-simd-threaded.asyncify.{mjs,wasm}`, 27 MB, used for both WebGPU and WASM). Licenses sit next to each (onnxruntime-web is MIT and ships no license file).

## Voice

A mic button sits beside every text field (added by a `MutationObserver`, so new windows get one too; fields marked `data-mic="off"`, such as model ids and paths, do not) and in every terminal's title bar. Push to talk by default, click-to-toggle in Settings. `MediaRecorder` records; `transcribe(blob)` dispatches on the configured backend, of which `local` is the only one: transformers.js runs `automatic-speech-recognition` with the pinned Whisper model, on WebGPU when the webview has an adapter and WASM otherwise, after `AudioContext` decodes the audio to 16 kHz mono. Text goes to the field's caret, or to the pty as `{data}` without Enter. A daemon-side or provider backend would be another entry in `voice.js`'s `backends` table; nothing else changes.

The model is pinned in `daemon/voice-model.json`: `onnx-community/whisper-base.en` at one Hugging Face revision, seven files (configs, tokenizer, q8 encoder and merged decoder, 79.6 MB), each with size and SHA-256. The UI shows that manifest before anything is fetched; on OK, `POST /api/voice/download` fetches each file from `<source>/resolve/<revision>/<path>`, refuses more bytes than pinned, checks size and hash, and renames it into `~/.kanban95/models/whisper-base.en/`; a mismatch deletes the file and fails the download. transformers.js is set to local models only (`/voice-model/<id>/…`, which serves manifest-listed files and nothing else), no browser cache, and no WASM preload cache (its preload imports the runtime from a `blob:` URL, which the CSP refuses).

Checked on Windows 11, WebView2 154 inside the Tauri window: `navigator.gpu` gives an adapter and the model runs on **WebGPU**; the bundled fixture transcribes correctly, about 7 s for the first call (model load included) and 3 s after. In headless Edge (no adapter) it runs on WASM.

## Working on the board

Gotchas collected while the board was built. Each one cost a phase some time.

**Node and the daemon**
- `node` on PATH may still be an older Node. On Node 22 `import.meta.main` is `undefined`, so the daemon prints nothing and the shell fails with `bad daemon handshake ""`. `Kanban95.cmd` finds Node 24 through fnm; in a bare shell run `fnm env --use-on-cd | Out-String | Invoke-Expression` first, or put the Node 24 install dir first on PATH. `fnm exec` cannot start `npm` (a `.cmd` shim), and Node 24 throws on `process.exit(true)`.
- The daemon's first stdout line is the handshake. Anything printed before it breaks the shell; log to stderr.
- A daemon started with stdin closed exits right after printing its port (Daemon lifetime). Spawn it with a held-open stdin pipe.
- `DatabaseSync.exec` with several statements leaves a transaction open if a middle one throws. `migrate` and `api.ts`'s `transaction()` use explicit `BEGIN` / `COMMIT` / `ROLLBACK`; do the same anywhere else.
- `audit.ticket_id` is a foreign key: attributing an audit row to a ticket that does not exist throws. Check existence or pass `null`.
- `apply` is synchronous and may spawn agents (`execFileSync git`, a pty) inside an MCP request. Effects run after the transaction commits, so a failing effect (a launch) re-enters `apply` with `exit`.
- `sessions` in `launcher.ts` is module-level, shared by every `start()` in one process: one daemon per process.
- A merge that touches `daemon/` or `shell/` takes effect only after a board restart (`Kanban95.cmd` rebuilds); `ui/` changes show at once.

**MCP**
- `TOOLS` in `mcp.ts` is the only place a tool is defined. After changing its `access` or `description`, run `npm run docs:mcp` or the doc test fails. `MOVE_TARGETS` and `WORKER_FIELDS` feed both enforcement and the matrix text.
- A handler refuses by throwing the module-private `Deny`; anything else thrown is audited as `error` and its message goes back to the agent verbatim.
- `enableJsonResponse: true` returns each tool result as one JSON body. A tool that needs progress notifications would need that switched off for its server.
- The MCP SDK pulls in express, hono and ajv transitively. Nothing imports them; `node:http` is the only server.

**Templates**
- Operator edits to `<repo>/.kanban95/templates/` survive restarts, and a changed default in `templates/` only reaches repos that lack the file.
- Running the daemon on this repo creates `./.kanban95/templates/` (untracked, not ignored: in a target repo they are meant to be committed).
- The test diff is injected whole (`// ponytail:` in `context.ts`).

**Windows**
- node-pty prints `Error: AttachConsole failed` to stderr on `kill()`. It is harmless (the process is gone). `useConptyDll: true` silences it at about 3 s per spawn, so it is off. A one-off node script using node-pty does not exit by itself after the pty ends: call `process.exit`.
- A test must close its database before `rmSync`, or it gets `EPERM`.
- The repo is LF (`.gitattributes`), except `.cmd` files, which are CRLF because cmd.exe misreads labels with LF. Python on Windows writes CRLF in text mode: open files with `newline=''` when scripting edits.
- A stale `shell/target` from another checkout path fails the Tauri build reading permission files; `cargo clean` fixes it.
- Do not redirect `USERPROFILE` for the Tauri shell: WebView2 fails to start. Killing the shell with `kill()` alone can leave `msedgewebview2.exe` children; the job object (Daemon lifetime) handles a normal exit.
- Probing a second shell beside a live board: set `WEBVIEW2_USER_DATA_FOLDER` to a scratch dir, find your processes by walking `ParentProcessId` from your shell's pid, and kill only those, never by name. `taskkill /F /PID <shell>` without `/T` is enough. `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<n>` exposes the webview to DevTools (`http://127.0.0.1:<n>/json/list`).
- Never rebuild or run the installer while the operator's board is live: a rebuild replaces `daemon/dist` under the running daemon, and NSIS closes the app. Test on a second instance.

**Tests**
- Imports between `src/` files use `.js` extensions; tests import `../src/x.ts`.
- Node's `fetch` strips a caller-set `Host` header; a test that needs a foreign `Host` uses `node:http.request`.
- An unclosed MCP SDK client keeps vitest alive; close every client in `afterAll`.
- Every test file runs with a throwaway home (`daemon/test/home.ts`), and `daemon/test/real-home-guard.ts` fails the run if the real home was touched (`docs/SECURITY.md` → Operator files the board writes). Keep it that way.
- Headless Edge resizes its window to `--window-size` minus chrome; `cdp.ts` sets the viewport with `Emulation.setDeviceMetricsOverride` to get an exact size.
- `/events` carries several frame shapes; anything listening must ignore frames it does not know.
- The suite is load-sensitive (ptys, headless browsers, real git). Rerun a failing file alone before treating it as a regression.
- `api.ts` and `mcp.ts` import each other. A value from `api.ts` read while `mcp.ts` loads (inside the `TOOLS` table, not inside a `run`) is in its temporal dead zone when the built daemon starts from `main.js`: `server.test.ts` times out with "Cannot access X before initialization" while the vitest files that import `api.ts` first pass. Put such constants in a leaf module (`db.ts` holds the brain ones).

## How the board was built

Planned on 2026-10-07 as nine phases, each a handoff prompt run by a fresh agent that wrote a log entry for the next. Phases 0 to 2 (scaffold, daemon core and grants, MCP) were built by hand with Claude Code; from phase 3 (templates) on the board built itself, ticket by ticket. Phase 8 (2026-10-08) shipped the agent skills, finished `docs/`, and ran two dogfood cycles: a throwaway sample repo brainstormed into five dependent tickets that all merged with no `needs_human` flag (the walkthrough and its manual touches are in `docs/OPERATOR.md` → Dogfood walkthrough), then this repo, whose improvements are now brainstormed and launched on its own board.

What changed when the build plan was retired:

- The build plan (the spec) and the phase handoffs with their log are deleted. Everything still true moved into the living docs: the design principles and conventions into `CLAUDE.md`; decisions into the doc of the part they shape (`SECURITY.md`, `CLIS.md`, `LIFECYCLE.md`, `AGENTS.md`); the gotchas from the phase log into Working on the board above, `SECURITY.md` and `CLIS.md`. Per-phase deviations that the docs already describe as the current design were not repeated.
- New knowledge goes where it applies: a behaviour change into its living doc in the same ticket, a gotcha a future ticket would trip on into the brain (`brain_add`) and, when it is about the code itself, into Working on the board. There is no phase log any more; the board's notes, runs and brain are the record.
- Housekeeping now has only the living docs, plans and proposals to judge: with no build plan or handoff left, a run on a clean repo should report nothing to change.
