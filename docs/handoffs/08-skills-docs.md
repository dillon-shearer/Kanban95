# Phase 8 — Skills, docs and dogfood

Read `CLAUDE.md`, `PLAN.md`, `docs/handoffs/log/*`.

## Goal
Make the board self-explanatory to agents and humans, then prove it by running a full cycle on a sample repo and then on this repo.

## Deliverables
- `skills/` as a Claude Code plugin: `kanban95-ticket-start` (read ticket, deps, brain; post a plan note), `kanban95-ticket-complete` (summary note, `brain_add` for gotchas, `move_ticket`), `kanban95-ask-operator` (when and how to ask, how to phrase a question that can be answered in one line). Keep each under a page.
- `docs/` final pass: `ARCHITECTURE`, `SECURITY`, `DATA`, `MCP`, `CLIS`, `LIFECYCLE`, `AGENTS`, `OPERATOR`, plus `LEARNING.md`: a guided tour for someone new to agent tooling, explaining what a worktree, an MCP tool and a grant are and why the board uses them.
- `README.md` rewritten: what, why, a screenshot, three-command quickstart, link to each doc.
- Dogfood 1: a throwaway sample repo. Brainstorm 5 tickets with dependencies, Launch all, let it run to Done. Record every manual touch. Each one becomes a ticket on this repo.
- Dogfood 2: open this repo in Kanban95, brainstorm the next improvements, launch them. From here on the board builds itself.
- Retirement: fold anything still only in `PLAN.md` into the living docs, then delete `PLAN.md`. Fold the gotchas from `docs/handoffs/log/` into the living docs (`ARCHITECTURE`, `SECURITY`, `CLIS` as appropriate), then delete `docs/handoffs/` entirely. Run one housekeeping ticket on this repo and confirm it finds nothing.
- Log entry: because the handoffs folder is being removed, write the phase 8 findings and dogfood results into `docs/OPERATOR.md` (dogfood walkthrough) and `docs/ARCHITECTURE.md` (what changed), not into a log file.

## Acceptance criteria
1. A fresh agent given only `docs/AGENTS.md` and a worker grant completes a trivial ticket correctly.
2. A person given only `docs/OPERATOR.md` runs a brainstorm → done cycle without asking anything.
3. Dogfood 1 reaches Done with at most one `needs_human` per ticket.
4. After retirement, the repo contains no `PLAN.md`, no `docs/handoffs/`, and a housekeeping run reports zero changes.

## Required tests
None new. The dogfood cycles are the test. Record them.
