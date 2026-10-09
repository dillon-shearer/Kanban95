# Agents on a Kanban95 board

Living document. How an agent session is expected to behave, derived from the default prompt templates in `templates/`. If a template changes what it asks of an agent, change this file in the same ticket.

## What an agent is given

Each session starts from one rendered template. The board pushes only this; everything else the agent pulls over MCP (`get_ticket`, `brain_search`). No transcripts of earlier sessions are ever injected.

| variable | contents |
|---|---|
| `{{ticket}}` | `#<id> <title>`, a blank line, the body; when the ticket has attachments, a blank line and `Attachments (open with your file reader):` with one `- <absolute path>` line each |
| `{{criteria}}` | the acceptance criteria as written on the ticket |
| `{{brain}}` | up to 8 brain rows matching any word (3+ letters) of the ticket's title and body, best first (`bm25` with title ×10, tags ×5, body ×1). The first 2 as `- [#id] title: body`, the rest as an index line `- [#id] title · tags` the agent fetches with `brain_search` `id`. Capped at 2500 characters and cut only between rows (a body that does not fit falls back to its index line); a cut is marked `[brain truncated; search for more with brain_search]` |
| `{{notes}}` | `failure` notes written since the latest execute run of this ticket started, i.e. what went wrong in the attempt being retried. Earlier cycles are left out |
| `{{retry}}` | the ticket's retry count, `0` on the first attempt |
| `{{diff}}` | test sessions only: `git diff --stat <base>...HEAD` of every changed file, then the diff of code and config only. Markdown, `docs/` and lockfiles are named in the stat but their hunks are left out, and the rest is capped at 32 000 characters with a `[diff truncated: run git diff <base>...HEAD -- <path>]` marker (`gitDiff` in `daemon/src/context.ts`). The tester pulls any file it needs. Empty in every other template |
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

A repo renders its own copies in `.kanban95/templates/`, copied once from `templates/` and never overwritten. When a ticket adds a template variable, the running board is still the old build and refuses every launch whose template names it. Order: merge, restart the board, then copy `templates/*.md` over the repo's copies (diff first; only safe while they are unedited).

## Expected behaviour

**Planner (brainstorm).** Interviews the operator in its own terminal, one question at a time, waiting for each reply, before proposing anything. It has no `ask_operator`: that tool is for ticket agents only (worker, tester), since it needs a running ticket. It reads the code and brain, agrees the list with the operator, then calls `create_ticket` for each: imperative title, a body saying what and why, measurable acceptance criteria one per line, `depends_on`, and `model`/`effort` only when clearly warranted (`low` for trivial, `high` for hard). Writes no code. Turns brain rows that record a bug found but not fixed, or unbuilt work, into tickets and then deletes them (`brain_delete`). Ends by listing what it created.

**Operator terminal (operator).** The operator's hand on the board. Reads `CLAUDE.md`, pulls only the context the mission needs (`list_tickets`, `get_ticket`, `brain_search`), does the work, and records decisions and gotchas with `brain_add`. Changes code only in a worktree under `.worktrees/op-<time>` and merges it into the main checkout itself once the tests pass, because ticket agents may be running and the merge queue merges there. Commits as the operator with a plain imperative subject. Creates tickets only when the mission says so. Ends with a short written summary in its terminal. Never calls `report_test`. Like the planner it is interactive, so it asks the operator in its terminal and has no `ask_operator`.

**Planner of one ticket (plan; not launched by the board today).** Reads the code, decides files, steps, how each criterion will be proven and the risks. Sharpens vague criteria with `update_ticket`. Writes one short `plan` note. Does not code or move the ticket.

**Worker (execute).**
- Works only inside the current directory, the ticket's worktree.
- Reads only what the change needs: `CLAUDE.md` (loaded by the CLI) points it at `docs/ARCHITECTURE.md` → Working on the board, the ARCHITECTURE section for the part it touches and that part's living doc, not the whole of README and ARCHITECTURE up front. Each file read early is paid again on every later call of the session (ticket #43).
- Verify with `npm test` or a script built on `daemon/test/cdp.ts`, never by starting the app (`npm run dev`, `Kanban95.cmd`, `cargo run`) or a visible browser.
- Puts new tests in a new file named for the feature (`daemon/test/<feature>.test.ts`) unless it is extending an existing test's scenario: several tickets run at once and appending to a shared test file is the most common merge conflict.
- Records decisions with `add_note` kind `decision`, gotchas for future tickets with `brain_add` (rules below in The brain).
- Before finishing, `brain_search`es the subsystems it changed and `brain_update`s every row the change made false; names rows to delete in its summary.
- Asks with `ask_operator` instead of guessing, once, with the options it sees.
- Never commits secrets and never reads a `.env`.
- Commits in the worktree with a plain imperative subject, no ticket or phase ids, no trailers.
- Finishes with tests and build passing, a `summary` note, then `move_ticket(testing)`. Once the move is accepted the board ends the session and starts the tester; nothing after it is read.
- An `ask_operator` keeps the session open: the operator's answer is typed into the terminal as one line.
- On a retry, fixes the failure notes first.
- When a failure note reports a merge conflict (`merge conflict with <base>: …`, written when the board merges the base into the worktree on submit or in the merge queue), runs `git merge {{base}}` in the worktree, resolves keeping both sides' intent (two tests added at one spot: keep both), runs the tests and the build, commits, and submits as usual. The tester runs again and the merge is queued again. When it says `worktree has uncommitted changes`, commits or discards them and submits again.

