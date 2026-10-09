# MCP tool reference

Generated from `daemon/src/mcp.ts` by `npm run docs:mcp`. Do not edit by hand; the test suite fails if this file drifts from the code.

## Connecting

Endpoint: `POST http://127.0.0.1:<port>/mcp`, Streamable HTTP, stateless (no session id, JSON responses). The host must be `127.0.0.1`, never `localhost`.
Every request carries `Authorization: Bearer <token>` where the token is the grant minted for this agent session. A missing, malformed, unknown, expired or revoked token
gets `401` before any tool runs and leaves no audit row. A live token resolves to a grant `{ role, ticket }` that scopes every tool below.

Every tool call, allowed or not, writes one `audit` row with the grant id, tool name, a 200-character argument summary and `ok | denied | error`.
A refused call returns a tool error whose text says why and, for `move_ticket`, which targets the role may use. Results are JSON text.

## Role matrix

| tool | planner | worker | tester | operator |
|------|---|---|---|---|
| create_ticket | yes | yes, Backlog follow-up, no model/effort | no | yes |
| update_ticket | any ticket | own, body/criteria only; its Backlog follow-ups, title/body/criteria/tags/depends_on | no | any ticket |
| delete_ticket | Backlog, no notes or runs | its Backlog follow-ups | no | Backlog, no notes or runs |
| set_model | any | no | no | any |
| move_ticket | no | own → testing | own → done / in_progress | any → in_progress / testing / done |
| add_note | any | own | own | any |
| get_ticket | yes | own + its deps | own + its deps | yes |
| list_tickets | yes | own + its deps | own + its deps | yes |
| brain_add | yes | yes | yes | yes |
| brain_update | yes, and move_to | yes, not move_to | yes, not move_to | yes, and move_to |
| brain_delete | yes | no | no | yes |
| brain_search | yes | yes | yes | yes |
| ask_operator | no | own | own | no |
| report_test | no | no | own | no |
| report_cleanup | no | own | no | any |

"own" means the ticket the grant was minted for; a worker or tester may omit `ticket_id` and may not name another ticket. A planner or operator grant has no ticket and must pass `ticket_id`.
The operator role is an operator terminal: an agent the operator starts from the UI with a typed mission, holding the operator's own reach on the board. It never gets `report_test`; only a tester proves a ticket.

## Tools

### create_ticket

Create a ticket in the backlog. Give it a title, a body that says what to build and why, and acceptance criteria a tester can check one by one. List depends_on ids when this work must wait for other tickets. Tags (lowercase a-z, 0-9, -) group related tickets on the board. Set model and effort only when the work clearly warrants it: trivial work gets effort low, hard work gets high. A worker files a follow-up or a manual touch it found this way instead of widening its own scope: it lands in Backlog, its body starts with "Filed by #<your ticket>", it runs on the operator's default model and effort, and the worker may fix or delete it while it is still in Backlog. Returns the ticket.

| argument | type | required | description |
|---|---|---|---|
| title | string | yes | Short imperative title. |
| body | string | default `""` | What to build and why, markdown. |
| criteria | string | default `""` | Acceptance criteria, one checkable statement per line. |
| depends_on | integer[] | default `[]` | Ticket ids that must be done before this one starts. |
| tags | string[] | no | Grouping tags, each lowercase a-z, 0-9 and - only, e.g. ["ui", "daemon"]. |
| model | string | no | Model override; omit for the phase default. |
| effort | low \| medium \| high \| max | no | Effort override; omit for the phase default. |

### update_ticket

Edit a ticket's title, body, criteria or dependencies. A worker may only refine the body and criteria of its own ticket, for example to record a clarified scope, and fix any of these fields on a Backlog follow-up it created with create_ticket; use add_note for progress and decisions instead. Omitted fields are left unchanged. Returns the ticket.

| argument | type | required | description |
|---|---|---|---|
| ticket_id | integer | no | Ticket id. Worker and tester grants are bound to one ticket and may omit it; a planner or operator must give it. |
| title | string | no |  |
| body | string | no |  |
| criteria | string | no |  |
| tags | string[] | no | Replaces the full tag list; [] clears it. |
| depends_on | integer[] | no | Replaces the full dependency list. |

