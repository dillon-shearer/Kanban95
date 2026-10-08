# Learning Kanban95

Living document. A guided tour for someone new to agent tooling: the handful of ideas the board is built from, what each one is in plain terms, and why Kanban95 uses it. Each stop ends with where to look in the code and which doc goes deeper. Read it top to bottom once; after that the other docs make sense on their own.

## 0. The cast

- **An agent** here is a coding assistant running in a terminal: Claude Code (`claude`) or Codex CLI (`codex`). You give it a task in words; it reads files, runs commands, edits code and commits, in a loop, until it decides it is done. It logs in to its provider with its own command; Kanban95 never sees that key.
- **The board** is this app: a kanban of tickets (Backlog, In Progress, Testing, Done). It does not write code itself. For each ticket it starts an agent, gives it a brief, watches what it reports, starts a second agent to test the work, retries on failure, and merges the result.
- **The operator** is you. You describe what you want, answer the occasional question, and otherwise leave it alone.

Three ideas make it safe to let several agents loose on one repository at the same time: a **worktree** per ticket, **MCP tools** as the only way an agent talks to the board, and a **grant** that says what each agent may do through those tools.

## 1. Worktrees: a separate checkout per ticket

**What it is.** A git repository normally has one working folder: the files you edit. `git worktree add` creates a second working folder for the same repository, on its own branch. Both folders share one history (one `.git`), so a commit in either is visible to the other, but the files on disk are separate. Editing `app.js` in one folder does not touch `app.js` in the other.

```
my-project/                  main checkout, branch main (yours)
my-project/.worktrees/t-12/  ticket 12's worktree, branch ticket/12
my-project/.worktrees/t-13/  ticket 13's worktree, branch ticket/13
```

**Why the board uses it.** Five agents editing one folder would overwrite each other's half-finished files and commit each other's changes. With one worktree each, every agent has a quiet copy of the project, its own branch, and a clean `git diff` that shows exactly what it changed, which is what the tester reviews. When the ticket passes, the board merges `ticket/12` into your branch and deletes the worktree. Your own main checkout is never edited by an agent; the only thing that lands there is a merge commit.

**What it is not.** A worktree is a folder, not a sandbox. A worker agent runs as your Windows user and could read or write outside its folder if it tried. The brief tells it not to, and `docs/SECURITY.md` → A malicious agent in a worktree lists honestly what it can and cannot reach.

**Two consequences you will meet.**
- A worktree forks from your branch when the ticket launches and does not see later commits by itself. When two tickets change the same lines, the second one to merge conflicts. The board aborts that merge, leaves your checkout as it was, and sends the ticket back to a worker in its kept worktree, which merges your branch in, resolves the conflict there and goes through testing again.
- The board will not create a ticket's worktree while your main checkout has uncommitted changes to tracked files, and holds a merge until they are gone (it retries every 30 seconds and asks you after 10 minutes), because a merge there would mix with your edits. Commit your own work, or do it in a worktree too.

**In the code.** `daemon/src/git.ts` (`createWorktree`, `removeWorktree`), `daemon/src/merge.ts` (the merge queue), `daemon/src/janitor.ts` (removes leftovers). Deeper: `docs/LIFECYCLE.md`.

## 2. MCP tools: how an agent talks to the board

**What it is.** The Model Context Protocol (MCP) is a standard way to give an agent extra tools. A tool is a named function with a description and typed arguments, for example `move_ticket(status)` or `brain_search(query)`. An MCP server publishes a list of tools; the agent CLI connects to it, shows the descriptions to the model, and when the model decides to call one, the CLI sends the call to the server and hands the result back. The model never sees how the tool works, only its name, description and result.

