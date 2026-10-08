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
                                            │  WS /pty/<run> → an agent's terminal, both ways (xterm.js)
```

- **Shell** (`shell/`): owns the OS window and the daemon's lifetime. No app logic. In dev it runs `node daemon/dist/server.js` from PATH; packaging Node as a real sidecar is phase 7.
- **Daemon** (`daemon/src/`): the only process with state. `server.ts` is the HTTP plumbing (bind, origin guard, static files, `/health`, routes `/api/*` to `api.ts`). `db.ts` opens and migrates the per-repo SQLite file (schema in `docs/DATA.md`). `grants.ts` mints, verifies, revokes bearer grants and writes audit rows (`docs/SECURITY.md`). `mcp.ts` is the agent-facing MCP server at `/mcp`: one table of tools, each with a description, a role access cell and a handler, enforced per grant and audited per call. `mcp-doc.ts` renders `docs/MCP.md` from that table. `templates.ts` copies the default prompt templates from `templates/` into `<repo>/.kanban95/templates/` once and renders them; `context.ts` builds the variables for a ticket and records the rendered prompt on a `runs` row (`startRun`) before anything is spawned (see Prompts below). `git.ts` creates and removes the per-ticket worktree. `launcher.ts` launches an agent (worktree, run row, grant, session dir, argv, pty) and tears it down (see Launch below); `pty.ts` spawns the CLI in a pseudo-terminal with an env allowlist and keeps a 2000-line scrollback. The repo it serves is `argv[2]`, defaulting to the cwd.
- **UI** (`ui/`): plain files served by the daemon. No bundler. 98.css and its fonts are vendored in `ui/vendor/` so nothing loads from a CDN at runtime.

## Port handshake

1. Shell spawns the daemon with `stdin` and `stdout` piped.
2. Daemon binds `127.0.0.1:0` (kernel-assigned port), then prints exactly one line to stdout: `KANBAN95 port=<n>`.
3. Shell reads that line, builds `http://127.0.0.1:<n>/` and creates the main webview window on it. Any other first line is a fatal handshake error; the shell kills the child and exits.
4. Shell keeps draining daemon stdout to its own stderr prefixed `[daemon]` so the pipe can never fill and block the daemon.

## Daemon lifetime, two belts

- **Kill on exit**: on Tauri's `RunEvent::Exit` the shell calls `kill()` then `wait()` on the child.
- **Stdin EOF**: the daemon holds `process.stdin` open and exits with code 0 when it ends. The shell never writes to it; the pipe simply closes when the shell process dies, including on a crash. An orphaned daemon is therefore not possible. Consequence: if you start the daemon by hand with stdin closed (`< /dev/null`, `stdio: 'ignore'`), it exits immediately after printing the port. That is intended.

## Network boundary

- `validateConfig` rejects any bind host other than `127.0.0.1`. There is no flag, env var or config key that can widen it; a different host is a code change, and the tests fail on it.
- Every daemon response carries `Content-Security-Policy: default-src 'self'; img-src 'self' data:` (98.css uses inline SVG data URLs) and `X-Content-Type-Options: nosniff`. The window is loaded from the daemon's origin, so this header is the CSP that governs the UI; Tauri's own `app.security.csp` only applies to pages Tauri serves itself, which this app has none of.
- Static serving only answers `GET`/`HEAD`, only for files inside `ui/` with a known extension. Path traversal (`..`, encoded dots, backslashes) resolves outside `ui/` and is refused.
- The webview is an "external" URL to Tauri, so it has no IPC access and no capabilities. The UI talks to the daemon over plain HTTP and a websocket per terminal. Tauri IPC is not used.

## REST (operator UI only, same-origin)

| method | path | notes |
|---|---|---|
| GET, POST | `/api/tickets` | list / create. Body fields: `title` (required), `body`, `criteria`, `status`, `cli`, `model`, `effort`, `retry`, `needs_human`, `blocked_on_deps`, `depends_on: number[]` |
| GET, PATCH, DELETE | `/api/tickets/:id` | same fields on PATCH; `null` clears `cli`/`model`/`effort` |
| GET | `/api/tickets/:id/notes` `/runs` `/audit` | rows for that ticket, oldest first |
| GET | `/api/brain?q=&limit=` | FTS5 ranked search, limit at most 100; no `q` lists newest |
| GET | `/api/grants` | all grants, never the hash |
| DELETE | `/api/grants/:id` | revoke and kill the session's pty; 404 if not live |

Errors are `{ "error": "..." }`: 400 for bad input or a constraint violation, 404, 405, 413 for bodies over 1 MiB. Every POST/PATCH/DELETE writes an audit row, including failed ones.

## MCP (agents only, bearer grant)

`POST /mcp` is a stateless Streamable HTTP MCP endpoint (no session id, JSON responses). `handleMcp` reads `Authorization: Bearer <token>`, resolves it with `grants.verify`, answers `401` with no audit row when that fails, and otherwise builds a per-request `McpServer` whose twelve tools close over the grant. One wrapper around every tool checks the role cell, runs the handler, and writes exactly one audit row (`ok`, `denied` or `error`) with the grant id and the ticket the call was about. Worker and tester grants are bound to one ticket and may omit `ticket_id`; naming another ticket is a scope denial. Tool list, role matrix and argument tables are in `docs/MCP.md`, generated from the same table the server enforces (`npm run docs:mcp`); a test fails when the file drifts.

## Prompts

1. `startRun(db, repo, {ticketId, template, cli, model, effort, worktree?, base?})` loads `<repo>/.kanban95/templates/<template>.md`. A placeholder outside `VARS` throws here, naming it.
2. `buildContext` reads the ticket, the brain (FTS5 `OR` of the ticket's title and body words, top 5, 4000-char budget), the failure notes of the last cycle, the retry count, the role's tool list from the MCP table, and for a tester `git diff --no-color --no-ext-diff <base>...HEAD` in the worktree.
3. The template is filled in a single pass and the result inserted into `runs.prompt_rendered`. Same ticket and same database give byte-identical output: every query has a total order and nothing reads the clock.

The template is read from disk on every render, so operator edits apply without a restart. Template-to-role and template-to-phase mapping is the `TEMPLATES` table in `templates.ts`; agent-facing behaviour is in `docs/AGENTS.md`.

## Repo map

```
package.json      npm workspace root: build / test / dev scripts
daemon/           src/{server,api,db,grants,mcp,mcp-doc,templates,context}.ts, migrations/*.sql, test/, tsconfig.json; compiled to dist/ (gitignored)
ui/               index.html, app.js, app.css, vendor/98.css + fonts
templates/        default prompt templates (brainstorm, plan, execute, test, housekeeping), copied into each repo once
shell/            Cargo.toml, build.rs, tauri.conf.json, src/main.rs, icons/icon.ico
docs/             this file, DATA.md (schema), AGENTS.md (what agents receive and how they behave), SECURITY.md (grants, audit, network), MCP.md (generated tool reference), handoffs/ (ephemeral) and handoffs/log/ (phase log)
<repo>/.kanban95/ board.db (gitignored), .gitignore, templates/*.md (committed, operator-editable); created by the daemon on first start
```

## Launch

`launch({ db, repo, port }, { ticketId, template, cli, model, effort })` in `daemon/src/launcher.ts`, also exposed as `start().launch(...)`. In order:

1. `createWorktree` → `.worktrees/t-<id>` on `ticket/<id>` from the repo's current branch, reused if it exists; refused if the base branch has uncommitted tracked changes.
2. `startRun` renders the template and inserts the `runs` row (a bad template stops here, nothing is minted).
3. `mint` a grant with the template's role (`TEMPLATES[template].role`).
4. Session dir `.kanban95/sessions/<run-id>/`, owner-only, with `prompt.md` and (Claude Code) `mcp.json`.
5. `buildArgv` (flags in `docs/CLIS.md`), then `spawnPty` with `cwd` = worktree and the env allowlist.
6. The session is kept in `sessions` (by run id) until its pty exits. On exit, for any reason: `runs.ended_at` and `runs.scrollback` are written, the grant is revoked, the session dir is removed, `session.done` resolves.

Any failure after the run row is written revokes the grant and removes the session dir before the error is rethrown. Revoking the grant over REST kills the pty, which runs the same teardown. `close()` kills every live pty and waits for their teardown before closing the database.

### Terminal websocket

`/pty/<run-id>` with a websocket upgrade, same-origin only. The server first sends the scrollback so far, then every pty output chunk as a text frame, and closes when the pty exits. The client sends JSON: `{"data": "..."}` is written to the pty as typed input, `{"resize": [cols, rows]}` resizes it (1 to 999 each). Anything else is ignored. Several clients may watch one run.
