# Data

Living document. Update it in the same change that alters the schema.

## Where

- `<repo>/.kanban95/board.db`, one SQLite file per repo, WAL mode, foreign keys on. Created on first daemon start together with `.kanban95/.gitignore` (ignores `board.db`, `board.db-*`, `sessions/`).
- Nothing in the database leaves the machine. There is no sync, no telemetry, no export yet (export is explicit when it arrives).
- The daemon is the only writer. The UI goes through REST, agents go through MCP (phase 2).

## Migrations

`daemon/migrations/NNN-name.sql`, applied in filename order by `openDb` at every start. Each file runs in its own transaction and is recorded in `schema_migrations(version, applied_at)`; a second start applies nothing. A failing file is rolled back and the daemon refuses to start, so the database is always at a whole version. Never edit an applied migration; add the next number.

## Conventions

- Timestamps are ISO 8601 UTC text with milliseconds (`2026-10-07T19:41:00.123Z`), set by SQLite defaults. They compare correctly as strings.
- Enumerations are `CHECK` constraints, so an invalid value is refused by the database no matter which code path wrote it.
- Booleans are `INTEGER` 0/1 with a `CHECK`.

## Tables (migration 001)

### tickets
| column | type | notes |
|---|---|---|
| id | INTEGER PK | |
| title | TEXT | non-empty |
| body | TEXT | markdown, default `''` |
| criteria | TEXT | acceptance criteria, default `''` |
| status | TEXT | `backlog` `in_progress` `testing` `done`, default `backlog` |
| needs_human | INTEGER | 0/1 flag |
| blocked_on_deps | INTEGER | 0/1 flag |
| cli | TEXT | nullable, harness name as known to the launcher (phase 4 validates it against config) |
| model | TEXT | nullable, null = phase default from `~/.kanban95/models.json` |
| effort | TEXT | nullable, `low` `medium` `high` `max`, null = phase default |
| retry | INTEGER | `>= 0`, default 0 |
| created_at, updated_at | TEXT | `updated_at` is bumped by trigger `tickets_touch` |

The REST API presents the two flags as `flags: { needs_human, blocked_on_deps }` and the dependencies as `depends_on: number[]`.

### ticket_deps
`(ticket_id, depends_on_id)`, both FK to `tickets`. Deleting a ticket removes its own dependency rows; deleting a ticket that others depend on is refused (`ON DELETE RESTRICT`). A ticket cannot depend on itself. This is the `depends_on` array of the plan, kept relational so a dangling dependency cannot exist.

### notes
| column | type | notes |
|---|---|---|
| id | INTEGER PK | |
| ticket_id | INTEGER FK | cascade delete |
| role | TEXT | `planner` `worker` `tester` `operator` |
| kind | TEXT | `plan` `decision` `failure` `summary` `question` `answer` |
| body | TEXT | |
| created_at | TEXT | |

### brain, brain_fts
`brain(id, title, body, tags, ticket_id nullable FK set-null, created_at)`. `brain_fts` is an FTS5 external-content index over `title, body, tags` kept in sync by triggers `brain_ai`, `brain_au`, `brain_ad`. Query it with `brain_fts MATCH ? ORDER BY rank` and join `brain` on `rowid = id`.

### runs
| column | type | notes |
|---|---|---|
| id | INTEGER PK | |
| ticket_id | INTEGER FK | cascade delete |
| phase | TEXT | `plan` `execute` `test` |
| cli, model, effort | TEXT | what was actually launched; effort is one of the four values |
| prompt_rendered | TEXT | the exact prompt injected, for the context viewer |
| started_at, ended_at | TEXT | `ended_at` null while running |
| outcome | TEXT | null while running; values are set by the lifecycle (phase 5) |

### grants
| column | type | notes |
|---|---|---|
| id | INTEGER PK | |
| token_hash | TEXT UNIQUE | SHA-256 hex of the bearer token. The token itself is never stored. |
| ticket_id | INTEGER FK | null for `planner`, required for `worker`/`tester` (CHECK), cascade delete |
| role | TEXT | `planner` `worker` `tester` |
| expires_at | TEXT | |
| revoked_at | TEXT | null while live |
| created_at | TEXT | |

A grant is live when `revoked_at IS NULL AND expires_at > now`. Rows are kept after expiry or revocation for the audit trail.

### audit
| column | type | notes |
|---|---|---|
| id | INTEGER PK | |
| grant_id | INTEGER FK | null for operator actions over REST; set-null on grant delete |
| ticket_id | INTEGER FK | null when the action was not about one ticket, or the ticket no longer exists; set-null on delete |
| tool | TEXT | REST: `tickets.create` `tickets.update` `tickets.delete` `grants.revoke`. MCP tool names from phase 2. |
| args_summary | TEXT | JSON of the request, truncated to 200 characters. Callers must never put a token in it. |
| outcome | TEXT | `ok` `denied` `error` |
| created_at | TEXT | |

### schema_migrations
`(version TEXT PK, applied_at TEXT)`, one row per applied migration file.
