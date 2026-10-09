# Data

Living document. Update it in the same change that alters the schema.

## Where

- `<repo>/.kanban95/board.db`, one SQLite file per repo, WAL mode, foreign keys on. Created on first daemon start together with `.kanban95/.gitignore` (ignores `board.db`, `board.db-*`, `sessions/`, `attachments/`, `notepad.md`, `runner.json`; an older board's `.gitignore` gets the missing lines on the next start).
- `<repo>/.kanban95/sessions/<run-id>/` (a brainstorm, which has no run, uses `-<grant-id>`): per-run `prompt.md` and (Claude Code) `mcp.json` and, for a worker or tester, `settings.json`, owner-only for Claude Code (not for Codex, `docs/CLIS.md` → Reach by role), deleted when the run's pty exits. Not data to keep; the prompt is also in `runs.prompt_rendered`.
- `<repo>/.kanban95/attachments/<ticket-id>/<filename>`: files the operator attached to a ticket (pasted screenshots, dropped files), written by `POST /api/tickets/:id/attachments` (`daemon/src/attachments.ts`). Plain files, no table: the directory listing is the list. The `{{ticket}}` prompt variable and MCP `get_ticket` name each by absolute path so an agent opens it with its own file reader. Removed with the ticket.
- `<repo>/.worktrees/t-<id>/`: the ticket's git worktree on branch `ticket/<id>`, excluded through `.git/info/exclude`. Removed with the branch once the ticket merges (`docs/LIFECYCLE.md` → Janitor).
- `<repo>/.kanban95/notepad.md`: the operator's Notepad window, free text, at most 256 KB, read and written whole by `GET`/`PUT /api/notepad`. Git-ignored (the inner `.gitignore` lists it) and never given to an agent. Absent means empty.
- `<repo>/.kanban95/config.json`: optional, committed, no secrets. Read by the lifecycle: `operator: { model, effort }` (either or both; the operator terminal's model and effort, default the plan phase's). The daemon never writes it: a write would dirty a repo that commits it, and a dirty base refuses launches and merges.
- `<repo>/.kanban95/runner.json`: `{"on": true | false, "why"?: "nothing left to launch", "concurrency"?: 1-10}`, the Run toggle and how many tickets it keeps running (absent: 3; `docs/LIFECYCLE.md` → The runner). Written by the daemon on Run, Stop, Settings → General → Runner and when the runner stops itself; git-ignored. Absent means off.
- `~/.kanban95/` is the board's config directory, overridable as a whole by the `KANBAN95_HOME` environment variable (the only override; `daemon/src/settings.ts` `boardHome`). The entries below are written there and nowhere else. Under vitest the daemon refuses the real one and throws unless `KANBAN95_HOME` is set, which `daemon/test/home.ts` does for every test file.
- `~/.kanban95/models.json`: the operator's model catalog, read at each launch (`docs/LIFECYCLE.md` → Run settings): `cli` (the default CLI), and per CLI (`claude`, `codex`) an optional `models` list of allowed model ids plus the per-phase defaults `plan`/`execute`/`test`/`operator` as `{model, effort}`. When a CLI has a `models` list, a model id outside it is refused at launch and when set on a ticket. Written by Settings → Models → Save after a schema check. No secrets.
- `~/.kanban95/settings.json`: `paths` (`claude`, `codex`: an absolute path to the executable, empty for PATH), `sounds` (`merge`, `attention`: booleans, default true; an old single boolean applies to both), `voice` (`backend`: `local`; `mode`: `push` or `toggle`), `housekeeping` (`auto`: boolean, default true; `every`: a positive integer, default 10), `terminals` (`auto`: the phases among `plan`, `execute`, `test` whose sessions open a terminal on their own, default `["plan", "execute"]`), `zoom` (the UI zoom, a number from 0.8 to 2, default 1). Absent means all defaults. Written by Settings after a schema check. No secrets.
- `~/.kanban95/projects.json`: `[{ "path", "colour" }]`, every repo the operator runs a board on. `path` is the repo's absolute path in the file system's own spelling (resolved, real case), listed once; `colour` is the board's wallpaper colour, `#rgb`/`#rrggbb` or a hue number 0 to 360 (painted as `hsl(<hue> 100% 25%)`, the teal's saturation and lightness). The display name is the folder's basename and is not stored. A daemon adds the repo it serves on start, with `#008080` (the Win95 teal), unless it is listed. Written whole by Settings → Projects (`PUT /api/projects`): every path must be an existing git repo (it has a `.git`), and the board's own project cannot be dropped. Reading checks only the shape, so a repo deleted since does not break other boards; remove it in Settings → Projects. Absent means none yet. No secrets.
- `~/.kanban95/preferences.md`: the operator's standing instructions for every agent, free text, at most 16 KB. Injected into every prompt as `{{preferences}}` (`docs/AGENTS.md`). Absent means none. Written by Settings → Prompts → Save. Do not put secrets in it: it is copied into every session's prompt.md.
- `~/.kanban95/models/whisper-base.en/`: the speech model, downloaded on the operator's OK and hash-checked (`docs/SECURITY.md` → Voice model). Not data; delete it to free 80 MB, the mic will offer the download again.
- `localStorage` in the webview: window positions, sizes and maximized state, which Board columns are collapsed (`k95.collapsed`), and the Board's filter, sort and group (`k95.view`). Nothing else.
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
| cli | TEXT | nullable, harness name, `claude` or `codex`; REST stores any string, the launch refuses an unknown one |
| model | TEXT | nullable, null = phase default from `~/.kanban95/models.json` |
| effort | TEXT | nullable, `low` `medium` `high` `max`, null = phase default |
| retry | INTEGER | `>= 0`, default 0; failed tests so far, written by the lifecycle |
| template | TEXT | `execute` `housekeeping`, default `execute`: which template the ticket's execute runs use. Added in `003-lifecycle.sql` |
| merged_at | TEXT | null until the ticket's branch landed on the base. A dependency counts as done only once this is set. Added in `003-lifecycle.sql` |
| created_by_grant | INTEGER | nullable, FK `grants(id)` `ON DELETE SET NULL`: the grant whose `create_ticket` made the ticket; null for one the UI made. A worker may edit and delete only Backlog tickets whose `created_by_grant` is its own grant (`docs/SECURITY.md`). Added in `005-ticket-creator.sql` |
| tags | TEXT | default `''`: free-form grouping tags as distinct lowercase tokens matching `[a-z0-9-]+`, joined by one space. REST takes a string (split on commas and whitespace, lowercased) or an array; MCP takes an array; any other token is refused (400 / tool error) and nothing is written. Normalised by `normaliseTags` in `daemon/src/api.ts`. Added in `006-tags.sql` |
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

