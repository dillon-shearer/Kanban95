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

### 2. Launch all

**Launch all** (or Ctrl+L) starts every Backlog ticket whose dependencies have merged; the rest wait with a yellow "waits on #n" badge and start by themselves when their dependency lands. To start one ticket, select it and press **Launch**.

![The board](img/board.png)

Each card shows its id, title, model, effort and CLI (grey italic means "the phase default from Settings"), and badges for what needs attention: **running** (an agent is working on it), **needs human** (red), **retry n**, **merged**.

### 3. Watch, or don't

Every agent gets its own terminal window titled `#id — phase — model`. The board opens them by itself, behind whatever you are working in; a terminal whose agent finished its step closes itself a moment later (its output stays in the ticket's Runs tab). You can type into any terminal; it is the agent's real session.

The ticket moves on its own: In Progress → Testing → Done. A failed test sends it back to In Progress with the tester's notes, up to three retries. When it merges you hear the **ding**.

### 4. When the board needs you

You hear the **chord** and a card turns red when an agent asks a question, exits without reporting, hits the retry cap, or its merge conflicts. The Board's status bar says why at that moment (`#n needs you: …`, the card's newest failure note or question; hover it for the whole text). A launch the board refuses outright (no models saved, uncommitted changes on the base branch) starts no agent and opens no terminal, so that line is where its reason shows. Questions land in the **Inbox** (the "Inbox n" button in the taskbar tray, just right of Start). Type the answer and press **Answer**; it is typed into the agent's terminal and the card's badge clears.

![Inbox](img/inbox.png)

For anything else, open the ticket (double-click the card): the Notes tab has the failure notes, Runs has each run's exact prompt and terminal output, Diff shows what the worktree changed.

![Ticket window, Runs tab](img/ticket-runs.png)

### 5. Done

A merged ticket's worktree and branch are removed by the board. Every ten merged tickets the board files and launches a housekeeping ticket; the **Housekeeping** button does it on demand.

## The windows

| Window | Open from | What it is for |
|---|---|---|
| Board | Start → Board | the four columns, the toolbar, the status bar |
| Ticket | double-click a card, **New ticket** | fields, notes timeline, runs and prompts, diff, live grants (Revoke), audit trail |
| Terminal | opens by itself; Ticket → Runs → Terminal | one agent session, keyboard and mic |
| Inbox | taskbar "Inbox n", Start → Inbox | open questions from agents |
| Brain | Start → Brain | search what agents learned, add a note yourself |
| Settings | Start → Settings | Models, CLI paths and trusted folders, Grants, Voice, sounds |

Windows can be dragged by the title bar, resized from the corner and minimized to the taskbar. Board, Brain, Inbox and Settings remember where you left them.

## Cards

Right-click a card for its menu: Open, Launch, **Model**, **Effort** and **CLI** (set or clear this ticket's override without opening it), Retry merge (after a conflict you fixed), Reset to Backlog, Delete.

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

Inside a terminal every key goes to the agent instead: Esc interrupts Claude Code, Ctrl+L clears its screen.

## Grants

Every agent session runs on its own token, scoped to its role and ticket. **Settings → Grants** lists every live one; **Revoke** invalidates the token and stops that agent's terminal at once (the window stays, titled "(ended)"). A ticket's own grants are in its Grants tab.

## Voice

Every text field has a mic button beside it, and every terminal has one in its title bar. Hold it and speak, release to stop (or switch to click-to-start, click-to-stop in **Settings → Voice**). The words are inserted at the caret, or typed into the terminal without Enter: you check them and press Enter yourself. The button shows its state: red while recording, blinking blue while transcribing, red outline after an error (hover it for the reason).

Transcription runs inside the board's window with a local Whisper model. Audio never leaves the machine and no account is involved. The model is not in the repo: the first press of any mic opens a dialog with its name, source, size, license and the SHA-256 of every file. Nothing is downloaded unless you press **Download**; the daemon then fetches it once into `~/.kanban95/models/`, checks every hash, and refuses (and deletes) anything that does not match. After that, voice works offline.

![Download dialog](img/voice-download.png)

If the microphone is blocked, the board says how to allow it: Windows Settings → Privacy & security → Microphone, with "Microphone access" and "Let desktop apps access your microphone" on. The window may also ask once per start whether Kanban95 may use the microphone.

**Zero-code fallback: Win+H.** Windows' own dictation works in any field of the board, including the terminals, with nothing to set up. It is Windows' feature and its privacy terms, not the board's; the mic button is the board's own path.

## Sounds

`ding` when a ticket merges, `chord` when the board needs you. **Settings → General** turns them off.