### delete_ticket

Delete a Backlog ticket made by mistake, with its attachments, exactly as the operator's delete does. A planner may delete a Backlog ticket that has no notes and no runs; a worker may delete only a Backlog follow-up its own grant created with create_ticket. Anything else is refused with the reason. Returns the deleted id.

| argument | type | required | description |
|---|---|---|---|
| ticket_id | integer | yes |  |

### set_model

Change the model and/or effort a ticket runs with; give either or both. Lower effort for trivial work and raise it for hard work, do not only escalate. The ticket's model and effort apply to all its execute runs, retries included. Returns the ticket.

| argument | type | required | description |
|---|---|---|---|
| ticket_id | integer | no | Ticket id. Worker and tester grants are bound to one ticket and may omit it; a planner or operator must give it. |
| model | string | no | Model id as listed in the board's model catalog. |
| effort | low \| medium \| high \| max | no |  |

### move_ticket

Move a ticket to another column. A worker moves its ticket to testing when the work is committed in the worktree and ready to be checked. A tester does not need it: report_test moves the ticket (to done or back to in_progress) and ends the session. A move to the column the ticket is already in returns the ticket unchanged. Once the move is accepted your session is over: the board ends it and starts the next agent. An operator grant may move any ticket the same ways, which ends that ticket's agent, not its own session, and may launch a backlog ticket by moving it to in_progress; it still cannot finish a ticket the tester has not passed. Returns the ticket.

| argument | type | required | description |
|---|---|---|---|
| ticket_id | integer | no | Ticket id. Worker and tester grants are bound to one ticket and may omit it; a planner or operator must give it. |
| status | backlog \| in_progress \| testing \| done | yes |  |

### add_note

Attach a note to a ticket. Kinds: plan (how you intend to do the work, post it before starting), decision (a choice made and why), failure (what went wrong, for the next attempt), summary (what was done, post it when finished). Notes are shown to the operator and injected into later runs of this ticket. Returns the note id.

| argument | type | required | description |
|---|---|---|---|
| ticket_id | integer | no | Ticket id. Worker and tester grants are bound to one ticket and may omit it; a planner or operator must give it. |
| kind | plan \| decision \| failure \| summary | yes |  |
| body | string | yes | Markdown. |

### get_ticket

Read one ticket in full: title, body, acceptance criteria, status, flags, dependencies, model settings, the absolute paths of files the operator attached (screenshots and the like: open them with your file reader), and every note on it in order. A worker or tester may also read the tickets its own ticket depends on, to see what they delivered or decided.

| argument | type | required | description |
|---|---|---|---|
| ticket_id | integer | no | Ticket id. Worker and tester grants are bound to one ticket and may omit it; a planner or operator must give it. |

### list_tickets

List tickets with id, title, status, tags, flags and dependencies, optionally filtered by status. A planner or operator sees the whole board; a worker or tester sees its own ticket and the ones it depends on. Use get_ticket for the body and notes.

| argument | type | required | description |
|---|---|---|---|
| status | backlog \| in_progress \| testing \| done | no |  |

### brain_add

Save one fact a future agent would trip on to the brain: a gotcha, a non-obvious decision, or how an external tool behaves (with version and date). scope global when it holds in any repo (a CLI, git, Windows, a library); project, the default, when it is about this codebase. brain_search the subject first; if a row already covers it, correct that row with brain_update instead of adding a near-duplicate. Title: a sentence naming the trap ("X does Y; do Z"). Body: what happens, why, what to do instead, and the file or function, for a reader with no context. Tags: words the title of a future ticket would contain. Never write ticket status or plans ("pending", "until #N merges"): they go stale; unbuilt work belongs in a ticket. Skip what the code, docs or templates already say. Returns the brain row id and scope.

