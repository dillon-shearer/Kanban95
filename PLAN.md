# Kanban95 — Plan

Retro Win95-styled desktop kanban that launches, tests, retries and merges AI agent work per ticket.
Fire and forget. Planning closed 2026-10-07. This file is the spec; it is a living document.

## Principles (in priority order)

1. **Security first.** The operator's keys and data come before every feature. The board holds **no provider API keys**: Claude Code and Codex CLI own their own auth. The board's only secrets are the per-session tokens it mints itself. No `.env` is read implicitly, ever. Anything secret-shaped is declared, scoped and visible in the UI.
2. **Context management.** An agent gets exactly what the ticket needs, when it needs it: the ticket, the acceptance criteria, top-N brain notes, the last failure notes. Everything else is pull (`brain_search`, `get_ticket`), never push. No transcripts are injected.
3. **Instructional injection.** Prompts are versioned markdown templates with explicit variables, rendered deterministically, viewable in the board before and after launch.
4. **Ease of use.** One gate (Launch). After that the board resolves problems itself: retry, escalate model, ask the operator through the board, flag only when stuck.
5. **Clean, sleek design.** Win95 chrome, compact, nothing decorative that is not functional.
6. **Documented for everyone.** Human, agent and learner. Every MCP tool is self-describing. `docs/` is kept current by the tickets that change behaviour.
7. **Clean data handling.** One SQLite file per project, a documented schema, migrations, export. Nothing leaves localhost.
8. **Grant and revoke.** Every agent session runs on a scoped, revocable grant visible in the board.
9. **Purposeful tests.** Tests assert the behaviour that matters at the boundaries. No happy-path theatre.
10. **Modern and ongoing.** Skills and MCP for every repeatable workflow. Models are config, never code. The board is a permanent work in progress.
11. **Self-cleaning.** The board removes what it created (worktrees, sessions, test artefacts) and keeps its own docs honest: ephemeral documents are deleted when superseded, living documents are kept current, unused modules are removed. Nothing rots.
12. **Operator input is system-agnostic.** Voice-to-text is a mic button in the UI backed by a local model, not a feature of whichever AI or device happens to be in use.

## Decisions

### Runtime
- **Tauri desktop app from day one**, properly scoped, never rushed. Tauri provides the window, CSP, capability allowlist and packaging. It spawns the daemon as a sidecar.
- **Daemon: TypeScript on Node 24+.** One process: static UI, REST + websocket, HTTP MCP server, SQLite (`node:sqlite`), pty (`node-pty`), git. Binds `127.0.0.1` only.
- **UI: vanilla HTML/CSS/JS + 98.css.** MDI draggable windows. xterm.js terminals. No build step for the UI.
- **Storage: `<repo>/.kanban95/`**
  - `board.db` (gitignored), `templates/*.md` (committed), `config.json` (committed, no secrets).
  - `.worktrees/` (gitignored).
- **Global: `~/.kanban95/`** for operator-level settings: model catalog, CLI paths, sounds. No secrets.

### Agents
- Harnesses: **Claude Code CLI**, **OpenAI Codex CLI**. Providers: Anthropic, OpenAI.
- Agnostic means the board only chooses CLI + flags. The board makes no LLM calls.
- Permissions off inside worktrees (`--dangerously-skip-permissions` / Codex full-auto). The worktree is the blast radius.
- **Git worktree per ticket** at `.worktrees/t-<id>`, branch `ticket/<id>`.
- Concurrency unlimited. **Merges are serialized** through one queue regardless.
- **Commits carry the operator's identity.** Agent commits in a worktree and the merge commit are authored with the operator's git `user.name`/`user.email`, never a bot and never a `Co-Authored-By` trailer. Subject is a plain imperative sentence saying what changed, no ticket or phase ids (those live in the board); body only when the why is not obvious.
- Dependencies: `depends_on`. Dependents are held until deps are Done. **Launch all** respects this.

### Models
Models live in `~/.kanban95/models.json`, editable in the board's Settings window. Nothing in code names a model.

| Phase   | Anthropic default    | OpenAI default |
|---------|----------------------|----------------|
| plan    | claude-fable-5-1     | Sol            |
| execute | claude-opus-5-5      | Terra          |
| test    | claude-sonnet-5-5    | Luna           |

**Effort level** travels with the model. Values `low | medium | high | max`, default `medium` per phase, stored in the same config. The launcher maps it to each CLI's own mechanism (Claude Code effort setting, Codex reasoning effort), verified against the installed CLI, never guessed.

