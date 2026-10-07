# 01 — Daemon core and security (done 2026-10-07)

## What was built

- `daemon/migrations/001-init.sql`: `tickets`, `ticket_deps`, `notes`, `brain` + `brain_fts` (FTS5 external content, trigger-synced), `runs`, `grants`, `audit`. All enumerations are `CHECK` constraints; FKs on, with cascade / restrict / set-null as documented in `docs/DATA.md`.
- `daemon/src/db.ts`: `openDb(repo)` creates `<repo>/.kanban95/`, writes the inner `.gitignore` if missing, opens `board.db` in WAL mode with foreign keys on, runs unapplied migrations (one transaction each, recorded in `schema_migrations`). A failing migration rolls back, closes the handle and throws, so the daemon does not start.
- `daemon/src/grants.ts`: `mint` (32 random bytes base64url, SHA-256 hex stored), `verify` (null for unknown / expired / revoked), `revoke`, `audit` (args JSON truncated to 200 chars).
- `daemon/src/api.ts`: REST under `/api` (table in `docs/ARCHITECTURE.md`). Field whitelist and type check, then the schema does value validation; SQLite constraint errors map to 400. Every mutation, successful or not, writes an audit row with `grant_id = null` (operator).
- `daemon/src/server.ts`: origin guard before routing (`Host` must be `127.0.0.1:<port>`; `Origin`, if present, must be `http://127.0.0.1:<port>`), `/api/*` dispatch, `start({repo})` returns `{port, db, close}`, `argv[2]` picks the repo.
- Tests (29, about 0.5 s): `db.test.ts` (first-run files, idempotent migrate, failing migration rollback, status CHECK, dep FK and self-dep, planner/ticket pairing CHECK, FTS sync), `grants.test.ts` (live, hash-only storage, expired, revoked and idempotent revoke, one-byte tamper, planner scope, audit truncation), `api.test.ts` (foreign Origin and Host refused, CRUD with audit rows, bad-input matrix, deps FK / sort / restrict-delete, notes / runs / audit per ticket, brain ranking / limit / hostile syntax, grants list without hash and revoke).
- `docs/DATA.md`, `docs/SECURITY.md` written; `docs/ARCHITECTURE.md` and `README.md` updated.

## Deviations from the handoff

- **`depends_on` is a join table `ticket_deps`, not a JSON column.** The handoff asked that a dependency on a nonexistent ticket be impossible; a FK does that at the DB level, a JSON array cannot. REST still speaks `depends_on: number[]`.
- **`flags` are two integer columns `needs_human` and `blocked_on_deps`, not a JSON blob.** They are `CHECK`-able and phase 5 toggles them with a plain `UPDATE`. REST presents them as `flags: {needs_human, blocked_on_deps}`.
- **`audit` has an extra `ticket_id`.** Operator REST actions have no grant, so "audit per ticket" needed a direct column. It is `ON DELETE SET NULL`, so audit rows about a deleted ticket keep the id only inside `args_summary`.
- **`notes.role` also allows `operator`** for the answer half of `ask_operator` (phase 5).
- **Revoke does not kill a pty.** There is no pty yet; phase 4 must hook `revoke` to the session kill.
- **No REST for creating notes or brain rows.** Agents write those via MCP (phase 2); the operator UI (phase 6) adds endpoints when it needs them. Tests insert directly.

## Commands

```
npm test          # tsc && vitest run, 29 tests
node daemon/dist/server.js <repo>   # needs Node 24 on PATH, stdin held open
```

## Gotchas for the next phase

- `grants.verify(db, token)` and `audit(db, ...)` take the `DatabaseSync` explicitly; `start()` returns it as `db`. Mount MCP inside `server.ts`'s `handle` after the origin guard and before the static fallback. The origin guard requires `Host: 127.0.0.1:<port>`, so the MCP config handed to CLIs must say `127.0.0.1`, never `localhost`.
- `DatabaseSync.exec` with a multi-statement string leaves a transaction open if a middle statement throws. `migrate` and `api.ts`'s `transaction()` do explicit `BEGIN` / `COMMIT` / `ROLLBACK`; do the same anywhere else.
- `audit.ticket_id` is a FK: attributing an action to a ticket that does not exist throws. `api.ts` checks existence on the error path; MCP must too, or pass null.
- Imports between `src/` files use `.js` extensions (tsconfig has no `allowImportingTsExtensions`); tests import `../src/x.ts` directly.
- Node's `fetch` strips a caller-set `Host` header; tests that need a foreign Host use `node:http.request`.
- On Windows a test must close its DB before `rmSync`, or it gets `EPERM`. `openDb` closes the handle on migration failure for this reason.
- `npm run dev` from the repo root creates `./.kanban95/board.db` in this repo. The root `.gitignore` already covers it.
