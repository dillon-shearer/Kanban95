---
name: kanban95-ticket-complete
description: Finish a Kanban95 ticket as the worker. Use when the work is built and committed in the worktree: verify, write the summary note, save gotchas to the brain, then move the ticket to testing.
---

# Complete a Kanban95 ticket

Do these in order. `move_ticket` ends your session: nothing after it is read.

1. **Verify.** Run the tests and the build the repo uses. Fix what fails. An intermittent failure in a test your change did not touch: rerun that file alone before debugging your change.
2. **Clean up.** Remove what you created that is not the deliverable: temp files, scratch repos, screenshots not kept as evidence, processes you started.
3. **Commit** in the worktree. Subject: a plain imperative sentence saying what changed, no ticket or phase ids, no trailers. Never commit secrets, keys, tokens or `.env` files.
4. **Keep the brain true.** `brain_search` the subsystems you changed and `brain_update` every row your change made false; name rows that should be deleted in your summary (only the operator or planner deletes). Then, for each new thing a future ticket would trip on, one `brain_add`: a `title` that is a sentence naming the trap ("X does Y; do Z"), a `body` under ~800 characters written for a reader with no context (what happens, why, what to do instead, the file or function), and `tags` with the words a later ticket's title would contain. `brain_search` the subject first and `brain_update` a row that already covers it rather than add a near-duplicate. Never write ticket status or plans ("pending", "until #N merges"); unbuilt work belongs in a ticket. Skip what the code, docs or templates already say; a durable convention goes into the matching `docs/*.md` instead.
5. **Summarise.** One `add_note` with `kind: "summary"`: what changed (files, behaviour) and, criterion by criterion, how each is met and what proves it. The tester reads this against the diff.
6. **Hand over.** `move_ticket` with `status: "testing"`. The board ends the session and starts the tester.

A housekeeping ticket calls `report_cleanup` with every path removed or updated and the reason, before step 5.

If you cannot meet a criterion, do not move the ticket. Ask with the `kanban95-ask-operator` skill, or post an `add_note` `kind: "failure"` saying what blocks it.
