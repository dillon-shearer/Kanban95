# Agents on a Kanban95 board

Living document. How an agent session is expected to behave, derived from the default prompt templates in `templates/`. If a template changes what it asks of an agent, change this file in the same ticket.

## What an agent is given

Each session starts from one rendered template. The board pushes only this; everything else the agent pulls over MCP (`get_ticket`, `brain_search`). No transcripts of earlier sessions are ever injected.

| variable | contents |
|---|---|
| `{{ticket}}` | `#<id> <title>`, a blank line, the body; when the ticket has attachments, a blank line and `Attachments (open with your file reader):` with one `- <absolute path>` line each |
| `{{criteria}}` | the acceptance criteria as written on the ticket |
| `{{brain}}` | up to 8 brain rows, from the project and the global brain in one ranking, matching any word (3+ letters) of the ticket's title and body, best first (`bm25` with title ×10, tags ×5, body ×1). A global row is prefixed `[global] ` (`- [global] [#id] title`). The first 2 as `- [#id] title: body`, the rest as an index line `- [#id] title · tags` the agent fetches with `brain_search` `id`. Capped at 2500 characters and cut only between rows (a body that does not fit falls back to its index line); a cut is marked `[brain truncated; search for more with brain_search]` |
| `{{notes}}` | notes written since the latest execute run of this ticket started (`attemptNotes` in `daemon/src/context.ts`). A worker gets the `failure` notes, i.e. what went wrong in the attempt being retried. A tester also gets the worker's `decision` and `summary` notes of the attempt under test, each marked `[role kind]`. Earlier cycles are left out |
| `{{retry}}` | the ticket's retry count, `0` on the first attempt |
| `{{diff}}` | test sessions only: `git diff --stat <base>...HEAD` of every changed file, then the diff of code and config only. Markdown, `docs/` and lockfiles are named in the stat but their hunks are left out, and the rest is capped at 32 000 characters with a `[diff truncated: run git diff <base>...HEAD -- <path>]` marker (`gitDiff` in `daemon/src/context.ts`). The tester pulls any file it needs. Empty in every other template |
| `{{base}}` | the branch the ticket's worktree forked from and merges into (the main checkout's current branch); `(none)` for a brainstorm or operator terminal |
| `{{tools}}` | the MCP tools this session's role may call, with the access cell from `docs/MCP.md` |
| `{{preferences}}` | the operator's standing instructions, `~/.kanban95/preferences.md` as written (Settings → Prompts), under every template's "## Operator preferences" heading |
| `{{worktrees}}` | the repo's worktrees root, `<board home>/worktrees/<repo key>` (`worktreesRoot` in `daemon/src/git.ts`), outside the repo; every ticket's worktree is a `t-<id>` folder in it. Set in every template |
| `{{mission}}` | an operator terminal's typed mission, or a brainstorm's starting notes (Notepad → New brainstorm from selection), verbatim. `(none)` everywhere else. A launch with text whose template lacks `{{mission}}` (a repo copy older than the slot) is refused, not run without it |
| `{{ready}}` | brainstorm and operator terminal: one line per failing readiness item, `- <id>: <fix>`, or `ready` (`readiness` in `daemon/src/ready.ts`, `docs/OPERATOR.md` → Readiness). `(none)` in ticket templates |

Empty values render as `(none)`, except `{{diff}}` outside a test session (empty) and the attachments block (left out when there are none). Values are inserted literally: a brain note containing `{{ticket}}` stays that text. A template naming a variable that has no value is refused, never rendered.

## Templates and roles

| template | grant role | `runs.phase` | job |
|---|---|---|---|
| `brainstorm.md` | planner | no run (no ticket) | interview the operator, create tickets |
| `operator.md` | operator | no run (no ticket) | carry out the operator's typed mission with the operator's reach on the board |
| `plan.md` | worker | plan | design pass for one ticket, write a `plan` note. The board does not launch it today: the lifecycle starts only `execute`, `housekeeping` and `test` sessions, and the `plan` phase settings in `models.json` are used by brainstorms (operator terminals use the `operator` phase) |
| `execute.md` | worker | execute | build the ticket in its worktree |
| `housekeeping.md` | worker | execute | clean stale docs, dead modules, leftover artefacts |
| `test.md` | tester | test | check the work against the criteria |

