# Phase 3 — Templates and context assembly

Read `CLAUDE.md`, `PLAN.md`, `docs/handoffs/log/*`.

## Goal
Deterministic prompt rendering. An agent receives exactly: the ticket, its criteria, top-N brain notes, the last failure notes, the retry count. Nothing else is pushed.

## Deliverables
- `templates/brainstorm.md`, `plan.md`, `execute.md`, `test.md`. Variables: `{{ticket}}` `{{criteria}}` `{{brain}}` `{{notes}}` `{{retry}}` `{{diff}}` `{{tools}}` (a short reminder of which MCP tools this role may call). Each template must instruct the agent, in plain language:
  - `brainstorm.md`: interview the operator, then create tickets with full body, measurable acceptance criteria, `depends_on`, and a `model` or `effort` only when the work clearly warrants it: `low` effort for trivial tickets, `high` for hard ones, defaults otherwise. End by listing what was created.
  - `execute.md`: work only inside the current directory (the worktree); record decisions with `add_note`, gotchas with `brain_add`; ask with `ask_operator` instead of guessing; never commit secrets; finish by calling `move_ticket(testing)`.
  - `test.md`: run the suite/build; review `{{diff}}` against `{{criteria}}`; write tests for new behaviour that has none; for UI tickets launch and screenshot; finish with `report_test` then `move_ticket(done)` or `move_ticket(in_progress)` with a `failure` note. May `set_model` to escalate before sending it back.
  - `plan.md`: for a single ticket that needs a design pass before execution; writes a `plan` note.
  - `housekeeping.md`: scan the repo for stale docs (references to code that no longer exists, superseded plans, ephemeral docs per `CLAUDE.md` → Document lifecycle), modules with no importers, templates nobody renders, leftover artefacts (`.worktrees` orphans, temp dirs, screenshots). Move durable content into the matching living doc, then delete. Call `report_cleanup` with every path and reason, then `move_ticket(testing)`. The test phase for a housekeeping ticket verifies the build still passes and nothing living was removed.
- `daemon/src/templates.ts`: `render(name, ctx)`. Unknown variable in a template throws, naming it. Unused context keys are fine. Templates are read from `<repo>/.kanban95/templates/`; on init the defaults are copied there once and never overwritten.
- `daemon/src/context.ts`: builds `ctx` for a ticket. `brain` = top 5 FTS matches on title + body + tags, formatted as `- [#id] title: body`. `notes` = failure notes from the current retry cycle only. `diff` = `git diff <base>...HEAD` in the worktree, empty outside the test phase.
- Rendered prompt stored on the `runs` row before spawn (phase 4 uses it).
- `docs/AGENTS.md`: how an agent is expected to behave on this board, derived from the templates.
- Log entry `docs/handoffs/log/03-templates.md`.

## Acceptance criteria
1. Same ticket + same DB → byte-identical render.
2. A template referencing `{{transcript}}` or any unknown variable fails at load, not at launch.
3. Brain injection never exceeds N entries or a configurable character budget (default 4000 chars); truncation is marked.
4. Editing `.kanban95/templates/execute.md` changes the next render without a restart.

## Required tests
- Unknown variable throws with the variable name and template name.
- Character budget truncates and appends a visible marker.
- Failure notes from a previous retry cycle are excluded.
- Defaults are copied on init and not overwritten on second init when the user has edited one.
