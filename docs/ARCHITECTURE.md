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
```

- **Shell** (`shell/`): owns the OS window and the daemon's lifetime. No app logic. In dev it runs `node daemon/dist/server.js` from PATH; packaging Node as a real sidecar is phase 7.
- **Daemon** (`daemon/src/`): the only process with state. `server.ts` is the HTTP plumbing (bind, origin guard, static files, `/health`, routes `/api/*` to `api.ts`). `db.ts` opens and migrates the per-repo SQLite file (schema in `docs/DATA.md`). `grants.ts` mints, verifies, revokes bearer grants and writes audit rows (`docs/SECURITY.md`). `mcp.ts` is the agent-facing MCP server at `/mcp`: one table of tools, each with a description, a role access cell and a handler, enforced per grant and audited per call. `mcp-doc.ts` renders `docs/MCP.md` from that table. The repo it serves is `argv[2]`, defaulting to the cwd. Later phases add websocket, pty and git here.
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
- The webview is an "external" URL to Tauri, so it has no IPC access and no capabilities. The UI talks to the daemon over plain HTTP (and websocket later). Tauri IPC is not used.

## REST (operator UI only, same-origin)

| method | path | notes |
|---|---|---|
| GET, POST | `/api/tickets` | list / create. Body fields: `title` (required), `body`, `criteria`, `status`, `cli`, `model`, `effort`, `retry`, `needs_human`, `blocked_on_deps`, `depends_on: number[]` |
| GET, PATCH, DELETE | `/api/tickets/:id` | same fields on PATCH; `null` clears `cli`/`model`/`effort` |
| GET | `/api/tickets/:id/notes` `/runs` `/audit` | rows for that ticket, oldest first |
| GET | `/api/brain?q=&limit=` | FTS5 ranked search, limit at most 100; no `q` lists newest |
| GET | `/api/grants` | all grants, never the hash |
| DELETE | `/api/grants/:id` | revoke; 404 if not live |

Errors are `{ "error": "..." }`: 400 for bad input or a constraint violation, 404, 405, 413 for bodies over 1 MiB. Every POST/PATCH/DELETE writes an audit row, including failed ones.

## MCP (agents only, bearer grant)

`POST /mcp` is a stateless Streamable HTTP MCP endpoint (no session id, JSON responses). `handleMcp` reads `Authorization: Bearer <token>`, resolves it with `grants.verify`, answers `401` with no audit row when that fails, and otherwise builds a per-request `McpServer` whose twelve tools close over the grant. One wrapper around every tool checks the role cell, runs the handler, and writes exactly one audit row (`ok`, `denied` or `error`) with the grant id and the ticket the call was about. Worker and tester grants are bound to one ticket and may omit `ticket_id`; naming another ticket is a scope denial. Tool list, role matrix and argument tables are in `docs/MCP.md`, generated from the same table the server enforces (`npm run docs:mcp`); a test fails when the file drifts.

## Repo map

```
package.json      npm workspace root: build / test / dev scripts
daemon/           src/{server,api,db,grants,mcp,mcp-doc}.ts, migrations/*.sql, test/, tsconfig.json; compiled to dist/ (gitignored)
ui/               index.html, app.js, app.css, vendor/98.css + fonts
shell/            Cargo.toml, build.rs, tauri.conf.json, src/main.rs, icons/icon.ico
docs/             this file, DATA.md (schema), SECURITY.md (grants, audit, network), MCP.md (generated tool reference), handoffs/ (ephemeral) and handoffs/log/ (phase log)
<repo>/.kanban95/ board.db (gitignored), .gitignore; created by the daemon on first start
```
