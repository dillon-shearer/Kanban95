# Agents on a Kanban95 board

Living document. How an agent session is expected to behave, derived from the default prompt templates in `templates/`. If a template changes what it asks of an agent, change this file in the same ticket.

## What an agent is given

Each session starts from one rendered template. The board pushes only this; everything else the agent pulls over MCP (`get_ticket`, `brain_search`). No transcripts of earlier sessions are ever injected.

| variable | contents |
|---|---|
| `{{ticket}}` | `#<id> <title>`, a blank line, the body; when the ticket has attachments, a blank line and `Attachments (open with your file reader):` with one `- <absolute path>` line each |
| `{{criteria}}` | the acceptance criteria as written on the ticket |
| `{{brain}}` | up to 5 brain rows matching any word (3+ letters) of the ticket's title and body, best first, as `- [#id] title: body`; capped at 4000 characters, a cut is marked `[brain truncated; search for more with brain_search]` |
| `{{notes}}` | `failure` notes written since the latest execute run of this ticket started, i.e. what went wrong in the attempt being retried. Earlier cycles are left out |
| `{{retry}}` | the ticket's retry count, `0` on the first attempt |
| `{{diff}}` | test sessions only: `git diff <base>...HEAD` in the worktree. Empty in every other template |
| `{{base}}` | the branch the ticket's worktree forked from and merges into (the main checkout's current branch); `(none)` for a brainstorm or operator terminal |
| `{{tools}}` | the MCP tools this session's role may call, with the access cell from `docs/MCP.md` |
| `{{preferences}}` | the operator's standing instructions, `~/.kanban95/preferences.md` as written (Settings → Prompts), under every template's "## Operator preferences" heading |
| `{{mission}}` | operator terminals only: the mission the operator typed, verbatim. `(none)` everywhere else |

Empty values render as `(none)`, except `{{diff}}` outside a test session (empty) and the attachments block (left out when there are none). Values are inserted literally: a brain note containing `{{ticket}}` stays that text. A template naming a variable that has no value is refused, never rendered.

## Templates and roles

| template | grant role | `runs.phase` | job |
|---|---|---|---|
| `brainstorm.md` | planner | no run (no ticket) | interview the operator, create tickets |
| `operator.md` | operator | no run (no ticket) | carry out the operator's typed mission with the operator's reach on the board |
| `plan.md` | worker | plan | design pass for one ticket, write a `plan` note. The board does not launch it today: the lifecycle starts only `execute`, `housekeeping` and `test` sessions, and the `plan` phase settings in `models.json` are used by brainstorms and operator terminals |
| `execute.md` | worker | execute | build the ticket in its worktree |
| `housekeeping.md` | worker | execute | clean stale docs, dead modules, leftover artefacts |
| `test.md` | tester | test | check the work against the criteria |

## Expected behaviour

**Planner (brainstorm).** Interviews the operator before proposing anything, reads the code and brain, agrees the list with the operator, then calls `create_ticket` for each: imperative title, a body saying what and why, measurable acceptance criteria one per line, `depends_on`, and `model`/`effort` only when clearly warranted (`low` for trivial, `high` for hard). Writes no code. Ends by listing what it created.

**Operator terminal (operator).** The operator's hand on the board. Reads `CLAUDE.md`, pulls only the context the mission needs (`list_tickets`, `get_ticket`, `brain_search`), does the work, and records decisions and gotchas with `brain_add`. Changes code only in a worktree under `.worktrees/op-<time>` and merges it into the main checkout itself once the tests pass, because ticket agents may be running and the merge queue merges there. Commits as the operator with a plain imperative subject. Creates tickets only when the mission says so. Ends with a short written summary in its terminal. Never calls `report_test`.

**Planner of one ticket (plan; not launched by the board today).** Reads the code, decides files, steps, how each criterion will be proven and the risks. Sharpens vague criteria with `update_ticket`. Writes one short `plan` note. Does not code or move the ticket.

