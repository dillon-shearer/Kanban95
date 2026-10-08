# Data

Living document. Update it in the same change that alters the schema.

## Where

- `<repo>/.kanban95/board.db`, one SQLite file per repo, WAL mode, foreign keys on. Created on first daemon start together with `.kanban95/.gitignore` (ignores `board.db`, `board.db-*`, `sessions/`, `attachments/`; an older board's `.gitignore` gets the `attachments/` line on the next start).
- `<repo>/.kanban95/sessions/<run-id>/`: per-run `prompt.md` and (Claude Code) `mcp.json`, owner-only, deleted when the run's pty exits. Not data to keep; the prompt is also in `runs.prompt_rendered`.
- `<repo>/.kanban95/attachments/<ticket-id>/<filename>`: files the operator attached to a ticket (pasted screenshots, dropped files), written by `POST /api/tickets/:id/attachments` (`daemon/src/attachments.ts`). Plain files, no table: the directory listing is the list. The `{{ticket}}` prompt variable and MCP `get_ticket` name each by absolute path so an agent opens it with its own file reader. Removed with the ticket.
- `<repo>/.worktrees/t-<id>/`: the ticket's git worktree on branch `ticket/<id>`, excluded through `.git/info/exclude`. Removed with the branch once the ticket merges (`docs/LIFECYCLE.md` → Janitor).
- `<repo>/.kanban95/config.json`: optional, committed, no secrets. Read by the lifecycle: `housekeeping_every` (default 10). The daemon never writes it.
- `~/.kanban95/models.json`: the operator's model catalog, read at each launch (`docs/LIFECYCLE.md` → Run settings). Written by Settings → Models → Save after a schema check. No secrets.
- `~/.kanban95/settings.json`: `paths` (`claude`, `codex`: an absolute path to the executable, empty for PATH), `sounds` (boolean, default true), `voice` (`backend`: `local`; `mode`: `push` or `toggle`). Absent means all defaults. Written by Settings after a schema check. No secrets.
- `~/.kanban95/models/whisper-base.en/`: the speech model, downloaded on the operator's OK and hash-checked (`docs/SECURITY.md` → Voice model). Not data; delete it to free 80 MB, the mic will offer the download again.
- `localStorage` in the webview: window positions and sizes only.
- Nothing in the database leaves the machine. There is no sync, no telemetry, no export yet (export is explicit when it arrives).
- The daemon is the only writer. The UI goes through REST, agents go through MCP (`docs/MCP.md`).

## Migrations

`daemon/migrations/NNN-name.sql`, applied in filename order by `openDb` at every start. Each file runs in its own transaction and is recorded in `schema_migrations(version, applied_at)`; a second start applies nothing. A failing file is rolled back and the daemon refuses to start, so the database is always at a whole version. Never edit an applied migration; add the next number.

## Conventions

- Timestamps are ISO 8601 UTC text with milliseconds (`2026-10-07T19:41:00.123Z`), set by SQLite defaults. They compare correctly as strings.
- Enumerations are `CHECK` constraints, so an invalid value is refused by the database no matter which code path wrote it.
- Booleans are `INTEGER` 0/1 with a `CHECK`.

## Tables (migration 001, plus the columns later migrations add)

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
| retry | INTEGER | `>= 0`, default 0; failed tests so far, written by the lifecycle |
| template | TEXT | `execute` `housekeeping`, default `execute`: which template the ticket's execute runs use. Added in `003-lifecycle.sql` |
| merged_at | TEXT | null until the ticket's branch landed on the base. A dependency counts as done only once this is set. Added in `003-lifecycle.sql` |
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

How the kinds are written over MCP: `add_note` takes `plan` `decision` `failure` `summary`; `ask_operator` writes `question` and sets `needs_human`; the operator's answer (`POST /api/tickets/:id/answer`) is `answer` with role `operator`; the lifecycle writes `failure` notes for an agent that exited without reporting or failed to launch (role of that session) and for a failed merge (role `tester`); `report_test` writes `summary` on pass and `failure` on fail, body `PASS|FAIL: <summary>` followed by one `- ` line per evidence item; `report_cleanup` writes `summary` with one `- <action> \`<path>\`: <reason>` line per item. `role` is always the grant's role. Prompts include only `failure` notes created at or after the `started_at` of the ticket's latest `execute` run (`context.failureNotes`), so each retry sees the failures of the attempt before it and nothing older.

### brain, brain_fts
`brain(id, title, body, tags, ticket_id nullable FK set-null, created_at)`. `brain_add` over MCP sets `ticket_id` to the grant's ticket (null for a planner). `brain_fts` is an FTS5 external-content index over `title, body, tags` kept in sync by triggers `brain_ai`, `brain_au`, `brain_ad`. Query it with `brain_fts MATCH ? ORDER BY rank` and join `brain` on `rowid = id`.

### runs
| column | type | notes |
|---|---|---|
| id | INTEGER PK | |
| ticket_id | INTEGER FK | cascade delete |
| phase | TEXT | `plan` `execute` `test` |
| cli, model, effort | TEXT | what was actually launched; effort is one of the four values |
| prompt_rendered | TEXT | the exact prompt injected, written by `context.startRun` before the CLI is spawned; for the context viewer |
| started_at, ended_at | TEXT | `ended_at` null while running |
| outcome | TEXT | null while running. Set by the lifecycle when the terminal closes: `submit`, `pass`, `fail` (the agent's move was accepted and the board ended the session), `exit` (closed without reporting), or `lost` (set by the janitor for a run that has no end and no live session, after a daemon crash) |
| scrollback | TEXT | last 2000 lines of the agent's raw terminal output (ANSI included), written by the launcher when the pty exits; null while running or if the launch failed before spawning, and set back to null by the janitor 30 days after the run ended. Added in `002-run-scrollback.sql` |

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
| tool | TEXT | REST: `tickets.create` `tickets.update` `tickets.delete` `grants.revoke` `tickets.launch` `tickets.launch_all` `tickets.answer` `tickets.merge` `tickets.housekeeping` `brainstorm.launch` `brain.add` `config.write` `trust.clear` `voice.download`. MCP: the tool name (`create_ticket`, `move_ticket`, ..., see `docs/MCP.md`). Board: `trust.write` (a key written into an agent CLI's config, `docs/SECURITY.md`) and `janitor.worktree` `janitor.session` `janitor.grant` `janitor.run` `janitor.scrollback` (`docs/LIFECYCLE.md`), all with a null grant. |
| args_summary | TEXT | JSON of the request, truncated to 200 characters. Callers must never put a token in it. |
| outcome | TEXT | `ok` `denied` `error` |
| created_at | TEXT | |

### schema_migrations
`(version TEXT PK, applied_at TEXT)`, one row per applied migration file.