How the kinds are written over MCP: `add_note` takes `plan` `decision` `failure` `summary`; `ask_operator` writes `question` and sets `needs_human`; the operator's answer (`POST /api/tickets/:id/answer`) is `answer` with role `operator`; the lifecycle writes `failure` notes for an agent that exited without reporting or failed to launch (role of that session), for the retry cap (`stopped after 4 failed tests`, role `tester`), for a merge conflict (`merge conflict with <base>: <git output>`, role `tester`) and for a base still dirty after the merge queue's wait (role `tester`). Every note written with a `needs_human` flag, except a `question`, ends with a line starting `To resolve:` naming the operator's next step (`docs/LIFECYCLE.md` → Needs human); `GET /api/inbox` lists the unanswered `question` notes of flagged tickets and, when no newer question is open, the newest `failure`; `report_test` writes `summary` on pass and `failure` on fail, body `PASS|FAIL: <summary>` followed by one `- ` line per evidence item; `report_cleanup` writes `summary` with one `- <action> \`<path>\`: <reason>` line per item. `role` is always the grant's role. Prompts include only `failure` notes created at or after the `started_at` of the ticket's latest `execute` run (`context.failureNotes`), so each retry sees the failures of the attempt before it and nothing older.

### brain, brain_fts
`brain(id, title, body, tags, ticket_id nullable FK set-null, created_at)`. `brain_add` over MCP sets `ticket_id` to the grant's ticket (null for a planner or operator). `brain_fts` is an FTS5 external-content index over `title, body, tags` kept in sync by triggers `brain_ai`, `brain_au`, `brain_ad`. Query it with `brain_fts MATCH ?` and join `brain` on `rowid = id`; the board ranks with `bm25(brain_fts, 10.0, 1.0, 5.0)` (`BRAIN_RANK` in `daemon/src/db.ts`) so title and tags outweigh the body. Rows are edited and deleted in place (`brain_update`, `brain_delete`, REST `PATCH`/`DELETE /api/brain/<id>`), with no history: the audit log records who did it. A body over 1500 characters is refused on write (not a schema constraint; older rows may be longer).

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
| ticket_id | INTEGER FK | null for `planner`/`operator`, required for `worker`/`tester` (CHECK), cascade delete |
| role | TEXT | `planner` `worker` `tester` `operator`. `operator` added in `004-operator-grants.sql` (a rebuild of the table that keeps `audit.grant_id`) |
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
| tool | TEXT | REST: `tickets.create` `tickets.update` `tickets.delete` `grants.revoke` `tickets.launch` `tickets.answer` `tickets.merge` `tickets.resume` `tickets.housekeeping` `brainstorm.launch` `operator.launch` `runner.set` `brain.add` `brain.update` `brain.delete` `attachments.add` `attachments.remove` `config.write` `trust.clear` `voice.download`. MCP: the tool name (`create_ticket`, `move_ticket`, ..., see `docs/MCP.md`). Board: `trust.write` (a key written into an agent CLI's config, `docs/SECURITY.md`) and `janitor.worktree` `janitor.session` `janitor.grant` `janitor.run` `janitor.scrollback` (`docs/LIFECYCLE.md`), all with a null grant. |
| args_summary | TEXT | JSON of the request, truncated to 200 characters. Callers must never put a token in it. |
| outcome | TEXT | `ok` `denied` `error` |
| created_at | TEXT | |

### schema_migrations
`(version TEXT PK, applied_at TEXT)`, one row per applied migration file.
