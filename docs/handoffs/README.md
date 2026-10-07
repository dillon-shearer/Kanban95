# Handoffs

One file per build phase. Each is a complete prompt for a fresh agent. Run them in order; each phase assumes the previous ones are done.

## How to launch a phase (by hand, until the board exists)

Open Claude Code in this repo and paste:

```
Read CLAUDE.md, PLAN.md, every file in docs/handoffs/log/, then docs/handoffs/NN-name.md. Execute that handoff fully. When done, write the log entry it asks for.
```

Suggested models: phases 0 to 2 with `claude-opus-5-5`; phase 5 (lifecycle) with `claude-fable-5-1`; the rest with `claude-opus-5-5`.

## Phases

| NN | File | Exit condition |
|----|------|----------------|
| 00 | `00-scaffold.md` | `tauri dev` opens a Win95 window served by the daemon; `npm test` runs |
| 01 | `01-daemon-core.md` | Schema, REST, grants, audit, with boundary tests |
| 02 | `02-mcp.md` | All MCP tools, role-scoped, with scope tests |
| 03 | `03-templates.md` | Deterministic prompt rendering + brain FTS injection |
| 04 | `04-launcher.md` | Worktree + CLI spawn + pty over websocket |
| 05 | `05-lifecycle.md` | Full state machine, retries, deps, merge queue, ask_operator |
| 06 | `06-ui.md` | MDI board, ticket viewer, terminals, brain, settings, inbox |
| 07 | `07-tauri-hardening.md` | Sidecar lifecycle, CSP, capabilities, installer |
| 08 | `08-skills-docs.md` | Agent skills, finished docs, dogfood cycle |

After each phase the agent writes `log/NN-name.md` and deletes the handoff it executed. The next agent reads all of the log. That log is the brain until the board has one. In phase 8 the log is folded into the living docs and this folder is removed.
