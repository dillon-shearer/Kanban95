# Security

Living document. Update it in the same change that moves a boundary described here.

## What the board holds, and does not

- **No provider API keys.** Claude Code and Codex CLI authenticate themselves in their own config. The board never asks for, reads, or stores a provider key, and never reads a `.env`.
- **Its own grant tokens, hashed.** The only secrets the board creates are per-session bearer tokens. The database stores a SHA-256 of each; the raw token exists in memory at mint time and in the agent's session: Claude Code reads it from `sessions/<run-id>/mcp.json` (owner-only, deleted at teardown), Codex from `KANBAN95_TOKEN` in its own pty environment. It is never put on a command line and must never appear in logs, audit rows, or REST responses.
- **Everything else is plain project data** (tickets, notes, brain, runs, audit) in `<repo>/.kanban95/board.db`, gitignored, never uploaded.

## Grants

`daemon/src/grants.ts`.

- `mint({ ticket, role, ttlMs })` creates a row and returns `{ id, token }` once. `token` is 32 random bytes, base64url.
- `verify(token)` hashes and looks up the row. Unknown, expired, or revoked all return `null`; the caller cannot tell which, and neither can a probing client.
- `revoke(id)` stamps `revoked_at`. Every later `verify` fails. `DELETE /api/grants/:id` also kills the agent's pty, which tears its session down (see Agent sessions).
- Roles: `planner` and `operator` (no ticket), `worker` and `tester` (bound to one ticket). The database `CHECK` enforces the pairing. Role scopes per tool are enforced by the MCP layer (`daemon/src/mcp.ts`, matrix in `docs/MCP.md`).
- Expiry is set at mint from a TTL (24 h, a ceiling). In practice a grant lives exactly as long as its session: it is revoked the moment the agent's `move_ticket` is accepted (the board then ends the session), on every terminal exit, and by the janitor for any live grant without a live session on daemon start and once a day. Grants also die with their ticket (`ON DELETE CASCADE`).

## Audit

Every REST mutation and every MCP tool call writes one `audit` row: grant id (null for the operator), ticket id, tool, a 200-character JSON summary of the arguments, and `ok | denied | error`. Failed attempts are audited too. Audit is readable per ticket at `GET /api/tickets/:id/audit`.

## Network

