---
name: kanban95-ticket-start
description: Start work on a Kanban95 ticket. Use at the beginning of a worker session, before editing anything: read the ticket, its dependencies and the brain, then post a plan note.
---

# Start a Kanban95 ticket

Your prompt carries the ticket, its criteria, matching brain rows and any failure notes. Pull the rest over MCP; nothing else will be sent to you.

1. **Read the ticket.** `get_ticket` (omit `ticket_id`; your grant is bound to one ticket). Read the body, every acceptance criterion and every note in order. On a retry (`retry` > 0) the `failure` notes are what you fix first.
2. **Read the dependencies.** `list_tickets` shows your ticket and the ones it depends on. `get_ticket` on each dependency to see what it delivered: its `summary` note says what changed and where. A dependency not in `done` means its work may not be on your branch; check the code before relying on it.
3. **Search the brain.** `brain_search` with the subsystem, file or tool names the ticket touches (each word must match, so use two or three keywords, not a sentence). Search again before any decision another ticket may already have made. The rows in your prompt are picked by keyword overlap and most will not apply: use one only if it concerns what you are changing, and check it against the code. Rows listed by title only: fetch with `brain_search` and the row's `id`.
4. **Read the code** the ticket touches, end to end, and the repo's own conventions (`CLAUDE.md`, `AGENTS.md`). If the worktree needs dependencies to build or test, install them in it (`npm install`, or the repo's equivalent); never junction or symlink the main checkout's `node_modules`, or anything else of the main checkout's, into the worktree.
5. **Post a plan.** One `add_note` with `kind: "plan"`: the files you will change, the steps, how each criterion will be proven, and the risks. Keep it short; it is shown to the operator and to later attempts.

If the ticket leaves a real choice open that the code and brain do not settle, use the `kanban95-ask-operator` skill now, before building on a guess. If you only sharpened the scope, record it with `update_ticket` (body/criteria only).

Then build. Record each non-obvious choice as you make it with `add_note` `kind: "decision"`: what you chose and why.

## When a tool is refused

When a board tool is refused for reach ("may not call", "scoped to ticket", "ask for level N"), call `request_permission` once with the lowest level that covers the need and a one-line reason, then wait for the answer in your terminal. Never retry the refused call before the answer. A denial is final for this ticket: note it and finish within the reach you have.

Levels, each holding the ones below:
- 0: your role's own tools, in your prompt.
- 1: move any ticket to backlog or in_progress.
- 2: also move any running ticket to done without a tester pass.
- 3: also the operator's reach for update_ticket, delete_ticket, set_model and add_note.
- 4: the operator's reach for every tool, move to testing included.
- read_all: get_ticket and list_tickets on every ticket.

When the limit you hit is a Kanban95 bug or gap (a missing tool, a wrong refusal, a crash), file it with `file_on_board` on the Kanban95 board by folder name, with the exact refusal text and your ticket id, note the filed id on your own ticket, and continue. When that board is not registered or cannot be opened, add a note on your own ticket instead.