**Worker (execute).**
- Works only inside the current directory, the ticket's worktree.
- Verify with `npm test` or a script built on `daemon/test/cdp.ts`, never by starting the app (`npm run dev`, `Kanban95.cmd`, `cargo run`) or a visible browser.
- Records decisions with `add_note` kind `decision`, gotchas for future tickets with `brain_add`.
- Asks with `ask_operator` instead of guessing, once, with the options it sees.
- Never commits secrets and never reads a `.env`.
- Commits in the worktree with a plain imperative subject, no ticket or phase ids, no trailers.
- Finishes with tests and build passing, a `summary` note, then `move_ticket(testing)`. Once the move is accepted the board ends the session and starts the tester; nothing after it is read.
- An `ask_operator` keeps the session open: the operator's answer is typed into the terminal as one line.
- On a retry, fixes the failure notes first.
- When a failure note reports a merge conflict (`merge conflict with <base>: …`, written by the merge queue), runs `git merge {{base}}` in the worktree, resolves keeping both sides' intent (two tests added at one spot: keep both), runs the tests and the build, commits, and submits as usual. The tester runs again and the merge is queued again.

**Tester (test).** Runs the suite and build, reviews `{{diff}}` against each criterion, writes and commits tests for new behaviour that has none, for UI tickets takes screenshots with a headless script built on `daemon/test/cdp.ts` (never by starting the app or a visible browser), and deletes every artefact not kept as evidence. May raise the model or effort with `set_model` when the work was too hard for it. Finishes with `report_test` (verdict, per-criterion summary, evidence), then `move_ticket(done)` or `move_ticket(in_progress)`. `done` is refused unless `report_test(passed: true)` was called in this test run; it ends the session and queues the merge. `in_progress` starts the next execute attempt, up to three retries (`docs/LIFECYCLE.md`).

**Housekeeper (housekeeping).** Created by the board after every 10th merged ticket (`housekeeping_every`), and run through the same test and merge path as any ticket. Finds stale docs, ephemeral docs that are superseded, modules with no importers, templates nothing renders, orphan worktrees, temp dirs and stray screenshots. Moves anything durable into the matching living doc, then deletes. Confirms "unused" by search. Changes no behaviour; tests and build must pass as before. Calls `report_cleanup` with every path and reason, then `move_ticket(testing)`. Its tester checks the build still passes and no living doc was removed.

## Skills

`skills/` in the Kanban95 repo is a Claude Code plugin named `kanban95` (manifest `skills/.claude-plugin/plugin.json`). Each skill is one page and names only tools from `docs/MCP.md`.

| skill | use it |
|---|---|
| [`kanban95-ticket-start`](../skills/kanban95-ticket-start/SKILL.md) | at the start of a worker session: read the ticket, its dependencies and the brain, post a `plan` note |
| [`kanban95-ticket-complete`](../skills/kanban95-ticket-complete/SKILL.md) | when the work is committed: verify, `brain_add` the gotchas, `summary` note, `move_ticket(testing)` |
| [`kanban95-ask-operator`](../skills/kanban95-ask-operator/SKILL.md) | when a decision is the operator's: when to ask, and how to phrase a question answered in one line |

Load it for a session with `claude --plugin-dir <kanban95 repo>/skills`; the skills then appear as `kanban95:<skill>`. Check the manifest with `claude plugin validate skills`. The board's launcher does not pass `--plugin-dir` yet, so a launched agent gets the same guidance from its template instead.

## Editing templates

The defaults live in `templates/` in the Kanban95 repo. On every start the daemon copies any default missing from `<repo>/.kanban95/templates/` (committed with the project) and never overwrites one that exists, so an operator's edits stick. Every render reads the file again, so an edit applies to the next launch without a restart. A template that uses any variable outside the table above is refused, naming the variable and the template, before anything is launched.
