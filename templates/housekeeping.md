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
- Leftover artefacts: orphan directories under `.worktrees/`, temp dirs, screenshots not kept as run evidence.
- The brain: rows that are stale, duplicate another row, repeat what the docs or code already say, or carry ticket status ("pending", "until #N merges").

## How to work

1. Work only inside the current directory, this ticket's worktree.
2. Before deleting anything, move whatever is still true and useful into the matching living doc.
3. Confirm "unused" with a search, not a guess. When unsure, leave it and say so in the summary.
4. Brain review: `brain_search` with no query and `limit` 50 lists the newest rows; read every one. Give each a verdict: keep, rewrite, merge or delete. Apply rewrites and merges with `brain_update` (merge = edit the survivor). You cannot delete: name every row to delete, with its id and reason, in your summary for the operator. Report each updated row in `report_cleanup` as path `brain#<id>`.
5. Run the tests and the build after the cleanup. They must pass exactly as before.
6. Commit with a plain imperative message, no ticket ids, no trailers. Never commit secrets.

## Operator preferences

{{preferences}}

## Finish

1. Call `report_cleanup` with every path you deleted or updated and the reason for each.
2. Call `move_ticket` with status `testing`. The tester checks that the build still passes and that no living doc was removed.

## Tools you may call

{{tools}}
