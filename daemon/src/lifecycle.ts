// The ticket state machine, documented row by row in docs/LIFECYCLE.md. TABLE is every transition there is: transition()
// picks a row or refuses, apply() writes the row and runs its effects. Nothing else changes a ticket's status or flags.
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { readTicket, transaction, type Ticket } from './api.js';
import { branchName, git, isAncestor, syncWorktree } from './git.js';
import { revoke, type Role } from './grants.js';
import { cleanTicket } from './janitor.js';
import { launch, launchRoot, prepareWorktree, sessions, sessionsOf, transcriptSize, type Session } from './launcher.js';
import { ahead, enqueue, merge, push } from './merge.js';
import { lastLines } from './pty.js';
import { BadConfig, EFFORT, readConfig, runSettings, type Effort } from './settings.js';
import { TEMPLATES } from './templates.js';

export const MAX_RETRY = 3;

export type Status = 'backlog' | 'in_progress' | 'testing' | 'done';
export type Event =
  | 'launch' // operator Launch, the runner, or the last dependency landing
  | 'submit' // worker move_ticket(testing)
  | 'pass' // tester move_ticket(done), after report_test(passed: true)
  | 'fail' // tester move_ticket(in_progress)
  | 'ask' // ask_operator
  | 'answer' // the operator answers over REST
  | 'exit' // the agent's pty exited without a move_ticket, or its launch failed
  | 'silent' // the agent's transcript gained no line for idle_minutes (the silence watch)
  | 'woke' // a silent agent's transcript grew again
  | 'merged' // the merge queue's verdict
  | 'conflict' // the base would not merge into the worktree (on submit or in the merge queue), or the worktree was dirty
  | 'dirty' // the merge queue gave up waiting for the main checkout to be clean (DIRTY_WAIT)
  | 'unpushed' // the merge landed but git push of the base to its upstream failed
  | 'merge' // the operator retries a merge that failed
  | 'resume' // the operator restarts the agent of a flagged running ticket whose agent is gone
  | 'restart' // the operator replaces a running ticket's agent, live or not, with a fresh one in the same phase
  | 'reject'; // the operator sends a done ticket, merged or not, back to a worker with a reason
type Effect =
  | 'spawn_execute' | 'spawn_test' | 'end_session' | 'enqueue_merge' | 'note' | 'answer_pty'
  | 'chord' | 'ding' | 'remove_worktree' | 'release_dependents' | 'housekeeping';

/** Everything a guard may look at. */
export interface Facts {
  status: Status;
  needs_human: boolean;
  retry: number;
  merged: boolean;
  depsMerged: boolean;
  passReported: boolean;
  live: boolean;
}
interface Row {
  from: Status[];
  event: Event;
  when?: (f: Facts) => boolean;
  /** Why a guarded row did not match, for the refusal. */
  why?: string | ((f: Facts) => string);
  /** Omitted: the status does not change. */
  to?: Status;
  set?: { needs_human?: 0 | 1; blocked_on_deps?: 0 | 1; retry?: '+1' | 0; merged?: boolean };
  effects: Effect[];
  /** The note this row writes when the event brings none of its own. */
  says?: string;
  /**
   * Every row that raises needs_human writes one note: what happened, then `To resolve: <this>`, the operator's next step.
   * A question has none: the Inbox's Answer box is its fix.
   */
  resolve?: (id: number, repo: string) => string;
}

