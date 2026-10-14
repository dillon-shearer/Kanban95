# Data

Living document. Update it in the same change that alters the schema.

## Where

- `<repo>/.kanban95/board.db`, one SQLite file per repo, WAL mode, foreign keys on. Created on first daemon start together with `.kanban95/.gitignore` (ignores `board.db`, `board.db-*`, `sessions/`, `attachments/`, `memory.log`, `notepad.md`, `runner.json`, `ui.json`, `templates/*.replaced.md`; an older board's `.gitignore` gets the missing lines on the next start).
- `board.db` travels with the repo folder; it is not in the data folder (`~/.kanban95`), so deleting or moving the repo folder deletes or moves the board's tickets, notes and brain.
- `<repo>/.kanban95/sessions/<run-id>/` (a brainstorm, which has no run, uses `-<grant-id>`): per-run `prompt.md` and (Claude Code) `mcp.json` and, for a worker or tester, `settings.json`, owner-only for Claude Code (not for Codex, `docs/CLIS.md` → Reach by role), deleted when the run's pty exits. Not data to keep; the prompt is also in `runs.prompt_rendered`.
- `<repo>/.kanban95/attachments/<ticket-id>/<filename>`: files the operator attached to a ticket (pasted screenshots, dropped files), written by `POST /api/tickets/:id/attachments` (`daemon/src/attachments.ts`). Plain files, no table: the directory listing is the list, minus the macOS metadata files `._*` and `.DS_Store` that an exFAT volume gets. The `{{ticket}}` prompt variable and MCP `get_ticket` name each by absolute path so an agent opens it with its own file reader. Removed with the ticket.
- `<repo>/.kanban95/memory.log`: the daemon's memory log (`daemon/src/memlog.ts`), plain text, one line per entry, each starting with an ISO UTC timestamp. Every 30 s a `mem` line: `free=` (available physical memory, as Task Manager's Available), `total=`, `commit=used/limit` (commit charge, from `Win32_OperatingSystem`), `daemon=` (the daemon's own resident memory), `procs=` (how many processes the machine runs), then one `t<ticket>=<MB>/<processes>` per live session (`s<key>` for a brainstorm or operator terminal) summing the working set of the session's whole process tree (cmd.exe, the CLI, node, Edge, conhost, found by parent pid from the pty's pid in one `Get-CimInstance Win32_Process` listing), then `top=` the three process names with the most working set machine-wide. A failed listing writes `snapshot-error="..."` with free and total still in. Tagged lines in between: `launch t<id> <phase>`, `kill t<id> <phase>` (every session the board ends), `merge-start t<id>`, `merge-end t<id> ok|conflict|dirty|skipped`. Git-ignored; lines older than 24 h are dropped on start and once an hour. No settings.
- `<repo>/.kanban95/notepad.md`: the operator's Notepad window, free text, at most 256 KB, read and written whole by `GET`/`PUT /api/notepad`. Git-ignored (the inner `.gitignore` lists it) and never given to an agent. Absent means empty.
- `<repo>/.kanban95/ui.json`: the UI's state, one JSON object of at most 64 KB, read and written whole by `GET`/`PUT /api/ui` through `ui/state.js`. Git-ignored and never given to an agent. Absent or unreadable means defaults. The UI keeps nothing in browser storage (`localStorage` and the like are per origin, and the daemon's port, so its origin, changes every start). Keys:
  - `k95.collapsed` (the folded Board columns' statuses)
  - `k95.layout` (the startup layout, `[{id, x, y, w, h, max?, dw, dh}]` bottom-most first)
  - `k95.view` (the Board's `{filter, sort: {backlog, in_progress, testing, done}}`; an old single `sort` string applies to every column, an old `group` is ignored)
  - `k95.win.<key>` (a window's `{x, y, w, h, max?, dw, dh}` under its window id, `dw`×`dh` being the desktop in screen px it was saved on, so it scales to another screen; terminals take slots and save nothing)
- `<repo>/.kanban95/templates/`: the repo's prompt templates (`<name>.md`, committed, operator-editable) and `.shipped.json`, `{"<name>": "<sha256 hex>"}`, the hash of the shipped default each copy was last copied or reset from. The daemon writes both: a missing copy on start, an unedited copy (its hash equals the record) when the default changed, a copy with no entry that differs from the default, and on Reset. A copy with an entry it no longer matches is edited and never overwritten. `<name>.replaced.md` (git-ignored) holds the old text of a copy replaced for having no entry, until the next start deletes it. Absent or unreadable `.shipped.json` means no entries.
- `<repo>/.kanban95/config.json`: optional, committed, no secrets. The daemon never writes it: a write would dirty a repo that commits it, and a dirty base refuses launches and merges. Read by the lifecycle. Keys:
  - `operator: { model, effort }` (either or both; the operator terminal's model and effort; each one left out comes from the `operator` phase in `models.json`, and with no model there the CLI runs its own default).
  - `worktree_setup` (a shell command run once in each new ticket worktree before its first agent, `npm ci` in this repo; `docs/LIFECYCLE.md` → Worktree setup).
- `<repo>/.kanban95/runner.json`: `{"on": true | false, "why"?: "nothing left to launch"}`, the Run toggle (`docs/LIFECYCLE.md` → The runner). A `concurrency` key from an older board is ignored: it is `settings.json` `concurrency` now. Written by the daemon on Run, Stop and when the runner stops itself; git-ignored. Absent means off.
- `~/.kanban95/` is this machine's local board directory, overridable as a whole by the `KANBAN95_HOME` environment variable (the only override; `localHome` in `daemon/src/settings.ts`). `~` is `os.homedir()` (`HOME`, `USERPROFILE` on Windows), or the OS account's home (`os.userInfo().homedir`, getpwuid on POSIX) when that is unset, empty or not an absolute path. It holds the data folder pointer and the worktrees, and is the data folder when there is no pointer. Under vitest the daemon refuses the real one and throws unless `KANBAN95_HOME` is set, which `daemon/test/home.ts` does for every test file.
- `~/.kanban95/home`: the data folder pointer. One line, the absolute path of the data folder (an SSD carried between machines, say). Written by first-run setup, by the missing-folder page when the operator picks another folder, or by Settings → Board → Data folder (`PUT /api/data-folder`, which accepts only an existing folder), before anything else is created there (`setBoardHome`), never otherwise. Only `setBoardHome` creates the folder it names: when that folder is missing at start the daemon serves the not-found page instead of a board, and every write to the data folder goes through `dataHome`, which refuses a missing pointer folder; absent (or not an absolute path) means the data folder is `~/.kanban95` itself. Every read of the data folder goes through `boardHome` in `daemon/src/settings.ts`, which reads it on every call. No secrets.
- The data folder holds every entry below that is written as `~/.kanban95/...`, except `worktrees/` (and the pointer itself): settings, models, preferences, projects, project copies, the running registry, the global brain and the voice model. Read `~/.kanban95/` in those entries as "the data folder".
- `~/.kanban95/models.json`: the operator's model catalog, read at each launch (`docs/LIFECYCLE.md` → Run settings). When a CLI has a `models` list, a model id outside it is refused at launch and when set on a ticket. Written by Settings → Agents → Models → Save after a schema check. No secrets. Keys:
  - `cli` (the default CLI)
  - `claude`, `codex`: one object per CLI, with these keys:
    - `execute`: the execute phase's default, as `{model, effort}`
    - `models`: an optional list of allowed model ids
    - `operator`: the operator phase's default, as `{model, effort}`
    - `plan`: the plan phase's default, as `{model, effort}`
    - `test`: the test phase's default, as `{model, effort}`
- `~/.kanban95/settings.json`: absent means all defaults. Written by Settings after a schema check. No secrets. Keys:
  - `concurrency` (an integer 1 to 10, default 3: how many tickets the runner keeps running, `docs/LIFECYCLE.md` → The runner)
  - `housekeeping` (`auto`: boolean, default true; `every`: a positive integer, default 10)
  - `idle_minutes` (a positive integer, default 20: how long a running agent's transcript may gain no line before its ticket is flagged, `docs/LIFECYCLE.md` → Silent agents)
  - `paths` (`claude`, `codex`: an absolute path to the executable, empty for PATH)
  - `push_after_merge` (boolean, default true: the merge queue pushes the base to its upstream before a ticket counts as merged, `docs/LIFECYCLE.md` → Push)
  - `release` (boolean, default false: on the Kanban95 repo only, shows Start → Release board and the release-pending text, and lets `POST /api/release` run, `docs/LIFECYCLE.md` → Release board)
  - `sleepAfterMinutes` (a number of minutes, 0 or more, default 30; 0 never: how long a board under the shell may have no live session and no `/events` client before it asks the shell to close it, `docs/ARCHITECTURE.md` → Daemon lifetime)
  - `sounds` (`merge`, `attention`, `done`: booleans, default true; an old single boolean applies to all three)
  - `terminals` (`auto`: the phases among `plan`, `execute`, `test` whose sessions open a terminal on their own, default `["plan", "execute", "test"]`; `tile`: terminals take slots left of the action column, default `true`)
  - `updateCheck` (boolean, default true: a board started by the installed app asks it to check for a newer release, `docs/OPERATOR.md` → Updates)
  - `voice` (`backend`: `local`; `mode`: `push` or `toggle`)
  - `zoom` (the UI zoom, a number from 0.8 to 2, default 1)
- `~/.kanban95/projects.json`: `[{ "path", "colour" }]`, every repo the operator runs a board on. `path` is the repo's absolute path in the file system's own spelling (resolved, real case), listed once; `colour` is the board's wallpaper colour, `#rgb`/`#rrggbb` or a hue number 0 to 360 (painted as `hsl(<hue> 100% 25%)`, the teal's saturation and lightness). The display name is the folder's basename and is not stored. While the pointer (`~/.kanban95/home`) names a data folder, a project on the same volume as that folder (the same drive or share root on Windows, the same `/Volumes/<name>` on macOS or `/media/<user>/<name>` on Linux) is stored relative to the volume and marked, as `{ "path": "code/Kanban95", "root": "data", "colour" }`; reading joins it to the volume the data folder is on now, so a drive carrying both the data folder and its projects keeps them when another machine mounts it under another letter or name. Every reader (`GET /api/projects`, Start → Projects, the running registry, the first-run setup) only ever sees absolute paths. A project on another volume, and every project while there is no pointer, is stored absolute as before, and a file with only absolute paths reads as it always did. The running registry, the worktrees and `projects/<repo key>/` stay keyed by each machine's own path, so a repo on a carried drive gets a new repo key, and so fresh per-project copies and worktrees, on each machine; the brain and the global files are unaffected. A daemon adds the repo it serves on start, with `#008080` (the Win95 teal), unless it is listed. Written whole by Settings → Projects (`PUT /api/projects`): every path must be an existing folder (git or not: a board makes a plain folder a repo when it starts there), and the board's own project cannot be dropped. Reading checks only the shape, so a repo deleted since does not break other boards: it reads as missing (`GET /api/projects` → `missing`), no board starts on it, and the operator removes it in Settings → Projects. Absent means none yet. No secrets. The rules that let one file on a carried drive serve both a Windows PC and a Mac:
  - A relative `path` is written with `/` on every platform; reading accepts `/` or `\` (older Windows files) and joins with the local separator.
  - An absolute `path` written on the other platform (`D:\...` on macOS, `/Users/...` on Windows) is kept as written and reads as missing, like a deleted folder.
  - A `root: "data"` entry while the data folder is on no recognised volume keeps its relative `path` and reads as missing.
  - A file that fails validation is a BadConfig naming the file and each bad entry by its `path` value, not its index.
- `~/.kanban95/running/<pid>.json`: one file per live daemon, `{ "pid", "repo", "port", "started", "shell", "agents", "attention" }` (`repo` in the same spelling as `projects.json`, `started` an ISO time, `shell` the hosting shell's pid from `KANBAN95_SHELL_ID`, or null for a daemon started by hand, `agents` its number of live sessions, `attention` its number of tickets with `needs_human = 1`). Written by the daemon once it has its port, and again when its session count or flagged-ticket count changes (on every board change event); removed by `close()` and the process's exit handler. A daemon killed with its window (the usual way a board closes) leaves its file: anyone reading the directory (`running()` in `daemon/src/boards.ts`) deletes a file whose pid is not alive, or that does not parse. `GET /api/projects` reads it for `running`, for `hosted` (same `shell` as this daemon's), for `agents` (the count, per running project), and for `attention` (the flagged count, per running project, shown in red on that board's row of the Switch board popup when above zero); Start → Projects uses it to decide between opening and focusing a board. A pid Windows has since given to another process reads as running until that process ends. No secrets.
- `~/.kanban95/preferences.md`: the operator's standing instructions for every agent, free text, at most 16 KB. Injected into every prompt as `{{preferences}}` (`docs/AGENTS.md`). Absent means none. Written by Settings → Prompts → Save. Do not put secrets in it: it is copied into every session's prompt.md.
- `~/.kanban95/projects/<repo key>/`: a repo's own `models.json`, `settings.json` and `preferences.md`, each optional, same format as the global file. The repo key is the one the worktrees root uses (`repoKey` in `daemon/src/settings.ts`). When a copy exists, every read for that repo's board (launches, the runner's concurrency, the silence watch, the merge queue's push, housekeeping, prompts, model checks) uses it whole, never merged key by key: a key the copy lacks takes its schema default, not the global file's value. Started by `POST /api/config/<name>/override` as a copy of the global file, removed by `DELETE` (the dir too once empty). Outside the repo, so nothing about the operator's models is committed. The janitor leaves it alone. No secrets.
- `~/.kanban95/brain.db` (with `brain.db-wal`, `brain.db-shm`): the global brain, the facts that hold in any repo, which every board searches beside its own (`docs/AGENTS.md` → The brain). Only the `brain` and `brain_fts` tables (below), from `daemon/migrations/global/`. Every running daemon, one per project, holds its own connection to it: WAL mode, so readers never wait for the one writer, and a 5 s busy timeout, so a writer waits for another daemon's lock instead of failing. Opening a fresh file, the switch to WAL and the first migrate are retried on SQLITE_BUSY for up to that same 5 s, since SQLite can return busy there without waiting (several daemons starting at once on a new machine). No ATTACH: each brain is its own `DatabaseSync` (`openGlobalBrain` in `daemon/src/db.ts`). Written by `brain_add`/`brain_update`/`brain_delete` with `scope: global` and by the Brain window. No secrets; plain agent-written text.
- `~/.kanban95/worktrees/<repo key>/t-<id>/`: the ticket's git worktree on branch `ticket/<id>`. The repo key is the repo folder's name, a dash and the 8-hex-digit FNV-1a hash of its canonical path (lower-cased on Windows), so two repos with the same name never share a folder (`repoKey` in `daemon/src/settings.ts`, used by `worktreesRoot` in `daemon/src/git.ts`). Outside the repo so a synced repo folder never uploads it. Always the local `~/.kanban95/worktrees/`, never the data folder the pointer names: a data folder on a removable or synced drive would carry every worktree's `node_modules` and lock files to it, and a worktree's path is recorded in its repo's `.git`, so it must not move between machines. Removed with the branch once the ticket merges (`docs/LIFECYCLE.md` → Janitor). The operator terminal's own worktrees (`op-<time>`) go in the same folder.
- `~/.kanban95/models/whisper-base.en/`: the speech model, downloaded on the operator's OK and hash-checked (`docs/SECURITY.md` → Voice model). Not data; delete it to free 80 MB, the mic will offer the download again.
- `~/.kanban95/models/whisper-base.en.lock`: an empty SQLite file whose write lock one daemon holds while it downloads the model, so boards downloading at once take turns (`locked` in `daemon/src/voice.ts`). Safe to delete when no download runs.
- Nothing in the database leaves the machine. There is no sync, no telemetry, no export yet (export is explicit when it arrives).
- Backup and restore: the board's state is the `.kanban95/` folder in the repo (`board.db` and its `-wal` file, `templates/`, `ui.json`, attachments). Copying it while the daemon is stopped is a complete backup, and copying it back is a complete restore.
- The Random Work, Variant Tool and Portfolio Website boards were imported from the old AI Task Board (`C:\Users\dills\ai-task-board\data\tasks.db`) on 2026-10-14, with ticket ids equal to the old task numbers. The one-off importer was removed afterwards.
- The daemon is the only writer. The UI goes through REST, agents go through MCP (`docs/MCP.md`).

## Migrations

`daemon/migrations/NNN-name.sql`, applied in filename order by `openDb` at every start; the global brain's own files are in `daemon/migrations/global/`, applied the same way by `openGlobalBrain`. Each file runs in its own transaction and is recorded in `schema_migrations(version, applied_at)`; a second start applies nothing. A failing file is rolled back and the daemon refuses to start, so the database is always at a whole version. Never edit an applied migration; add the next number. Each file runs under `BEGIN IMMEDIATE` and is checked again once the write lock is held, so two daemons starting at once on the shared global brain apply it once.

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

How the kinds are written over MCP: `add_note` takes `plan` `decision` `failure` `summary`; `ask_operator` writes `question` and sets `needs_human`; the operator's answer (`POST /api/tickets/:id/answer`) is `answer` with role `operator`; the lifecycle writes `failure` notes for an agent that exited without reporting or failed to launch (role of that session), for the retry cap (`stopped after 4 failed tests`, role `tester`), for a merge conflict (`merge conflict with <base>: <git output>`, role `tester`) and for a base still dirty after the merge queue's wait (role `tester`). Every note written with a `needs_human` flag, except a `question`, ends with a line starting `To resolve:` naming the operator's next step (`docs/LIFECYCLE.md` → Needs human); `GET /api/inbox` lists the unanswered `question` notes of flagged tickets and, when no newer question is open, the newest `failure`; `report_test` writes `summary` on pass and `failure` on fail, body `PASS|FAIL: <summary>` followed by one `- ` line per evidence item; `report_cleanup` writes `summary` with one `- <action> \`<path>\`: <reason>` line per item. `role` is always the grant's role. Prompts include only notes created at or after the `started_at` of the ticket's latest `execute` run (`context.attemptNotes`): `failure` notes for a worker, so each retry sees the failures of the attempt before it and nothing older, and `failure`, `decision` and `summary` notes for a tester.

### brain, brain_fts
`brain(id, title, body, tags, ticket_id nullable FK set-null, created_at)`. `brain_add` over MCP sets `ticket_id` to the grant's ticket (null for a planner or operator). The same two tables, triggers and ranking make up the global brain in `~/.kanban95/brain.db`, except that its `ticket_id` has no foreign key and is always null (`CHECK (ticket_id IS NULL)`: tickets are per repo). Ids are per file, so a row is named by `scope` (`project`, `global`) and `id`; every read through MCP or REST carries `scope`. A search runs on both files and merges by rank (bm25 is computed per file, so ranks across the two are close, not exact; a ponytail in `brainSearch`). A move to the other scope inserts the row there with a new id and the same `created_at`, then deletes it here. `brain_fts` is an FTS5 external-content index over `title, body, tags` kept in sync by triggers `brain_ai`, `brain_au`, `brain_ad`. Query it with `brain_fts MATCH ?` and join `brain` on `rowid = id`; the board ranks with `bm25(brain_fts, 10.0, 1.0, 5.0)` (`BRAIN_RANK` in `daemon/src/db.ts`) so title and tags outweigh the body. Rows are edited and deleted in place (`brain_update`, `brain_delete`, REST `PATCH`/`DELETE /api/brain/<id>?scope=project|global`, `move_to` in the PATCH body), with no history: the audit log records who did it. A body over 1500 characters is refused on write (not a schema constraint; older rows may be longer).

### runs
| column | type | notes |
|---|---|---|
| id | INTEGER PK | |
| ticket_id | INTEGER FK | cascade delete |
| phase | TEXT | `plan` `execute` `test` |
| cli, model, effort | TEXT | what was actually launched; effort is one of the four values |
| prompt_rendered | TEXT | the exact prompt injected, written by `context.startRun` before the CLI is spawned; for the context viewer; only `GET /api/tickets/:id/runs/:run` returns it, not the run list |
| started_at, ended_at | TEXT | `ended_at` null while running |
| outcome | TEXT | null while running. Set by the lifecycle when the terminal closes: `submit`, `pass`, `fail` (the agent's move was accepted and the board ended the session), `exit` (closed without reporting), `unstarted` (Windows failed to start its CLI; the board starts it again, `docs/LIFECYCLE.md` → Processes that never started), or `lost` (set by the janitor for a run that has no end and no live session, after a daemon crash) |
| session_id | TEXT | Claude Code's conversation id, a UUID the board picks and passes as `--session-id` at launch; a resumed run (`--resume`) repeats the id it continued. Null for Codex. Read by `resumable` in `daemon/src/launcher.ts` (docs/LIFECYCLE.md → Resume). Added in `007-run-session-id.sql` |
| scrollback | TEXT | last 2000 lines (at most 2 MiB) of the agent's raw terminal output (ANSI included), written by the launcher when the pty exits (the run list returns only `has_scrollback`, the full row route the text); null while running or if the launch failed before spawning, and set back to null by the janitor 30 days after the run ended. Added in `002-run-scrollback.sql` |

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
| tool | TEXT | what was called: a REST action, an MCP tool or a board action, listed under the table |
| args_summary | TEXT | JSON of the request, truncated to 200 characters. Callers must never put a token in it. |
| outcome | TEXT | `ok` `denied` `error` |
| created_at | TEXT | |

`tool` values:

- REST:
  - `attachments.add`
  - `attachments.remove`
  - `board.push`
  - `brain.add`
  - `brain.delete`
  - `brain.update`
  - `brainstorm.launch`
  - `config.write`
  - `grants.revoke`
  - `operator.launch`
  - `runner.set`
  - `tickets.answer`
  - `tickets.create`
  - `tickets.delete`
  - `tickets.housekeeping`
  - `tickets.launch`
  - `tickets.merge`
  - `tickets.resume`
  - `tickets.update`
  - `trust.clear`
  - `voice.download`
- MCP: the tool name (`create_ticket`, `move_ticket`, ..., see `docs/MCP.md`).
- Board, all with a null grant:
  - `janitor.grant` (`docs/LIFECYCLE.md`)
  - `janitor.run` (`docs/LIFECYCLE.md`)
  - `janitor.scrollback` (`docs/LIFECYCLE.md`)
  - `janitor.session` (`docs/LIFECYCLE.md`)
  - `janitor.worktree` (`docs/LIFECYCLE.md`)
  - `trust.write` (a key written into an agent CLI's config, `docs/SECURITY.md`)

### schema_migrations
`(version TEXT PK, applied_at TEXT)`, one row per applied migration file.
