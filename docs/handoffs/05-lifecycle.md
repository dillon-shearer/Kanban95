# Phase 5 — Lifecycle

Read `CLAUDE.md`, `PLAN.md`, `docs/handoffs/log/*`. This is the heart of the board. Use the largest model available.

## Goal
Tickets move themselves. The operator clicks Launch or Launch all. The board runs execute → test → retry → merge → done, holds on dependencies, escalates models, routes questions to the operator, and flags only when stuck.

## State machine (implement exactly; document in `docs/LIFECYCLE.md`)

| from | event | to | side effects |
|------|-------|----|--------------|
| backlog | launch, deps all done | in_progress | worktree, worker grant, spawn execute |
| backlog | launch, deps not done | backlog + `blocked_on_deps` | auto-launch when deps finish |
| in_progress | worker `move_ticket(testing)` | testing | expire worker grant, tester grant, spawn test |
| testing | tester `report_test(pass)` + `move_ticket(done)` | done | enqueue merge |
| testing | tester `move_ticket(in_progress)` | in_progress | retry+1; if retry > 3 → `needs_human` + chord, stop; else spawn execute with failure notes, model = tester's `set_model` if any |
| any running | `ask_operator` | same + `needs_human` | chord; pty stays alive; the answer is written into the pty as input and clears the flag |
| any running | pty exits without a `move_ticket` | same + `needs_human` | failure note "agent exited without reporting" |
| done | merge ok | done | ding; remove worktree; release dependents |
| done | merge conflict | done + `needs_human` | chord; worktree kept |

## Deliverables
- `daemon/src/lifecycle.ts`: the table above as data plus one `transition(ticket, event)` function. No transitions outside the table.
- `daemon/src/merge.ts`: one serialized queue. `git merge --no-ff ticket/<id>` into the base branch in the main working tree; aborts cleanly on conflict. Merge commit message is the ticket title as a plain sentence (no ticket or phase ids), authored by the operator's git identity, no trailers (see `CLAUDE.md` → commits). The `execute.md` template tells the agent the same format for its own commits.
- Launch all: topological order over `depends_on`; launches everything launchable now, holds the rest.
- `ask_operator` round trip: operator answer via REST → `answer` note → written to the pty stdin followed by newline → `needs_human` cleared.
- Sounds: `ding.wav` on done, `chord.wav` on needs_human, played by the UI on a websocket event from `/events`.
- `daemon/src/janitor.ts`: on done + merged → remove worktree, branch, session dir, any test artefacts the run registered. On daemon start and once a day → delete orphan worktrees and session dirs (no matching live run), drop `runs` scrollback older than 30 days keeping outcome and summary, `VACUUM`. Every deletion is audited.
- Housekeeping auto-trigger: after every 10th ticket reaches Done, create a `housekeeping` ticket from the template and launch it like any other (it respects concurrency and the merge queue). Counter and interval live in `.kanban95/config.json`.
- Log entry `docs/handoffs/log/05-lifecycle.md`.

## Acceptance criteria
1. Every row of the table is exercised by a test.
2. Retry cap is exactly 3 execute attempts after the first failure, then stop.
3. Two tickets finishing within the same second merge sequentially and both land.
4. A dependent ticket launches automatically the moment its last dependency is Done and merged.
5. A process that dies silently cannot leave a ticket in `in_progress` without `needs_human`.

## Required tests
- Table test over every row, plus the implicit "any other event → refused" case.
- Merge conflict path: conflicting branches → second one gets `needs_human`, base branch left clean.
- Dependency cycle in `depends_on` is detected and refused at `create_ticket` and `update_ticket`.
- `ask_operator` answer reaches the pty as a single line and clears the flag.
- Concurrency: 5 tickets launched at once, 5 ptys, one merge queue, deterministic final state.
- Janitor: after a ticket is done and merged, `.worktrees/`, `.kanban95/sessions/` and the branch list contain nothing for it. An orphan worktree planted by the test is removed on daemon start.
- The 10th Done creates exactly one housekeeping ticket; the 11th does not.
