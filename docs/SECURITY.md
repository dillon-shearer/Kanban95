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
- Expiry is set at mint from a TTL (24 h, a ceiling). In practice a grant lives exactly as long as its session: it is revoked the moment the agent's `move_ticket` is accepted (the board then ends the session), on every terminal exit, and by the janitor for any live grant without a live session on daemon start and once a day. Grants also die with their ticket (`ON DELETE CASCADE`).

## Audit

Every REST mutation and every MCP tool call writes one `audit` row: grant id (null for the operator), ticket id, tool, a 200-character JSON summary of the arguments, and `ok | denied | error`. Failed attempts are audited too. Audit is readable per ticket at `GET /api/tickets/:id/audit`.

## Network

- The daemon binds `127.0.0.1` on a kernel-chosen port. `validateConfig` throws on any other host; there is no flag to widen it.
- Every request must carry `Host: 127.0.0.1:<port>`; a request with an `Origin` header must carry `Origin: http://127.0.0.1:<port>`. Anything else is `403` before routing. This blocks DNS-rebinding and cross-site requests from other pages running on the machine, including other localhost apps. The shell's webview is loaded from that exact origin, so it always passes.
- Responses carry `Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:` and `X-Content-Type-Options: nosniff`. Scripts only from the daemon (no inline, no `blob:`, no eval; `'wasm-unsafe-eval'` permits compiling the speech model's WebAssembly and nothing else); `connect-src` falls back to `'self'`, so the UI cannot reach another host even by mistake. Inline styles are allowed for xterm.js's theme `<style>`; a style cannot run code.
- REST (`/api/*`) is operator-facing and unauthenticated beyond the origin check: anything that can make a same-origin request already sits inside the webview. MCP (`/mcp`) requires a bearer grant: see below.
- Request bodies over 1 MiB are refused.

## MCP

`daemon/src/mcp.ts`, reference in `docs/MCP.md`.

- `POST /mcp` reads `Authorization: Bearer <token>` and resolves it with `verify`. Missing, malformed, unknown, expired or revoked all get `401` and the same body, before any MCP message is parsed. No audit row is written, there is no grant to attribute it to.
- A live grant scopes every tool. A role not listed for a tool, a worker or tester naming a ticket other than its own, a worker editing a field other than body/criteria, or a move to a target the role may not use is refused as a tool error (`denied` in audit). The refusal text says why but never reveals whether the other ticket exists.
- The ticket id a worker or tester acts on comes from the grant, not from the request, so a compromised agent can at most damage its own ticket.
- Arguments are the only thing summarised into `audit.args_summary`; the bearer never reaches a tool handler.
- `move_ticket` and `ask_operator` go through the lifecycle state machine (`docs/LIFECYCLE.md`). A move the table does not have (a worker submitting a ticket that is not in progress, a tester passing a ticket without `report_test(passed: true)` in this test run) is refused as `denied` and changes nothing.

## Agent sessions

`daemon/src/launcher.ts`, `daemon/src/pty.ts`, flags in `docs/CLIS.md`.

- **Environment allowlist.** The CLI's pty gets only `PATH`, `PATHEXT`, `SystemRoot`, `SystemDrive`, `windir`, `ComSpec`, `HOME`, `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `APPDATA`, `LOCALAPPDATA`, `USERNAME`, `TEMP`, `TMP`, `TMPDIR`, `LANG`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME` from the daemon (when set), plus `TERM`, `NoDefaultCurrentDirectoryInExePath=1` and, for Codex, `KANBAN95_TOKEN`. A secret in the daemon's environment does not reach an agent (tested with a canary variable).
- **Session dir** `<repo>/.kanban95/sessions/<key>/` holds `prompt.md` and Claude Code's `mcp.json` (the bearer header). For Claude Code it is created owner-only: on Windows inheritance is removed and only the current user is granted access; on POSIX mode 0700, files 0600. A Codex session's dir holds only `prompt.md` (its token is in the pty environment) and keeps normal permissions, because Codex's read-only sandbox runs as another Windows account and must read the brief (checked live). It is gitignored.
- **Teardown** happens on every pty exit, whatever the cause (agent done, crash, kill, revoke, daemon shutdown): the scrollback is written to `runs`, the grant is revoked, the session dir is deleted. Revoke to dead agent process and gone session dir takes under a second (tested). The worktree is left for the operator or the lifecycle to decide.
- **Command line.** On Windows the CLI is started through `cmd.exe /d /s /c`; any argument with `"`, `%`, a newline or a trailing backslash is refused instead of escaped. `NoDefaultCurrentDirectoryInExePath` stops `cmd.exe` from resolving `claude` or `codex` to a script in the worktree.
- **Terminal websocket** `/pty/<key>` requires `Host` and `Origin` to be the daemon's own (`Origin` is mandatory here, unlike plain HTTP, because every browser sends it on a websocket). Frames are capped at 64 KiB. It carries keystrokes, so it is exactly as trusted as the operator UI.
- **Reach by role.** Approvals are off for every role (operator decision). A planner cannot write files: Claude Code runs it with `--disallowedTools Edit Write NotebookEdit Bash PowerShell Agent`, Codex with `-s read-only -a never` (the board's own MCP tools pre-approved for that server only). Workers and testers run with permissions off in their worktree. Details and what was checked live: `docs/CLIS.md` → Reach by role.
- **Brainstorm** sessions run a planner grant with no ticket in the repo root. They have no `runs` row; the grant, session dir and teardown are the same as any other session, and the janitor treats them the same way.
- **Worktrees** are only created from a base branch without uncommitted changes to tracked files; otherwise the launch is refused with the `git status` lines. `/.worktrees/` is added to the repo's `.git/info/exclude`, so an operator's `git add -A` cannot pick a worktree up as an embedded repo.

## Operator files the board writes

In `~/.kanban95/`, only on an explicit operator action: `models.json` and `settings.json` when **Save** is pressed in Settings (the whole file is checked against its schema first and written through a temp file; a bad value is refused with the field named and the file is not touched), and `models/` when the speech model download is OK'd (see Voice model). No secrets go in either file; there is no field for one.

In an agent CLI's config, one file, only for Claude Code launches: `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`), key `projects["<repo root>"].hasTrustDialogAccepted = true`, so Claude Code does not stop at its workspace-trust prompt in the board's worktrees (operator decision, `PLAN.md` → Agents). `daemon/src/trust.ts`:

- written only when neither the repo root nor an ancestor is already trusted; one entry per repo, never per worktree (`docs/CLIS.md` → First-run prompts);
- merged: every other key in the file is preserved; the first write copies the original to `~/.claude.json.kanban95.bak` (same mode); the new content is written to an owner-only (0600) temp file and renamed over the original;
- audited: `trust.write` with the file and the key, attributed to the launching ticket;
- removable from Settings → CLIs (`trust.clear`), which deletes only that key, by the same write path.

Codex is trusted per process with `-c`, so `~/.codex/config.toml` is never written. Claude Code's one-time bypass-permissions warning (`skipDangerousModePermissionPrompt` in `~/.claude/settings.json`) is not written by the board: the operator accepts it once by hand.

Tests run against a throwaway home directory (`daemon/test/home.ts`, which refuses to run if `os.homedir()` did not follow it), so the suite cannot write the operator's files. `daemon/test/real-home-guard.ts` checks the real home after every run and fails `npm test` if a test left a trust entry for a `k95-` temp repo, a `~/.claude.json.kanban95.bak` or a `~/.kanban95` that was not there before (proven by running the launcher tests with the redirect switched off against a fake home: exit 1, every entry named).

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

- An agent is pushed only its ticket, criteria, up to 5 brain rows (4000 characters at most), the failure notes of the attempt being retried, the retry count, the diff (test only) and its tool list. No transcript, no other ticket, no environment, no file contents.
- A template may only name the seven known variables. Anything else (for example `{{transcript}}`) is refused when the template is loaded, before any context is built or any run row is written.
- Values are substituted in one pass, so text an agent wrote into the brain or a note (including `{{...}}`) is inserted literally and cannot pull in another variable.
- The template name is checked against a fixed set before any path is built, so it cannot read a file outside `.kanban95/templates/`.
- Brain text and notes are agent-written and end up in later prompts. Treat them as untrusted input to the next agent, the same as any file in the repo.

## Threats this does not address yet

- A hostile process on the same machine with the same user can read `board.db` and a live agent's MCP config. Same-user isolation is out of scope; the worktree is the blast radius for agent actions, not for local malware.
- No MCP tool touches the filesystem yet (`report_cleanup` records paths, it does not delete them).
- Permissions are off inside the worker and tester CLIs. Such an agent can read and write anything the operator's user can, including its own session dir; the worktree bounds where it is told to work, not what it can reach. Only the planner is confined (no file writes).
- If the daemon itself dies, its ptys die with it; their session dirs (which hold a bearer for Claude Code) and grants stay until the next daemon start, when the janitor removes and revokes them. Grants still expire on their TTL (24 h) if the daemon never starts again.
- The webview asks for microphone permission per origin, and the daemon's origin changes with its random port, so the operator may be asked once per start. Answering that request in the shell (WebView2 `PermissionRequested`, microphone only, own origin only) is left for the shell hardening phase.
- An answer the operator types is written into the agent's terminal as keystrokes. It is the operator's own input to their own agent; the board only flattens it to one line.
- A tool call whose arguments fail schema validation is answered by the MCP SDK before the tool wrapper runs, so it leaves no audit row. Only calls that reach a tool are audited.
