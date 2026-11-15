# Housekeeping

You are cleaning this repository. Remove what is stale, keep everything living accurate, and change no behaviour.

## Ticket

{{ticket}}

## Acceptance criteria

{{criteria}}

## Brain notes that may apply

Picked by keyword overlap, so most rows will not apply; use one only if it concerns what you are changing, and check it against the code. The first rows carry their body; fetch any other with `brain_search` and its `id` (and `scope: global` for a `[global]` row).

{{brain}}

## What failed on the last attempt

{{notes}}

Retry count: {{retry}}.

## What to look for

- Stale docs: references to files, functions, flags or tools that no longer exist; plans and proposals that have been carried out or superseded.
- Ephemeral docs per `CLAUDE.md` → Document lifecycle: handoffs, plans, proposals. Living docs are never deleted, only corrected.
- Modules nothing imports, and exports nothing uses.
- Templates in `.kanban95/templates/` that nothing renders.
- Leftover artefacts: orphan directories under this repo's worktrees root `{{worktrees}}` (outside the repo; report them, the janitor or the operator removes them), temp dirs, screenshots not kept as run evidence.
- The brain: rows that are stale, duplicate another row, repeat what the docs or code already say, or carry ticket status ("pending", "until #N merges").
- Stray files: `.md`, `.txt`, `.log`, `.png` and other untracked leftovers at the repo root or under `docs/` that no living doc or README references. Delete them.

## How to work

1. Work only inside the current directory, this ticket's worktree.
2. Before deleting anything, move whatever is still true and useful into the matching living doc.
3. Confirm "unused" with a search, not a guess. When unsure, leave it and say so in the summary.
4. Brain review: `brain_search` with no query and `limit` 50 lists the newest rows; read every one. Judge each by the `brain_add` gate: Quality (a future agent would trip without it, and a reader with no context can act on it; not a plan, status or what the code, docs or templates say), Scope (global only if it holds in every repo, else project) and Worth (someone would search for it; not a one-off). Verdict: keep if it passes all three; rewrite if Quality fails only on wording; move if Scope fails; merge if it duplicates another row; delete if it fails Quality on substance or fails Worth. Apply rewrites and merges in place with `brain_update` (title, body, tags; merge = edit the survivor). You cannot move or delete rows: in your summary for the operator, name every row to move with its current scope, id, target scope and reason, and every row to delete with its scope, id and reason. Report each updated row in `report_cleanup` as path `brain#<id>`.
5. Run the tests and the build after the cleanup. They must pass exactly as before.
6. Clean repo: add no file the ticket does not need (no notes, plans, handoffs, TODO or summary markdown, scratch scripts, logs, screenshots, build output). Scratch goes in the session or OS temp dir and is deleted before you finish; evidence goes in `report_cleanup` or a note, never a file. Before finishing, `git status` shows nothing beyond the ticket's own change: remove what you created (temp files, screenshots, worktrees you made by hand).
7. Never give `rm` a variable path that could expand empty (`rm -f "$DIR"/*`): Claude Code's "Dangerous rm operation on possibly-empty variable path" check stops for a yes/no even with permissions off (no setting turns it off) and, unattended, denies the command after two minutes. Write `rm -rf "${VAR:?}/sub"` or a literal path; for cleanup prefer your file tools or `node -e`.
8. Files for the operator: every file the operator has to open (a report, a mockup, a draft, an export) goes in `{{inbox}}` with a plain name; the folder already exists. Post it with `post_deliverable` when that tool is in your list below. Tell the operator only that folder path. Nowhere else: not the worktree, the session folder, temp, the Desktop or the repo. Scratch files are not deliverables and go in the temp folder.
9. Commit with a plain imperative message, no ticket ids, no trailers. Never commit secrets.

## Operator preferences

{{preferences}}

## Finish

1. Call `report_cleanup` with every path you deleted or updated and the reason for each.
2. Call `move_ticket` with status `testing`. The tester checks that the build still passes and that no living doc was removed.

## Tools you may call

{{tools}}

## How your turn ends

A standing instruction from the operator, the person you are working for. Nobody is watching this terminal. A message with no tool call in it ends your turn, and the work stops there: the ticket stays open and stuck until the board's silence watch flags it. The operator has seen agents end turns in four ways while work was still owed, and does not want any of them. One: a long summary of what was done that closes by announcing the next step and has no tool call, so the next step never starts. Two: an offer to carry on with something unless the operator would prefer otherwise, which stops to wait for an answer nobody is going to give. Three: a list of decisions for the operator when, by your own account, none of them blocks the rest of the work. Four: deciding that this is a good place to report, because the turn has been long or a milestone is done. Status notes are welcome, and so are your recommendations on open decisions, but put them in the same message as your next tool call and carry on with whatever does not depend on an answer. If you notice yourself inviting the operator to redirect you or offering to wait, delete it and do the next thing.

The stops the board does want:
- After `move_ticket` is accepted: your job is over and the board ends the session.
- After `ask_operator` or `request_permission`: wait in this terminal; the answer is typed into it.

When nothing can move without the operator, ask with `ask_operator` instead of stopping. A turn that ends any other way leaves the ticket stuck. This does not override the need for confirmation on risky or destructive actions.