A repo renders its own copies in `.kanban95/templates/`, copied from `templates/`. On daemon start an unedited copy is replaced by a changed default; a copy edited in Settings → Prompts is kept and shown stale (`docs/ARCHITECTURE.md` describes the `.shipped.json` record). When a ticket adds a template variable, the running board is still the old build and refuses every launch whose template names it. Order: merge, then restart the board, which refreshes the unedited copies. Never write the new variable into `.kanban95/templates/` by hand before that restart.

## Expected behaviour

**Planner (brainstorm).** Interviews the operator in its own terminal, one question at a time, waiting for each reply, before proposing anything. It has no `ask_operator`: that tool is for ticket agents only (worker, tester), since it needs a running ticket. It reads the code and brain, agrees the list with the operator, then calls `create_ticket` for each: imperative title, a body saying what and why, measurable acceptance criteria one per line, `depends_on`, and `model`/`effort` only when clearly warranted (`low` for trivial, `high` for hard). Writes no code and changes nothing in the repo checkout; writes a file the operator asks for outside the repo and names its path. Removes a ticket it made by mistake with `delete_ticket` (Backlog, no notes, no runs). Turns brain rows that record a bug found but not fixed, or unbuilt work, into tickets and then deletes them (`brain_delete`). Ends by listing what it created.

**Operator terminal (operator).** The operator's hand on the board. Reads `CLAUDE.md`, pulls only the context the mission needs (`list_tickets`, `get_ticket`, `brain_search`), does the work, and records decisions and gotchas with `brain_add`. Changes code only in a worktree under `{{worktrees}}/op-<time>` and merges it into the main checkout itself once the tests pass, because ticket agents may be running and the merge queue merges there. Commits as the operator with a plain imperative subject. Creates tickets only when the mission says so. Ends with a short written summary in its terminal. Never calls `report_test`. Like the planner it is interactive, so it asks the operator in its terminal and has no `ask_operator`.

**Planner of one ticket (plan; not launched by the board today).** Reads the code, decides files, steps, how each criterion will be proven and the risks. Sharpens vague criteria with `update_ticket`. Writes one short `plan` note. Does not code or move the ticket.

