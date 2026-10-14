# MCP tool reference

Generated from `daemon/src/mcp.ts` by `npm run docs:mcp`. Do not edit by hand; the test suite fails if this file drifts from the code.

## Connecting

Endpoint: `POST http://127.0.0.1:<port>/mcp`, Streamable HTTP, stateless (no session id, JSON responses). The host must be `127.0.0.1`, never `localhost`.
Every request carries `Authorization: Bearer <token>` where the token is the grant minted for this agent session. A missing, malformed, unknown, expired or revoked token
gets `401` before any tool runs and leaves no audit row. A live token resolves to a grant `{ role, ticket }` that scopes every tool below.
Each tool call rechecks the grant when it runs: one revoked or expired after the headers arrived returns a tool error and does nothing.

Every tool call, allowed or not, writes one `audit` row with the grant id, tool name, a 200-character argument summary and `ok | denied | error`.
A refused call returns a tool error whose text says why and, for `move_ticket`, which targets the role may use. Results are JSON text.

## Role matrix

| tool | planner | worker | tester | operator |
|------|---|---|---|---|
| create_ticket | yes | yes, Backlog follow-up, no model/effort | no | yes |
| bootstrap_board | once per board | no | no | once per board |
| file_on_board | yes | yes; own board as create_ticket | other boards only | yes |
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
| request_permission | no | own | own | no |
| report_test | no | no | own | no |
| report_cleanup | no | own | no | any |

"own" means the ticket the grant was minted for; a worker or tester may omit `ticket_id` and may not name another ticket. A planner or operator grant has no ticket and must pass `ticket_id`.
The operator role is an operator terminal: an agent the operator starts from the UI with a typed mission, holding the operator's own reach on the board. It never gets `report_test`; only a tester proves a ticket.

### Levels

A worker or tester grant reaches further when the operator raises its ticket's `agent_level` (0 to 4, in the Ticket window). The level holds for every run of that ticket, retries and testers alike, and is read on every call. Each level holds the ones below it:

- 0: the role's cells above.
- 1: `move_ticket` any ticket to backlog (a reset) or in_progress (a launch, or a failed test from testing), with the operator's lifecycle guards.
- 2: also `move_ticket` any running ticket to done without a tester pass; its sessions end and no merge is queued (docs/LIFECYCLE.md → Agent moves under a level).
- 3: also the operator's cell for `update_ticket`, `delete_ticket`, `set_model`, `add_note`.
- 4: the operator's cell for every tool, `move_ticket` to testing included. A worker still never gets `report_test`; `ask_operator`, and a tester's `report_test`, stay on its own ticket.

`read_all` on the ticket, or `workers_read: "all"` in settings.json, lets its worker and tester `get_ticket` and `list_tickets` every ticket. A refusal that a higher level would lift ends with "ask for level N with request_permission". Only the operator sets a level or `read_all` (docs/SECURITY.md → MCP).

## Tools

### create_ticket

Create a ticket in the backlog. Give it a title, a body that says what to build and why, and acceptance criteria a tester can check one by one (a test passes once, never "N runs in a row"). List depends_on ids when this work must wait for other tickets. Tags (lowercase a-z, 0-9, -) group related tickets on the board. Set model and effort only when the work clearly warrants it: trivial work gets effort low, hard work gets high. A worker files a follow-up or a manual touch it found this way instead of widening its own scope: it lands in Backlog, its body starts with "Filed by #<your ticket>", it runs on the operator's default model and effort, and the worker may fix or delete it while it is still in Backlog. Returns the ticket.

| argument | type | required | description |
|---|---|---|---|
| title | string | yes | Short imperative title. |
| body | string | default `""` | What to build and why, markdown. |
| criteria | string | default `""` | Acceptance criteria, one checkable statement per line. |
| depends_on | integer[] | default `[]` | Ticket ids that must be done before this one starts. |
| tags | string[] | no | Grouping tags, each lowercase a-z, 0-9 and - only, e.g. ["ui", "daemon"]. |
| model | string | no | Model override; omit for the phase default. |
| effort | low \| medium \| high \| max | no | Effort override; omit for the phase default. |

### bootstrap_board

Create the starter ticket set for a new board from .kanban95/templates/bootstrap.md: one Backlog ticket per section, in order, each depending on the one before, tagged setup. Call it when you create a board or are told to set one up. Refused once the board has a ticket tagged setup, so it runs once. Returns the tickets.

No arguments.

### file_on_board

File a ticket on another Kanban95 board running on this machine, for a bug or gap in that project you hit and cannot fix here. project is the folder name or absolute path as listed in projects.json. The ticket lands in the Backlog of that board with no model or effort, its body starting "Filed from <this repo folder> #<your ticket>". A board that is not running is never started: the call fails and names the running boards, so note it on your ticket instead. Filing on your own board is create_ticket with the limits of your role. Returns the board name and the new ticket.

| argument | type | required | description |
|---|---|---|---|
| project | string | yes | Folder name or absolute path of the target project, as in projects.json. |
| title | string | yes | Short imperative title. |
| body | string | default `""` | What is wrong or missing and how you hit it, markdown. |
| criteria | string | default `""` | Acceptance criteria, one checkable statement per line. |
| tags | string[] | no | Grouping tags, each lowercase a-z, 0-9 and - only. |

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

Save one fact a future agent would trip on to the brain: a gotcha, a non-obvious decision, or how an external tool behaves (with version and date). Gate: write a row only if it passes all three questions; a row failing any one is not written. 1 Quality: would a future agent trip without it, and can a reader with no context act on it (what, why, what to do, where)? Not a plan, not ticket status, not what the code, docs or templates say. 2 Scope: holds in every repo (a tool, CLI, OS or model behaviour, with version and date) → global; only this codebase → project; unsure → project. 3 Worth: would anyone search for it, or is it a one-off that bloats the brain? brain_search the subject first; if a row already covers it, correct that row with brain_update instead of adding a near-duplicate. Title: a sentence naming the trap ("X does Y; do Z"). Body: what happens, why, what to do instead, and the file or function, for a reader with no context. Tags: words the title of a future ticket would contain. Never write ticket status or plans ("pending", "until #N merges"): they go stale; unbuilt work belongs in a ticket. Skip what the code, docs or templates already say. Returns the brain row id and scope.

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

### request_permission

Ask the operator to raise your ticket's agent level or turn on read all, when a call was refused with "ask for level N with request_permission". Give level (above the ticket's current one), read_all: true, or both, and a reason saying which call needs it and why. The ticket is flagged needs_human and the operator sees Approve and Deny in the Inbox; the answer is typed into your session as one line. On "approved", retry the refused call: the new level applies from the next call. Refused when the ticket already has what you ask for, or while an earlier request is unanswered. Returns the question id.

| argument | type | required | description |
|---|---|---|---|
| level | integer | no | Agent level to ask for, 1 to 4 (docs/MCP.md → Levels). |
| read_all | boolean | no | true to ask to read every ticket on the board. |
| reason | string | yes | Which refused call needs this and why. |

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