const RUNNING: Status[] = ['in_progress', 'testing'];
/** What fixes an agent that went away. */
const RESUME = 'Resume (card menu or Inbox) starts the agent again in the same worktree; Reset to Backlog starts over.';
export const TO_RESOLVE = `To resolve: ${RESUME}`;
const busy = (f: Facts) => f.live ? 'it already has a running agent; open its terminal, or Reset to Backlog to stop it' : '';
const resumable = (f: Facts) => f.needs_human && !f.live;
const notResumable = (f: Facts) => busy(f) || 'it is not flagged; nothing failed, so there is nothing to resume';
export const TABLE: Row[] = [
  { from: ['backlog'], event: 'launch', when: (f) => f.depsMerged, to: 'in_progress', set: { blocked_on_deps: 0 }, effects: ['spawn_execute'] },
  { from: ['backlog'], event: 'launch', when: (f) => !f.depsMerged, set: { blocked_on_deps: 1 }, effects: [] },
  // Launch on a running ticket whose agent is gone (a crash, a failed launch, a restart) starts the agent for its phase again.
  { from: ['in_progress'], event: 'launch', when: (f) => !f.live, why: busy, set: { needs_human: 0 }, effects: ['spawn_execute'] },
  { from: ['testing'], event: 'launch', when: (f) => !f.live, why: busy, set: { needs_human: 0 }, effects: ['spawn_test'] },
  { from: ['in_progress'], event: 'resume', when: resumable, why: notResumable, set: { needs_human: 0 }, effects: ['spawn_execute'] },
  { from: ['testing'], event: 'resume', when: resumable, why: notResumable, set: { needs_human: 0 }, effects: ['spawn_test'] },
  // end_session sets the outcome before the kill, so exited() does not flag the killed session.
  { from: ['in_progress'], event: 'restart', set: { needs_human: 0 }, effects: ['end_session', 'note', 'spawn_execute'] },
  { from: ['testing'], event: 'restart', set: { needs_human: 0 }, effects: ['end_session', 'note', 'spawn_test'] },
  { from: ['in_progress'], event: 'submit', to: 'testing', effects: ['end_session', 'spawn_test'] },
  // merged: false clears the merged_at an earlier cycle left (a rejected ticket), so the queue merges this pass again.
  { from: ['testing'], event: 'pass', when: (f) => f.passReported, why: 'call report_test with passed: true first', to: 'done', set: { merged: false }, effects: ['end_session', 'enqueue_merge'] },
  { from: ['testing'], event: 'fail', when: (f) => f.retry < MAX_RETRY, to: 'in_progress', set: { retry: '+1' }, effects: ['end_session', 'spawn_execute'] },
  { from: ['testing'], event: 'fail', when: (f) => f.retry >= MAX_RETRY, to: 'in_progress', set: { retry: '+1', needs_human: 1 }, effects: ['end_session', 'note', 'chord'],
    says: `stopped after ${MAX_RETRY + 1} failed tests`,
    resolve: () => "read the tester's failure notes on the ticket. Fix its body or criteria if they ask for the wrong thing, then Reset to Backlog and Launch; the agent starts again in the same worktree." },
  { from: RUNNING, event: 'ask', set: { needs_human: 1 }, effects: ['note', 'chord'] },
  { from: RUNNING, event: 'answer', when: (f) => f.needs_human && f.live, why: 'no flagged question with a live agent session', set: { needs_human: 0 }, effects: ['note', 'answer_pty'] },
  { from: RUNNING, event: 'exit', set: { needs_human: 1 }, effects: ['note', 'chord'],
    resolve: () => RESUME },
  // The agent is still running: it may be hung on an API call, or sitting at its prompt after an error it cannot get past.
  { from: RUNNING, event: 'silent', when: (f) => f.live && !f.needs_human, why: 'it has no running agent, or it is flagged already', set: { needs_human: 1 }, effects: ['note', 'chord'],
    resolve: () => 'open its terminal (card menu → Terminal). If it is waiting on something you can fix there (a model error, a prompt), fix it; if it is hung, Restart. The flag clears by itself if the agent writes again.' },
  { from: RUNNING, event: 'woke', when: (f) => f.live && f.needs_human, why: 'it has no running agent, or it is not flagged', set: { needs_human: 0 }, effects: [] },
  { from: ['done'], event: 'merged', set: { merged: true, needs_human: 0 }, effects: ['ding', 'remove_worktree', 'release_dependents', 'housekeeping'] },
  // A submit whose base will not merge in (lifecycle submit) and a merge-queue conflict share the way back to the worker.
  { from: ['in_progress', 'done'], event: 'conflict', when: (f) => f.retry < MAX_RETRY, to: 'in_progress', set: { retry: '+1' }, effects: ['end_session', 'note', 'spawn_execute'] },
  { from: ['in_progress'], event: 'conflict', when: (f) => f.retry >= MAX_RETRY, set: { needs_human: 1 }, effects: ['end_session', 'note', 'chord'],
    resolve: (id) => `in .worktrees/t-${id} commit or discard any uncommitted changes, run git merge with the base branch, fix the conflicting files keeping both sides' intent, run the tests, commit, then Resume; the worker submits again.` },
  { from: ['done'], event: 'conflict', when: (f) => f.retry >= MAX_RETRY, set: { needs_human: 1 }, effects: ['note', 'chord'],
    resolve: (id) => `in .worktrees/t-${id} run git merge with the base branch, fix the conflicting files keeping both sides' intent, run the tests, commit, then Retry merge.` },
  { from: ['done'], event: 'dirty', set: { needs_human: 1 }, effects: ['note', 'chord'],
    resolve: (_, repo) => `commit or stash those changes in the main checkout (${repo}), then Retry merge. While the board runs, work in a worktree, never in the main checkout.` },
  // The merge stays in the base; Retry merge finds the branch already in it and only pushes again.
  { from: ['done'], event: 'unpushed', set: { needs_human: 1 }, effects: ['note', 'chord'],
    resolve: (_, repo) => `fix what git says in the main checkout (${repo}): when the remote has commits the base lacks, pull them and merge; when offline or signed out, reconnect or sign in to the remote with git. Then Retry merge; it pushes again.` },
  // A rejection is a new cycle, not a failed test. Unmerged, the queue drops it (status is no longer done); merged, its worktree
  // is gone and the worker's launch forks a fresh one from the base, which holds the merged work. merged_at is kept until a pass.
  { from: ['done'], event: 'reject', when: (f) => !f.live, why: busy, to: 'in_progress', set: { needs_human: 0, retry: 0 }, effects: ['note', 'spawn_execute'] },
  { from: ['done'], event: 'merge', when: (f) => !f.merged, why: 'already merged', effects: ['enqueue_merge'] },
];

/** A transition the table does not have. Refused, never forced. */
export class Refused extends Error {}

