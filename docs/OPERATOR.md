# Operating the board

Living document. How a person drives Kanban95, from an idea to merged work. Update it in the same change that moves a button.

## Before the first launch

1. Log in to Claude Code and/or Codex CLI with their own commands. The board never asks for a key.
2. For Claude Code, accept its one-time `--dangerously-skip-permissions` warning by hand once (`docs/CLIS.md`).
3. Start the board: double-click `Kanban95.cmd`, or drop the project folder you want it to work on onto it (`README.md` → Run). Open **Start → Settings → Models**, pick the default CLI and a model and effort for each phase (type a model id, or press ▾ beside the box for every model that CLI knows) (plan is the brainstorm, execute does the work, test checks it), and press **Save**. That writes `~/.kanban95/models.json`; until it exists nothing can launch, and the Board's status bar says so.

![Settings, Models tab](img/settings-models.png)

## A full cycle

### 1. Brainstorm

**New brainstorm** (or Ctrl+N) opens a terminal with a planner agent in the repo root. Tell it what you want. It reads the code and the brain, proposes tickets, and writes them to the board with `create_ticket` once you agree. The planner cannot write files. Cards appear in Backlog as it creates them.

### Operator terminal

For board work that is not a ticket: maintenance on the repo, a refactor you want to steer live, a one-off investigation, fixing the board itself. **Start → New operator terminal** (or Ctrl+Shift+N) asks for a **Mission** (the mic works there too) and opens a terminal titled `Operator — <model>` in the repo root with an agent whose brief starts from your mission, word for word. An empty mission is refused.

The agent has your reach on the board and nothing beyond the repo and the board: it can read and list every ticket, create and edit tickets, add notes, change a ticket's model, and move tickets through the usual steps (launch, submit, fail; it cannot pass a ticket, only a tester can). It has full tools in the repo, works in its own worktree under `.worktrees/op-<time>` when it changes code, merges that itself when the tests pass, and ends with a short summary in its terminal. It does not create tickets unless your mission asks it to.

It runs with the plan phase's model and effort, unless `.kanban95/config.json` has `"operator": { "model": "...", "effort": "..." }` (either or both). It shows in the agent count and the taskbar like a brainstorm. Closing its window does not stop it; **Revoke** its grant in Settings → Grants, or close the board, does.

### 2. Run

**Run** (or Ctrl+L, or Start → Run) works the backlog for you, one ticket at a time, smallest first: it launches a ticket, waits for it to execute, pass its test and merge, then launches the next, until nothing launchable is left. The button then reads **Stop**, and the status bar shows `Running: #id (n of m candidates left)`: the ticket it is on, how many backlog tickets it can launch now, out of everything in Backlog. Smallest means lowest effort first (low, medium, high, max; no effort counts as medium), then fewest acceptance-criteria lines, then lowest id.

It skips what needs you: a red (needs human) ticket waits in the Inbox, and so does anything depending on it, while the runner moves on. When nothing is running and nothing is left it turns itself off with a ding and the status bar says "Runner stopped: nothing left to launch". **Stop** (or Ctrl+L again) starts nothing new; agents already running finish their step and merge. It stays on across a restart. To run two at once, put `{ "runner_concurrency": 2 }` in `.kanban95/config.json`.

To start tickets yourself, select them and press **Launch**, runner on or off. A ticket whose dependencies have not merged waits with a yellow "waits on #n" badge and starts by itself when they land.

![The board](img/board.png)

Each card shows its id, title, model, effort and CLI (grey italic means "the phase default from Settings"), and badges for what needs attention: **running** (an agent is working on it), **needs human** (red), **retry n**, **merged**, **housekeeping** (a ticket the board filed to clean up).

### 3. Watch, or don't