Claude Code workers and testers run without the operator's user settings, plugins and skills, and on a 5 minute prompt cache (`docs/CLIS.md` → Claude Code). The board's guidance reaches them through the template and `CLAUDE.md` only.

**Tester (test).** Runs the suite and build, reviews `{{diff}}` against each criterion (pulling with `git diff <base>...HEAD -- <path>` every file the inline diff leaves out that a criterion is about), writes and commits tests for new behaviour that has none (in a new file named for the feature, as the worker does), for UI tickets takes screenshots with a headless script built on `daemon/test/cdp.ts` (never by starting the app or a visible browser), and deletes every artefact not kept as evidence. Names, by id, any brain row the diff made false. Finishes with one call, `report_test` (verdict, per-criterion summary, evidence), which is also the move and ends the session: `passed: true` moves the ticket to done and queues the merge; `passed: false` moves it back to in_progress and starts the next execute attempt, up to three retries (`docs/LIFECYCLE.md`). It is refused on a ticket not in testing. No `move_ticket` is needed; one to the column the report already chose returns the ticket unchanged.

**Housekeeper (housekeeping).** Created by the board after every 10th merged ticket (Settings → General → Housekeeping), and run through the same test and merge path as any ticket. Finds stale docs, ephemeral docs that are superseded, modules with no importers, templates nothing renders, orphan worktrees, temp dirs and stray screenshots. Reviews every brain row (keep, rewrite, merge, delete): applies rewrites and merges with `brain_update`, reports each as `brain#<id>` in `report_cleanup`, and names the rows to delete for the operator. Moves anything durable into the matching living doc, then deletes. Confirms "unused" by search. Changes no behaviour; tests and build must pass as before. Calls `report_cleanup` with every path and reason, then `move_ticket(testing)`. Its tester checks the build still passes and no living doc was removed.

## Skills

`skills/` in the Kanban95 repo is a Claude Code plugin named `kanban95` (manifest `skills/.claude-plugin/plugin.json`). Each skill is one page and names only tools from `docs/MCP.md`.

| skill | use it |
|---|---|
| [`kanban95-ticket-start`](../skills/kanban95-ticket-start/SKILL.md) | at the start of a worker session: read the ticket, its dependencies and the brain, post a `plan` note |
| [`kanban95-ticket-complete`](../skills/kanban95-ticket-complete/SKILL.md) | when the work is committed: verify, keep the brain true (`brain_update`, `brain_add`), `summary` note, `move_ticket(testing)` |
| [`kanban95-ask-operator`](../skills/kanban95-ask-operator/SKILL.md) | when a decision is the operator's: when to ask, and how to phrase a question answered in one line |

Load it for a session with `claude --plugin-dir <kanban95 repo>/skills`; the skills then appear as `kanban95:<skill>`. Check the manifest with `claude plugin validate skills`; that checks only the manifest and SKILL.md frontmatter. To prove the plugin loads, run from a neutral cwd `claude -p --plugin-dir <abs path>/skills --model <any> --output-format stream-json --verbose "Reply OK"` and read the first (`"subtype":"init"`) event: the plugin is listed in `plugins` as `kanban95@inline` and its skills as `kanban95:<skill>`. `claude plugin details` knows only installed plugins. The board's launcher does not pass `--plugin-dir` yet, so a launched agent gets the same guidance from its template instead.

## Editing templates

The defaults live in `templates/` in the Kanban95 repo. On every start the daemon copies any default missing from `<repo>/.kanban95/templates/` (committed with the project) and never overwrites one that exists, so an operator's edits stick. Every render reads the file again, so an edit applies to the next launch without a restart. A template that uses any variable outside the table above is refused, naming the variable and the template, before anything is launched.

## The brain

The project brain is a shared table of short facts (`docs/DATA.md` → brain). Every role reads it with `brain_search` and writes with `brain_add` and `brain_update`; only a planner, an operator terminal or the operator in the Brain window deletes (`brain_delete`), so a confused agent cannot erase a decision. Edits are in place, with no history; the audit log says who changed what. The rules come from the audit on ticket #41.

- **Reading.** `{{brain}}` is picked by keyword overlap and most rows will not apply. Use a row only if it concerns what you are changing, and check it against the code. To find more, `brain_search` with 2–3 subsystem, file or tool names (every word must match).
- **Before writing,** `brain_search` the subject. If a row already covers it, correct that row with `brain_update` instead of adding a near-duplicate.
- **What belongs.** One fact a future agent would trip on: a gotcha, a non-obvious decision, or an external tool's behaviour (with version and date). Not what the code, docs or templates already say: a durable convention goes into the matching living doc in your own ticket.
- **How to write.** Title: a sentence naming the trap ("X does Y; do Z"). Body: what happens, why, what to do instead, and the file or function, under ~800 characters (1500 is refused). Tags: 4–8 words a future ticket's title would contain.
- **Never write** ticket status or plans ("until #53 merges", "pending"): they go stale within hours. Unbuilt work or an unfixed bug belongs in a ticket.
- **Keeping it true.** Before finishing, `brain_search` the subsystems you changed and fix every row your change made false. The housekeeping ticket reviews every row.

Not done on purpose: embeddings (a provider key or another local model, and the failure was duplicates, not recall), time decay (a gotcha stays true until the code changes), confidence scores, supersede chains or soft delete, and usage counters (revisit past ~100 rows).