function pick(f: Facts, event: Event): Row {
  const rows = TABLE.filter((r) => r.event === event && r.from.includes(f.status));
  const row = rows.find((r) => !r.when || r.when(f));
  if (!row) {
    const why = rows.find((r) => r.why)?.why;
    throw new Refused(`cannot ${event} a ticket in ${f.status}${why ? `: ${typeof why === 'string' ? why : why(f)}` : ''}`);
  }
  return row;
}

/** The one row that applies, or a refusal naming why. */
export function transition(f: Facts, event: Event): { to: Status; set: NonNullable<Row['set']>; effects: Effect[] } {
  const row = pick(f, event);
  return { to: row.to ?? f.status, set: row.set ?? {}, effects: row.effects };
}

export interface Board {
  db: DatabaseSync;
  repo: string;
  port: number;
  /** Set by close(): nothing new is spawned, and agents killed by the shutdown are not flagged, so `recover` resumes them. */
  closing?: boolean;
  /** Kanban95's own install root (the repo checkout or the installer's `app/`). Defaults to the one this code runs from. */
  root?: string;
  /** Closes the board and exits the process with `code`. Set only when the daemon runs as its own process. */
  shutdown?: (code: number) => void;
  /** The Tauri shell started this daemon and restarts it on exit code 75. */
  shell?: boolean;
  /** `git rev-parse HEAD` in the repo when the daemon started; unset in a repo with no commits. */
  startCommit?: string;
  /** A merge since start changed what the running daemon was built from: 'shell' when shell/ changed too (docs/OPERATOR.md → Restart board). */
  stale?: false | 'daemon' | 'shell';
  /** Commits on the base its upstream lacks, counted on start (push_after_merge on) and zeroed by a push; the status bar's Push button. */
  unpushed?: number;
}

/**
 * Board events for the UI's /events websocket. `event`: a sound, `{ sound: 'ding' | 'chord', ticket }`. `change`: something about
 * a ticket (`ticket` = its id) or the set of live sessions (`ticket` = null) changed; the UI refetches just that.
 */
export const events = new EventEmitter().setMaxListeners(0);
export const changed = (ticket: number | null) => events.emit('change', { ticket });

function facts(b: Board, t: Ticket): Facts {
  const merged = (id: number) => (b.db.prepare('SELECT merged_at FROM tickets WHERE id = ?').get(id) as { merged_at: string | null }).merged_at !== null;
  // A pass counts only if reported during the latest test run, so a pass from an earlier cycle cannot finish a retry.
  const pass = b.db.prepare(`
    SELECT 1 FROM notes WHERE ticket_id = ? AND role = 'tester' AND kind = 'summary' AND body LIKE 'PASS:%'
      AND created_at >= coalesce((SELECT max(started_at) FROM runs WHERE ticket_id = ? AND phase = 'test'), '')`).get(t.id, t.id);
  return {
    status: t.status as Status,
    needs_human: t.flags.needs_human,
    retry: t.retry,
    merged: t.merged_at !== null,
    depsMerged: t.depends_on.every(merged),
    passReported: pass !== undefined,
    live: sessionsOf(t.id).length > 0 || settingUp.has(t.id),
  };
}

type Note = { role: Role | 'operator'; kind: 'question' | 'answer' | 'failure'; body: string };

/**
 * Applies `event` to the ticket: picks the row, writes status, flags and note in one transaction, then runs the effects.
 * Throws Refused when the table has no row. `pending` holds the effects that finish later (worktree removal).
 */
