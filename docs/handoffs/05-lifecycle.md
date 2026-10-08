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

## Agent trust and reach (operator decision, 2026-10-07)

Phase 4 left two things open (see `log/04-launcher.md` and `docs/CLIS.md`). The operator decided:

1. **Approve the permission bypass.** Keep `--dangerously-skip-permissions` (Claude Code) and `--dangerously-bypass-approvals-and-sandbox` (Codex) as the default. The board trusts what agents do; it does not stall on approvals.
2. **Pre-trust on first run.** The board answers each CLI's one-time prompts itself so a launch is unattended:
   - Workspace trust for every new worktree. Claude Code keeps it per project in `~/.claude.json` (`projects["<path>"].hasTrustDialogAccepted`); Codex in `~/.codex/config.toml` (`[projects."<path>"] trust_level = "trusted"`), or per process with `-c` if a quote-free form works through `cmd.exe`. Check first whether trusting the repo root once already covers `.worktrees/t-*` (it would be one write instead of one per ticket).
   - Claude Code's one-time bypass-permissions warning, if it has not been accepted on this machine.
   - Verify every key against the installed CLI (`--help`, a real launch) before writing it. Do not guess.
   - Write the minimum, merge into the existing file without disturbing anything else in it, back the file up before the first write, and audit each write (who, which file, which key). Remove the per-worktree entries when the janitor removes the worktree. Show "Trusted folders" in Settings (phase 6) so the operator can see and clear them. Document all of it in `docs/CLIS.md` and `docs/SECURITY.md`.
3. **Limit reach by role, not by approvals.** With approvals off, scope what each role can touch using each CLI's own mechanisms, applied by `buildArgv` per role (role becomes an input to `buildArgv` and a column of its table test):

   | role | needs | Claude Code (verify) | Codex (verify) |
   |---|---|---|---|
   | planner (brainstorm) | read the repo, write tickets over MCP | `--disallowedTools` for Edit/Write/NotebookEdit; Bash stays for reading | `-s read-only` |
   | worker (plan, execute, housekeeping) | write and commit in its worktree, run builds | bypass, `cwd` = worktree | try `-s workspace-write -a never --add-dir <repo>/.git` so commits work; if commits or builds still fail, fall back to the bypass and record why |
   | tester | run the suite, write tests, screenshots | as worker | as worker |

   Candidates found in `claude --help` but not adopted yet: `--restricted` confines file tools to the working dirs but refuses bypass mode and removes Bash, so it does not fit a worker; `--settings <json>` can carry per-session permission deny rules without touching the operator's settings. Any reach a role loses must be justified by what the role's template asks it to do. Test it: the argv table per role, and one live check per CLI that a planner cannot write a file.

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
