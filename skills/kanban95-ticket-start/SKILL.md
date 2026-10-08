---
name: kanban95-ticket-start
description: Start work on a Kanban95 ticket. Use at the beginning of a worker session, before editing anything: read the ticket, its dependencies and the brain, then post a plan note.
---

# Start a Kanban95 ticket

Your prompt carries the ticket, its criteria, matching brain rows and any failure notes. Pull the rest over MCP; nothing else will be sent to you.

1. **Read the ticket.** `get_ticket` (omit `ticket_id`; your grant is bound to one ticket). Read the body, every acceptance criterion and every note in order. On a retry (`retry` > 0) the `failure` notes are what you fix first.
2. **Read the dependencies.** `list_tickets` shows your ticket and the ones it depends on. `get_ticket` on each dependency to see what it delivered: its `summary` note says what changed and where. A dependency not in `done` means its work may not be on your branch; check the code before relying on it.
3. **Search the brain.** `brain_search` with the subsystem, file or tool names the ticket touches (each word must match, so use two or three keywords, not a sentence). Search again before any decision another ticket may already have made. The rows in your prompt are picked by keyword overlap and most will not apply: use one only if it concerns what you are changing, and check it against the code. Rows listed by title only: fetch with `brain_search` and the row's `id`.
4. **Read the code** the ticket touches, end to end, and the repo's own conventions (`CLAUDE.md`, `AGENTS.md`).
5. **Post a plan.** One `add_note` with `kind: "plan"`: the files you will change, the steps, how each criterion will be proven, and the risks. Keep it short; it is shown to the operator and to later attempts.

If the ticket leaves a real choice open that the code and brain do not settle, use the `kanban95-ask-operator` skill now, before building on a guess. If you only sharpened the scope, record it with `update_ticket` (body/criteria only).

Then build. Record each non-obvious choice as you make it with `add_note` `kind: "decision"`: what you chose and why.
