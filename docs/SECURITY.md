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
- Roles: `planner` (no ticket), `worker` and `tester` (bound to one ticket). The database `CHECK` enforces the pairing. Role scopes per tool are enforced by the MCP layer (`daemon/src/mcp.ts`, matrix in `docs/MCP.md`).
- Expiry is set at mint from a TTL. Grants also die with their ticket (`ON DELETE CASCADE`).

## Audit

Every REST mutation and every MCP tool call writes one `audit` row: grant id (null for the operator), ticket id, tool, a 200-character JSON summary of the arguments, and `ok | denied | error`. Failed attempts are audited too. Audit is readable per ticket at `GET /api/tickets/:id/audit`.

## Network

- The daemon binds `127.0.0.1` on a kernel-chosen port. `validateConfig` throws on any other host; there is no flag to widen it.
- Every request must carry `Host: 127.0.0.1:<port>`; a request with an `Origin` header must carry `Origin: http://127.0.0.1:<port>`. Anything else is `403` before routing. This blocks DNS-rebinding and cross-site requests from other pages running on the machine, including other localhost apps. The shell's webview is loaded from that exact origin, so it always passes.
- Responses carry `Content-Security-Policy: default-src 'self'; img-src 'self' data:` and `X-Content-Type-Options: nosniff`.
- REST (`/api/*`) is operator-facing and unauthenticated beyond the origin check: anything that can make a same-origin request already sits inside the webview. MCP (`/mcp`) requires a bearer grant: see below.
- Request bodies over 1 MiB are refused.

## MCP

`daemon/src/mcp.ts`, reference in `docs/MCP.md`.

- `POST /mcp` reads `Authorization: Bearer <token>` and resolves it with `verify`. Missing, malformed, unknown, expired or revoked all get `401` and the same body, before any MCP message is parsed. No audit row is written, there is no grant to attribute it to.
- A live grant scopes every tool. A role not listed for a tool, a worker or tester naming a ticket other than its own, a worker editing a field other than body/criteria, or a move to a target the role may not use is refused as a tool error (`denied` in audit). The refusal text says why but never reveals whether the other ticket exists.
- The ticket id a worker or tester acts on comes from the grant, not from the request, so a compromised agent can at most damage its own ticket.
- Arguments are the only thing summarised into `audit.args_summary`; the bearer never reaches a tool handler.

## Agent sessions

`daemon/src/launcher.ts`, `daemon/src/pty.ts`, flags in `docs/CLIS.md`.

- **Environment allowlist.** The CLI's pty gets only `PATH`, `PATHEXT`, `SystemRoot`, `SystemDrive`, `windir`, `ComSpec`, `HOME`, `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `APPDATA`, `LOCALAPPDATA`, `USERNAME`, `TEMP`, `TMP`, `TMPDIR`, `LANG`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME` from the daemon (when set), plus `TERM`, `NoDefaultCurrentDirectoryInExePath=1` and, for Codex, `KANBAN95_TOKEN`. A secret in the daemon's environment does not reach an agent (tested with a canary variable).
- **Session dir** `<repo>/.kanban95/sessions/<run-id>/` holds `prompt.md` and Claude Code's `mcp.json` (the bearer header). It is created owner-only: on Windows inheritance is removed and only the current user is granted access; on POSIX mode 0700, files 0600. It is gitignored.
- **Teardown** happens on every pty exit, whatever the cause (agent done, crash, kill, revoke, daemon shutdown): the scrollback is written to `runs`, the grant is revoked, the session dir is deleted. Revoke to dead agent process and gone session dir takes under a second (tested). The worktree is left for the operator or the lifecycle to decide.
- **Command line.** On Windows the CLI is started through `cmd.exe /d /s /c`; any argument with `"`, `%`, a newline or a trailing backslash is refused instead of escaped. `NoDefaultCurrentDirectoryInExePath` stops `cmd.exe` from resolving `claude` or `codex` to a script in the worktree.
- **Terminal websocket** `/pty/<run-id>` requires `Host` and `Origin` to be the daemon's own (`Origin` is mandatory here, unlike plain HTTP, because every browser sends it on a websocket). Frames are capped at 64 KiB. It carries keystrokes, so it is exactly as trusted as the operator UI.
- **Worktrees** are only created from a base branch without uncommitted changes to tracked files; otherwise the launch is refused with the `git status` lines. `/.worktrees/` is added to the repo's `.git/info/exclude`, so an operator's `git add -A` cannot pick a worktree up as an embedded repo.

## Input

- REST writes accept a whitelist of fields with type checks; values are then validated by the schema's `CHECK` and foreign-key constraints, so a bad status, effort, or dependency is refused by SQLite itself and surfaced as `400`.
- Brain search quotes every term before handing it to FTS5, so query syntax cannot be injected.
- Static file serving refuses any path that resolves outside `ui/` and any extension not in the MIME allowlist.

## Prompts

`daemon/src/templates.ts`, `daemon/src/context.ts`; what agents receive is listed in `docs/AGENTS.md`.

- An agent is pushed only its ticket, criteria, up to 5 brain rows (4000 characters at most), the failure notes of the attempt being retried, the retry count, the diff (test only) and its tool list. No transcript, no other ticket, no environment, no file contents.
- A template may only name the seven known variables. Anything else (for example `{{transcript}}`) is refused when the template is loaded, before any context is built or any run row is written.
- Values are substituted in one pass, so text an agent wrote into the brain or a note (including `{{...}}`) is inserted literally and cannot pull in another variable.
- The template name is checked against a fixed set before any path is built, so it cannot read a file outside `.kanban95/templates/`.
- Brain text and notes are agent-written and end up in later prompts. Treat them as untrusted input to the next agent, the same as any file in the repo.

## Threats this does not address yet

- A hostile process on the same machine with the same user can read `board.db` and a live agent's MCP config. Same-user isolation is out of scope; the worktree is the blast radius for agent actions, not for local malware.
- No MCP tool touches the filesystem yet (`report_cleanup` records paths, it does not delete them).
- Permissions are off inside the agent CLI. An agent can read anything the operator's user can, including its own session dir; the worktree bounds where it is told to work, not what it can reach.
- If the daemon itself dies, its ptys die with it but their session dirs and grants are left until the janitor (phase 5) sweeps orphans. Grants still expire on their TTL (24 h today).
- A tool call whose arguments fail schema validation is answered by the MCP SDK before the tool wrapper runs, so it leaves no audit row. Only calls that reach a tool are audited.