**Worker (execute).**
- Works only inside the current directory, the ticket's worktree.
- Reads only what the change needs: `CLAUDE.md` (loaded by the CLI) points it at `docs/ARCHITECTURE.md` → Working on the board, the ARCHITECTURE section for the part it touches and that part's living doc, not the whole of README and ARCHITECTURE up front. Each file read early is paid again on every later call of the session (ticket #43).
- Installs dependencies in the worktree itself (`npm install`, or the repo's equivalent), never junctions or symlinks the main checkout's `node_modules` or anything else of the main checkout's into it: removing the worktree, or a tool deleting through the link, reaches the main checkout's files. The tester's template says the same.
- Verifies with `npm run build` and `npm run test:changed -- <base>` (or a script built on `daemon/test/cdp.ts`). Nothing it runs may create a window, dialog, Dock icon or notification on the operator's desktop, on any platform: not `npm run dev`, `cargo run`, the built shell binary, `open` or `open -a`, `osascript`, a browser without `--headless=new`, a Swift, Python or Node program that makes a window, or the installer. It uses tests, `daemon/test/cdp.ts`, `npm run shot` or `npm run shot:mac` (WebKit screenshots below) instead. Both `npm run dev` and the shell binary refuse to start while `KANBAN95_AGENT` is set (every agent's pty has it): the shell exits with code 1 and one line on stderr before any window exists. A check that needs the real app is written as a manual check for the operator (the worker in its summary and `ask_operator`, the tester in its `report_test` summary), never done by the agent. The planner never asks for proof in the real app. It never runs the full `npm test`, which is the operator's, by hand (Verification below).
- Puts new tests in a new file named for the feature (`daemon/test/<feature>.test.ts`) unless it is extending an existing test's scenario: several tickets run at once and appending to a shared test file is the most common merge conflict.
- Records decisions with `add_note` kind `decision`, gotchas for future tickets with `brain_add` (rules below in The brain).
- Before finishing, `brain_search`es the subsystems it changed and `brain_update`s every row the change made false; names rows to delete in its summary.
- Asks with `ask_operator` instead of guessing, once, with the options it sees.
- Files a manual touch or follow-up it finds with `create_ticket` instead of expanding its own scope. The ticket lands in Backlog with `Filed by #<its ticket>` at the top of the body and runs on the operator's default model and effort. The same session may fix it with `update_ticket` (title, body, criteria, dependencies) or remove it with `delete_ticket` while it is in Backlog; no other ticket (`docs/SECURITY.md` → MCP).
- Never commits secrets and never reads a `.env`.
- Never gives `rm` a variable path that could expand empty; writes `rm -rf "${VAR:?}/sub"` or a literal path, or cleans up with its file tools or `node -e`. Claude Code's "Dangerous rm operation on possibly-empty variable path" check asks even with permissions off, no setting turns it off, and unattended it denies after two minutes (`docs/LIFECYCLE.md` → Claude Code prompts). `execute.md`, `test.md`, `operator.md` and `housekeeping.md` all carry this rule.
- Clean repo: adds no file the ticket does not need (notes, plans, handoffs, TODO or summary markdown, scratch scripts, logs, screenshots, build output). Scratch lives in the session or OS temp dir and is deleted before finishing; evidence goes in notes, `report_test` or `report_cleanup`. `git status` shows nothing beyond the ticket's change. `execute.md`, `test.md`, `operator.md` and `housekeeping.md` all carry this rule (`templates.test.ts` checks), and the housekeeper also deletes stray unreferenced `.md`, `.txt`, `.log`, `.png` files at the repo root and under `docs/`.
- Commits in the worktree with a plain imperative subject, no ticket or phase ids, no trailers.
- Finishes with `test:changed` and the build passing, a `summary` note, then `move_ticket(testing)`. Once the move is accepted the board ends the session and starts the tester; nothing after it is read.
- An `ask_operator` keeps the session open: the operator's answer is typed into the terminal as one line.
- On a retry, fixes the failure notes first.
- When the ticket's work is already on the base (another ticket landed it), makes no change: proves each criterion against the code, posts a `decision` note naming the base commits that did the work and the evidence, and submits the empty branch as usual (`docs/LIFECYCLE.md` → Work already on the base).
- When a failure note reports a merge conflict (`merge conflict with <base>: …`, written when the board merges the base into the worktree on submit or in the merge queue), runs `git merge {{base}}` in the worktree, resolves keeping both sides' intent (two tests added at one spot: keep both), runs `test:changed` and the build, commits, and submits as usual. The tester runs again and the merge is queued again. When it says `worktree has uncommitted changes`, commits or discards them and submits again.

Claude Code workers and testers run without the operator's user settings, plugins and skills, and on a 5 minute prompt cache (`docs/CLIS.md` → Claude Code). The board's guidance reaches them through the template and `CLAUDE.md` only.

**Tester (test).** Runs `npm run build` and `npm run test:changed -- <base>` once, reviews `{{diff}}` against each criterion (pulling with `git diff <base>...HEAD -- <path>` every file the inline diff leaves out that a criterion is about), writes and commits tests for new behaviour that has none (in a new file named for the feature, as the worker does, iterating on them with `test:changed`), for UI tickets takes screenshots with a headless script built on `daemon/test/cdp.ts` (no window, under the rule in the worker list above), and deletes every artefact not kept as evidence. Names, by id, any brain row the diff made false. Reads the worker's decision and summary notes in `{{notes}}` as claims to check, not facts. With an empty diff (`(none)`) it judges each criterion against the code on the base, runs the checks the criteria name, and passes when all hold; an empty diff alone is never a failure. Finishes with one call, `report_test` (verdict, per-criterion summary, evidence), which is also the move and ends the session: `passed: true` moves the ticket to done and queues the merge; `passed: false` moves it back to in_progress and starts the next execute attempt, up to three retries (`docs/LIFECYCLE.md`). It is refused on a ticket not in testing. No `move_ticket` is needed; one to the column the report already chose returns the ticket unchanged.