export function apply(b: Board, id: number, event: Event, x: { note?: Note; answer?: string; auto?: boolean } = {}) {
  const t = readTicket(b.db, id);
  const row = pick(facts(b, t), event);
  // The one gate on the board starting an agent by itself (`auto`: a released dependent, a conflict sent back): while the
  // runner is off it starts nothing. A backlog launch is not applied at all, so the ticket stays held; any other row is
  // written without its spawn and kept in `held`, and tick() starts that agent when Run is turned on.
  const hold = x.auto === true && !runner(b).on && row.effects.includes('spawn_execute');
  if (hold && t.status === 'backlog') return { ticket: t, noteId: undefined, pending: [] as Promise<void>[] };
  if (hold) held.add(id);
  if (event === 'submit') {
    // The tester tests the branch with the base merged in, so stale code never spends a tester round.
    const s = syncWorktree(b.repo, id);
    if (!s.ok) return apply(b, id, 'conflict', { note: { role: 'worker', kind: 'failure', body: s.reason }, auto: true });
  }
  const { to = t.status as Status, set = {}, effects } = row;
  let note = x.note ?? (row.says ? ({ role: 'tester', kind: 'failure', body: row.says } as Note) : undefined);
  if (event === 'restart') note = { role: 'operator', kind: 'failure', body: RESTART_NOTE };
  if (note && row.resolve) note = { ...note, body: `${note.body}\nTo resolve: ${row.resolve(id, b.repo)}` };
  if (effects.includes('note') !== (note !== undefined)) throw new Error(`${event} ${note ? 'takes no' : 'needs a'} note`);
  const noteId = transaction(b.db, () => {
    b.db.prepare(`
      UPDATE tickets SET status = ?, needs_human = coalesce(?, needs_human), blocked_on_deps = coalesce(?, blocked_on_deps),
        retry = CASE WHEN ? THEN 0 ELSE retry + ? END,
        merged_at = CASE ? WHEN 1 THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHEN 0 THEN NULL ELSE merged_at END
      WHERE id = ?`).run(to, set.needs_human ?? null, set.blocked_on_deps ?? null, set.retry === 0 ? 1 : 0, set.retry === '+1' ? 1 : 0,
      set.merged === undefined ? null : set.merged ? 1 : 0, id);
    if (!note) return undefined;
    const r = b.db.prepare('INSERT INTO notes (ticket_id, role, kind, body) VALUES (?, ?, ?, ?)').run(id, note.role, note.kind, note.body);
    return Number(r.lastInsertRowid);
  });

  // Resume, and Launch on a running ticket whose agent is gone (as recover does after a restart), continue the killed
  // conversation when they can; every other spawn (a retry, a Restart) starts a fresh one.
  const resume = (event === 'resume' || event === 'launch') && t.status !== 'backlog';
  const pending: Promise<void>[] = [];
  for (const e of effects) {
    switch (e) {
      case 'spawn_execute': if (!hold) spawn(b, id, t.template as 'execute' | 'housekeeping', resume); break;
      case 'spawn_test': spawn(b, id, 'test', resume); break;
      case 'end_session':
        // The agent reported; its session is over. The grant expires now, the pty is killed, its exit is expected.
        for (const s of sessionsOf(id)) {
          s.outcome = event;
          revoke(b.db, s.grantId);
          s.pty.kill();
        }
        break;
      case 'enqueue_merge': queueMerge(b, id); break;
      case 'note': break; // written above, in the transaction
      case 'answer_pty':
        // Text, then Enter as its own write: Claude Code reads one burst as a paste, where \r is a newline, not Enter.
        // ponytail: fixed 300 ms gap, a very slow pty may still merge the two; upgrade is to wait for the echo before Enter.
        for (const s of sessionsOf(id)) {
          s.pty.write(oneLine(x.answer ?? ''));
          setTimeout(() => s.pty.write('\r'), 300);
        }
        break;
      case 'chord': case 'ding': events.emit('event', { sound: e, ticket: id }); break;
      case 'remove_worktree': pending.push(cleanTicket(b, id)); break;
      case 'release_dependents': releaseDependents(b, id); break;
      case 'housekeeping': maybeHousekeeping(b, t); break;
    }
  }
  changed(id);
  tick(b);
  return { ticket: readTicket(b.db, id), noteId, pending };
}

/**
 * Running tickets whose agent apply() held back while the runner was off.
 * ponytail: in memory, so a restart forgets them and recover resumes them whatever the runner says; upgrade is a column.
 */
const held = new Set<number>();

/** An answer is typed into a terminal: a newline would submit half of it, so it becomes one line. */
const oneLine = (s: string) => s.replace(/\s*[\r\n]+\s*/g, ' ').trim();

/** Tickets whose new worktree is running `worktree_setup`. They count as live, so a second launch is refused meanwhile. */
const settingUp = new Set<number>();

/**
 * Launches the phase's agent, after the repo's `worktree_setup` when its worktree is new. A launch that fails is an agent that
 * exited without reporting: the ticket is flagged. A ticket moved on while its setup ran (Reset, a shutdown) starts nothing.
 */
function spawn(b: Board, id: number, template: 'execute' | 'housekeeping' | 'test', resume = false) {
  const status = template === 'test' ? 'testing' : 'in_progress';
  const fail = (e: unknown) => apply(b, id, 'exit', { note: { role: TEMPLATES[template].role, kind: 'failure', body: `launch failed: ${(e as Error).message}` } });
  try {
    if (b.closing) throw new Error('the daemon is shutting down');
    const settings = runSettings(readTicket(b.db, id), template === 'test' ? 'test' : 'execute');
    const go = () => void launch({ ...b, onExit: (s) => exited(b, s) }, { ticketId: id, template, resume, ...settings });
    const setup = prepareWorktree(b.repo, id, worktreeSetup(b.repo));
    if (!setup) return go();
    settingUp.add(id);
    const after = async () => {
      try {
        await setup;
      } finally {
        settingUp.delete(id);
      }
      const t = readTicket(b.db, id);
      if (!b.closing && t.status === status && !t.flags.needs_human && !sessionsOf(id).length) go();
    };
    void after().catch((e) => {
      try {
        if (!b.closing && readTicket(b.db, id).status === status) fail(e);
      } catch (x) {
        console.error('[lifecycle]', x); // deleted or moved on meanwhile: nothing to flag
      }
    }).finally(() => changed(id));
  } catch (e) {
    fail(e);
  }
}

function exited(b: Board, s: Session) {
  b.db.prepare('UPDATE runs SET outcome = ? WHERE id = ?').run(s.outcome ?? 'exit', s.runId);
  changed(s.ticketId);
  if (s.outcome || b.closing) return;
  try {
    apply(b, s.ticketId!, 'exit', { note: { role: s.role, kind: 'failure', body: 'agent exited without reporting' } });
  } catch (e) {
    if (!(e instanceof Refused)) throw e; // the ticket has moved on (operator edit); nothing to flag
  }
}