Overrides, all through MCP (`set_model` takes `model` and/or `effort`):
- Planning agent sets `model` and `effort` on a ticket at creation when the work warrants it: trivial tickets get `low`, hard ones `high`.
- Executing agent can `set_model` and requeue itself mid-work, up or down.
- Test agent can escalate the retry to a bigger model or higher effort before flagging the operator.
- Operator can pin any model or effort per phase or per ticket, and downgrade globally (the Opus 5 → 4.8 case must be one edit).

### Workflow
- Columns: **Backlog → In Progress → Testing → Done.** `needs_human` and `blocked_on_deps` are flags, not columns.
- Brainstorm: a Claude Code terminal with `brainstorm.md` injected; it writes tickets via MCP with full context and acceptance criteria.
- Agents report only through MCP. The board never parses terminal output.
- Retry limit 3, then `needs_human` + chord.wav. Done + merge → ding.wav.
- `ask_operator`: agent asks a question, ticket flags, chord plays, operator answers in the board, agent resumes.
- Templates: `brainstorm.md`, `plan.md`, `execute.md`, `test.md`. Variables: `{{ticket}}`, `{{criteria}}`, `{{brain}}`, `{{notes}}`, `{{retry}}`, `{{diff}}`. Editable in the board; rendered prompt is previewable.

### Testing standard (the test agent, and the board's own tests)
- Test agent: runs the suite/build, reviews the diff against acceptance criteria, writes tests for new behaviour that has none, launches and screenshots the app for UI tickets.
- Tests must be purposeful: each maps to an acceptance criterion or a failure mode. Boundary and failure cases first: auth rejected, scope rejected, bad state transition rejected, retry cap reached, merge conflict → `needs_human`, dependency hold. No snapshot tests of chrome. No test that cannot fail for a real reason.

### Brain
- Markdown notes as rows in SQLite with FTS5. Injected by keyword match on ticket title/body/tags, top N (default 5).
- Fed by: closing summary per ticket, decisions/gotchas flagged mid-work via `brain_add`.
- Context viewer shows: ticket body + criteria, agent notes/plan, git diff, test results + run history, and the exact rendered prompt that was injected.

### Look
- Win95/98, navy→blue title bars, MS Sans Serif/Tahoma, compact, no CRT effects, MDI windows: Board, Ticket, Terminal(s), Brain, Settings, Inbox (ask_operator).

### Voice input
- A mic button next to every text input and in every terminal window. Hold or toggle to record, release to transcribe, text lands in the focused field or is written to the pty as input.
- Transcription runs **locally in the webview** with a Whisper-class model via transformers.js (WASM/WebGPU). No provider key, no network at runtime. The model file is downloaded once on first use after an explicit click that shows the URL and size, stored under `~/.kanban95/models/`, hash-checked.
- Single `transcribe(audioBlob) → text` function with the backend chosen in Settings. Local is the only backend at launch; a daemon-side whisper.cpp or a provider backend can be added later without touching the UI.
- Windows' built-in dictation (Win+H) works in any field in the Tauri window as a zero-code fallback and is documented, not relied on.

### Self-cleaning
- **Janitor** in the daemon: on ticket Done + merged → remove worktree, branch, session dir, test artefacts. On start and daily → delete orphan worktrees and sessions, prune `runs` scrollback older than 30 days (outcome and summary rows are kept), `VACUUM`.
- **Document lifecycle.** Every doc is either *living* (`ARCHITECTURE`, `SECURITY`, `DATA`, `MCP`, `CLIS`, `LIFECYCLE`, `AGENTS`, `OPERATOR`, `LEARNING`, `README`) or *ephemeral* (handoffs, plans, proposals). Ephemeral docs are deleted the moment they are superseded; their durable content moves into a living doc first. Each handoff file is deleted when its log entry is written. `PLAN.md` is retired in phase 8.
- **Housekeeping ticket.** A `housekeeping.md` template that scans for stale docs (references to removed code, superseded plans), unused modules (no importers), dead templates and leftover artefacts, then deletes or updates them. Triggered by a Housekeeping button and automatically after every 10 tickets reach Done.
- The test agent removes its own artefacts (screenshots, temp dirs) unless stored as run evidence.

## Security model

