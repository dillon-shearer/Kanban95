# 02 — MCP server (done 2026-10-07)

## What was built

- `daemon/src/mcp.ts`: `handleMcp(db, req, res)` mounted at `/mcp` in `server.ts`, after the origin guard. Parses `Authorization: Bearer <token>`, resolves it with `grants.verify`; anything short of a live grant gets `401` (JSON-RPC error body, `WWW-Authenticate: Bearer`) with no audit row. A live grant gets a fresh, stateless `McpServer` (`@modelcontextprotocol/sdk` 1.32.1, `StreamableHTTPServerTransport` with `sessionIdGenerator: undefined`, `enableJsonResponse: true`, 1 MiB body cap) whose tools close over the grant. The server and transport are closed when the response closes.
- `TOOLS`: one table with the twelve tools. Each entry has `description`, `access` (a role present may call; the text is the matrix cell), a zod `input` shape and `run`. `registerTools` wraps every handler: role check → run → exactly one audit row (`ok` / `denied` / `error`) with the grant id and the ticket the call was about. Refusals throw `Deny`; everything else thrown is `error`. Results are JSON text; refusals are tool errors (`isError: true`) whose text says why.
- Scope rules: `own(call, ticket_id)` gives worker/tester their grant ticket and denies a foreign id with "this grant is scoped to ticket N" (does not reveal whether N exists); a planner must pass `ticket_id`. `get_ticket`/`list_tickets` extend a worker to its dependencies. `update_ticket` restricts a worker to `WORKER_FIELDS` (`body`, `criteria`). `move_ticket` uses `MOVE_TARGETS` (worker → testing; tester → done, in_progress) and names the allowed targets in the refusal.
- `ask_operator` writes a `question` note under the grant role and sets `needs_human = 1` in one transaction; returns `{ question_id }` (the note id). `report_test` writes `summary` (pass) or `failure` (fail) with `PASS|FAIL: <summary>` and one `- ` line per evidence item. `report_cleanup` writes a `summary` note with one line per item. `brain_add` stamps the grant's ticket.
- `daemon/src/mcp-doc.ts`: `renderMcpDoc()` builds `docs/MCP.md` from `TOOLS` (connection notes, role matrix, per-tool argument table via `z.toJSONSchema(..., { io: 'input' })`). `npm run docs:mcp` writes it; `mcp.test.ts` asserts the file is byte-identical to the render.
- `api.ts` now exports `readTicket` (typed `Ticket`), `setDeps`, `transaction` and a new `brainSearch` that REST and MCP share.
- Tests: `daemon/test/mcp.test.ts`, 22 tests through the SDK `Client` + `StreamableHTTPClientTransport`: 401 matrix (missing, malformed, unknown, expired, revoked; audit count unchanged), every "no" cell of the role matrix denied and audited, worker on 3 vs ticket 4 (six tools, audited against ticket 4, no note written), worker visibility of deps, worker field restriction, planner missing/unknown ticket → `error`, move refusals naming targets, allowed moves, create with deps and FK failure, `set_model` either/neither, `ask_operator` note + flag, `report_test` bodies, `report_cleanup`, brain ranking / limit / schema cap / hostile FTS syntax, doc drift. Whole suite: 51 tests, about 1 s.
- Docs: `docs/MCP.md` (generated), `docs/ARCHITECTURE.md` (MCP section, repo map), `docs/SECURITY.md` (MCP section, threats), `docs/DATA.md` (how MCP writes notes, audit tool names), `README.md`.

## Deviations from the handoff

- **Stateless transport, one `McpServer` per request** instead of one long-lived server with per-session auth. The grant is simply closed over, so there is no `authInfo` plumbing and no session table to clean up. Ceiling: no server-initiated notifications (GET stream) and the twelve `registerTool` calls repeat per request, which is microseconds. Marked `// ponytail:` in `handleMcp`.
- **Refusals are tool errors, not JSON-RPC errors.** An agent reads tool error text; a protocol error would surface as a transport failure in some clients.
- **`ticket_id` is optional for worker/tester.** The handoff matrix says "own"; the simplest faithful encoding is that the grant supplies the ticket and a passed id must match. A planner must pass it.
- **Argument-schema failures are not audited.** The SDK validates `inputSchema` before calling the handler, so a malformed call (for example `brain_search` with `limit: 99`) is answered by the SDK and never reaches the wrapper. Documented in `SECURITY.md`. Auditing those would mean replacing the SDK's validation; not worth it today.
- **`report_test` does not move the ticket.** The tester calls `move_ticket` separately; the lifecycle (phase 5) decides what a failure note triggers.
- **No `limit > 20` for `brain_search`.** The schema caps it, so "never exceeds the requested limit" is enforced by zod, not by a clamp.

## Commands

```
npm test            # tsc && vitest run, 51 tests
npm run docs:mcp    # rebuild and regenerate docs/MCP.md
```

## Gotchas for the next phase

- The MCP URL handed to a CLI must be `http://127.0.0.1:<port>/mcp` with a `Bearer` header (`Authorization: Bearer <token>`). `localhost` fails the origin guard with 403 before MCP sees it. Claude Code: `--mcp-config` with a `"type": "http"` server and `"headers": { "Authorization": "Bearer ..." }`; verify against `claude --help` / `claude mcp add --help` when building the argv (phase 4), do not trust this note.
- `TOOLS` is the only place to add or change a tool. Change the `access` text and `description` there, then `npm run docs:mcp`, or the doc test fails. `MOVE_TARGETS` and `WORKER_FIELDS` feed both enforcement and the matrix text.
- The tool wrapper computes the audit `ticket_id` as `args.ticket_id ?? grant.ticket_id`, then nulls it if that ticket does not exist (FK). A handler that creates a ticket sets `c.ticket` itself.
- `Deny` is module-private; a handler signals a refusal by throwing it. Any other throw (including SQLite constraint errors, whose message mentions `FOREIGN KEY` or `CHECK`) is audited as `error` and its message is returned verbatim to the agent.
- `enableJsonResponse: true` means a tool result comes back as one `application/json` body. If a future tool needs progress notifications, switch that flag off for that server; the SDK client handles both.
- The SDK pulls in express, hono, ajv and friends as transitive dependencies. Nothing in the daemon imports them; `node:http` remains the only server.
- Tests connect four SDK clients in `beforeAll` and close them in `afterAll`; an unclosed client keeps vitest alive.
