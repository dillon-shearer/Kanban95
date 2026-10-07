# Phase 2 — MCP server

Read `CLAUDE.md`, `PLAN.md`, `docs/handoffs/log/*`.

## Goal
Agents talk to the board only through MCP. Every tool is role-scoped to a grant from phase 1 and audited.

## Deliverables
- `daemon/src/mcp.ts` using `@modelcontextprotocol/sdk`, Streamable HTTP transport mounted at `/mcp` on the daemon. Bearer token required; it resolves to a grant via `grants.verify`. No grant → 401 before any tool runs.
- Tools (each with a one-paragraph description an agent can act on without other docs):
  `create_ticket`, `update_ticket`, `set_model`, `move_ticket`, `add_note`, `get_ticket`, `list_tickets`, `brain_add`, `brain_search`, `ask_operator`, `report_test`, `report_cleanup` (structured list of files deleted or updated and why; worker only, used by housekeeping tickets).
- Role matrix, enforced server-side, documented in `docs/MCP.md`:

| tool | planner | worker | tester |
|------|---------|--------|--------|
| create_ticket | yes | no | no |
| update_ticket | any ticket | own, body/criteria only | no |
| set_model | any | own | own (for the retry) |
| move_ticket | no | own → testing | own → done / in_progress |
| add_note | any | own | own |
| get_ticket / list_tickets | yes | own + its deps | own |
| brain_add / brain_search | yes | yes | yes |
| ask_operator | yes | own | own |
| report_test | no | no | own |
| report_cleanup | no | own | no |

- `set_model` takes `model` and/or `effort` (`low|medium|high|max`); either may be omitted. The tool description must tell the agent to lower effort for trivial work and raise it for hard work, not only escalate.
- `ask_operator` creates a `question` note, sets `needs_human`, and returns a question id. The resume path is wired in phase 5.
- `docs/MCP.md`: tool reference generated from the tool definitions by a small script, so it cannot drift.
- Log entry `docs/handoffs/log/02-mcp.md`.

## Out of scope
Spawning anything. Prompt templates. The operator answering (phases 5 and 6).

## Acceptance criteria
1. A worker token for ticket 3 cannot read, move, or note ticket 4.
2. A planner token cannot move any ticket.
3. A tester cannot move a ticket to `backlog`.
4. Every tool call, allowed or refused, writes one audit row with the grant id.
5. `docs/MCP.md` regenerates byte-identical from the tool definitions.

## Required tests
- Each "no" cell in the matrix is a test that asserts refusal and an audit row with outcome `denied`.
- Missing or malformed bearer → 401, no audit row (there is no grant to attribute).
- `move_ticket` to a transition the role may not make is refused with a message naming the allowed targets.
- `brain_search` returns ranked FTS results and never exceeds the requested limit.