// ---- the silence watch (docs/LIFECYCLE.md → Silent agents) ----

/** How often running agents' transcripts are looked at, and how long one of settings.json's idle_minutes is. Tests shorten both. */
export const SILENCE = { every: 60_000, minute: 60_000 };
/** Per session key: the transcript size last seen, when the silence began, and the note that flagged it, if it did. */
const heard = new Map<number, { size: number; at: number; note?: number }>();

/** Starts the watch; the returned function stops it. */
export function watchSilence(b: Board): () => void {
  let timer: NodeJS.Timeout;
  const next = () => (timer = setTimeout(() => {
    try {
      listen(b);
    } finally {
      next();
    }
  }, SILENCE.every).unref());
  next();
  return () => clearTimeout(timer);
}

/**
 * The pty is no signal (Claude Code's spinner animates while it waits on the API), so a ticket's agent is judged by its transcript
 * (`transcriptSize`): no new line for idle_minutes while the ticket is unflagged applies `silent`. Time spent flagged (a question
 * waiting on the operator) does not count. A transcript that grows again while the silence note is still the ticket's latest
 * applies `woke`, so a long step that was healthy after all does not hold the card red.
 */
function listen(b: Board) {
  if (b.closing) return;
  let limit = 20;
  try {
    limit = readConfig('settings').idle_minutes;
  } catch { /* a broken settings.json: the default */ }
  const now = Date.now();
  for (const k of heard.keys()) if (!sessions.has(k)) heard.delete(k);
  for (const s of sessions.values()) {
    if (s.ticketId === null || s.outcome) continue;
    try {
      const size = transcriptSize(s);
      const h = heard.get(s.key) ?? { size, at: s.started };
      heard.set(s.key, h);
      const flagged = readTicket(b.db, s.ticketId).flags.needs_human;
      if (size !== h.size) {
        const latest = (b.db.prepare('SELECT max(id) AS id FROM notes WHERE ticket_id = ?').get(s.ticketId) as { id: number | null }).id;
        if (h.note !== undefined && flagged && latest === h.note) apply(b, s.ticketId, 'woke');
        Object.assign(h, { size, at: now, note: undefined });
      } else if (flagged) h.at = now;
      else if (now - h.at >= limit * SILENCE.minute) {
        const mins = Math.round((now - h.at) / SILENCE.minute);
        const tail = lastLines(s.scrollback(), 10).join('\n') || '(nothing)';
        const body = `agent silent for ${mins} min: its ${s.cli === 'codex' ? 'rollout' : 'transcript'} has had no new line since ${new Date(h.at).toISOString()}. ` +
          `Last lines of its terminal:\n\`\`\`\n${tail}\n\`\`\``;
        h.note = apply(b, s.ticketId, 'silent', { note: { role: s.role, kind: 'failure', body } }).noteId;
      }
    } catch (e) {
      if (!(e instanceof Refused)) console.error('[silence]', e); // one session's trouble must not stop the watch for the rest
    }
  }
}

/** A merge refused for a dirty main checkout is tried again every `every` ms and flagged once it has waited `max`. Tests shorten it. */
export const DIRTY_WAIT = { every: 30_000, max: 600_000 };
const waiting = new Map<number, NodeJS.Timeout>();

/**
 * A conflict goes back to the worker (TABLE); it is met in the ticket's worktree, never in the main checkout. A dirty base is the
 * operator's own edits in the main checkout, not the ticket's fault: the merge waits for them to be committed, and only a base
 * still dirty after DIRTY_WAIT.max is flagged.
 */
