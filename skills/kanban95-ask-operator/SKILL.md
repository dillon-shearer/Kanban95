---
name: kanban95-ask-operator
description: Ask the Kanban95 operator a question. Use when a decision is genuinely the operator's and the ticket, brain and code cannot settle it; covers when to ask and how to phrase a question answerable in one line.
---

# Ask the operator

`ask_operator` flags the ticket `needs_human` and alerts a person who is doing other work. Their answer is typed into your session as one line and kept as a note on the ticket. Every question costs them a context switch, so ask rarely and make it easy.

It is for ticket agents only (worker, tester on their own running ticket). A planner or operator terminal is interactive: ask in the terminal instead.

## When to ask

Ask only when all of these hold:
- The choice changes what you build, not just how (scope, behaviour the operator will see, a trade-off between their goals, anything touching their keys or data).
- `get_ticket`, its dependencies, `brain_search` and the code do not settle it.
- No sensible default exists. If one does, take it, record it with `add_note` `kind: "decision"`, and move on.

Do not ask to confirm a plan, to ask permission for something the ticket already says, or to report progress (`add_note` does that). Ask once, early, with everything in one question, not a trickle of small ones.

## How to phrase it

The answer must fit in one typed line. So:
1. One sentence of context: what you are building and what you found.
2. The decision, as a question.
3. Lettered options, each a few words, with your recommendation first and why.

> Ticket says "export the board" but not the format. Which format? (a) JSON, recommended: matches DATA.md and round-trips; (b) CSV, flat, loses notes; (c) both.

The operator answers `a`, or a short sentence. Never ask an open question ("what do you think?") or one whose answer needs a paragraph.

## After asking

The session stays open. Wait for the answer, act on it, and do not ask the same thing again: the answer is a note on the ticket, and later attempts see it.
