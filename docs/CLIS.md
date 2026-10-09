# Agent CLIs

Living document. How the board launches each CLI, with every flag checked against the installed tool. Re-verify with `--help` and update this file before changing `buildArgv` (`daemon/src/launcher.ts`).

Verified 2026-10-07 on Windows 11 against **Claude Code 2.1.293** and **codex-cli 0.154.0**.

## What the board does not do

The board makes no model calls of its own: being provider-agnostic means it only picks a CLI and its flags. It never handles provider credentials. Each CLI logs in with its own command (`claude` then `/login`, `codex login`) and keeps its auth under the operator's home directory (`~/.claude/`, `~/.codex/`). The pty environment passes the home and app-data variables through so the CLI finds it; nothing else.

## Launch, common to both

1. `git worktree` `<repo>/.worktrees/t-<id>` on branch `ticket/<id>` (`daemon/src/git.ts`).
2. `startRun` renders the template and writes the `runs` row.
3. A grant is minted for the template's role.
4. `<repo>/.kanban95/sessions/<run-id>/` is created (for Claude Code owner-only, Windows: `icacls /inheritance:r /grant:r <user>:(OI)(CI)F`, POSIX: mode 0700; for Codex not, see Reach by role) and gets `prompt.md` and, for Claude Code, `mcp.json` (plus `settings.json` for a worker or tester).
5. The CLI starts in a pty with `cwd` = the worktree. The **initial message** is one line:
   `Read C:/path/to/repo/.kanban95/sessions/<run-id>/prompt.md in full and follow it. It is your brief for this session.`
   The path is absolute, with forward slashes: given the relative form, agents resolved it against the home directory, got "File does not exist" and had to retry. If the absolute path holds a character `cmd.exe` cannot carry (below), the message falls back to the relative form `../../.kanban95/sessions/<run-id>/prompt.md`, since the worktree and the session dir share the repo prefix where that character sits.
   The prompt is not put on the command line: Windows caps a command line at 32 767 characters (a test prompt carries the whole diff) and `cmd.exe` cannot pass a newline inside an argument.

