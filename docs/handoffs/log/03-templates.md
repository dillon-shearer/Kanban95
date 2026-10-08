# 03 — Templates and context assembly (done 2026-10-07)

## What was built

- `templates/`: `brainstorm.md`, `plan.md`, `execute.md`, `test.md`, `housekeeping.md`, each written as plain-language instructions with the behaviour the handoff listed. `execute.md` also carries the commit-message rule phase 5 asked for (plain imperative subject, no ids, no trailers).
- `daemon/src/templates.ts`: `TEMPLATES` (name → grant role and `runs.phase`), `VARS` (the seven variables), `initTemplates(repo)` (copies defaults with `COPYFILE_EXCL`, so an existing file is never touched), `loadTemplate` (reads from disk every time, refuses an unknown name, refuses any `{{var}}` outside `VARS` with `template <name>.md uses unknown variable {{x}}`), `fill` (single-pass substitution), `render = fill ∘ loadTemplate`.
- `daemon/src/context.ts`: `brainFor` (FTS5 `OR` over the unique 3+ char words of title + body, `ORDER BY rank, id`, top 5, `- [#id] title: body` with continuation lines indented, 4000-char budget with a `[brain truncated; …]` marker, total length never above the budget), `failureNotes` (failure notes at or after the latest execute run's `started_at`), `buildContext(db, ticketId | null, role, opts)`, `startRun(db, repo, {...})` (validates the template, builds context, renders, inserts the `runs` row, returns `{id, prompt}`).
- `server.ts` `start()` calls `initTemplates(repo)` after `openDb`.
- `daemon/test/templates.test.ts`: 11 tests. Copy-once / no-overwrite / edit-applies-next-render; unknown variable named with template (even when ctx has the key); bad template name; every default uses only known vars; literal insertion (`{{ticket}}` and `$&` inside a value); brain cap at N, ranking, no unrelated rows; char budget exact length + marker; failure notes from an earlier cycle and non-failure kinds excluded; byte-identical render; diff empty for worker, real `git diff main...HEAD` for tester, error without worktree; `startRun` stores the prompt and a bad template writes no row. Suite: 62 tests, about 1 s.
- Docs: new `docs/AGENTS.md`; Prompts sections in `docs/ARCHITECTURE.md` and `docs/SECURITY.md`; `docs/DATA.md` (`runs.prompt_rendered` writer, failure-note cycle rule); `README.md`; `PLAN.md` template line.

## Deviations from the handoff

- **`render(repo, name, ctx)`**, not `render(name, ctx)`: the templates live per repo and nothing else carries the repo.
- **"Current retry cycle" = failure notes created at or after the latest `execute` run's `started_at`.** Notes carry no retry number. The prompt for a new execute run is rendered before its row is inserted, so "latest execute run" is the attempt that just failed, and an "agent exited without reporting" failure (phase 5) is picked up the same way. No migration needed. Ceiling: millisecond timestamps; a note in the same millisecond as a run start counts as that run's.
- **Brain matching is `OR` of words, not `brain_search`'s `AND`.** A whole ticket body ANDed matches nothing. Words under 3 characters are dropped; bm25 ranks common words low.
- **`plan.md` runs on a worker grant**, not planner: a planner grant can touch every ticket, a worker only its own, which is all a plan pass needs.
- **`{{tools}}` lists `name (access cell)`** from the MCP `TOOLS` table, so it cannot drift from what is enforced.
- **Brainstorm has no ticket**: `buildContext(db, null, 'planner')` gives `(none)` for everything but `tools`; there is no `runs` row (`runs.ticket_id` is NOT NULL).
- **The brain/char limits are parameters** (`brainLimit`, `brainChars` on `ContextOpts`), defaulting to 5 / 4000. Nothing reads them from `config.json` yet; phase 5 creates that file and can pass them through.
- **Empty values render `(none)`**, except `diff` outside the test phase, which is `''` as the handoff says.

## Commands

```
npm test     # tsc && vitest run, 62 tests
```

## Gotchas for the next phase

- Phase 4 calls `startRun(db, repo, { ticketId, template, cli, model, effort, worktree, base })` and writes the returned `prompt` to `sessions/<run-id>/prompt.md`. `worktree` and `base` are required for `template: 'test'` (it runs `git diff`) and ignored otherwise. Use `TEMPLATES[template].role` for the grant role.
- `startRun` throws on a bad template before any git call or DB write; surface the message to the operator, it names the variable.
- The diff is injected whole (`// ponytail:` in `context.ts`, `maxBuffer` 16 MiB). If a CLI chokes on prompt size, truncate there with a marker.
- `npm run dev` from this repo now also creates `./.kanban95/templates/` (untracked, not ignored: in a target repo they are meant to be committed). Delete it or ignore it locally.
- Template edits by the operator survive daemon restarts and new defaults do not reach an existing repo. A changed default only lands in repos that lack the file.