**Housekeeper (housekeeping).** Created by the board after every 10th merged ticket (Settings → Agents → Housekeeping), and run through the same test and merge path as any ticket. Finds stale docs, ephemeral docs that are superseded, modules with no importers, templates nothing renders, orphan worktrees, temp dirs, stray screenshots, and untracked or unreferenced `.md`, `.txt`, `.log`, `.png` files at the repo root or under `docs/`. Reviews every brain row (keep, rewrite, move, merge, delete): applies rewrites and merges with `brain_update`, reports each as `brain#<id>` in `report_cleanup`, and names for the operator the rows to move (current scope, id, target scope, reason) and to delete. Its worker grant cannot `move_to`. Moves anything durable into the matching living doc, then deletes. Confirms "unused" by search. Changes no behaviour; tests and build must pass as before. Calls `report_cleanup` with every path and reason, then `move_ticket(testing)`. Its tester checks the build still passes and no living doc was removed.

## Verification

The full suite (`npm test`: `tsc`, then unit tests plus a small set of critical-path tests with real git, ptys and headless Edge, at most 5 minutes; docs/ARCHITECTURE.md → Working on the board) is run by the operator by hand only; the board never runs it. Both the worker and the tester run `npm run build` and `npm run test:changed -- <base>` (`daemon/test/changed.ts`; `<base>` defaults to `main`), which runs only the test files the worktree's changes against the base can affect, committed, staged or not. A broken test outside the diff is caught when a later ticket touches that area or the operator runs `npm test`:

- vitest's module graph (`vitest related` on the `unit` project, fed the same changed-file list `vitest --changed <base>` reads): every unit test file that imports a changed `daemon/` file, directly or through other modules. Nearly every test reaches `server.ts`, which imports `api.ts`, which imports most of `src/`, so a change to a shared module still runs most of the suite; a leaf like `mcp-doc.ts` runs one file. A changed `package.json` or `vitest.config.*` runs every file (vitest's `forceRerunTriggers`).
- pty, browser and restart files (`daemon/test/projects.ts` sorts them, as `vitest.config.ts` does), in a second vitest run after the first: only those that import a changed file themselves, or through a changed test helper (`board.ts`, `ui.ts`, `cdp.ts`). A `daemon/src` file imported only by shared helpers (`server.ts` through `ui.ts`, `lifecycle.ts` through `memory.ts`) does not run every file that uses the helper; the full suite catches the rest. Every browser file runs for a `ui/**` change or a change to `test/browser-setup.ts`; `npm run test:changed -- <base> --pty` or `--browser` runs every file of that kind.
- a path mapping for what the graph cannot see: `templates/**` and `skills/**` run `templates.test.ts`; `templates/operator.md` and `templates/housekeeping.md` also run `operator.test.ts`; `daemon/migrations/global/**` runs `brain-global.test.ts` and the other `daemon/migrations/**` run `db.test.ts`; `docs/MCP.md` runs `mcp.test.ts` and `docs/LIFECYCLE.md` runs `lifecycle.test.ts`. A new doc drift test adds its row to `DOC_TESTS` there.
- A change that maps to nothing (`README.md`, other docs) runs nothing and says so. It runs no `tsc`, so the worker runs `npm run build` as well; `server.test.ts` and `restart.test.ts` start the built daemon from `daemon/dist`.

The worker runs `test:changed` and the build while working and before `move_ticket(testing)`. The tester runs `test:changed` and the build once in its step 1, and `test:changed` again while iterating on tests it adds.

### WebKit screenshots

The Mac app renders the UI in the system WKWebView, so a WebKit-only bug (thin font, a misplaced menu) does not show in the headless Edge or Chrome of the UI tests. Two commands take a screenshot of a seeded scratch board, and neither opens a window:

