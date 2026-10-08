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
| create_ticket | yes | no | no | yes |
| update_ticket | any ticket | own, body/criteria only | no | any ticket |
| set_model | any | no | no | any |
| move_ticket | no | own → testing | own → done / in_progress | any → in_progress / testing / done |
| add_note | any | own | own | any |
| get_ticket | yes | own + its deps | own | yes |
| list_tickets | yes | own + its deps | own | yes |
| brain_add | yes | yes | yes | yes |
| brain_update | yes | yes | yes | yes |
| brain_delete | yes | no | no | yes |
| brain_search | yes | yes | yes | yes |
| ask_operator | yes | own | own | yes |
| report_test | no | no | own | no |
| report_cleanup | no | own | no | any |

"own" means the ticket the grant was minted for; a worker or tester may omit `ticket_id` and may not name another ticket. A planner or operator grant has no ticket and must pass `ticket_id`.
The operator role is an operator terminal: an agent the operator starts from the UI with a typed mission, holding the operator's own reach on the board. It never gets `report_test`; only a tester proves a ticket.

## Tools

### create_ticket

Create a ticket in the backlog. Give it a title, a body that says what to build and why, and acceptance criteria a tester can check one by one. List depends_on ids when this work must wait for other tickets. Set model and effort only when the work clearly warrants it: trivial work gets effort low, hard work gets high. Returns the ticket.

| argument | type | required | description |
|---|---|---|---|
| title | string | yes | Short imperative title. |
| body | string | default `""` | What to build and why, markdown. |
| criteria | string | default `""` | Acceptance criteria, one checkable statement per line. |
| depends_on | integer[] | default `[]` | Ticket ids that must be done before this one starts. |
| model | string | no | Model override; omit for the phase default. |
| effort | low \| medium \| high \| max | no | Effort override; omit for the phase default. |

### update_ticket

Edit a ticket's title, body, criteria or dependencies. A worker may only refine the body and criteria of its own ticket, for example to record a clarified scope; use add_note for progress and decisions instead. Omitted fields are left unchanged. Returns the ticket.

| argument | type | required | description |
|---|---|---|---|
| ticket_id | integer | no | Ticket id. Worker and tester grants are bound to one ticket and may omit it; a planner or operator must give it. |
| title | string | no |  |
| body | string | no |  |
| criteria | string | no |  |
| depends_on | integer[] | no | Replaces the full dependency list. |

### set_model

Change the model and/or effort a ticket runs with; give either or both. Lower effort for trivial work and raise it for hard work, do not only escalate. The ticket's model and effort apply to all its execute runs, retries included. Returns the ticket.

| argument | type | required | description |
|---|---|---|---|
| ticket_id | integer | no | Ticket id. Worker and tester grants are bound to one ticket and may omit it; a planner or operator must give it. |
| model | string | no | Model id as listed in the board's model catalog. |
| effort | low \| medium \| high \| max | no |  |

### move_ticket

Move a ticket to another column. A worker moves its ticket to testing when the work is committed in the worktree and ready to be checked. A tester moves it to done after report_test with passed true (the board then merges the branch), or back to in_progress after report_test with the failure so the worker retries. Once the move is accepted your session is over: the board ends it and starts the next agent. An operator grant may move any ticket the same ways, which ends that ticket's agent, not its own session, and may launch a backlog ticket by moving it to in_progress; it still cannot finish a ticket the tester has not passed. Returns the ticket.

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

Read one ticket in full: title, body, acceptance criteria, status, flags, dependencies, model settings, the absolute paths of files the operator attached (screenshots and the like: open them with your file reader), and every note on it in order. A worker may also read the tickets its own ticket depends on, to see what they delivered.

| argument | type | required | description |
|---|---|---|---|
| ticket_id | integer | no | Ticket id. Worker and tester grants are bound to one ticket and may omit it; a planner or operator must give it. |

### list_tickets