function queueMerge(b: Board, id: number, since = Date.now()) {
  clearTimeout(waiting.get(id)); // the operator's Retry merge restarts a wait
  waiting.delete(id);
  void enqueue(async () => {
    // A ticket rejected while it waited has a worker running now; waiting on that session would hold the whole queue.
    if (readTicket(b.db, id).status !== 'done') return;
    await Promise.all(sessionsOf(id).map((s) => s.done)); // the tester's pty is still closing
    const t = readTicket(b.db, id);
    if (t.status !== 'done' || t.merged_at) return; // reset, rejected or moved by hand while it waited
    // Main is merged into the worktree first, so the merge into the main checkout is conflict-free by construction; merge.ts's
    // abort stays as a safety net.
    // ponytail: lands even when the sync brought in new commits (the worker merged and the tester tested at submit); upgrade is
    // to send it back to testing when the sync touched files the ticket also touched.
    // Retry merge after a failed push: the branch is already in the base, so only the push is left.
    const inBase = isAncestor(b.repo, branchName(id), 'HEAD');
    const s = inBase ? { ok: true as const } : syncWorktree(b.repo, id);
    if (!s.ok) return void (await Promise.all(apply(b, id, 'conflict', { note: { role: 'tester', kind: 'failure', body: s.reason }, auto: true }).pending));
    const r = inBase ? { ok: true as const } : await merge(b.repo, id, t.title, () => readTicket(b.db, id).status === 'done');
    if (!r) return;
    // Rejected while git merge ran: the work landed, but the ticket is a worker's again and its next pass merges again.
    if (r.ok && readTicket(b.db, id).status !== 'done') return;
    let out;
    if (r.ok) {
      if (!inBase) markStale(b);
      // Published before it counts as merged: a failed push flags the ticket and leaves the merge in the base.
      const p = readConfig('settings').push_after_merge ? await push(b.repo) : { ok: true as const, pushed: false };
      if (!p.ok) {
        const body = `merged into ${p.base}, but git push to ${p.remote} failed, so the ticket is not closed:
${p.reason}`;
        return void apply(b, id, 'unpushed', { note: { role: 'tester', kind: 'failure', body } });
      }
      if (p.pushed) b.unpushed = 0;
      out = apply(b, id, 'merged');
    }
    else if (r.dirty && Date.now() - since < DIRTY_WAIT.max) {
      waiting.set(id, setTimeout(() => b.closing || queueMerge(b, id, since), DIRTY_WAIT.every).unref());
      return;
    } else if (r.dirty) {
      const body = `merge did not run: the main checkout (${r.base}) still has uncommitted changes after the wait:\n${r.reason}`;
      out = apply(b, id, 'dirty', { note: { role: 'tester', kind: 'failure', body } });
    } else out = apply(b, id, 'conflict', { note: { role: 'tester', kind: 'failure', body: `merge conflict with ${r.base}: ${r.reason}` }, auto: true });
    await Promise.all(out.pending);
  });
}

/** Daemon start, before recover(): with push_after_merge on, how far the base is ahead of its upstream (a crash, or a time the setting was off). */
export function countUnpushed(b: Board) {
  // In the queue, so a push recover() queued cannot finish between the count and its write.
  return enqueue(async () => {
    if (!readConfig('settings').push_after_merge) return;
    b.unpushed = await ahead(b.repo);
    if (b.unpushed) changed(null);
  });
}

/** The status bar's Push button: the merge queue's push, in the queue so it never runs beside a merge. Resolves to git's refusal or null. */
export async function pushBase(b: Board): Promise<string | null> {
  let failed: string | null = null;
  await enqueue(async () => {
    const p = await push(b.repo);
    if (!p.ok) failed = `git push to ${p.remote} failed:
${p.reason}`;
    else b.unpushed = 0;
  });
  changed(null);
  return failed;
}

/** After a merge: did it change the daemon's own code since start? The UI reads `stale` from GET /api/runner. */
function markStale(b: Board) {
  if (!b.startCommit || b.stale === 'shell') return;
  let files: string[];
  try {
    files = git(b.repo, 'diff', '--name-only', b.startCommit, 'HEAD', '--', 'daemon/', 'shell/', 'package.json', 'package-lock.json').split('\n').filter(Boolean);
  } catch {
    return; // start commit gone (history rewritten): nothing to compare against
  }
  if (!files.length) return;
  b.stale = files.some((f) => f.startsWith('shell/')) ? 'shell' : 'daemon';
  changed(null);
}

function releaseDependents(b: Board, id: number) {
  const rows = b.db.prepare(`
    SELECT t.id FROM tickets t JOIN ticket_deps d ON d.ticket_id = t.id
    WHERE d.depends_on_id = ? AND t.status = 'backlog' AND t.blocked_on_deps = 1 ORDER BY t.id`).all(id) as { id: number }[];
  for (const r of rows) apply(b, r.id, 'launch', { auto: true }); // one still waiting on another dependency stays held
}

/** `<repo>/.kanban95/config.json`, the repo's own board settings (docs/DATA.md); `{}` when absent. The daemon never writes it. */
const repoConfigPath = (repo: string) => join(repo, '.kanban95', 'config.json');
const repoConfig = (repo: string) => (existsSync(repoConfigPath(repo)) ? JSON.parse(readFileSync(repoConfigPath(repo), 'utf8')) : {});

/** config.json `worktree_setup`: a shell command run once in each new ticket worktree before its first agent (docs/LIFECYCLE.md). */
function worktreeSetup(repo: string): string | undefined {
  const c = repoConfig(repo).worktree_setup;
  if (c !== undefined && (typeof c !== 'string' || !c.trim())) throw new BadConfig(`${repoConfigPath(repo)} worktree_setup must be a non-empty string`);
  return c;
}

/** settings.json `housekeeping: { auto, every }` (on, 10). Merged execute tickets are counted; housekeeping ones are not. The ticket waits in Backlog for the runner. */
function maybeHousekeeping(b: Board, t: Ticket) {
  if (t.template !== 'execute') return;
  const { auto, every } = readConfig('settings').housekeeping;
  if (!auto) return;
  const { n } = b.db.prepare("SELECT count(*) AS n FROM tickets WHERE template = 'execute' AND merged_at IS NOT NULL").get() as { n: number };
  if (n % every !== 0) return;
  housekeeping(b, `Scheduled after ${n} tickets reached Done. Follow the housekeeping brief.`, false);
}