- `npm run shot -- <out.png> [--zoom 100] [--open board|start|switch|taskmenu]` (`daemon/test/shot.ts`) renders in Playwright's headless WebKit. Use it for layout at Playwright speed, on any platform. Playwright's WebKit is newer than the system one and behaves like Chromium for zoom, so it does not show Mac-only bugs.
- `npm run shot:mac -- <out.png> [--zoom 100] [--open board|start|switch|taskmenu]` (`daemon/test/shot-mac.ts`) renders in the system WKWebView, the engine the Mac app ships with. Use it for anything zoom-, font- or WebKit-version-specific (smeared bevels, doubled scrollbar arrows, rects off by the zoom). It is the only way an agent sees the Mac engine. Mac only: elsewhere it prints one line and exits 2.

Both build the daemon, start it on a scratch repo in a throwaway home with eleven seeded tickets (enough that Backlog scrolls), open the board at 1280x800, optionally open the Start menu, the Switch board panel or the Board taskbar button's right-click menu, write a PNG and remove the scratch folder, also after a failed run. `--zoom` is the UI zoom in percent (80 to 200).

`shot:mac` compiles `daemon/test/shot-mac.swift` once into the OS temp dir (`k95-shot-mac-<hash of the source>`, about 10 s with `swiftc` from the Xcode command line tools) and runs it with the login URL on stdin. The Swift program sets the activation policy to prohibited and holds a WKWebView in a borderless window that is never ordered on screen or made key, so the frontmost app does not change and no Space switches; `lsappinfo list` shows it only as `BackgroundOnly` while it runs (WebKit checks every host in with Launch Services, so it cannot be absent). Menus are opened by mouse events dispatched in the page, since there is no CDP. `takeSnapshot` leaves out composited scrollbars, so the program turns off WebKit's `AsyncOverflowScrollingEnabled` feature flag; scrollbars are then painted with the page and show in the PNG. The output is at the screen's backing scale (2560x1600 on a Retina display).

