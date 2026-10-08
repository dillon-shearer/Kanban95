# Ticket lifecycle

Living document. How a ticket moves itself from Launch to merged, and what the board does at each step. The table below is `TABLE` in `daemon/src/lifecycle.ts`; change both together (`daemon/test/lifecycle.test.ts` has the same rows written out by hand and fails on a mismatch).

## Columns and flags

Status is one of **backlog → in_progress → testing → done**. Two flags sit beside it: `needs_human` (the operator is needed: a question, a silent exit, the retry cap, a merge conflict at the retry cap, a main checkout still dirty after the merge queue's wait) and `blocked_on_deps` (launched, but waiting for a dependency to merge). A ticket also records `retry` (failed tests and merge conflicts so far) and `merged_at` (when its branch landed).

## Events

| event | raised by |
|---|---|
| `launch` | the operator (Launch, Launch all), or the board when the last dependency of a held ticket merges |
| `submit` | the worker's `move_ticket(testing)` |
| `pass` | the tester's `move_ticket(done)` |
| `fail` | the tester's `move_ticket(in_progress)` |
| `ask` | `ask_operator` from any agent |
| `answer` | the operator, `POST /api/tickets/:id/answer` |
| `exit` | the agent's terminal closed without a `move_ticket`, or its launch failed |
| `merged`, `conflict` | the merge queue |
| `dirty` | the merge queue, once the main checkout has had uncommitted changes for the whole wait (10 min) |
| `merge` | the operator retrying a failed merge, `POST /api/tickets/:id/merge` |
| `resume` | the operator, Resume in the card menu or the Inbox, `POST /api/tickets/:id/resume` |

## The table

"Running" means status `in_progress` or `testing`. Anything not in this table is refused (`409` over REST, a `denied` tool error over MCP), and nothing changes.

| from | event | guard | to | flags / counters | side effects |
|---|---|---|---|---|---|
| backlog | launch | every dependency merged | in_progress | `blocked_on_deps` off | worktree, worker grant, execute agent |
| backlog | launch | a dependency not merged | backlog | `blocked_on_deps` on | none; launched again when the dependency merges |
| in_progress | launch | no live agent session | in_progress | `needs_human` off | execute agent again in the same worktree, `retry` unchanged. Refused while an agent is live: "it already has a running agent; open its terminal, or Reset to Backlog to stop it" |
| testing | launch | no live agent session | testing | `needs_human` off | test agent again in the same worktree, `retry` unchanged. Refused while an agent is live, as above |
| in_progress | resume | `needs_human` on and no live agent session | in_progress | `needs_human` off | execute agent again, as for launch |
| testing | resume | `needs_human` on and no live agent session | testing | `needs_human` off | test agent again, as for launch |
| in_progress | submit | | testing | | worker session ended (grant revoked, pty killed), tester grant, test agent |
| testing | pass | the tester called `report_test(passed: true)` during this test run | done | | tester session ended, merge queued |
| testing | fail | `retry` < 3 | in_progress | `retry` + 1 | tester session ended, execute agent again, with the failure notes and the ticket's (possibly escalated) model |
| testing | fail | `retry` = 3 | in_progress | `retry` + 1, `needs_human` on | tester session ended, failure note "stopped after 4 failed tests", chord. Stops |
| running | ask | | same | `needs_human` on | question note, chord. The agent's terminal stays open |
| running | answer | `needs_human` on and an agent session is live | same | `needs_human` off | answer note; the answer typed into the agent's terminal as one line + Enter |
| running | exit | | same | `needs_human` on | failure note ("agent exited without reporting" or "launch failed: …", then a "To resolve:" line naming Resume and Reset to Backlog), chord |
| done | merged | | done | `merged_at` set, `needs_human` off | ding, worktree and branch removed, held dependents launched, housekeeping check |
| done | conflict | `retry` < 3 | in_progress | `retry` + 1 | failure note "merge conflict with <base>: <git output>", execute agent again in the kept worktree. It merges the base in, resolves, and submits; the tester runs and the merge is queued again |
| done | conflict | `retry` = 3 | done | `needs_human` on | the same failure note, chord. Worktree kept |
| done | dirty | | done | `needs_human` on | failure note naming the uncommitted files, chord |
| done | merge | not merged yet | done | | merge queued again |

Resume and launch on a running ticket are not in the original spec. Before them, the only way past a silent exit was Reset to Backlog and Launch, which threw away `retry` and the phase. The new prompt carries the exit's failure note like any retry (`failureNotes` in `daemon/src/context.ts`: failure notes since the latest execute run). Resume is the strict form (only a flagged ticket); Launch on a running ticket also starts an unflagged one with no agent, such as one dragged by hand into a running column.

The `merge` row is not in the original spec: it is how the operator finishes a flagged merge. They fix the branch in its worktree (merge the base into it and commit) or clean the main checkout, then retry the merge.

### Needs human

Every row that turns `needs_human` on writes exactly one note in the same transaction (`Row.says` when the event brings none). Except for a question, that note is what happened, then a last line starting `To resolve:` with the operator's concrete next step: the worktree path (`.worktrees/t-<id>`) and the button (Retry merge, Resume, Reset to Backlog). A question needs no such line: the Inbox's Answer box is its fix. `GET /api/inbox` lists every unanswered question of a flagged ticket, and its newest `failure` when no newer question is open, with `kind` and `status`; the Inbox window shows it with the buttons the line names. `daemon/test/lifecycle.test.ts` checks every such row.

| row | note | To resolve |
|---|---|---|
| fail at the cap | `stopped after 4 failed tests` | read the tester's notes, fix the ticket if it asks for the wrong thing, Reset to Backlog and Launch |
| ask | the question | (the Answer box) |
| exit | `agent exited without reporting` / `launch failed: …` | Resume (the agent starts again in the same worktree), or Reset to Backlog to start over |
| conflict at the cap | `merge conflict with <base>: …` | in `.worktrees/t-<id>` merge the base, fix, test, commit, Retry merge |
| dirty | the `git status` lines | commit or stash in the main checkout, Retry merge |

### Retries

The first execute run is attempt 0. Each failed test adds one to `retry` and runs execute again, up to `retry` = 3: the first attempt plus exactly three retries. The fourth failed test stops the ticket with `needs_human`. A merge conflict counts against the same `retry`: below the cap it sends the ticket back to the worker, at the cap it flags it. Each retry's prompt carries the failure notes of the attempt before it (`docs/AGENTS.md`).

### Escalation

The ticket's `model` and `effort` override the execute phase only, so a retry runs with the same ones; test runs keep the phase default. Only the planner (`set_model`, `create_ticket`) and the operator (UI) set them; a worker or tester that thinks the work needs a bigger model says so in its note.

### Ending a session

Both CLIs run interactive sessions that never exit by themselves. When an agent's `move_ticket` is accepted, the board revokes its grant and kills its terminal; that exit is expected (`runs.outcome` = the event: `submit`, `pass`, `fail`). Any other exit, including the operator revoking a grant and the daemon shutting down, is the `exit` event (`runs.outcome` = `exit`), so a ticket can never sit in a running column with no agent and no flag.

### Restart

No agent survives a daemon restart, and an agent killed by one did nothing wrong. On start, every running ticket without a live session and without `needs_human` gets a failure note ("agent exited without reporting (the daemon restarted)") and the running-ticket `launch` row: the agent for its phase starts again in the same worktree with that note in its prompt, `retry` unchanged, no operator action. If that agent then exits without reporting, the ordinary `exit` row flags the ticket. A ticket already flagged before the restart stays flagged until the operator resumes it. Every done ticket that never merged and is not flagged is queued for merge again.

There is no Pause yet; when it exists, a paused board flags these tickets (`exit`, with the "To resolve:" line) instead of resuming them.

## Launch all

`POST /api/tickets/launch-all` takes every backlog ticket, orders them so a dependency comes before its dependents (ids ascending otherwise) and applies `launch` to each. Tickets whose dependencies have not merged are held with `blocked_on_deps`. Dependency cycles cannot exist: `create_ticket`, `update_ticket` and `PATCH /api/tickets/:id` refuse a dependency list that would make a ticket depend on itself through any chain.

## The merge queue

`daemon/src/merge.ts`. One queue for the whole daemon; a merge starts only after the previous one, and its cleanup, has finished. Each job:

1. waits until the ticket's tester terminal has fully closed;
2. refuses if the main working tree has uncommitted changes to tracked files. That is not the ticket's fault, so nothing is flagged: the job is queued again every 30 s and raises `dirty` only if the tree is still dirty 10 min after the first try (`DIRTY_WAIT`). It never merges into a dirty tree and never runs `git merge --abort` over the operator's edits. A Retry merge restarts the wait; a ticket moved out of done or merged meanwhile is skipped;
3. runs `git merge --no-ff --no-edit -m "<ticket title>" ticket/<id>` in the main working tree, into whatever branch it has checked out. The commit is authored by the repo's own git identity (the operator), with the title as its only line: no ticket id, no trailer;
4. on any other failure runs `git merge --abort`, so the base is left exactly as it was, and raises `conflict` (back to the worker below the retry cap, flagged at it);
5. on success raises `merged`, whose effects remove the worktree and branch before the next job starts.

## Run settings

The board names no model. Each run's CLI, model and effort come from `~/.kanban95/models.json`, which the operator edits in **Settings → Models** (or by hand):

```json
{
  "cli": "claude",
  "claude": {
    "plan": { "model": "<model id>", "effort": "medium" },
    "execute": { "model": "<model id>", "effort": "medium" },
    "test": { "model": "<model id>", "effort": "medium" }
  },
  "codex": {
    "execute": { "model": "<model id>", "effort": "medium" },
    "test": { "model": "<model id>", "effort": "medium" }
  }
}
```

The ticket's `cli` overrides `cli`; its `model` and `effort` override the execute phase. `plan` is the brainstorm's phase. Effort defaults to `medium`. A missing file, CLI, model or a bad effort fails the launch, which flags the ticket with the reason. Settings → CLIs can name the executable per CLI (`~/.kanban95/settings.json` → `paths`); unset, the CLI is found on `PATH`.

## Operator preferences

Every template has a `## Operator preferences` section holding `{{preferences}}`: the contents of `~/.kanban95/preferences.md` (Settings → Prompts), read fresh at each render, `(none)` when the file is absent or empty. It is the operator's file, not the repo's, so it applies to every repo the board works on. Capped at 16 KB; a bigger save is refused.

A repo's prompts come from its own `.kanban95/templates/`, copied from `templates/` once and never overwritten. A repo that had copies before this variable existed does not get the section: add it by hand (or copy `templates/*.md` over unedited copies). Do that only once the board has been restarted on a build that knows `{{preferences}}`, because an older daemon refuses any template naming an unknown variable and every launch would fail.

## Sounds

`ding.wav` when a ticket is merged, `chord.wav` whenever `needs_human` is raised by the table (question, silent exit, retry cap, conflict at the cap, dirty base). The daemon sends `{"sound": "ding" | "chord", "ticket": <id>}` on the `/events` websocket; the UI plays `ui/sounds/<sound>.wav` unless sounds are off in Settings → General. Every transition also sends `{"ticket": <id>}`, so the board redraws that card without a reload (`docs/ARCHITECTURE.md` → Events).

## Janitor

`daemon/src/janitor.ts`. Every deletion writes an audit row (`janitor.worktree`, `janitor.session`, `janitor.grant`, `janitor.run`, `janitor.scrollback`; no grant). A directory that cannot be deleted (Windows refuses while a process still holds a file or sits in it) is audited as `error` and left for the next sweep; it never stops the daemon.

- **After a merge**: the ticket's worktree is removed (forced: the committed work is on the base; what is left is build output and test leftovers) and its branch deleted. Windows holds a directory for a moment after the agent in it exits, so removal is retried for about two seconds. Session dirs are already gone: each is removed when its terminal closes.
- **When a ticket is deleted**: each of its live sessions has its grant revoked and its pty killed before the row goes (its runs, notes and grants cascade away with it); the UI closes the ticket's window and its terminals. The worktree is left to the next sweep.
- **On start and once a day**: worktrees under `.worktrees/` whose ticket is gone or merged (a deleted ticket's worktree only if clean; a branch is deleted only if merged), session dirs and live grants with no live session, runs with no end and no live session (`outcome` = `lost`), and `runs.scrollback` of runs that ended more than 30 days ago (the row, its outcome and the ticket's notes stay). Then `VACUUM`. A worktree of an unmerged ticket is never touched: it may hold the only copy of the work.

## Housekeeping

Every time the number of merged tickets (housekeeping tickets not counted) reaches a multiple of `housekeeping_every`, the board creates a ticket that runs the `housekeeping.md` template and launches it like any other: same worktree, test, retry and merge path. The interval lives in `<repo>/.kanban95/config.json` and defaults to 10:

```json
{ "housekeeping_every": 10 }
```

The count is derived from the database (`template = 'execute' AND merged_at IS NOT NULL`), not stored: a counter in the committed `config.json` would leave the base branch dirty after every merge, and a dirty base refuses launches and merges.

## REST

| method | path | event |
|---|---|---|
| POST | `/api/tickets/:id/launch` | `launch` |
| POST | `/api/tickets/launch-all` | `launch` on every backlog ticket, in dependency order; returns them |
| POST | `/api/tickets/:id/answer` | `answer`; body `{ "answer": "..." }`, non-empty |
| POST | `/api/tickets/:id/merge` | `merge` |
| POST | `/api/tickets/:id/resume` | `resume` |

Each returns the ticket (`200`), `409` with the refusal when the table has no row, and is audited like every REST mutation (`tickets.launch`, `tickets.launch_all`, `tickets.answer`, `tickets.merge`, `tickets.resume`).
