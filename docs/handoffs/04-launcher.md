# Phase 4 — Launcher

Read `CLAUDE.md`, `PLAN.md`, `docs/handoffs/log/*`.

## Goal
Given a ticket, phase and role: create the worktree, mint a grant, write a per-session MCP config, build the CLI argv, spawn it in a pty, stream it over websocket. Tear all of it down on exit or revoke.

Before writing any argv builder, run `claude --help` and `codex --help` on this machine and record the exact flags in `docs/CLIS.md`. Do not rely on memory.

## Deliverables
- `daemon/src/git.ts`: `createWorktree(ticketId)` → `.worktrees/t-<id>` on branch `ticket/<id>` from the repo's current base branch; `removeWorktree(ticketId)` also deletes the branch if merged; refuses to operate if the base branch has uncommitted changes (reports it instead).
- `daemon/src/launcher.ts`:
  - `buildArgv({cli, model, effort, promptPath, mcpConfigPath, cwd})` for `claude` and `codex`. Prompt passed as the initial message. Permissions off per `PLAN.md`. MCP config pointed at the daemon's `/mcp` with the bearer token in a header. Effort is mapped to each CLI's own mechanism (flag, config override, or env var) as found in `--help` and the CLI's docs; record the mapping in `docs/CLIS.md`. If a CLI has no effort control, log it once per run and proceed. For Codex, find and document the supported per-session mechanism for MCP server config; if it only supports a global config file, write the server entry there under a unique name per session and remove it on teardown.
  - Per-session directory `.kanban95/sessions/<run-id>/` holding `prompt.md` and `mcp.json`, restricted to the current user where the platform allows; deleted on teardown.
- `daemon/src/pty.ts`: `node-pty` spawn with `cwd` = worktree and env = a minimal allowlist (PATH, HOME/USERPROFILE, TEMP, the CLI's own auth dirs). Do not pass the daemon's full environment through. Resize support. Scrollback capped (2000 lines) and persisted to `runs` on exit.
- Websocket `/pty/<run-id>` streaming both ways for xterm.js; accepts only the daemon's own origin.
- `revoke(grant)` kills the pty, deletes the session dir, leaves the worktree for the operator to decide.
- `docs/CLIS.md` with the verified flags and the exact MCP config shape per CLI.
- Log entry `docs/handoffs/log/04-launcher.md`.

## Acceptance criteria
1. Launching a worker on ticket 7 produces a worktree, a grant row, a session dir, a `runs` row with the rendered prompt, and a running pty.
2. The spawned process's environment contains nothing from the daemon's environment except the allowlist.
3. Killing the pty or revoking the grant removes the session dir and expires the grant within one second.
4. The CLI inside the pty can reach `/mcp` with its token and call `get_ticket` for its own ticket.

## Required tests
- `buildArgv` for each CLI × role × model × effort is asserted exactly (table test), including the "no effort control" case.
- Session dir and `mcp.json` are gone after teardown, including on abnormal exit.
- Env allowlist: a canary variable set on the daemon is absent in the child.
- `createWorktree` refuses when the base branch is dirty.
