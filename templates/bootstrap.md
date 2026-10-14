# Starter tickets

Set up this board (or the `bootstrap_board` tool) creates one Backlog ticket per `## <title>` section below, in order, each depending on the one before and tagged `setup`. The text under a title is the ticket's body; the lines under `Criteria:` are its acceptance criteria, one per line. Edit this file to change the set; it runs once per board.

## Write the board's intention

Write what this project is for and how the operator wants to work into the project preferences (Settings -> Prompts -> Preferences, project scope, saved as the project's `preferences.md`). Say which way of working applies: casual prompts with no remote, a GitHub repo, or a repo the board pushes to. Every agent reads these preferences in its brief, so keep them short and concrete.

Criteria:
The project preferences.md names what the project is for in a few sentences
The project preferences.md says how the operator works: casual prompts, a GitHub repo, or repo plus push

## Record the build and test commands

Find how this project installs its dependencies, builds and runs its tests. Put the install step in `.kanban95/config.json` `worktree_setup` (it runs once in each new ticket worktree) and add a `test` key holding the command agents run before submitting. Say in README or a file under `docs/` how to run both by hand.

Criteria:
.kanban95/config.json has worktree_setup and test, each a command that succeeds on the base branch
README or a file under docs/ says how to build and test the project

## Choose local-only or push

Decide with the operator whether merged work stays on this machine or is pushed. For push: add the remote and set the base branch's upstream once (`git push -u <remote> <base>`). For local-only: confirm the base branch has no upstream, so the Board's Push button stays hidden.

Criteria:
For push, git rev-parse --abbrev-ref @{u} on the base branch names the remote branch
For local-only, the base branch has no upstream and the Board shows no Push button

## Confirm the board is ready

Check `GET /api/ready` (the Readiness window, opened from a "Not ready" status bar line) until every item is ok and fix what is not. Then create and launch one tiny smoke ticket, a one-line README change, and watch it go through test and merge.

Criteria:
Every item of GET /api/ready is ok
A one-line README smoke ticket reached Done and its commit is on the base branch
