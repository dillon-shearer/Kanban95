# 05 — Lifecycle (done 2026-10-07)

## What was built

- `daemon/src/lifecycle.ts`: `TABLE` (every transition as data: from, event, guard, to, flag changes, effects), `transition(facts, event)` (picks the row or throws `Refused` naming why), `apply(board, ticket, event, {note, answer})` (one transaction for status, flags, counters and the event's note, then the effects), `launchAll` (dependency order), `recover` (daemon start), `runSettings` (cli/model/effort from `~/.kanban95/models.json`), housekeeping trigger, `/events` emitter. Retry cap `MAX_RETRY = 3`.
- `daemon/src/merge.ts`: one promise-chained queue for the whole daemon; `merge()` refuses a dirty base, runs `git merge --no-ff --no-edit -m <title> ticket/<id>`, aborts on any failure. Each queued job waits for the tester's terminal to close, merges, applies `merged`/`conflict`, and waits for the worktree removal before the next job starts.
- `daemon/src/janitor.ts`: `cleanTicket` (forced worktree removal plus branch after a merge, retried ~2 s because Windows holds the directory briefly after the agent exits) and `sweep` (start + every 24 h: orphan worktrees, session dirs, grants and open runs; scrollback older than 30 days; `VACUUM`). Every deletion audited as `janitor.*`.
- `daemon/src/trust.ts`: `preTrustClaude` writes `projects["<repo root>"].hasTrustDialogAccepted = true` into `~/.claude.json` when neither the root nor an ancestor is trusted. Merged, backed up once to `.kanban95.bak`, written by rename, audited as `trust.write`.
- `launcher.ts`: `buildArgv` takes `role` and `repo`. Claude planner gets `--disallowedTools Edit Write NotebookEdit Bash PowerShell Agent`; Codex gets `-c projects={'<repo>'={trust_level='trusted'}}` on every launch, `-s read-only -a never` for a planner, the bypass otherwise. `launch` takes an `onExit` hook; `Session` has `role` and `outcome`; `sessionsOf(ticket)`.
- `git.ts`: `removeWorktree(repo, id, force)`, `git` exported.
- `migrations/003-lifecycle.sql`: `tickets.template` (`execute` | `housekeeping`) and `tickets.merged_at`.
- `api.ts`: `setDeps` refuses dependency cycles (recursive CTE, inside the caller's transaction, 400); `POST /api/tickets/:id/launch`, `/api/tickets/launch-all`, `/api/tickets/:id/answer`, `/api/tickets/:id/merge`; `Refused` → 409. `handleApi` and `handleMcp` take the `Board`.
- `mcp.ts`: `move_ticket` maps to `submit`/`pass`/`fail` and `ask_operator` to `ask` through `apply`; `Refused` is audited as `denied`. Descriptions of `move_ticket`, `set_model`, `ask_operator` say what now happens; `docs/MCP.md` regenerated.
- `server.ts`: `/events` websocket (same-origin, Origin required), janitor sweep + recovery on start, daily sweep, `close()` = stop spawning → kill ptys → drain merge queue → close db. `start()` returns `board`.
- UI: `ui/sounds/ding.wav`, `chord.wav` (generated tones), `app.js` plays them from `/events`.
- Tests: `test/lifecycle.test.ts` (27): the transition table row by row, written out by hand; every other status × event refused (27 pairs); guard refusals; then end to end with a scripted fake `claude` that talks to `/mcp`: happy path (merge commit by the operator, title only, two parents, ding over the websocket, nothing left behind); dependency hold and release plus Launch all order; retry cap (exactly 4 execute + 4 test runs, then stop); escalation; `ask_operator` round trip (multi-line answer arrives as one line, flag cleared, 409 when nothing is asked); silent exit and failed launch flagged; merge conflict (second ticket flagged, base clean, no `MERGE_HEAD`, worktree kept, retried merge lands it); five tickets at once (five ptys, five merges in a straight first-parent line); housekeeping (10th creates exactly one, 11th none); janitor on daemon start. `launcher.test.ts`: argv table now CLI × role, pre-trust tests. `mcp.test.ts`: cycle refusal, lifecycle refusals through MCP. `test/home.ts` + `vitest.config.ts`: every test file runs with a throwaway home dir. Suite: 111 tests, about 30 s; lifecycle and launcher files ran three times green.
- Docs: new `docs/LIFECYCLE.md`; `CLIS.md` (First-run prompts, Reach by role, argv), `SECURITY.md` (grant lifetime, operator files written, reach, threats), `DATA.md` (003 columns, outcomes, notes, audit tools, config files), `ARCHITECTURE.md`, `AGENTS.md`, `README.md`.

## Live checks (scratch repos, now deleted)

- Claude Code 2.1.293: prompts for trust in an untrusted worktree; after the repo root was trusted (by accepting the prompt in the root), `.worktrees/t-1` opened without a prompt. Claude re-reads `~/.claude.json` before saving: an entry added outside it survived this session's own saves.
- Codex 0.154.0: the trust prompt appears only once a prompt is submitted; it says trust applies to the repository root for a worktree. With `-c projects={'C:\k95probe'={trust_level='trusted'}}` the worktree ran without a prompt and `config.toml` was untouched.
- Codex worker under `-s workspace-write -a never --add-dir <repo>/.git`: file write and `node --version` worked; `git commit` failed with "detected dubious ownership" (Windows elevated sandbox runs commands as another account). Workers and testers keep the bypass.
- Codex planner under `-s read-only -a never`: "patch rejected: writing is blocked by read-only sandbox".

## Deviations from the handoff

- **Bypass warning not pre-accepted by the board.** The agent safety check blocked the board writing `skipDangerousModePermissionPrompt` into the operator's `~/.claude/settings.json`. Operator decision: it stays a one-time operator step (README, `CLIS.md`), done on this machine with the same one-off script (it found the key already set and wrote nothing).
- **Claude planner live check run by the operator** (the safety check blocked this session from launching Claude with the bypass), via a one-off script in the session scratchpad: PASS, read allowed, no file written. Haiku refuses the bypass flag; Sonnet was used. `Agent` was added to the deny list after the agent named subagents as a way around it (`CLIS.md` → Reach by role).
- **Claude planner also loses Bash and PowerShell** (handoff: "Bash stays for reading"). Either can write a file, the brainstorm template asks for no commands, and Read/Grep/Glob cover reading. Without it, "a planner cannot write a file" would not hold.
- **No per-worktree trust entries, so nothing for the janitor to remove.** One entry per repo root covers every worktree for Claude; Codex needs no file at all.
- **"Done" for dependencies means merged** (`merged_at`, migration 003). A done ticket whose merge conflicted does not release its dependents.
- **An extra row: `done` + `merge` (operator retries a failed merge).** The table had no way out of a conflict.
- **Housekeeping counter is derived, not stored.** Count of merged execute tickets; only the interval is in `.kanban95/config.json` (read, never written). A counter in the committed config would dirty the base branch after every merge, and a dirty base refuses launches and merges.
- **`ask_operator` is refused on a ticket that is not running** (table: "any running"), including from a planner about a backlog ticket. A planner talks to the operator in its own terminal.
- **A failed launch is the `exit` event** with note `launch failed: <reason>` rather than a transition of its own.
- **Ticket `model`/`effort` override the execute phase only.** Test runs use the phase default; that is what makes a tester's `set_model` mean "the retry runs with this".
- **No artefact registry.** No MCP tool registers test artefacts, so "remove the artefacts the run registered" is covered by removing the worktree (forced, after merge). Add a registry when artefacts live outside the worktree.
- **`set_model` does not requeue a running worker.** Not in the table; the description now says the setting applies to the next execute run.
- **Board-written failure notes** carry the role of the session they are about; a merge conflict note uses `tester` (the notes CHECK has no board role; adding one needs a table rebuild).

## Commands

```
npm test          # 111 tests, ~30 s; needs Node 24 on PATH and git
npm run docs:mcp  # after changing any MCP tool text
```

To run the board by hand you need `~/.kanban95/models.json` (shape in `docs/LIFECYCLE.md` → Run settings).

## Gotchas for the next phase

- **The UI needs ticket-change events.** `/events` only sends `{sound, ticket}`. Phase 6 wants cards to move without reload: emit a `{ticket}` frame from `apply` (one line next to the sound emit) and have the UI refetch that ticket.
- **Operator drags bypass the lifecycle.** `PATCH status` still works (operator power). Dragging to `in_progress` starts no agent; such a ticket is flagged by `recover` on the next daemon start. Resetting a stuck ticket = PATCH `status: backlog`, `needs_human: false` (and `retry: 0` if wanted), then Launch; the worktree and branch are reused.
- **Housekeeping button**: create a ticket with `template = 'housekeeping'` and apply `launch`; there is no REST route for it yet.
- **Brainstorm sessions** are not launched by `launch()` (no ticket). When phase 6 adds them, put them in `sessions` too, or the janitor's sweep revokes their planner grant as an orphan. Check then whether Codex under `-s read-only -a never` can still call `create_ticket`.
- **Trusted folders in Settings**: list from `audit WHERE tool = 'trust.write'`; clearing = delete that `projects` key from `~/.claude.json`.
- Every test file runs with `USERPROFILE`/`HOME` pointed at a temp dir (`test/home.ts`). A test that launches `claude` writes trust there, never in the real home. Keep it that way: before this guard existed, one run of the launcher tests wrote five temp-repo entries into the operator's real `~/.claude.json` (removed by hand). `test/real-home-guard.ts` (vitest `globalSetup`, main process, real home) now fails the run if that ever happens again, naming what to remove.
- `apply` is synchronous and may spawn agents (`execFileSync git`, pty spawn) inside an MCP request; fine at this scale. Effects run after the transaction commits, so an effect that fails (a launch) re-enters `apply` with `exit`.
- node-pty's `AttachConsole failed` stack traces in test output are the known harmless race from phase 4.
