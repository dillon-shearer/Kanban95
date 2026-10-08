# 04 — Launcher (done 2026-10-07)

## What was built

- `daemon/src/git.ts`: `createWorktree(repo, id)` → `.worktrees/t-<id>` on `ticket/<id>` from the current branch; returns `{path, branch, base}`; reuses an existing worktree (retries, test phase); reuses an existing branch; refuses with the `git status` lines when the base branch has uncommitted tracked changes; adds `/.worktrees/` to `.git/info/exclude`. `removeWorktree(repo, id)` runs `git worktree remove` (git refuses on uncommitted work) and `git branch -d` (deleted only if merged), returns `{branchDeleted}`.
- `daemon/src/pty.ts`: `ENV_ALLOW`, `childEnv(extra)`, `spawnPty(cmd, args, {cwd, env})` → `{pty, scrollback()}`. Windows goes through `cmd.exe /d /s /c "<line>"` built by hand (arguments with `"`, `%`, newline or trailing `\` are refused). Scrollback is raw output trimmed to 2000 lines.
- `daemon/src/launcher.ts`: `buildArgv`, `launch`, `sessions` (live, by run id), `killGrantSession`, `killAll`. Session dir `.kanban95/sessions/<run-id>/` owner-only (`icacls` on Windows, 0700 elsewhere). One teardown for every exit path: `runs.ended_at` + `runs.scrollback`, revoke grant, remove session dir, resolve `session.done`.
- `daemon/migrations/002-run-scrollback.sql`: `runs.scrollback`.
- `server.ts`: websocket `/pty/<run-id>` (`ws` 8, same-origin with `Origin` mandatory, 64 KiB frames, JSON `{data}` / `{resize}` in, scrollback then raw output out); `start()` now returns `launch(o)`; `close()` kills every pty and waits for teardown before closing the db. `api.ts`: `DELETE /api/grants/:id` also kills the session.
- Dependencies: `node-pty` 1.1.0 (ships win32-x64 prebuilds, no compiler needed), `ws` 8.22, `@types/ws`.
- Tests `daemon/test/launcher.test.ts` (15): exact argv table per CLI × model × effort; launch on ticket 7 (worktree, branch, worker grant, prompt.md equals `runs.prompt_rendered`, mcp.json URL and bearer, live pid, argv message, `.worktrees` absent from `git status`); env canary absent and `KANBAN95_TOKEN` present for Codex; revoke over REST → agent process dead, session dir gone, grant revoked, scrollback stored, all under 1 s, worktree kept; exit code 3 tears down the same; direct `pty.kill()` likewise; bad template mints nothing; websocket refuses missing/foreign origin and unknown run, streams scrollback, echoes typed input, closes on exit; dirty base refused, untracked ignored, worktree reused; merged branch deleted, unmerged kept. Fake `claude.cmd`/`codex.cmd` are put first on `PATH`, so the real launch path (cmd.exe, PATHEXT, env, conpty) is what runs. `db.test.ts` now counts migration files instead of assuming one. Suite: 77 tests, about 7 s.
- Live check (acceptance 4), by hand on a scratch repo: real Claude Code 2.1.293 (`claude-haiku-5-5`, low) and Codex 0.154.0 (`gpt-5.6-luna`, low) both read the brief and called `get_ticket` on `/mcp`, audited `ok` on ticket 7; session dir gone after shutdown.
- Docs: new `docs/CLIS.md`; `SECURITY.md` (Agent sessions section, token whereabouts, revoke kills, new threats), `ARCHITECTURE.md` (Launch, websocket, REST revoke row), `DATA.md` (`runs.scrollback`, sessions and worktrees), `README.md`.

## Deviations from the handoff

- **The initial message points at `prompt.md` instead of carrying the prompt.** Windows caps a command line at 32 767 characters and `cmd.exe` cannot pass a newline in an argument; a test prompt carries the whole diff. The message is `Read ../../.kanban95/sessions/<run>/prompt.md in full and follow it. ...`, relative so the repo path (which may contain spaces) never appears. Both CLIs followed it in the live check.
- **`buildArgv` takes `mcpUrl` as well as `mcpConfigPath`.** Codex has a supported per-session mechanism, `-c mcp_servers.<name>.*` overrides, with the token read from an env var (`bearer_token_env_var`). So nothing is written to `~/.codex/config.toml`, no unique global entry, nothing to remove on teardown, and no `mcp.json` in a Codex session dir.
- **No "no effort control" case.** Both installed CLIs have one (`--effort`, `-c model_reasoning_effort`). Building a log-and-skip path for a CLI that does not exist would be scaffolding; `CLIS.md` says to add it with the first CLI that needs it. The argv table test covers both CLIs at several efforts.
- **Role is not in the argv table.** Role only decides the grant; the command line is identical for every role. The table is CLI × model × effort.
- **Untracked files do not make the base "dirty".** Only tracked changes are reported; untracked files are in no commit either way, and `.kanban95/templates/` is untracked on first run.
- **`removeWorktree(repo, id)` and `createWorktree(repo, id)` take the repo**, like `render` in phase 3.
- **No REST endpoint to launch.** `launch` is a function (and `start().launch`); the lifecycle (phase 5) owns Launch. Grants live 24 h (`// ponytail:` in `launcher.ts`); phase 5 expires them with the ticket.
- **`runs.outcome` is not written.** The launcher writes `ended_at` and `scrollback`; outcome values belong to the lifecycle.

## Commands

```
npm test          # 77 tests; needs Node 24 on PATH and git
```

Live check (not in the suite, it spends tokens): build, then `start({repo})` on a scratch git repo, insert a ticket, overwrite `.kanban95/templates/execute.md` with "call get_ticket", `launch(...)` and watch `audit` for the grant.

## Gotchas for the next phase

- **First-run trust prompts block an unattended launch.** Claude Code asks "Is this a project you created or one you trust?" and Codex asks "Do you trust the contents of this directory?" in every new worktree (Claude Code has no flag to skip it outside `-p`). The board does not answer them; today the operator does, in the terminal. Phase 5 must decide: pre-trust the worktree in each CLI's own config (Claude Code `~/.claude.json` projects, Codex `[projects."<path>"] trust_level`), or make it an explicit operator setting. Do not silently write into the operator's CLI configs without that decision.
- Both CLIs run **interactive** sessions and do not exit by themselves when the agent is done. The lifecycle has to end the run (kill the pty) after `move_ticket`, or treat an idle session as finished. Everything on exit is already handled by teardown.
- Claude Code applies the operator's user-level hooks and `CLAUDE.md` inside agent sessions (seen in the live run). `--strict-mcp-config` only covers MCP. Codex loads the operator's own MCP servers too.
- **node-pty on Windows prints `Error: AttachConsole failed` to stderr** on `kill()` (its console-list helper races the closing console). It is harmless: the agent process is gone (tested). `useConptyDll: true` silences it but adds about 3 s to every spawn (bundled OpenConsole), so it is off.
- A node script using node-pty does not exit on its own after the pty ends on Windows; call `process.exit` in one-off scripts. vitest is unaffected.
- `sessions` is module-level, shared by every `start()` in one process. Fine for one daemon per process.
- If the daemon dies, session dirs and grants are left behind; the janitor (phase 5) should remove `sessions/*` with no live pty and revoke their grants (`runs.ended_at IS NULL` finds them).
- The websocket protocol is JSON in, raw text out. xterm.js: `term.onData(d => ws.send(JSON.stringify({data: d})))`, `term.onResize(({cols, rows}) => ws.send(JSON.stringify({resize: [cols, rows]})))`, `ws.onmessage = e => term.write(e.data)`.
- `launch` for `template: 'test'` passes the worktree and base to `startRun` for the diff; base is the repo's current branch at launch time.
