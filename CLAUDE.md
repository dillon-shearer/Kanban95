# Kanban95 — agent conventions

Read `docs/ARCHITECTURE.md` → Working on the board, the section of `docs/ARCHITECTURE.md` for the part you touch, and the living doc for that part. Search the board's brain (`brain_search`) for gotchas.

## Principles, in priority order
1. Security and the operator's keys/data above every feature. The board never holds provider API keys. Never read a `.env` implicitly. Never log a token in the clear.
2. Give agents only the context they need. Pull over push.
3. Prompts are versioned markdown templates with explicit variables.
4. Minimal operator interaction. Resolve, retry, escalate, then flag.
5. Win95 look, compact, functional only.
6. Docs are for humans, agents and learners. Update `docs/` in the same ticket that changes behaviour.
7. One SQLite file per repo, documented schema, migrations.
8. Every agent session runs on a scoped, revocable grant.
9. Tests are purposeful. Boundary and failure cases first. No test that cannot fail for a real reason. No snapshot tests of UI chrome.
10. Models are config (`~/.kanban95/models.json`), never named in code.
11. Self-cleaning. Remove what you created (worktrees, sessions, temp files, screenshots not kept as evidence). Delete ephemeral docs when superseded after moving anything durable into a living doc. Delete unused modules; do not leave them "in case".
12. Operator input is system-agnostic. Voice-to-text is a local model behind a mic button, never a provider feature.

## Document lifecycle
- Living (keep current, never delete): `README.md`, `docs/ARCHITECTURE.md`, `SECURITY.md`, `DATA.md`, `MCP.md`, `CLIS.md`, `LIFECYCLE.md`, `AGENTS.md`, `OPERATOR.md`, `LEARNING.md`.
- Ephemeral (delete when superseded): any plan, proposal or handoff. Move what is still true into a living doc first.

## Stack
Node 24+, TypeScript, vitest. `node:sqlite`. Vanilla UI + 98.css + xterm.js. Tauri 2 shell with the daemon as sidecar. Windows is the primary platform.

## Layout
`daemon/` `ui/` `shell/` `templates/` `skills/` `docs/`. See `docs/ARCHITECTURE.md` → Repo map.

## Working rules
- Verify CLI flags against the installed tool (`claude --help`, `codex --help`) before writing an argv builder. Do not guess flags.
- Daemon binds `127.0.0.1` only. Random port.
- Tokens are stored hashed. Grants expire with the ticket.
- Keep diffs small. No abstraction with one implementation. No scaffolding "for later."
- Commits, by hand or by the board, are authored as the operator (their `git config user.name`/`user.email`), with no `Co-Authored-By` or other trailer. Subject: a plain imperative sentence saying what changed, no ticket or phase ids. Body only when the why is not obvious from the subject.
- Never leave uncommitted changes in the main checkout while the board runs; the merge queue merges there. Work in a worktree.
- Mark deliberate shortcuts with a `// ponytail:` comment naming the ceiling and the upgrade path.
- Record a gotcha a future ticket would trip on with `brain_add`; when it is about working on the code, also add it to `docs/ARCHITECTURE.md` → Working on the board.
