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

### 2. Launch all

**Launch all** (or Ctrl+L) starts every Backlog ticket whose dependencies have merged; the rest wait with a yellow "waits on #n" badge and start by themselves when their dependency lands. To start one ticket, select it and press **Launch**.

![The board](img/board.png)

Each card shows its id, title, model, effort and CLI (grey italic means "the phase default from Settings"), and badges for what needs attention: **running** (an agent is working on it), **needs human** (red), **retry n**, **merged**.

### 3. Watch, or don't

Every agent gets its own terminal window titled `#id — phase — model`. The board opens them by itself, behind whatever you are working in; a terminal whose agent finished its step closes itself a moment later (its output stays in the ticket's Runs tab). You can type into any terminal; it is the agent's real session.

The ticket moves on its own: In Progress → Testing → Done. A failed test sends it back to In Progress with the tester's notes, up to three retries. When it merges you hear the **ding**.

### 4. When the board needs you

The board fixes what it can before it asks you. A merge that conflicts goes back to the worker: the ticket returns to In Progress (retry + 1) and the agent merges the base into its worktree, resolves the conflict, and goes through testing again. A merge refused only because the main checkout has uncommitted changes is not flagged: the board retries it every 30 seconds and it lands once you commit or stash. So never leave edits in the main checkout while the board runs; work in a worktree.

You hear the **chord** and a card turns red when an agent asks a question, exits without reporting, hits the retry cap, its merge still conflicts at the retry cap, or the main checkout is still dirty after 10 minutes. Every one of these lands in the **Inbox** (the "Inbox n" button in the taskbar tray, just right of Start; n counts them all), and the ticket's facts line says "needs human (the Inbox says why)". A question has an answer box: type the answer and press **Answer**; it is typed into the agent's terminal and the card's badge clears. Anything else shows the note that flagged it: what happened, then a line starting **To resolve:** with your next step (it names the worktree, e.g. `.worktrees/t-12`, and the button). Its buttons are **Open ticket**, **Retry merge** (a done ticket that has not merged), **Resume** (a running ticket) and **Reset to Backlog** (otherwise). The Board's status bar also says why at the moment a card turns red (`#n needs you: …`). A launch the board refuses outright (no models saved, uncommitted changes on the base branch) starts no agent and opens no terminal, so that line is where its reason shows. For an agent that went away (it crashed, its launch failed, it exited without reporting), press **Resume**: the agent for the ticket's phase starts again in the same worktree, with the failure note in its brief and the retry count kept. Resume is also in the card menu, and **Launch** on such a card does the same. Launch on a card whose agent is still running is refused: open its terminal, or Reset to Backlog to stop it.

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
| Ticket | double-click a card, **New ticket** | fields and attachments, notes timeline, runs and prompts, diff, live grants (Revoke), audit trail. Ctrl+V a screenshot (outside a text field) or drop a file on the window to attach it; the agents get its path |
| Terminal | opens by itself; Ticket → Runs → Terminal | one agent session, keyboard and mic |
| Inbox | taskbar "Inbox n", Start → Inbox | every ticket that needs you: questions to answer, and failures with what resolves them |
| Brain | Start → Brain | search what agents learned, add a note yourself |
| Settings | Start → Settings | Models, CLI paths and trusted folders, Prompts (preferences), Grants, Voice, sounds |
| Notepad | Start → Notepad | your own scratch notes for this repo, saved as you type |

The desktop has an icon for Board, Inbox, Brain, Settings, Notepad, New ticket and New brainstorm down its left edge: click selects, double-click or Enter does what the Start menu entry does. Icons sit under every window.

Windows can be dragged by the title bar, resized from the corner, minimized to the taskbar and maximized to fill the desktop (Maximize button or double-click the title bar; Restore puts it back). Board, Brain, Inbox, Settings and Notepad remember where you left them, maximized or not.

## Notepad

A place to draft before you hand words to an agent or a ticket. One plain text area, with the mic beside it. It saves half a second after you stop typing and again when you close the window, to `.kanban95/notepad.md` in the repo (git-ignored; each repo has its own). **New ticket from selection** opens the New ticket form with the selected text in Body, or all of it when nothing is selected; **Copy** puts the same text on the clipboard. Up to 256 KB; past that the status line says it was not saved and the file keeps the last text that fit. Agents never read it.

## Cards

Right-click a card for its menu: Open, Launch, Resume (a red running card whose agent is gone), **Model**, **Effort** and **CLI** (set or clear this ticket's override without opening it), Retry merge (after you fixed a conflict or cleaned the main checkout), Reset to Backlog (also on a card waiting on a dependency: it cancels the wait, so it will not launch by itself), Delete.

![Card menu](img/card-menu.png)

Dragging is for the two things an operator may do by hand; everything else is the agents' job:

- **Backlog → In Progress**: mark a ticket as being worked on by hand. No agent is started.
- **Any column → Backlog**: reset. Flags and the retry count are cleared, a running agent is stopped. Launch it again when ready; its worktree and branch are reused.

Any other drop snaps back, and the status bar names where that card may go.

## Keyboard

| Key | Does |
|---|---|
| Esc | closes the focused window (or an open menu) |
| Ctrl+L | Launch all |
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