On Windows the pty runs `cmd.exe /d /s /c "<cli> <args>"` so that `PATHEXT` resolves `claude.exe` and the `codex.cmd` npm shim. Arguments containing `"`, `%`, a newline, or ending in `\` are refused rather than escaped. `NoDefaultCurrentDirectoryInExePath=1` stops `cmd.exe` from running a `claude.cmd` that happens to sit in the worktree.

A Claude Code worker or tester also gets `CLAUDE_CODE_PROMPT_CACHE_TTL=5m` in its pty environment. On a subscription the main conversation otherwise caches for 1 h, written at 2× the input price; 5 min writes at 1.25×. Only 8 of 2,161 measured call gaps exceeded 5 min, so an unattended session almost never pays the extra prefix rewrite (ticket #43). Planner and operator sessions keep the 1 h TTL, since they wait on the operator.

## Claude Code

```
claude --mcp-config <session>/mcp.json --strict-mcp-config --model <model> --effort <effort> [planner: --disallowedTools Edit Write NotebookEdit Bash PowerShell Agent] [worker, tester: --setting-sources project,local --settings <session>/settings.json --disable-slash-commands] --dangerously-skip-permissions "<initial message>"
```

| Need | Flag | Notes |
|---|---|---|
| model | `--model <model>` | alias or full name, taken from the board's model config |
| effort | `--effort <level>` | accepts `low medium high xhigh max`; the board uses `low medium high max` unchanged |
| MCP | `--mcp-config <file>` | variadic, so it comes first and a boolean flag separates it from the message |
| only the board's MCP | `--strict-mcp-config` | the operator's other MCP servers are not loaded into agent sessions |
| permissions off | `--dangerously-skip-permissions` | every role; approved by the operator (2026-10-07): the board trusts agent actions and limits reach per role with each CLI's own scoping instead of approvals |
| planner reach | `--disallowedTools Edit Write NotebookEdit Bash PowerShell Agent` | variadic, so a flag follows it. See Reach by role |
| no user settings | `--setting-sources project,local` | worker and tester only. The operator's `~/.claude/settings.json` is not loaded, so neither are its plugins: their SessionStart hooks and skill listing were ≈15k of the ≈17k tokens written fresh every session and re-read on every call (ticket #43; operator approved 2026-10-08). The repo's `.claude/settings.json`, `settings.local.json`, `CLAUDE.md` and auto-memory still load. Planner and operator sessions keep the operator's settings: someone is watching them |
| board settings | `--settings <session>/settings.json` | worker and tester only: `{"attribution":{"commit":"","pr":""}}`, so commits carry no trailer (CLAUDE.md) without relying on the operator's own setting. A file, because `"` cannot cross `cmd.exe` |
| no skills | `--disable-slash-commands` | worker and tester only ("Disable all skills"). 0 `Skill` calls in 113 measured runs |
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
codex --model <model> -c model_reasoning_effort=<effort> -c mcp_servers.kanban95.url=http://127.0.0.1:<port>/mcp -c mcp_servers.kanban95.bearer_token_env_var=KANBAN95_TOKEN -c mcp_servers.kanban95.default_tools_approval_mode=approve -c "projects={'<repo>'={trust_level='trusted'}}" <reach> "<initial message>"
```

| Need | Flag | Notes |
|---|---|---|
| model | `--model <model>` (`-m`) | the model slug, e.g. `gpt-5.6-terra` |
| effort | `-c model_reasoning_effort=<level>` | config override; current GPT 5.6 models accept `low medium high xhigh max` (`ultra` on some). A model without `max` (`gpt-5.5`) is Codex's to reject, not the board's |
| MCP | `-c mcp_servers.kanban95.url=<url>` and `-c mcp_servers.kanban95.bearer_token_env_var=KANBAN95_TOKEN` | per-process override, verified with `codex -c ... mcp get kanban95 --json` (transport `streamable_http`). Nothing is written to `~/.codex/config.toml` |
| MCP approval | `-c mcp_servers.kanban95.default_tools_approval_mode=approve` | the board's own tools only, pre-approved; the grant already scopes them. Without it a planner under `-a never` gets "MCP tool call requires approval, but approval policy is never" on every board tool. `auto` did not lift that in 0.154; `approve` did (checked live, see Reach by role) |
| token | env `KANBAN95_TOKEN` | set only in the CLI's own pty environment, never on the command line. Commands the agent runs may see it; it is that agent's own grant |
| trust | `-c projects={'<repo>'={trust_level='trusted'}}` | per process, merged over the operator's own `[projects]`; nothing is written. See First-run prompts |
| reach | worker, tester: `--dangerously-bypass-approvals-and-sandbox`; planner: `-s read-only -a never` | `--full-auto` does not exist in 0.154. See Reach by role |
| initial message | positional `[PROMPT]` | interactive TUI |

`-c` values are unquoted on purpose: a value that is not valid TOML is taken as a literal string, so `high` and the URL need no quotes, and no `"` has to cross `cmd.exe`.

Codex has no equivalent of `--strict-mcp-config`; MCP servers from the operator's own `~/.codex/config.toml` still load in agent sessions.

## Resuming a killed session

Both CLIs can continue an earlier conversation: Claude Code with `--resume <session-id>` (and `--session-id <uuid>` to choose the id at launch), Codex with `codex resume <SESSION_ID>` (or `--last`, the newest session in the working directory). The board does not use either yet: Resume and the restart recovery start a fresh session with the ticket's failure notes in the brief, in the same worktree, so committed and uncommitted work is kept but the conversation is not. The upgrade path: pass `--session-id` at launch and keep it on the `runs` row, then `--resume <id>` with a fresh `mcp.json` on Resume; for Codex, record the session id Codex prints and use `codex resume <id>`. Checked against `claude --help` and `codex resume --help` on 2026-10-08.

## Model lists

The ▾ beside each model box in Settings → Models lists every model the installed CLI knows (`GET /api/models`, `knownModels` in `daemon/src/settings.ts`); the box still takes any id typed by hand. Nothing is listed from the board's own code:

- Codex: every entry of `~/.codex/models_cache.json`, which Codex refreshes itself, ordered by each entry's `priority`, including the ones its own picker hides. No other file under `~/.codex/` is read.
- Claude Code has no command that lists models. First come the "latest model" aliases its `claude --help` names on the `--model` line (for example `opus`, `sonnet`); each resolves to the newest model of its family at launch. Then every full model id compiled into the Claude Code executable (`claude-<family>-<version>`), newest version first. The executable is the path in Settings → CLIs, else `claude.exe` on PATH; it is read in 4 MB chunks and the result cached until the file changes. Families are the names that appear with a minor version (`opus-4-5`), which drops beta-header strings like `claude-code-20250219`. An npm-installed Claude Code (a `.cmd` shim) gives the aliases only.