Every agent gets its own terminal window titled `#id — phase — model`. The board opens them by itself, behind whatever you are working in; a terminal whose agent finished its step closes itself a moment later (its output stays in the ticket's Runs tab). You can type into any terminal; it is the agent's real session. **Minimize** hides a terminal and keeps its agent running (reopen it from the taskbar or Ticket → Runs). **X** stops the agent for good: it asks first ("End the agent for #id? The ticket is flagged so you can resume it. Minimize to keep it running."; for a brainstorm, "End this brainstorm?"), and Cancel or Esc keeps everything running. An ended ticket agent turns the card red with the note "ended by the operator from the terminal window" and offers **Resume** in the Inbox and the card menu. A terminal titled "(ended)" has no agent left, so its X just closes the window.

The ticket moves on its own: In Progress → Testing → Done. A failed test sends it back to In Progress with the tester's notes, up to three retries. When it merges you hear the **ding**.

### 4. When the board needs you

The board fixes what it can before it asks you. A merge that conflicts goes back to the worker: the ticket returns to In Progress (retry + 1) and the agent merges the base into its worktree, resolves the conflict, and goes through testing again. A merge refused only because the main checkout has uncommitted changes is not flagged: the board retries it every 30 seconds and it lands once you commit or stash. So never leave edits in the main checkout while the board runs; work in a worktree.

You hear the **chord** and a card turns red when an agent asks a question, exits without reporting, hits the retry cap, its merge still conflicts at the retry cap, or the main checkout is still dirty after 10 minutes. Every one of these lands in the **Inbox** (the "Inbox n" button in the taskbar tray, just right of Start; n counts them all), and the ticket's facts line says "needs human (the Inbox says why)". A question has an answer box: type the answer and press **Answer**; it is typed into the agent's terminal and the card's badge clears. Anything else shows the note that flagged it: what happened, then a line starting **To resolve:** with your next step (for a merge conflict it names the worktree, e.g. `.worktrees/t-12`; otherwise the button). Its buttons are **Open ticket**, **Retry merge** (a done ticket that has not merged), **Resume** and **Restart** (a running ticket) and **Reset to Backlog** (any ticket not done). The Board's status bar also says why at the moment a card turns red (`#n needs you: …`). A launch the board refuses outright (no models saved, uncommitted changes on the base branch) starts no agent and opens no terminal (the card moves to In Progress and turns red with `launch failed: …`), so that line and the Inbox are where its reason shows. For an agent that went away (it crashed, its launch failed, it exited without reporting), press **Resume**: the agent for the ticket's phase starts again in the same worktree, with the failure note in its brief and the retry count kept. Resume is also in the card menu, and **Launch** on such a card does the same. Launch on a card whose agent is still running is refused: open its terminal, or Reset to Backlog to stop it. For an agent that is still running but stuck (idle, hung, waiting on nothing), press **Restart** (card menu, ticket window, Inbox, or Ctrl+R in a ticket window) and confirm: the running agent is ended and a new one starts in the same phase and worktree, retry count kept, told to read `git status` and `git log` and carry on. Reset to Backlog, by contrast, starts the ticket over.

When the board restarts, every agent it was running is killed. Tickets that were running and not flagged are resumed by themselves, once; you only hear the chord if a resumed agent then exits without reporting. A ticket that was already red before the restart stays red until you resume it.

![Inbox](img/inbox.png)

For anything else, open the ticket (double-click the card): the Notes tab has the failure notes, Runs has each run's exact prompt and terminal output, Diff shows what the worktree changed.

![Ticket window, Runs tab](img/ticket-runs.png)

### 5. Done

A merged ticket's worktree and branch are removed by the board. Every ten merged tickets the board files and launches a housekeeping ticket; the **Housekeeping** button does it on demand.

## The windows

| Window | Open from | What it is for |
|---|---|---|
| Board | Start → Board | the four columns, the toolbar, the status bar |
| Ticket | double-click a card, **New ticket** | fields and attachments, notes timeline, runs and prompts, diff, live grants (Revoke), audit trail. Ctrl+V a screenshot (outside a text field) or drop a file on the window to attach it; the agents get its path. Images show a thumbnail and open in their own window, other files download, **Remove** deletes one. The form's **Depends on** field lists the tickets it waits for; a new ticket takes attachments once it is created |
| Terminal | opens by itself; Ticket → Runs → Terminal | one agent session, keyboard and mic |
| Inbox | taskbar "Inbox n", Start → Inbox | every ticket that needs you: questions to answer, and failures with what resolves them |
| Brain | Start → Brain | search what agents learned, add a note yourself |
| Settings | Start → Settings | Models, CLI paths and trusted folders (**Clear Claude trust**), Prompts (preferences), Grants, Voice, sounds |
| Notepad | Start → Notepad | your own scratch notes for this repo, saved as you type |

The desktop has an icon for Board, Inbox, Brain, Settings, Notepad, New ticket and New brainstorm down its left edge: click selects, double-click or Enter does what the Start menu entry does. Icons sit under every window.

Windows can be dragged by the title bar, resized from the corner, minimized to the taskbar and maximized to fill the desktop (Maximize button or double-click the title bar; Restore puts it back). Board, Brain, Inbox, Settings and Notepad remember where you left them, maximized or not. With more windows than fit, small arrows appear at the ends of the taskbar buttons; click them or turn the mouse wheel over the taskbar to scroll.

## Notepad

A place to draft before you hand words to an agent or a ticket. One plain text area, with the mic beside it. It saves half a second after you stop typing and again when you close the window, to `.kanban95/notepad.md` in the repo (git-ignored; each repo has its own). **New ticket from selection** opens the New ticket form with the selected text in Body, or all of it when nothing is selected; **Copy** puts the same text on the clipboard. Up to 256 KB; past that the status line says it was not saved and the file keeps the last text that fit. Agents never read it.

## Cards

Click a card to select it, Ctrl+click to add or remove one, Shift+click to select the run of cards in the same column from the last one you clicked, Ctrl+A to select every card; click empty column space to clear the selection. Right-click a selected card and its menu acts on the whole selection: one confirmation for Reset to Backlog or Delete naming the count, Launch starts only the Backlog cards and says how many it skipped, Open opens at most 8 Ticket windows, and the status bar reports the outcome once ("Effort set to high on 4 tickets."), naming any ticket the daemon refused while the rest go ahead.

Right-click a card for its menu: Open, Launch, Resume (a red running card whose agent is gone), Restart (one In progress or Testing card: replaces its agent), **Model**, **Effort** and **CLI** (set or clear this ticket's override without opening it), Retry merge (after you fixed a conflict or cleaned the main checkout), Reset to Backlog (also on a card waiting on a dependency: it cancels the wait, so it will not launch by itself), Delete.

![Card menu](img/card-menu.png)

Dragging is for the two things an operator may do by hand; everything else is the agents' job:

- **Backlog → In Progress**: mark a ticket as being worked on by hand. No agent is started.
- **Any column → Backlog**: reset. Flags and the retry count are cleared, a running agent is stopped. Launch it again when ready; its worktree and branch are reused.

Any other drop snaps back, and the status bar names where that card may go.

## Keyboard

| Key | Does |
|---|---|
| Esc | closes the focused window (or an open menu) |
| Ctrl+L | Run / Stop the runner |
| Ctrl+R | Restart the agent of the focused ticket window (after a confirm) |
| Ctrl+A | select every card (on the Board, outside a text field) |
| Ctrl+N | New brainstorm |
| Ctrl+Shift+N | New operator terminal |

Inside a terminal every key goes to the agent instead: Esc interrupts Claude Code, Ctrl+L clears its screen.

## Preferences

Standing instructions for every agent, for example "No em dashes or non-ASCII characters in output" or "Keep responses brief". Write them in **Settings → Prompts → Preferences** and press **Save**; that writes `~/.kanban95/preferences.md` (the path is shown on the tab), up to 16 KB. Every prompt rendered after that (brainstorm, operator, plan, execute, test, housekeeping) carries them under "Operator preferences"; sessions already running keep the prompt they started with. They are yours, not the repo's, so they apply to every project the board works on. Never put a key or token in them: they are copied into every session's prompt.

## Grants

Every agent session runs on its own token, scoped to its role and ticket. **Settings → Grants** lists every live one; **Revoke** invalidates the token and stops that agent's terminal at once (the window stays, titled "(ended)"). A ticket's own grants are in its Grants tab.

## Voice

Every text field has a mic button beside it, and every terminal has one in its title bar. Hold it and speak, release to stop (or switch to click-to-start, click-to-stop in **Settings → Voice**). The words are inserted at the caret, or typed into the terminal without Enter: you check them and press Enter yourself. The button shows its state: red while recording, blinking blue while transcribing, red outline after an error (hover it for the reason).

Transcription runs inside the board's window with a local Whisper model. Audio never leaves the machine and no account is involved. The model is not in the repo: the first press of any mic opens a dialog with its name, source, size, license and the SHA-256 of every file. Nothing is downloaded unless you press **Download**; the daemon then fetches it once into `~/.kanban95/models/`, checks every hash, and refuses (and deletes) anything that does not match. After that, voice works offline.

![Download dialog](img/voice-download.png)

If the microphone is blocked, the board says how to allow it: Windows Settings → Privacy & security → Microphone, with "Microphone access" and "Let desktop apps access your microphone" on. The board itself never asks: the window grants itself the microphone and nothing else.

**Zero-code fallback: Win+H.** Windows' own dictation works in any field of the board, including the terminals, with nothing to set up. It is Windows' feature and its privacy terms, not the board's; the mic button is the board's own path.

## Sounds

`ding` when a ticket merges, `chord` when the board needs you. **Settings → General** turns them off.

## Dogfood walkthrough

The first full cycle on a throwaway repo, 2026-10-08, kept here as a worked example of what a run looks like and where the operator still had to step in.

**Setup.** A fresh git repo, `tally`, holding only a README ("a tiny Node CLI that counts words in a text file") and a `package.json`. Models: plan `fable`/medium, execute `opus`, test `sonnet`/low, all Claude Code. The board ran headless: the daemon (`node daemon/dist/server.js <repo>` with `KANBAN95_SECRET` set) on its own random port, driven through `/api` and the `/pty/<key>` websocket (the cookie `k95=<secret>` and an `Origin: http://127.0.0.1:<port>` header are both required). It was a second instance beside the live board, so no window opened.

**Brainstorm.** New brainstorm, then wait. The planner read its brief, surveyed the empty repo and brain, then created a "Confirm scope" ticket to hang a question on rather than asking in its terminal, and assumed defaults when that question was refused. One line typed into its terminal ("I'm here, defaults are fine, make 5 tickets with dependencies") got five tickets: `countWords` (#2), CLI entry (#3, after #2), stdin (#4, after #3), tests (#5, after #2-4) and README (#6, after #3-4), plus a brain note on the conventions. The leftover scoping ticket had to be deleted by hand.

**Launch all.** One ticket started; the rest waited on their dependencies and started by themselves as each one merged. #2 and #3 went In Progress → Testing → Done → merged with no help, about 4 minutes each. #4's worker started with a model id that did not exist (`work`, read from `~/.kanban95/models.json` at that moment). Claude Code printed "There's an issue with the selected model" and sat at its prompt, so the ticket stayed In Progress for 15 minutes without being flagged. Reset to Backlog then Launch restarted it with the right model, and #4, #5 and #6 merged by themselves. Total: about 35 minutes, 5 of 5 merged, zero needs_human flags, and `npm test` in the sample passed 5 of 5.

**Manual touches.** Each is filed as a ticket on this board. A worker grant cannot call `create_ticket`, so the operator filed them. The operator has agreed that agents may create and edit follow-up tickets, so a later change can let the worker file its own.

1. #56: The planner asked through a throwaway ticket instead of its terminal. Its brief lists `ask_operator`, which only works on a ticket that has left Backlog. The operator had to type into the terminal to unblock it.
2. #57: The planner cannot delete tickets, so its leftover ticket had to be deleted by the operator.
3. #58: A worker launched with an unknown model sat idle and was never flagged. The operator had to notice the stall and Reset then Launch. The launch should check the model, or the board should flag an agent that sits idle at its prompt.
