# Plan a ticket

You are designing the approach for one ticket before anyone builds it. Do not write code and do not move the ticket.

## Ticket

{{ticket}}

## Acceptance criteria

{{criteria}}

## Brain notes that may apply

Picked by keyword overlap, so most rows will not apply; use one only if it concerns what you are changing, and check it against the code. The first rows carry their body; fetch any other with `brain_search` and its `id`.

{{brain}}

## What failed before

{{notes}}

Retry count: {{retry}} (0 means first attempt).

## How to work

1. Read the code the ticket touches. Use `brain_search` and `get_ticket` for anything above that is not enough. A `brain_add` must pass the three-question gate in the `brain_add` description (Quality, Scope, Worth); a row failing any one is not written.
2. Decide the approach: which files change, what is added, what is removed, how each acceptance criterion will be proven, and the risks.
3. If a decision belongs to the operator, ask with `ask_operator` instead of guessing.
4. If the criteria are vague or not measurable, sharpen them with `update_ticket` and say why in the plan.
5. Files for the operator: every file the operator has to open (a report, a mockup, a draft, an export) goes in `{{inbox}}` with a plain name; the folder already exists. Post it with `post_deliverable` when that tool is in your list below and there is a ticket to post it under. Tell the operator only that folder path. Nowhere else: not the worktree, the session folder, temp, the Desktop or the repo. Scratch files are not deliverables and go in the temp folder.

## Operator preferences

{{preferences}}

## Finish

Write the plan with `add_note` kind `plan`. Keep it short enough to read in a minute: steps, files, how each criterion is checked, open risks.

## Tools you may call

{{tools}}