- **No provider keys in the board.** CLIs authenticate themselves. The board documents how, and never asks for a key.
- **Grants.** On launch the daemon mints a random bearer token bound to `{ticket, role, expiry}` and passes it to the CLI through its MCP config. Roles: `planner` (create/list tickets, brain), `worker` (own ticket only + brain), `tester` (own ticket, move to done/in_progress, brain). A token outside its scope gets a refusal, logged.
- **Revoke.** Settings → Grants lists live sessions. Revoke invalidates the token and kills the pty. Expiry is automatic on ticket close.
- **Network.** Daemon on `127.0.0.1`, random port, Tauri CSP locked to it. MCP over HTTP with bearer auth only.
- **Filesystem.** MCP tools that touch paths reject anything outside the ticket's worktree.
- **Data.** `board.db` and worktrees gitignored by default. Export is explicit. Nothing is uploaded anywhere.
- **Audit.** Every MCP call is logged with grant id, tool, outcome. Viewable per ticket.

## Ticket lifecycle

```
Backlog
  │ Launch / Launch all   (held if depends_on not Done)
  ▼
git worktree .worktrees/t-014 (branch ticket/014)
mint grant{ticket:14, role:worker}
spawn <cli> --model <execute> "execute.md ⟵ ticket + criteria + brain(5) + notes"
  │ agent: add_note / brain_add / ask_operator / set_model
  │ agent: move_ticket(testing)
  ▼
Testing
mint grant{role:tester}; spawn <cli> --model <test> "test.md ⟵ ticket + criteria + diff"
  ├─ pass → move_ticket(done) → merge queue → ding.wav → worktree removed → grants expire
  │          conflict → needs_human
  └─ fail → add_note(failure) → retry+1 (tester may escalate model) → back to execute
             retry > 3 → needs_human → chord.wav → stop
Done
```

## MCP tools

`create_ticket`, `update_ticket`, `set_model`, `move_ticket`, `add_note`, `get_ticket`, `list_tickets`,
`brain_add`, `brain_search`, `ask_operator`, `report_test` (structured pass/fail + evidence), `report_cleanup` (housekeeping: what was deleted or updated and why).

## Repo layout

```
kanban95/
  daemon/        server.ts, mcp.ts, grants.ts, db.ts (schema + migrations), templates.ts,
                 launcher.ts (argv per CLI), pty.ts, git.ts, lifecycle.ts, merge.ts, janitor.ts
  ui/            index.html, app.js, wm.js, voice.js, 98.css, xterm/, vendor/transformers/
  shell/         Tauri project, sidecar config, capabilities
  templates/     default prompt templates (copied into <repo>/.kanban95 on init)
  skills/        Claude Code skills shipped for agents: ticket-start, ticket-complete, ask-operator
  docs/          ARCHITECTURE.md, SECURITY.md, MCP.md (tool reference), DATA.md (schema), AGENTS.md (how an agent should behave on this board), OPERATOR.md
  CLAUDE.md      conventions for agents working on this repo
```

## Build sequence

Each phase is a set of tickets with acceptance criteria. Phases 0 to 2 are built by hand with Claude Code. From phase 3 on, Kanban95 builds Kanban95.

0. **Scaffold.** Repo, Node 24, TypeScript, vitest, Tauri project skeleton that opens a window on a placeholder daemon. `docs/` stubs, `CLAUDE.md`, `.gitignore`. Exit: `tauri dev` shows a Win95 window served by the daemon.
1. **Daemon core + security.** Schema + migrations, REST, grants (mint, scope, expire, revoke), audit log, localhost bind. Tests: unscoped token refused, expired token refused, revoked token kills session, audit written.
2. **MCP server.** All tools, scoped by role. Tests: worker cannot touch another ticket, planner cannot move tickets, every tool self-describes.
3. **Templates + context assembly.** Render with variables, brain FTS top-N, rendered-prompt preview stored per run. Tests: deterministic render, no transcript leakage, unknown variable fails loudly.
4. **Launcher.** Worktree create/remove, argv builders for Claude Code and Codex (model, MCP config, permissions flag), pty + websocket stream. Tests: argv per CLI/model/role, worktree cleanup on kill.
5. **Lifecycle.** State machine, retry cap, escalation, dependencies, launch all, merge queue, ask_operator round trip, sounds, janitor, housekeeping auto-trigger. Tests: every transition table row, retry cap, conflict → needs_human, dep hold released on Done, janitor leaves nothing behind.
6. **UI.** MDI window manager, board with drag between columns, ticket window (context viewer), terminal windows, brain window, settings (models, CLIs, grants, voice), inbox for ask_operator, mic button with local transcription.
7. **Tauri hardening + packaging.** Sidecar lifecycle, CSP, capability allowlist, installer. Tests: daemon dies with the window, no external origins allowed.
8. **Skills + docs pass.** Ship agent skills, finish `docs/`, dogfood a full brainstorm → launch all → done cycle on a sample repo. Retire `PLAN.md` and the handoffs into living docs.