- The daemon binds `127.0.0.1` on a kernel-chosen port. `validateConfig` throws on any other host; there is no flag to widen it.
- Every request must carry `Host: 127.0.0.1:<port>`; a request with an `Origin` header must carry `Origin: http://127.0.0.1:<port>`. Anything else is `403` before routing. This blocks DNS-rebinding and cross-site requests from other pages running on the machine, including other localhost apps. The shell's webview is loaded from that exact origin, so it always passes.
- Responses carry `Content-Security-Policy: default-src 'self' http://127.0.0.1:<port> ws://127.0.0.1:<port>; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'` and `X-Content-Type-Options: nosniff`. Scripts only from the daemon (no inline, no `blob:`, no eval; `'wasm-unsafe-eval'` permits compiling the speech model's WebAssembly and nothing else); `connect-src` and `frame-src` fall back to the daemon's own origin (HTTP and websocket), so the UI cannot reach or frame another host even by mistake. Inline styles are allowed for xterm.js's theme `<style>`; a style cannot run code. `frame-ancestors 'none'` stops another local page from framing the board: a frame's GET carries no `Origin`, so the origin check alone would let it through.
- Ticket attachments (`.kanban95/attachments/`, `docs/DATA.md`) are operator uploads behind the same cookie. A name with a path separator or `..` is refused, never cleaned into another path, and the stored name is a sanitised basename. Only raster images (PNG, JPEG, GIF, WebP, BMP) are served inline; everything else, SVG and HTML included, is served as an `application/octet-stream` download, so an attached file cannot run script on the board's origin.
- REST (`/api/*`) and the `/events` and `/pty/<key>` websockets need the shell secret (below). MCP (`/mcp`) requires a bearer grant: see MCP. Static UI files, `/health` and `/voice-model/*` (only the files the pinned speech-model manifest lists) are open: they are public code and say nothing about the board.
- Request bodies over 1 MiB are refused.
- The UI stores nothing in the browser (no `localStorage`, `sessionStorage` or IndexedDB): its state (window places, startup layout, folded columns, the Board's filter, sort and group) is `<repo>/.kanban95/ui.json` behind the same cookie (`docs/DATA.md`). A new start is a new origin, and the WebView2 profile is not a place for board data.

### Shell secret

Without it any local process (a script in another terminal, an agent in a worktree) could drive the board over REST with a plain `curl`.

- **Minted by the shell**, 32 bytes from the OS RNG (`getrandom`) as 64 hex characters, new on every start.
- **To the daemon in the environment** (`KANBAN95_SECRET`), never in argv, which other processes can read. The daemon deletes it from its own `process.env` before anything else runs, so nothing it spawns inherits it (agent ptys get an allowlist anyway, see Agent sessions; git and its hooks would otherwise). It refuses to start without a secret of at least 32 characters, before it opens a port, so a bare `node daemon/dist/server.js` cannot serve an open board.
- **To the webview by a one-step cookie swap.** The shell opens the window on `http://127.0.0.1:<port>/?k95=<secret>`. The daemon answers a matching value with `302 Location: /` and `Set-Cookie: k95=<secret>; HttpOnly; SameSite=Strict; Path=/`, and a wrong one with `401` and no cookie. The redirect keeps the URL with the secret out of the page's history, `HttpOnly` keeps it out of page scripts (`document.cookie` is empty), and the browser then sends it on every same-origin `fetch` and websocket handshake, so the UI code is unchanged. The navigation URL goes from the shell to WebView2 over its API, not a command line (checked: no `msedgewebview2.exe` command line contains it).
- **Checked on every request** to `/api/*` (`401` before routing) and every `/events` or `/pty` upgrade (`401` after the origin check), as a constant-time compare of SHA-256 digests.
- **A secret dies with its daemon.** The next start mints a new one, so a cookie or value from an earlier run gets `401` (tested). The session cookie is overwritten by the next start's swap.
- **Never written down**: not on a command line, not in a log line (the daemon prints only its port; the shell forwards daemon stdout), not in an audit row (audit summarises request bodies, never headers; tested).
- **Ceiling.** A process running as the same Windows user can still read the daemon's environment block or the WebView2 profile's cookie store with debugger-level access. The secret stops scripts and agents that can only open a socket; it is not a boundary against same-user code that reads other processes' memory. Running agents as another account is the upgrade path.

## Webview

The shell (`shell/src/main.rs`) opens one window on the daemon's origin and locks it there.

- **No Tauri command is reachable.** The UI never calls Tauri, so the shell has no `capabilities/` dir and grants nothing; to Tauri the window is a remote URL, and a remote URL may only call what a capability lists for it. `cargo test` in `shell/` builds the real window on the mock runtime and checks that core commands (`app`, `window`, `webview`, `event`, `path`) and an unknown one are each refused with Tauri's ACL error. Adding a capability that grants the daemon origin anything fails it.
- **No navigation off the origin.** Any top-level navigation whose origin is not `http://127.0.0.1:<port>` is cancelled (`on_navigation`), including another port on loopback. `window.open` is refused (wry denies new windows when the app sets no handler). Frames are held to the origin by the CSP.
- **Microphone only.** The shell answers WebView2's permission requests itself: microphone allowed, every other kind (camera, location, notifications, clipboard read, …) denied, so nothing prompts. Navigation is pinned to the daemon's origin, so the allowed request can only come from it; answering in code also means no prompt when the random port gives a new origin each start.
- Checked in the real shell (WebView2 154, a fresh profile, remote debugging): `__TAURI_INTERNALS__.invoke('plugin:app|version')` and friends rejected with "not allowed"; `getUserMedia({audio})` granted with no prompt; `{video}` `NotAllowedError`; geolocation denied; `window.open('https://example.com/')` returned `null`; `location.href = 'https://example.com/'`, `http://127.0.0.1:1/` and a DevTools `Page.navigate` all left the page on the daemon origin.

## MCP

`daemon/src/mcp.ts`, reference in `docs/MCP.md`.

- `POST /mcp` reads `Authorization: Bearer <token>` and resolves it with `verify`. Missing, malformed, unknown, expired or revoked all get `401` and the same body, before any MCP message is parsed. No audit row is written, there is no grant to attribute it to.
- A live grant scopes every tool. A role not listed for a tool, a worker or tester naming a ticket other than its own (except that both may `get_ticket` and `list_tickets` the tickets their ticket depends on, read-only, so a tester can check criteria a research dependency defined; and a worker may edit its Backlog follow-ups), a worker editing a field other than body/criteria on its own ticket, or a move to a target the role may not use is refused as a tool error (`denied` in audit). The refusal text says why but never reveals whether the other ticket exists.
- The ticket id a worker or tester acts on comes from the grant, not from the request, so a compromised agent can at most damage its own ticket. A planner or operator grant has no ticket and must name one on every ticket tool.
- Follow-ups. A worker may `create_ticket` (operator policy, brain #22). The new ticket lands in Backlog with no model or effort (a worker cannot pick what it runs on, `set_model` stays planner-only), its body starts with `Filed by #<worker's ticket>`, and `tickets.created_by_grant` records the worker's grant. That grant may then `update_ticket` (title, body, criteria, dependencies) and `delete_ticket` that ticket while it is in Backlog, and nothing else of the board: a ticket made by another grant, by the UI or by an earlier run of the same ticket (each run has its own grant), or one that has left Backlog, is refused as `denied`. Backlog tickets do not run until the operator launches them or the runner picks them up, so the worst a hostile worker can do is file tickets the operator then reads before they run; filing a ticket is not a launch.
- `delete_ticket` for a planner or operator grant: a Backlog ticket with no notes and no runs, so it cannot erase a ticket's history. Everything else is the operator's delete in the UI. Both paths share `deleteTicket` in `daemon/src/api.ts` (sessions, attachments, the row).
- Arguments are the only thing summarised into `audit.args_summary`; the bearer never reaches a tool handler.
- `move_ticket` and `ask_operator` go through the lifecycle state machine (`docs/LIFECYCLE.md`). A move the table does not have (a worker submitting a ticket that is not in progress, a tester passing a ticket without `report_test(passed: true)` in this test run) is refused as `denied` and changes nothing.

## Agent sessions

`daemon/src/launcher.ts`, `daemon/src/pty.ts`, flags in `docs/CLIS.md`.

- **Environment allowlist.** The CLI's pty gets only `PATH`, `PATHEXT`, `SystemRoot`, `SystemDrive`, `windir`, `ComSpec`, `HOME`, `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `APPDATA`, `LOCALAPPDATA`, `USERNAME`, `TEMP`, `TMP`, `TMPDIR`, `LANG`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME` from the daemon (when set), plus `TERM`, `NoDefaultCurrentDirectoryInExePath=1`, `KANBAN95_AGENT=1` and, for Codex, `KANBAN95_TOKEN`. A secret in the daemon's environment does not reach an agent (tested with a canary variable).
- **Session dir** `<repo>/.kanban95/sessions/<key>/` holds `prompt.md`, Claude Code's `mcp.json` (the bearer header) and, for a Claude worker or tester, `settings.json` (the board's commit attribution, no secret). For Claude Code it is created owner-only: on Windows inheritance is removed and only the current user is granted access; on POSIX mode 0700, files 0600. A Codex session's dir holds only `prompt.md` (its token is in the pty environment) and keeps normal permissions, because Codex's read-only sandbox runs as another Windows account and must read the brief (checked live). It is gitignored.
- **Teardown** happens on every pty exit, whatever the cause (agent done, crash, kill, revoke, daemon shutdown): the scrollback is written to `runs`, the grant is revoked, the session dir is deleted. Revoke to dead agent process and gone session dir takes under a second (tested). The worktree is left for the operator or the lifecycle to decide.
- **Command line.** On Windows the CLI is started through `cmd.exe /d /s /c`; any argument with `"`, `%`, a newline or a trailing backslash is refused instead of escaped. `NoDefaultCurrentDirectoryInExePath` stops `cmd.exe` from resolving `claude` or `codex` to a script in the worktree.
- **Terminal websocket** `/pty/<key>` requires `Host` and `Origin` to be the daemon's own (`Origin` is mandatory here, unlike plain HTTP, because every browser sends it on a websocket) and the shell secret cookie. Frames are capped at 64 KiB. It carries keystrokes, so it is exactly as trusted as the operator UI.
- **Reach by role.** Approvals are off for every role (operator decision). A planner cannot write files: Claude Code runs it with `--disallowedTools Edit Write NotebookEdit Bash PowerShell Agent`, Codex with `-s read-only -a never` (the board's own MCP tools pre-approved for that server only). Workers and testers run with permissions off in their worktree. Details and what was checked live: `docs/CLIS.md` → Reach by role.
- **Brainstorm** sessions run a planner grant with no ticket in the repo root. They have no `runs` row; the grant, session dir and teardown are the same as any other session, and the janitor treats them the same way.
- **Operator terminals** run an `operator` grant the same way (see Operator terminal).
- **Worktrees** are only created from a base branch without uncommitted changes to tracked files; otherwise the launch is refused with the `git status` lines. `/.worktrees/` is added to the repo's `.git/info/exclude`, so an operator's `git add -A` cannot pick a worktree up as an embedded repo.

## Operator terminal

An agent the operator starts with a typed mission, for board work outside the ticket flow (maintenance, a refactor steered live, fixing the board itself). `daemon/src/lifecycle.ts` `operator`, `daemon/src/launcher.ts` `launchRoot`.

- **Started only by the operator.** The one way in is `POST /api/operator` with a non-empty `mission`, sent by the UI's **New operator terminal** dialog (Start menu or Ctrl+Shift+N). The route sits behind the shell cookie and the `Host`/`Origin` checks like every other, on a daemon bound to `127.0.0.1`, and is audited (`operator.launch`, the mission's first 200 characters in the summary). No MCP tool and no lifecycle row starts one, so an agent cannot spawn an operator.
- **Reach: what the operator could do by hand on the board, nothing more.** The grant's role is `operator` with no ticket. Over MCP it may create tickets, edit any field of any ticket, change model and effort, add notes, read and list every ticket, use the brain, ask the operator, record a cleanup, and move any ticket through the lifecycle (`launch`, `submit`, `pass`, `fail` with the same guards as everyone else). It never gets `report_test`, and a move to `done` still needs a tester's `report_test(passed: true)` from the current test run, so an operator agent cannot pass a ticket itself. Matrix: `docs/MCP.md`.
- **Files and commands.** It runs in the repo root with the worker's CLI flags (permissions off; no planner deny list), so it can do what a worker can (see A malicious agent in a worktree). Its brief tells it to change code only in a worktree under `.worktrees/op-<time>` and merge that itself when green, because the merge queue merges into the main checkout.
- **Lifetime.** The grant is minted when the session starts and revoked on every pty exit: the operator's Revoke in Settings → Grants, the agent quitting, or the daemon shutting down. Closing its terminal window does not end it. The janitor revokes a leftover operator grant on the next start like any other.
- **The mission** is operator text. It is inserted into the brief literally, in one pass, so a `{{...}}` inside it is not expanded.

## Operator files the board writes

In `~/.kanban95/` (or `$KANBAN95_HOME` when set; the board writes operator config nowhere else), only on an explicit operator action: `models.json`, `settings.json` and `preferences.md` when **Save** is pressed in Settings (the whole file is checked against its schema first and written through a temp file; a bad value is refused with the field named and the file is not touched), and `models/` when the speech model download is OK'd (see Voice model). No secrets go in `models.json` or `settings.json`; there is no field for one. `preferences.md` is free text copied into every prompt, so the operator is told not to put one there (`docs/DATA.md`).

In an agent CLI's config, one file, only for Claude Code launches: `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`), key `projects["<repo root>"].hasTrustDialogAccepted = true`, so Claude Code does not stop at its workspace-trust prompt in the board's worktrees (operator decision, 2026-10-07). `daemon/src/trust.ts`:

- written only when neither the repo root nor an ancestor is already trusted; one entry per repo, never per worktree (`docs/CLIS.md` → First-run prompts);
- merged: every other key in the file is preserved; the first write copies the original to `~/.claude.json.kanban95.bak` (same mode); the new content is written to an owner-only (0600) temp file and renamed over the original;
- audited: `trust.write` with the file and the key, attributed to the launching ticket;
- removable from Settings → CLIs (`trust.clear`), which deletes only that key, by the same write path.

To resume a killed Claude Code session the board only checks that `<uuid>.jsonl` exists under `~/.claude/projects/*/` (or `$CLAUDE_CONFIG_DIR/projects/*/`): it lists those dirs and never opens a transcript (`docs/CLIS.md` → Resuming a killed session).

Codex is trusted per process with `-c`, so `~/.codex/config.toml` is never written. Claude Code's one-time bypass-permissions warning (`skipDangerousModePermissionPrompt` in `~/.claude/settings.json`) is not written by the board: the operator accepts it once by hand.

Tests run against a throwaway home directory (`daemon/test/home.ts`, loaded as a `setupFiles` entry by `daemon/vitest.config.ts`, which the repo-root `vitest.config.mts` re-exports so a run from either directory is the same; it also sets `KANBAN95_HOME`, and the daemon throws on any `~/.kanban95` path under vitest without it; which refuses to run if `os.homedir()` did not follow it), so the suite cannot write the operator's files. `daemon/test/real-home-guard.ts` checks the real home after every run and fails `npm test` if a test left a trust entry for one of this run's temp repos (every temp dir of the run is under one fresh `k95-run-*` dir, so a concurrent run in another worktree does not count), a `~/.claude.json.kanban95.bak` or a `~/.kanban95` that was not there before (proven by running the launcher tests with the redirect switched off against a fake home: exit 1, every entry named).

## Usage limits

Settings → Limits and the taskbar's limit (`daemon/src/limits.ts`, `GET /api/limits`) ask each CLI for its own account's limits; the board holds no token for this and reads no credential file (`~/.claude/.credentials.json`, `~/.codex/auth.json` are never opened).

- **What runs.** `claude -p --safe-mode --no-session-persistence "/usage"` (a local slash command: no model call; safe mode loads no hooks, plugins or MCP servers; no session file is written) and `codex app-server` over stdio, sent `initialize` and `account/rateLimits/read` only, then closed. Both run from the temp dir with the agent env allowlist (`pty.ts` → `childEnv`), using the executable from Settings → CLIs or PATH. Each CLI talks to its own provider with its own login, as it does for every agent session.
- **When.** On board load and every 5 minutes while the board is open (the daemon caches the answer for 5 minutes), plus Refresh. One fetch at a time; a request during a fetch shares it.
- **What is kept.** Only the parsed rows (window, percent used, reset time) in daemon memory. Codex's reply also carries the account id, plan and credit ids; they are dropped. Raw output is never logged or returned: a failure reports the exit code or a fixed message, never the CLI's text.

## Voice model

The mic button's speech model is the only thing the board ever downloads, and the download is the only network request the board makes. `daemon/src/voice.ts`, manifest `daemon/voice-model.json`.

- **Operator-initiated.** Nothing is fetched until the operator presses Download in a dialog that shows the model, the source URL with its pinned revision, the size, the license and every file's SHA-256 (tested: pressing a mic with no model shows the dialog, Cancel fetches nothing and audits nothing). `POST /api/voice/download` is audited (`voice.download`).
- **Pinned and verified.** The URL names a fixed revision; every file has a pinned size and SHA-256. A response larger than pinned is cut off; a size or hash mismatch deletes the file (and its `.part`) and fails the download, naming the file and both hashes (tested). A file already on disk is used only if its hash still matches.
- **Served narrowly.** `/voice-model/<id>/<path>` answers only the paths the manifest lists; anything else is 404, so it cannot be used to read other files under the home directory (tested).
- **Runs locally.** transformers.js is configured for local models only and the CSP blocks every other host, so neither the model nor the audio can leave the machine. The recorded audio exists only in the page's memory until it is transcribed. Checked: a full cycle in headless Edge, including transcription, made 182 requests, all to `127.0.0.1`.

## Input

- REST writes accept a whitelist of fields with type checks; values are then validated by the schema's `CHECK` and foreign-key constraints, so a bad status, effort, or dependency is refused by SQLite itself and surfaced as `400`.
- Brain search quotes every term before handing it to FTS5, so query syntax cannot be injected.
- Static file serving refuses any path that resolves outside `ui/` and any extension not in the MIME allowlist.

## Prompts

`daemon/src/templates.ts`, `daemon/src/context.ts`; what agents receive is listed in `docs/AGENTS.md`.

- An agent is pushed only its ticket, criteria, up to 8 brain rows (2500 characters at most), the failure notes of the attempt being retried, the retry count, the base branch, the operator's preferences, the absolute paths of the ticket's attachments, the diff stat and a capped code diff (test only), its tool list and, for an operator terminal, the mission the operator typed. No transcript, no other ticket, no environment, no file contents.
- A template may only name the known variables (`VARS` in `daemon/src/templates.ts`, listed in `docs/AGENTS.md`), and every one it names must have a value. Anything else (for example `{{transcript}}`) is refused when the template is loaded, before any context is built or any run row is written.
- Values are substituted in one pass, so text an agent wrote into the brain or a note (including `{{...}}`) is inserted literally and cannot pull in another variable.
- The template name is checked against a fixed set before any path is built, so it cannot read a file outside `.kanban95/templates/`.
- Brain text and notes are agent-written and end up in later prompts. Treat them as untrusted input to the next agent, the same as any file in the repo.

## A malicious agent in a worktree

The threat model as of the end of the hardening phase. The attacker is a worker or tester whose CLI follows hostile instructions (planted in a repo file, a brain note, a dependency's README). It runs in `<repo>/.worktrees/t-<n>/` as the operator's Windows user, with permissions off (Agent sessions → Reach by role), holding one live grant for its own ticket and knowing the daemon's port (it is in its MCP config).

### What it cannot reach

| It cannot | Because | Enforced by | Tested by |
|---|---|---|---|
| Call the board's REST or open the `/events` or `/pty` websockets | It has no shell secret: the daemon drops `KANBAN95_SECRET` from its own environment before anything runs, and the pty gets an env allowlist | `daemon/src/server.ts` (`import.meta.main` block, `start`), `daemon/src/pty.ts` `ENV_ALLOW` | `server.test.ts` "refuses /api and /events without the secret, and a stale secret after a restart"; `launcher.test.ts` "passes only the env allowlist" (canary absent), "refuses a missing or foreign origin, an unknown run and a wrong secret" |
| Read, note, move or edit another ticket over MCP | The ticket id comes from the grant, not the request | `daemon/src/mcp.ts` | `mcp.test.ts` → ticket scope ("a worker on ticket 3 cannot read, move, or note ticket 4 …", "a worker / a tester reads its own ticket and its dependencies, nothing else") |
| Edit or delete board tickets through `create_ticket` / `update_ticket` / `delete_ticket` | Only Backlog tickets its own grant created (`tickets.created_by_grant`); no model or effort on them | `daemon/src/mcp.ts` | `mcp-followups.test.ts` |
| Use a tool its role lacks, edit title or dependencies, or move its ticket anywhere but where the state machine allows (a worker cannot pass itself; a tester cannot pass without `report_test(passed: true)`) | Role matrix and lifecycle table checked per call, refusals audited as `denied` | `daemon/src/mcp.ts`, `daemon/src/lifecycle.ts` | `mcp.test.ts` → role matrix, move_ticket; `lifecycle.test.ts` → transition table |
| Keep using its grant after its session | Revoked on the accepted move, on every pty exit, and by the janitor at start | `daemon/src/launcher.ts`, `daemon/src/janitor.ts` | `launcher.test.ts` "revoking the grant over REST kills the pty …", "an agent that dies on its own (exit 3) still revokes the grant …"; `lifecycle.test.ts` → janitor on daemon start; `grants.test.ts` "rejects a revoked token" |
| Recover any grant's token from the database | Only SHA-256 digests are stored | `daemon/src/grants.ts` | `grants.test.ts` "stores only a hash" |
| Smuggle another variable, ticket or file into the next agent's prompt through text it writes (brain, notes) | One-pass substitution, fixed variable set, fixed template names | `daemon/src/templates.ts` | `templates.test.ts` "inserts values literally …", "refuses an unknown variable …", "refuses a template name outside the set" |
| Run script in the operator's UI through text it writes (titles, bodies, notes, brain) | The UI never parses data as HTML: every element is built by `h()`, which appends strings as text nodes (`ui/` has no `innerHTML`); the CSP forbids inline script, so even injected markup could not run | `ui/wm.js` `h`, `CSP` in `daemon/src/server.ts` | `server.test.ts` "prints the port handshake …" (asserts the exact CSP) |
| Call a Tauri command, navigate the board window off the daemon's origin, open a new window, or use a device other than the microphone, even with script in the page | No capability is granted; navigation is pinned to the live port; permission requests are answered in code | `shell/src/main.rs` `window`, `on_daemon` | `cargo test` in `shell/`: `webview_cannot_call_any_tauri_command`, `the_navigation_lock_follows_a_restarted_daemon_to_its_new_port`; live checks under Webview above |
| Get a web page (one it serves, or one it opens in the operator's browser) to drive the board | `127.0.0.1` only; `Host`/`Origin` must be the daemon's own; `frame-ancestors 'none'`; the cookie is `SameSite=Strict` | `daemon/src/server.ts` | `server.test.ts` → bind address, shell secret; `api.test.ts` "refuses a foreign Origin and a foreign Host" |
| Read files outside `ui/` or the voice manifest through the daemon | Static serving and `/voice-model/` answer only allowlisted paths | `daemon/src/server.ts`, `daemon/src/voice.ts` | `server.test.ts` "serves the UI but nothing above it"; `voice.test.ts` "serves only paths the manifest lists" |
| Leave a daemon or webview behind it can attach to after the board closes | The shell's kill-on-close job takes the whole tree down on every exit path; the daemon exits on stdin EOF | `shell/src/main.rs` `kill_children_with_us`, `daemon/src/server.ts` | `server.test.ts` "… exits when stdin closes"; job object checked live (`docs/ARCHITECTURE.md` → Daemon lifetime) |

One guard here is against accidents, not attacks: `KANBAN95_AGENT=1` in every agent's environment (`daemon/src/launcher.ts`) makes `npm run dev` and `Kanban95.cmd` refuse to start, and `daemon/test/cdp.ts` refuses a headed browser, so a well-meaning agent does not open windows on the operator's desktop (`launcher.test.ts` asserts the variable). A hostile agent can unset it.

### What it can reach

Permissions are off and the agent is the operator's user, so the worktree is where it is told to work, not a sandbox. Only the planner is confined (no file writes). A hostile worker or tester can:

- **Read and write any file the operator's user can**: other worktrees, the main checkout, `~/.kanban95/`, `~/.claude.json`, SSH keys, git credentials, the provider CLIs' own logins.
- **Open `<repo>/.kanban95/board.db` directly** and read every ticket, note and brain row, or write rows, bypassing MCP scope, the lifecycle and the audit log. It cannot recover tokens from it (hashes only).
- **Read another live Claude Code session's `sessions/<key>/mcp.json`** (owner-only means owner = this same user) and act as that ticket's agent over MCP until that session ends. A Codex agent's token is in its pty's environment, readable by the same user.
- **Get the shell secret** with debugger-level same-user access: from the shell's memory or the WebView2 profile's cookie store (DPAPI, which the same user can decrypt). See Shell secret → Ceiling.
- **Use the network** with no egress filter: exfiltrate what it reads, push with the operator's git credentials.
- **Change git directly**: commit to the base branch in the main checkout or rewrite other branches; the merge queue only orders the board's own merges.
- **As a tester, pass bad work**: the board trusts the tester's verdict.
- **Plant code the board runs**: what it writes into the main checkout (`daemon/`, `package.json` scripts) runs at the next Start → Restart board (`npm run build`, then the rebuilt daemon), as it would at the next `Kanban95.cmd`.

Ceiling and upgrade path: run worker and tester CLIs as a separate low-privilege Windows account (or an AppContainer) with only its worktree ACL'd to it, and an egress allowlist for the provider's API. Then owner-only session dirs, `board.db` and the WebView2 profile become real boundaries and the rows above are the whole reach.

## Threats this does not address yet

- Same-user isolation: see A malicious agent in a worktree → What it can reach. The worktree is the blast radius for what an agent is asked to do, not for what a hostile agent or local malware can do.
- No MCP tool touches the filesystem yet (`report_cleanup` records paths, it does not delete them).
- If the daemon itself dies, its ptys die with it; their session dirs (which hold a bearer for Claude Code) and grants stay until the next daemon start, when the janitor removes and revokes them. Grants still expire on their TTL (24 h) if the daemon never starts again.
- Each start's microphone grant is saved in the WebView2 profile under that start's origin (WebView2's default), so old `127.0.0.1:<port>` entries pile up there. Harmless, since no other page can load in the window.
- `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<n>` opens the board's webview to DevTools, release builds included. Only a process that can set the shell's environment can do it, which is the same-user ceiling above, not a new hole.
- An answer the operator types is written into the agent's terminal as keystrokes. It is the operator's own input to their own agent; the board only flattens it to one line.
- A tool call whose arguments fail schema validation is answered by the MCP SDK before the tool wrapper runs, so it leaves no audit row. Only calls that reach a tool are audited.