List tickets with id, title, status, flags and dependencies, optionally filtered by status. A planner or operator sees the whole board; a worker sees its own ticket and the ones it depends on; a tester sees its own. Use get_ticket for the body and notes.

| argument | type | required | description |
|---|---|---|---|
| status | backlog \| in_progress \| testing \| done | no |  |

### brain_add

Save one fact a future agent would trip on to the project brain: a gotcha, a non-obvious decision, or how an external tool behaves (with version and date). brain_search the subject first; if a row already covers it, correct that row with brain_update instead of adding a near-duplicate. Title: a sentence naming the trap ("X does Y; do Z"). Body: what happens, why, what to do instead, and the file or function, for a reader with no context. Tags: words the title of a future ticket would contain. Never write ticket status or plans ("pending", "until #N merges"): they go stale; unbuilt work belongs in a ticket. Skip what the code, docs or templates already say. Returns the brain row id.

| argument | type | required | description |
|---|---|---|---|
| title | string | yes |  |
| body | string | yes | Markdown, at most 1500 characters. |
| tags | string | default `""` | Space-separated keywords used for matching. |

### brain_update

Correct a brain row in place: when your change made it false, when it duplicates what you were about to add, or to merge rows (edit the survivor; ask for the rest to be deleted in your summary). Omitted fields are left unchanged. Returns the row.

| argument | type | required | description |
|---|---|---|---|
| id | integer | yes |  |
| title | string | no |  |
| body | string | no | Markdown, at most 1500 characters. |
| tags | string | no |  |

### brain_delete

Delete a brain row that is stale or duplicates another row or the docs. Workers and testers update rows instead and name the ones to delete in their summary note. Returns the deleted id.

| argument | type | required | description |
|---|---|---|---|
| id | integer | yes |  |

### brain_search

Full-text search the project brain, best match first (title and tags weigh more than the body). Search before making a decision another ticket may already have made, before brain_add, and when you meet an unfamiliar subsystem. Give `id` instead to fetch one row, such as one your prompt listed by title only; give neither to list the newest rows. Returns up to limit rows (default 5, max 50) with title, body and tags.

| argument | type | required | description |
|---|---|---|---|
| query | string | no | Keywords; each word must match. |
| id | integer | no | Fetch this one row instead of searching. |
| limit | integer | default `5` |  |

### ask_operator

Ask the human operator a question you cannot resolve from the ticket, the brain or the code. The ticket is flagged needs_human and the operator is alerted; the answer is typed into your session as one line and kept as a note on the ticket. Ask once with full context and the options you see, rather than many small questions. Returns the question id.

| argument | type | required | description |
|---|---|---|---|
| ticket_id | integer | no | Ticket id. Worker and tester grants are bound to one ticket and may omit it; a planner or operator must give it. |
| question | string | yes |  |

### report_test

Record the structured result of testing a ticket against its acceptance criteria. passed is the overall verdict; summary says which criteria passed or failed and why; evidence lists what proves it (test output, screenshot paths kept as run evidence, commands run). Call this before move_ticket. A failed report becomes the failure note the worker sees on retry.

| argument | type | required | description |
|---|---|---|---|
| ticket_id | integer | no | Ticket id. Worker and tester grants are bound to one ticket and may omit it; a planner or operator must give it. |
| passed | boolean | yes |  |
| summary | string | yes |  |
| evidence | string[] | default `[]` |  |

### report_cleanup

Record what a housekeeping ticket removed or updated: one item per file or module with the action and the reason (superseded by X, no importers, references removed code). Used by housekeeping tickets, and by an operator grant on any ticket; the list is shown to the operator and kept with the ticket. Returns the note id.

| argument | type | required | description |
|---|---|---|---|
| ticket_id | integer | no | Ticket id. Worker and tester grants are bound to one ticket and may omit it; a planner or operator must give it. |
| items | { path: string, action: deleted \| updated, reason: string }[] | yes |  |