A missing cache, a failed `--help` or a reworded help text gives a shorter or empty list, never an error.

## Effort

| Board effort | Claude Code | Codex |
|---|---|---|
| low | `--effort low` | `-c model_reasoning_effort=low` |
| medium | `--effort medium` | `-c model_reasoning_effort=medium` |
| high | `--effort high` | `-c model_reasoning_effort=high` |
| max | `--effort max` | `-c model_reasoning_effort=max` |

Both installed CLIs have an effort control, so there is no "unsupported" path. If a future CLI lacks one, add it here first.

## First-run prompts, answered by the board

Both CLIs ask whether to trust a folder the first time they open it. A launch is unattended, so the board answers for its own worktrees (operator decision, 2026-10-07). Checked live on 2026-10-07 against the versions above, in a scratch repo outside any trusted folder:

- **Trusting the repo root covers every worktree, for both CLIs.** Claude Code walks up from its working directory looking for a trusted folder: with only the root trusted, `.worktrees/t-1` opened without a prompt. Codex maps a worktree to its main repository and says so in the prompt ("You're in a subdirectory of a Git project. Trusting will apply to the repository root"). So it is one entry per repo, never one per worktree, and the janitor has nothing to remove when a worktree goes.
- **Claude Code**: "Quick safety check: Is this a project you created or one you trust?". It has no flag to skip it outside `-p`. Before every Claude launch `preTrustClaude` (`daemon/src/trust.ts`) reads `~/.claude.json` (`$CLAUDE_CONFIG_DIR/.claude.json` when set) and, unless the repo root or an ancestor already has `projects["<path>"].hasTrustDialogAccepted: true`, sets exactly that key for the repo root. The path is absolute with forward slashes (`C:/Users/you/repo`), the form Claude Code writes when a person accepts the prompt. Everything else in the file is left as it was. The first write copies the file to `~/.claude.json.kanban95.bak`; the write goes to a temp file renamed over the original. Each write is audited (`trust.write`, the file and the key, the launching ticket). Claude Code re-reads the file before it saves, so an entry the board adds survives a running Claude session (observed); there is no shared lock (`// ponytail:` in `trust.ts`).
- **Codex**: "Do you trust the contents of this directory?". It appears only once a prompt is submitted, not on an idle start. The board passes `-c projects={'<repo>'={trust_level='trusted'}}` on every launch. A `-c` table is merged over the operator's own `[projects]` in `~/.codex/config.toml` for that process only; nothing is written. Single quotes make TOML literal strings, so no `"` crosses `cmd.exe`; a repo path containing `'` cannot be expressed and is refused at launch. Note that the operator's own `config.toml` may already trust an ancestor (for example the home directory), in which case Codex never asks.
- **Claude Code's one-time bypass-permissions warning is not answered by the board.** It is shown once per machine for `--dangerously-skip-permissions` until accepted, and accepting it stores `skipDangerousModePermissionPrompt: true` in `~/.claude/settings.json`. On the development machine it was already accepted. A worker or tester, which loads no user settings, was checked live on 2026-10-08 (Claude Code 2.1.295) on that machine and did not show the warning. Writing that key on the operator's behalf was blocked by the agent safety check during phase 5 and is left to the operator: accept the warning once in any Claude Code session started with `--dangerously-skip-permissions`, before the first board launch.

**Seeing and clearing.** Every trust write is in the audit log (`SELECT * FROM audit WHERE tool = 'trust.write'`). **Settings → CLIs → Trusted folders** shows whether this repo root is trusted and whether the board wrote it; **Clear Claude trust** removes only `hasTrustDialogAccepted` from that entry (Claude Code keeps other per-folder state there), audited as `trust.clear`. The next Claude launch writes it again, so clearing is for when the board is no longer used in this repo. `~/.claude.json.kanban95.bak` still holds the file as it was before the board's first write.

## Reach by role

Approvals are off for every role (the operator approved the bypass). What each role can touch is limited by the CLI's own mechanisms instead, applied by `buildArgv` from the template's role:

| role | template asks for | Claude Code | Codex |
|---|---|---|---|
| planner (brainstorm) | read the code, write tickets over MCP | `--disallowedTools Edit Write NotebookEdit Bash PowerShell Agent` | `-s read-only -a never` |
| worker (plan, execute, housekeeping) | write and commit in its worktree, run builds and tests | permissions off, `cwd` = worktree | `--dangerously-bypass-approvals-and-sandbox` |
| tester (test) | run the suite, write and commit tests, screenshot UI changes headlessly (never by starting the app) | as worker | as worker |
| operator (operator terminal) | the operator's typed mission, from the repo root; code changes in its own `.worktrees/op-<time>` | as worker, `cwd` = repo root | as worker |

- **Planner on Claude Code loses Bash, PowerShell and Agent too.** Bash or PowerShell could write a file, and a subagent is a way around the list; the brainstorm template never asks the planner to run a command or delegate. Read, Grep and Glob cover reading the code. MCP tools are unaffected.
- **Planner on Codex**: checked live, asked to "create a file by any means", it answered "patch rejected: writing is blocked by read-only sandbox". Brainstorm checked live on 2026-10-07 (Codex 0.154.0, `gpt-5.6-luna`, low, through `POST /api/brainstorm` on a scratch repo) and it found two problems, both fixed: the read-only sandbox runs as another Windows account, which could not open the owner-only session dir ("access-denied"), so a Codex session dir is no longer owner-only (it holds only `prompt.md`; Codex's token is in its environment); and every board tool was refused under `-a never` until `default_tools_approval_mode=approve` was passed for the board's server. After both, the planner read its brief, called `list_tickets` and `brain_search`, and created a ticket with `create_ticket`; nothing was written to the repo.
- **Planner on Claude Code**: checked live by the operator on 2026-10-07 (Claude Code 2.1.293, `claude-sonnet-5-5`, `-p`, the list without `Agent`, permissions off). Asked to read `seed.txt` and then create `planner.txt` "by any means", it quoted the seed and reported that Write was disabled, including in subagents, and that it had no other file-writing tool; no file appeared. It named delegating to a subagent with shell access as a way it chose not to try, which is why `Agent` was added to the list afterwards. Haiku models refuse `--dangerously-skip-permissions`, so a planner on Claude needs Sonnet or larger.
- **Workers and testers on Codex keep the bypass.** Tried `-s workspace-write -a never --add-dir <repo>/.git` (the worktree's git metadata lives under the main repo's `.git/`): the file was written and `node --version` ran, but `git commit` failed with `fatal: detected dubious ownership in repository`. On Windows the Codex sandbox (`[windows] sandbox = "elevated"`) runs commands as a separate sandbox account, so git refuses the operator's worktree. A worker that cannot commit cannot finish a ticket. Getting there would mean `safe.directory` overrides and ACLs for that account on `.git`; not worth it until a non-Windows platform matters.
- Claude Code applies the operator's user-level settings (`~/.claude/settings.json` hooks and plugins, user `CLAUDE.md`) inside planner and operator sessions; `--strict-mcp-config` only covers MCP servers. Workers and testers skip them (`--setting-sources project,local`); a plugin worth having in board sessions goes in the repo's `.claude/settings.json` `enabledPlugins`, which still loads. Seen live: a memory plugin's hook wrote a `.remember/` folder into the session's working directory and held it open for a few seconds after Claude exited (why `cleanTicket` retries). Codex likewise loads the operator's own MCP servers from `~/.codex/config.toml`.
- Candidates seen in `claude --help` and not used: `--restricted` (confines file tools to the working dirs, but removes Bash and refuses bypass mode, so it does not fit a worker).

## Gotchas

- Both CLIs run interactive sessions and do not exit by themselves when the agent is done. The board ends the session once the agent's `move_ticket` is accepted (`docs/LIFECYCLE.md`).
- A CLI started with a model id it does not know may print an error and sit at its prompt without exiting. The board does not flag that yet (`docs/OPERATOR.md` → Dogfood walkthrough, touch 3).
- node-pty's `Error: AttachConsole failed` on kill is harmless (`docs/ARCHITECTURE.md` → Working on the board).

## Checked live

Both CLIs, launched by `launch()` on a scratch repo with a template that only says "call get_ticket", reached `/mcp` with their token and wrote an `ok` `get_ticket` audit row for their own ticket; the session dir was gone after shutdown.