/** Creates a housekeeping ticket. The Housekeeping button launches it at once; the automatic trigger leaves it to the runner. */
export function housekeeping(b: Board, body: string, launchNow = true): Ticket {
  const r = b.db.prepare("INSERT INTO tickets (title, body, criteria, template) VALUES (?, ?, ?, 'housekeeping')").run(
    'Clean up stale docs, unused modules and leftover artefacts',
    body,
    'The tests and the build pass exactly as before.\nNo living document is removed.\nEvery deleted or updated path is listed with report_cleanup and a reason.',
  );
  const id = Number(r.lastInsertRowid);
  if (launchNow) return apply(b, id, 'launch').ticket;
  changed(id);
  return readTicket(b.db, id);
}

/** A session in the repo root without a ticket. It touches no ticket, so the lifecycle has no row for it. */
function rootSession(b: Board, o: Parameters<typeof launchRoot>[1]): Session {
  if (b.closing) throw new Error('the daemon is shutting down');
  const s = launchRoot({ ...b, onExit: () => changed(null) }, o);
  changed(null);
  return s;
}

/** A brainstorm session: a planner with plan-phase settings, optionally seeded with the operator's text (Notepad). */
export const brainstorm = (b: Board, mission?: string) => rootSession(b, { ...runSettings(null, 'plan'), template: 'brainstorm', mission });

/** An operator terminal: the operator phase (Settings → Models; the CLI's default model when unset) unless `.kanban95/config.json` has `operator: { model, effort }` (either or both). */
export function operator(b: Board, mission: string): Session {
  const o = repoConfig(b.repo).operator ?? {};
  const where = `${repoConfigPath(b.repo)} operator`;
  if (typeof o !== 'object' || Array.isArray(o)) throw new BadConfig(`${where} must be an object`);
  if (o.model !== undefined && (typeof o.model !== 'string' || !o.model)) throw new BadConfig(`${where}.model must be a non-empty string`);
  if (o.effort !== undefined && !EFFORT.includes(o.effort)) throw new BadConfig(`${where}.effort must be one of ${EFFORT.join(', ')}`);
  const plan = runSettings(null, 'operator');
  return rootSession(b, { ...plan, model: o.model ?? plan.model, effort: (o.effort as Effort) ?? plan.effort, template: 'operator', mission });
}

// ---- the runner (docs/LIFECYCLE.md → The runner) ----