| argument | type | required | description |
|---|---|---|---|
| title | string | yes |  |
| body | string | yes | Markdown, at most 1500 characters. |
| tags | string | default `""` | Space-separated keywords used for matching. |
| scope | project \| global | default `"project"` | project (default): this repo's brain, facts about this codebase. global: the brain every board shares, facts that hold in any repo (a tool, the OS, a CLI). |

### brain_update

Correct a brain row in place: when your change made it false, when it duplicates what you were about to add, or to merge rows (edit the survivor; ask for the rest to be deleted in your summary). Name the row by scope and id, as brain_search returned them. Omitted fields are left unchanged. move_to moves the row to the other brain under a new id. Returns the row.

| argument | type | required | description |
|---|---|---|---|
| id | integer | yes |  |
| scope | project \| global | default `"project"` | project (default): this repo's brain, facts about this codebase. global: the brain every board shares, facts that hold in any repo (a tool, the OS, a CLI). |
| title | string | no |  |
| body | string | no | Markdown, at most 1500 characters. |
| tags | string | no |  |
| move_to | project \| global | no | Move the row to this brain (insert there, delete here). |

### brain_delete

Delete a brain row (scope and id) that is stale or duplicates another row or the docs. Workers and testers update rows instead and name the ones to delete in their summary note. Returns the deleted id and scope.

| argument | type | required | description |
|---|---|---|---|
| id | integer | yes |  |
| scope | project \| global | default `"project"` | project (default): this repo's brain, facts about this codebase. global: the brain every board shares, facts that hold in any repo (a tool, the OS, a CLI). |

### brain_search

Full-text search the project brain and the global brain together, best match first (title and tags weigh more than the body); every row carries its scope. Search before making a decision another ticket may already have made, before brain_add, and when you meet an unfamiliar subsystem. Give `id` (with its scope) instead to fetch one row, such as one your prompt listed by title only; give neither to list the newest rows. Returns up to limit rows (default 5, max 50) with scope, title, body and tags.

| argument | type | required | description |
|---|---|---|---|
| query | string | no | Keywords; each word must match. |
| id | integer | no | Fetch this one row instead of searching. |
| scope | project \| global | default `"project"` | With id: which brain the row is in. Ignored by a search, which covers both. |
| limit | integer | default `5` |  |

### ask_operator

Ask the human operator a question you cannot resolve from the ticket, the brain or the code. The ticket is flagged needs_human and the operator is alerted; the answer is typed into your session as one line and kept as a note on the ticket. Ask once with full context and the options you see, rather than many small questions. Returns the question id.

| argument | type | required | description |
|---|---|---|---|
| ticket_id | integer | no | Ticket id. Worker and tester grants are bound to one ticket and may omit it; a planner or operator must give it. |
| question | string | yes |  |

### report_test

Record the structured result of testing a ticket against its acceptance criteria. passed is the overall verdict; summary says which criteria passed or failed and why; evidence lists what proves it, one string per item (test output, screenshot paths kept as run evidence, commands run); a single string is taken as one item. The report is the verdict: it moves the ticket to done (the board merges the branch) or back to in_progress (the worker retries, and a failed report becomes the failure note it sees), and ends your session. No move_ticket is needed. Returns the note id and the ticket.

| argument | type | required | description |
|---|---|---|---|
| ticket_id | integer | no | Ticket id. Worker and tester grants are bound to one ticket and may omit it; a planner or operator must give it. |
| passed | boolean | yes |  |
| summary | string | yes |  |
| evidence | string[] \| string | default `[]` |  |

### report_cleanup

Record what a housekeeping ticket removed or updated: one item per file or module with the action and the reason (superseded by X, no importers, references removed code). Used by housekeeping tickets, and by an operator grant on any ticket; the list is shown to the operator and kept with the ticket. Returns the note id.

| argument | type | required | description |
|---|---|---|---|
| ticket_id | integer | no | Ticket id. Worker and tester grants are bound to one ticket and may omit it; a planner or operator must give it. |
| items | { path: string, action: deleted \| updated, reason: string }[] | yes |  |