- One-time per machine: `npx playwright install webkit` (about 300 MB unpacked into Playwright's user cache, shared by every worktree; `npm ci` does not download it, so `worktree_setup` needs no change). Install no other Playwright browser.
- To attach a shot to a ticket: the operator (or anything holding the shell's cookie) sends the PNG as the raw body of `POST /api/tickets/:id/attachments?name=<file>.png`; an agent has no cookie, so it copies the PNG into `<board repo>/.kanban95/attachments/<id>/` (the folder that route writes, which `get_ticket` lists), or names the path in a note.

## Skills

`skills/` in the Kanban95 repo is a Claude Code plugin named `kanban95` (manifest `skills/.claude-plugin/plugin.json`). Each skill is one page and names only tools from `docs/MCP.md`.

| skill | use it |
|---|---|
| [`kanban95-ticket-start`](../skills/kanban95-ticket-start/SKILL.md) | at the start of a worker session: read the ticket, its dependencies and the brain, post a `plan` note |
| [`kanban95-ticket-complete`](../skills/kanban95-ticket-complete/SKILL.md) | when the work is committed: verify, keep the brain true (`brain_update`, `brain_add`), `summary` note, `move_ticket(testing)` |
| [`kanban95-ask-operator`](../skills/kanban95-ask-operator/SKILL.md) | when a decision is the operator's: when to ask, and how to phrase a question answered in one line |

Load it for a session with `claude --plugin-dir <kanban95 repo>/skills`; the skills then appear as `kanban95:<skill>`. Check the manifest with `claude plugin validate skills`; that checks only the manifest and SKILL.md frontmatter. To prove the plugin loads, run from a neutral cwd `claude -p --plugin-dir <abs path>/skills --model <any> --output-format stream-json --verbose "Reply OK"` and read the first (`"subtype":"init"`) event: the plugin is listed in `plugins` as `kanban95@inline` and its skills as `kanban95:<skill>`. `claude plugin details` knows only installed plugins. The board's launcher does not pass `--plugin-dir` yet, so a launched agent gets the same guidance from its template instead.

## Editing templates

The defaults live in `templates/` in the Kanban95 repo. On every start the daemon copies any default missing from `<repo>/.kanban95/templates/` (committed with the project) and replaces an unedited one when its default changed; one the operator edited is never overwritten, so their edits stick. Every render reads the file again, so an edit applies to the next launch without a restart. A template that uses any variable outside the table above is refused, naming the variable and the template, before anything is launched.

## The brain

The brain is two tables of short facts (`docs/DATA.md` → brain): the **project brain** in the repo's `board.db`, and the **global brain** in `~/.kanban95/brain.db` that every board on this machine reads and writes. `brain_search` and `{{brain}}` cover both in one ranking; a global row carries `scope: global` and shows in the prompt as `- [global] [#id] title`. A row is named by `scope` + `id` (ids are per file): pass `scope: global` to `brain_update`, `brain_delete` and `brain_search` `id` for a global row. Every role reads it with `brain_search` and writes with `brain_add` and `brain_update`; only a planner, an operator terminal or the operator in the Brain window deletes (`brain_delete`), so a confused agent cannot erase a decision. Edits are in place, with no history; the audit log says who changed what. The rules come from the audit on ticket #41.

- **Reading.** `{{brain}}` is picked by keyword overlap and most rows will not apply. Use a row only if it concerns what you are changing, and check it against the code. To find more, `brain_search` with 2–3 subsystem, file or tool names (every word must match).
- **Which brain.** `scope: global` for a fact that holds in any repo: an external tool or CLI (Claude Code flags, git on Windows, node-pty, vitest, fnm), the OS, a library's behaviour. `project`, the default, for anything about this codebase: its files, its tests, its conventions, its decisions. When unsure, project: a wrong global row reaches every board. Only a planner, an operator terminal (`brain_update` `move_to`) or the operator (Brain window → Edit → scope) moves a row between the two; a worker or tester names the row to move in its summary.
- **The gate.** Every `brain_add` must pass three questions; a row failing any one is not written. The housekeeping review uses the same three for its keep, rewrite, merge or delete verdicts.
  1. **Quality:** would a future agent trip without it, stated so a reader with no context can act on it (what happens, why, what to do, where)? Not a plan, not ticket status, not what the code, docs or templates already say.
     Passes: "`git worktree remove` fails on Windows while a terminal has the folder open; close the PTY first."
     Fails: "Ticket #73 is in testing; finish the gate wording next."
  2. **Scope:** holds in every repo (a tool, CLI, OS or model behaviour, with version and date) → `global`; only in this codebase → `project`. Unsure → project.
     Passes: global "Node 22 `node:sqlite` lacks FTS5; use Node 24 (checked 2026-10)."
     Fails: global "The daemon binds 127.0.0.1 on a random port" (a fact about this codebase, so project).
  3. **Worth:** does keeping it serve the project, or is it bloat? A row nobody would search for, or one that restates a one-off, is bloat.
     Passes: "vitest runs test files in parallel; tests that share `~/.kanban95` must use a temp home."
     Fails: "A typo in `README.md` was fixed on 2026-10-01."
- **Before writing,** `brain_search` the subject. If a row already covers it, correct that row with `brain_update` instead of adding a near-duplicate.
- **What belongs.** One fact a future agent would trip on: a gotcha, a non-obvious decision, or an external tool's behaviour (with version and date). Not what the code, docs or templates already say: a durable convention goes into the matching living doc in your own ticket.
- **How to write.** Title: a sentence naming the trap ("X does Y; do Z"). Body: what happens, why, what to do instead, and the file or function, under ~800 characters (1500 is refused). Tags: 4–8 words a future ticket's title would contain.
- **Never write** ticket status or plans ("until #53 merges", "pending"): they go stale within hours. Unbuilt work or an unfixed bug belongs in a ticket.
- **Keeping it true.** Before finishing, `brain_search` the subsystems you changed and fix every row your change made false. The housekeeping ticket reviews every row.

Not done on purpose: embeddings (a provider key or another local model, and the failure was duplicates, not recall), time decay (a gotcha stays true until the code changes), confidence scores, supersede chains or soft delete, and usage counters (revisit past ~100 rows).
