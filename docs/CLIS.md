# Agent CLIs

Living document. How the board launches each CLI, with every flag checked against the installed tool. Re-verify with `--help` and update this file before changing `buildArgv` (`daemon/src/launcher.ts`).

Verified 2026-10-07 on Windows 11 against **Claude Code 2.1.293** and **codex-cli 0.154.0**.

## What the board does not do

The board never handles provider credentials. Each CLI logs in with its own command (`claude` then `/login`, `codex login`) and keeps its auth under the operator's home directory (`~/.claude/`, `~/.codex/`). The pty environment passes the home and app-data variables through so the CLI finds it; nothing else.

## Launch, common to both

1. `git worktree` `<repo>/.worktrees/t-<id>` on branch `ticket/<id>` (`daemon/src/git.ts`).
2. `startRun` renders the template and writes the `runs` row.
3. A grant is minted for the template's role.
4. `<repo>/.kanban95/sessions/<run-id>/` is created owner-only (Windows: `icacls /inheritance:r /grant:r <user>:(OI)(CI)F`; POSIX: mode 0700) and gets `prompt.md` and, for Claude Code, `mcp.json`.
5. The CLI starts in a pty with `cwd` = the worktree. The **initial message** is one line:
   `Read ../../.kanban95/sessions/<run-id>/prompt.md in full and follow it. It is your brief for this session.`
   The prompt is not put on the command line: Windows caps a command line at 32 767 characters (a test prompt carries the whole diff) and `cmd.exe` cannot pass a newline inside an argument.

On Windows the pty runs `cmd.exe /d /s /c "<cli> <args>"` so that `PATHEXT` resolves `claude.exe` and the `codex.cmd` npm shim. Arguments containing `"`, `%`, a newline, or ending in `\` are refused rather than escaped. `NoDefaultCurrentDirectoryInExePath=1` stops `cmd.exe` from running a `claude.cmd` that happens to sit in the worktree.

## Claude Code

```
claude --mcp-config <session>/mcp.json --strict-mcp-config --model <model> --effort <effort> --dangerously-skip-permissions "<initial message>"
```

| Need | Flag | Notes |
|---|---|---|
| model | `--model <model>` | alias or full name, taken from the board's model config |
| effort | `--effort <level>` | accepts `low medium high xhigh max`; the board uses `low medium high max` unchanged |
| MCP | `--mcp-config <file>` | variadic, so it comes first and a boolean flag separates it from the message |
| only the board's MCP | `--strict-mcp-config` | the operator's other MCP servers are not loaded into agent sessions |
| permissions off | `--dangerously-skip-permissions` | the worktree is the blast radius (`PLAN.md`) |
| initial message | positional `[prompt]` | interactive session; the operator can type into it |

`mcp.json`:

```json
{
  "mcpServers": {
    "kanban95": {
      "type": "http",
      "url": "http://127.0.0.1:<port>/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

The host must be `127.0.0.1`, not `localhost`: the daemon's origin guard refuses any other `Host`.

## Codex CLI

```
codex --model <model> -c model_reasoning_effort=<effort> -c mcp_servers.kanban95.url=http://127.0.0.1:<port>/mcp -c mcp_servers.kanban95.bearer_token_env_var=KANBAN95_TOKEN --dangerously-bypass-approvals-and-sandbox "<initial message>"
```

| Need | Flag | Notes |
|---|---|---|
| model | `--model <model>` (`-m`) | the model slug, e.g. `gpt-5.6-terra` |
| effort | `-c model_reasoning_effort=<level>` | config override; current GPT 5.6 models accept `low medium high xhigh max` (`ultra` on some). A model without `max` (`gpt-5.5`) is Codex's to reject, not the board's |
| MCP | `-c mcp_servers.kanban95.url=<url>` and `-c mcp_servers.kanban95.bearer_token_env_var=KANBAN95_TOKEN` | per-process override, verified with `codex -c ... mcp get kanban95 --json` (transport `streamable_http`). Nothing is written to `~/.codex/config.toml` |
| token | env `KANBAN95_TOKEN` | set only in the CLI's own pty environment, never on the command line. Commands the agent runs may see it; it is that agent's own grant |
| permissions off | `--dangerously-bypass-approvals-and-sandbox` | matches Claude Code's mode; `--full-auto` does not exist in 0.154. `-s workspace-write -a never` would confine writes, but a worktree's git metadata lives in the main repo's `.git/worktrees/`, outside the workspace; not evaluated yet |
| initial message | positional `[PROMPT]` | interactive TUI |

`-c` values are unquoted on purpose: a value that is not valid TOML is taken as a literal string, so `high` and the URL need no quotes, and no `"` has to cross `cmd.exe`.

Codex has no equivalent of `--strict-mcp-config`; MCP servers from the operator's own `~/.codex/config.toml` still load in agent sessions.

## Effort

| Board effort | Claude Code | Codex |
|---|---|---|
| low | `--effort low` | `-c model_reasoning_effort=low` |
| medium | `--effort medium` | `-c model_reasoning_effort=medium` |
| high | `--effort high` | `-c model_reasoning_effort=high` |
| max | `--effort max` | `-c model_reasoning_effort=max` |

Both installed CLIs have an effort control, so there is no "unsupported" path. If a future CLI lacks one, add it here first.

## First-run prompts (operator, once)

Both CLIs ask whether to trust a folder the first time they open it, and a new worktree is a new folder. The board does not answer these for the operator.

- **Claude Code**: "Quick safety check: Is this a project you created or one you trust?" in each new worktree.
- **Codex**: "Do you trust the contents of this directory?" likewise.

Until the lifecycle (phase 5) handles this, the operator answers it in the agent's terminal window. Claude Code's one-time `--dangerously-skip-permissions` warning appears too if it was never accepted on this machine.

Claude Code also applies the operator's user-level settings (`~/.claude/settings.json` hooks, user `CLAUDE.md`) inside agent sessions; `--strict-mcp-config` only covers MCP servers.

## Checked live

Both CLIs, launched by `launch()` on a scratch repo with a template that only says "call get_ticket", reached `/mcp` with their token and wrote an `ok` `get_ticket` audit row for their own ticket; the session dir was gone after shutdown.