**Why the board uses it.** The board needs to hear from agents ("I'm done, please test this", "I have a question", "here is a gotcha for future tickets") and to give them information on request (the ticket, its dependencies, notes from earlier attempts, the project's brain). Scraping a terminal for that would be fragile. MCP gives both sides a typed, logged channel:

- **Pull over push.** An agent starts with a short brief and asks for more only when it needs it (`get_ticket`, `brain_search`), so its limited context is spent on the task, not on everything the board knows.
- **The board stays in charge.** Calling `move_ticket(testing)` does not move anything by itself; the daemon checks the request against the ticket's state machine, and refuses a move that makes no sense (testing a ticket that was never started).
- **Every call is recorded.** Each tool call writes one audit row: who, which ticket, which tool, the arguments, and whether it was allowed.

Kanban95's daemon is the MCP server, at `http://127.0.0.1:<port>/mcp`, reachable only from this machine. Claude Code and Codex are pointed at it when the board starts them.

**In the code.** `daemon/src/mcp.ts`: the `TOOLS` table holds every tool's description, who may call it, its argument schema and its handler. `docs/MCP.md` is generated from that same table, so the reference cannot drift from what runs.

## 3. Grants: what each agent is allowed to do

**What it is.** A grant is a permission slip the board writes for one agent session: a random token, the role it carries (`planner`, `worker` or `tester`), the ticket it is bound to, and an expiry. The agent presents the token with every MCP call (`Authorization: Bearer <token>`); the daemon looks it up and applies the role's rules. The database stores only a hash of the token, so a copy of `board.db` cannot be used to impersonate an agent.

**Why the board uses it.** Without grants any agent could call any tool on any ticket: a worker could mark its own work done and skip the tester, or edit another agent's ticket. A grant keeps each one in its lane:

| role | started for | may, for example | may not |
|---|---|---|---|
| planner | a brainstorm with you | create tickets, read the whole board | write files (Codex runs read-only; Claude Code runs without its edit, shell and subagent tools) |
| worker | building one ticket | read its ticket and its dependencies, add notes, ask you, move it to Testing | touch another ticket, move it to Done |
| tester | checking one ticket | report a test result, move it to Done or back to In Progress | move it to Done without first reporting a pass |

A grant is also **revocable** and **short-lived**. It is revoked the moment the session ends for any reason (the agent finished, crashed, or you pressed Revoke in Settings), and revoking it kills the agent's terminal. A token copied out of a session is useless once that session is over.

**In the code.** `daemon/src/grants.ts` (`mint`, `verify`, `revoke`), the role checks in `daemon/src/mcp.ts`. Deeper: `docs/SECURITY.md` → Grants and Agent sessions; the full who-may-call-what matrix is in `docs/MCP.md`.

## 4. How the pieces meet: one ticket, start to finish

1. You press **Launch** on ticket 12.
2. The daemon creates `.worktrees/t-12` on branch `ticket/12` (stop 1).
3. It renders the `execute` prompt template for ticket 12 (the ticket, its acceptance criteria, relevant brain notes, failure notes from an earlier attempt) and saves it as the run's brief.
4. It mints a worker grant for ticket 12 (stop 3) and starts the agent CLI in the worktree, in a terminal you can watch, connected to the board's MCP server with that grant (stop 2).
5. The agent builds the ticket, commits on `ticket/12`, posts a summary note and calls `move_ticket(testing)`. The board ends the session, which revokes the grant.
6. A tester agent starts in the same worktree with a tester grant and the diff. It reports pass or fail. A fail sends the ticket back to a fresh worker with the tester's notes, up to three retries.
7. On a pass, the merge queue merges `ticket/12` into your branch, one ticket at a time, and the janitor removes the worktree and branch. You hear a ding.

If anything needs you (a question, a crash, the retry cap), the card turns red and the Inbox says why and what to press.

## 5. Smaller ideas worth knowing

- **Prompt templates.** Every brief is a markdown file in `<repo>/.kanban95/templates/` with `{{variables}}` the board fills in. Edit one and the next launch uses it. `docs/AGENTS.md` lists the variables and what each template asks of an agent.
- **The brain.** A per-project notebook of decisions and gotchas, searchable by agents (`brain_search`) and written by them (`brain_add`). The board injects the few notes that best match a ticket into its brief, so a lesson learnt once reaches the next agent that needs it.
- **Models are config.** Which CLI, model and effort each phase uses is in `~/.kanban95/models.json`, set in Settings. Nothing in the code names a model.
- **Everything is local.** The daemon listens on `127.0.0.1` only, the window carries a per-start secret, and the board holds no provider key. `docs/SECURITY.md` explains each boundary.

## Where to go next

| to | read |
|---|---|
| drive the board | `docs/OPERATOR.md` |
| see how it is built | `docs/ARCHITECTURE.md` |
| follow a ticket's states, retries and merges | `docs/LIFECYCLE.md` |
| know what an agent receives and how it should behave | `docs/AGENTS.md` |
| look up a tool | `docs/MCP.md` |
| see how each CLI is started | `docs/CLIS.md` |
| check what is protected and what is not | `docs/SECURITY.md` |
| read the database schema | `docs/DATA.md` |