/** `.kanban95/runner.json`, git-ignored: whether the runner is on, why it last stopped itself, how many tickets it keeps running. Absent means off. */
export type Runner = { on: boolean; why?: string; concurrency?: number };
const CONCURRENCY = 3;
const runnerFile = (b: Board) => join(b.repo, '.kanban95', 'runner.json');
export function runner(b: Board): Runner {
  try {
    return JSON.parse(readFileSync(runnerFile(b), 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { on: false };
    throw e;
  }
}
const limit = (b: Board) => runner(b).concurrency ?? CONCURRENCY;

/** Turns the runner on (and launches at once) or off, keeping the concurrency unless given. Off lets running agents finish; nothing new starts. */
export function setRunner(b: Board, on: boolean, why?: string, concurrency = runner(b).concurrency) {
  writeFileSync(runnerFile(b), JSON.stringify({ on, ...(why && { why }), ...(concurrency && { concurrency }) }));
  changed(null);
  if (on) tick(b);
}

/** Tickets the runner waits on: unflagged and running, or done and not merged yet. A flagged one waits for the operator instead. */
const running = (b: Board) => (b.db.prepare(`
  SELECT id FROM tickets WHERE needs_human = 0 AND (status IN ('in_progress', 'testing') OR (status = 'done' AND merged_at IS NULL))
  ORDER BY id`).all() as { id: number }[]).map((r) => r.id);

const EFFORT_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, max: 3 };
const lines = (s: string) => s.split(/\r?\n/).filter((l) => l.trim()).length;

/**
 * Backlog tickets the runner may launch, next first: unflagged, every dependency merged.
 * ponytail: effort then criteria lines is a rough size; upgrade to a size estimate the planner writes on each ticket.
 */
export function candidates(b: Board): number[] {
  const rows = b.db.prepare(`
    SELECT id, effort, criteria FROM tickets t WHERE status = 'backlog' AND needs_human = 0 AND NOT EXISTS (
      SELECT 1 FROM ticket_deps d JOIN tickets x ON x.id = d.depends_on_id WHERE d.ticket_id = t.id AND x.merged_at IS NULL)`).all() as
    { id: number; effort: string | null; criteria: string }[];
  const rank = (r: (typeof rows)[number]) => EFFORT_RANK[r.effort ?? 'medium'];
  return rows.sort((x, y) => rank(x) - rank(y) || lines(x.criteria) - lines(y.criteria) || x.id - y.id).map((r) => r.id);
}

/**
 * The repo files a ticket touches, docs and markdown left out (every ticket touches those; the merge sync handles them):
 * paths its body or criteria names that exist in the repo, plus, once it has a branch, what that branch changed.
 * ponytail: names in prose are a guess; upgrade to a files list the planner writes on each ticket.
 */
function files(b: Board, id: number): string[] {
  const t = b.db.prepare('SELECT body, criteria FROM tickets WHERE id = ?').get(id) as { body: string; criteria: string };
  const named = `${t.body}\n${t.criteria}`.match(/[\w./-]+\.\w+/g) ?? [];
  let diff: string[] = [];
  try {
    diff = git(b.repo, 'diff', '--name-only', `${git(b.repo, 'rev-parse', '--abbrev-ref', 'HEAD')}...${branchName(id)}`).split('\n');
  } catch { /* no branch yet */ }
  const inRepo = (f: string) => !f.split('/').includes('..') && existsSync(join(b.repo, f));
  const all = [...named.map((f) => f.replace(/^\.\//, '')).filter(inRepo), ...diff];
  return [...new Set(all.filter((f) => f && !f.startsWith('docs/') && !f.endsWith('.md')))];
}

/** Each candidate that shares a file with a running ticket, mapped to the first running ticket it shares one with. */
function overlaps(b: Board, cs: number[]): Map<number, number> {
  const owner = new Map<string, number>();
  for (const id of running(b)) for (const f of files(b, id)) if (!owner.has(f)) owner.set(f, id);
  const out = new Map<number, number>();
  if (!owner.size) return out;
  for (const c of cs) {
    const f = files(b, c).find((x) => owner.has(x));
    if (f) out.set(c, owner.get(f)!);
  }
  return out;
}

/** What the status bar shows: the flag, the limit, the tickets it waits on, candidates left of everything in Backlog, deferrals. */
export function runnerState(b: Board) {
  const { n } = b.db.prepare("SELECT count(*) AS n FROM tickets WHERE status = 'backlog'").get() as { n: number };
  const cs = candidates(b);
  const waits = [...overlaps(b, cs)].map(([id, on]) => ({ id, on }));
  return { ...runner(b), concurrency: limit(b), running: running(b), left: cs.length, backlog: n, waits, stale: b.stale ?? false, unpushed: b.unpushed ?? 0 };
}

let ticking = false;

/**
 * Runs after every apply and on daemon start: while the runner is on and fewer than `concurrency` (runner.json, default 3)
 * tickets are running, launch the next candidate that shares no file with a running ticket, or the first candidate when all
 * do (the merge sync resolves it; waiting forever would be worse). Nothing running and nothing to launch: it turns itself off.
 * A ticket held on a running one is not "nothing": the runner waits for that merge.
 */
export function tick(b: Board) {
  if (ticking || b.closing || !runner(b).on) return;
  ticking = true; // its own launches call apply, which calls tick
  try {
    const max = limit(b);
    // A conflict sent back to its worker while the runner was off (apply's hold): that worker starts first, unless the
    // operator has moved the ticket on since.
    for (const id of held) {
      held.delete(id);
      const t = b.db.prepare('SELECT status, needs_human FROM tickets WHERE id = ?').get(id) as { status: string; needs_human: number } | undefined;
      if (t?.status === 'in_progress' && !t.needs_human && !sessionsOf(id).length) apply(b, id, 'launch');
    }
    while (running(b).length < max) {
      const cs = candidates(b);
      if (!cs.length) break;
      const busy = overlaps(b, cs);
      apply(b, cs.find((c) => !busy.has(c)) ?? cs[0], 'launch');
    }
    if (running(b).length === 0 && candidates(b).length === 0) {
      setRunner(b, false, 'nothing left to launch');
      events.emit('event', { sound: 'ding', ticket: null });
    }
  } finally {
    ticking = false;
  }
}

export const RESTART_NOTE = 'restarted by the operator; the previous session was ended without reporting. Continue from the state of this worktree: read `git status` and `git log` first';

export const RESTARTED = 'agent exited without reporting (the daemon restarted)';

/**
 * Daemon start: no agent survives a restart. The agent did nothing wrong, so a running, unflagged ticket is resumed once: the
 * agent for its phase starts again in the same worktree, continuing its Claude Code conversation (launcher `resumable`) or
 * else fresh with the note in its prompt. If that agent then exits
 * without reporting, the ordinary exit row flags it. A done ticket that never merged and is not flagged was cut off mid-queue:
 * it is queued again.
 */
export function recover(b: Board) {
  const running = b.db.prepare("SELECT id, status FROM tickets WHERE status IN ('in_progress', 'testing') AND needs_human = 0").all() as { id: number; status: string }[];
  for (const { id, status } of running) {
    if (sessionsOf(id).length > 0) continue;
    const role = status === 'testing' ? 'tester' : 'worker';
    // ponytail: no Pause yet; when it lands, a paused board flags here (apply 'exit' with RESTARTED) instead.
    b.db.prepare("INSERT INTO notes (ticket_id, role, kind, body) VALUES (?, ?, 'failure', ?)").run(id, role, RESTARTED);
    apply(b, id, 'launch');
  }
  for (const { id } of b.db.prepare("SELECT id FROM tickets WHERE status = 'done' AND merged_at IS NULL AND needs_human = 0").all() as { id: number }[]) {
    queueMerge(b, id);
  }
}
