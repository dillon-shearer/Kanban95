// The ticket state machine, documented row by row in docs/LIFECYCLE.md. TABLE is every transition there is: transition()
// picks a row or refuses, apply() writes the row and runs its effects. Nothing else changes a ticket's status or flags.
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { readTicket, transaction, type Ticket } from './api.js';
import { revoke, type Role } from './grants.js';
import { cleanTicket } from './janitor.js';
import { launch, launchRoot, sessionsOf, type Session } from './launcher.js';
import { enqueue, merge } from './merge.js';
import { BadConfig, EFFORT, runSettings, type Effort } from './settings.js';
import { TEMPLATES } from './templates.js';

export const MAX_RETRY = 3;
const HOUSEKEEPING_EVERY = 10;

export type Status = 'backlog' | 'in_progress' | 'testing' | 'done';
export type Event =
  | 'launch' // operator Launch / Launch all, or the last dependency landing
  | 'submit' // worker move_ticket(testing)
  | 'pass' // tester move_ticket(done), after report_test(passed: true)
  | 'fail' // tester move_ticket(in_progress)
  | 'ask' // ask_operator
  | 'answer' // the operator answers over REST
  | 'exit' // the agent's pty exited without a move_ticket, or its launch failed
  | 'merged' | 'conflict' // the merge queue's verdict
  | 'dirty' // the merge queue gave up waiting for the main checkout to be clean (DIRTY_WAIT)
  | 'merge' // the operator retries a merge that failed
  | 'resume' // the operator restarts the agent of a flagged running ticket whose agent is gone
  | 'restart'; // the operator replaces a running ticket's agent, live or not, with a fresh one in the same phase
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
  set?: { needs_human?: 0 | 1; blocked_on_deps?: 0 | 1; retry?: '+1'; merged?: true };
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
  { from: ['testing'], event: 'pass', when: (f) => f.passReported, why: 'call report_test with passed: true first', to: 'done', effects: ['end_session', 'enqueue_merge'] },
  { from: ['testing'], event: 'fail', when: (f) => f.retry < MAX_RETRY, to: 'in_progress', set: { retry: '+1' }, effects: ['end_session', 'spawn_execute'] },
  { from: ['testing'], event: 'fail', when: (f) => f.retry >= MAX_RETRY, to: 'in_progress', set: { retry: '+1', needs_human: 1 }, effects: ['end_session', 'note', 'chord'],
    says: `stopped after ${MAX_RETRY + 1} failed tests`,
    resolve: () => "read the tester's failure notes on the ticket. Fix its body or criteria if they ask for the wrong thing, then Reset to Backlog and Launch; the agent starts again in the same worktree." },
  { from: RUNNING, event: 'ask', set: { needs_human: 1 }, effects: ['note', 'chord'] },
  { from: RUNNING, event: 'answer', when: (f) => f.needs_human && f.live, why: 'no flagged question with a live agent session', set: { needs_human: 0 }, effects: ['note', 'answer_pty'] },
  { from: RUNNING, event: 'exit', set: { needs_human: 1 }, effects: ['note', 'chord'],
    resolve: () => RESUME },
  { from: ['done'], event: 'merged', set: { merged: true, needs_human: 0 }, effects: ['ding', 'remove_worktree', 'release_dependents', 'housekeeping'] },
  { from: ['done'], event: 'conflict', when: (f) => f.retry < MAX_RETRY, to: 'in_progress', set: { retry: '+1' }, effects: ['note', 'spawn_execute'] },
  { from: ['done'], event: 'conflict', when: (f) => f.retry >= MAX_RETRY, set: { needs_human: 1 }, effects: ['note', 'chord'],
    resolve: (id) => `in .worktrees/t-${id} run git merge with the base branch, fix the conflicting files keeping both sides' intent, run the tests, commit, then Retry merge.` },
  { from: ['done'], event: 'dirty', set: { needs_human: 1 }, effects: ['note', 'chord'],
    resolve: (_, repo) => `commit or stash those changes in the main checkout (${repo}), then Retry merge. While the board runs, work in a worktree, never in the main checkout.` },
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
  /** Set by close(): nothing new is spawned. */
  closing?: boolean;
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
    live: sessionsOf(t.id).length > 0,
  };
}

type Note = { role: Role | 'operator'; kind: 'question' | 'answer' | 'failure'; body: string };

/**
 * Applies `event` to the ticket: picks the row, writes status, flags and note in one transaction, then runs the effects.
 * Throws Refused when the table has no row. `pending` holds the effects that finish later (worktree removal).
 */
export function apply(b: Board, id: number, event: Event, x: { note?: Note; answer?: string } = {}) {
  const t = readTicket(b.db, id);
  const row = pick(facts(b, t), event);
  const { to = t.status as Status, set = {}, effects } = row;
  let note = x.note ?? (row.says ? ({ role: 'tester', kind: 'failure', body: row.says } as Note) : undefined);
  if (event === 'restart') note = { role: 'operator', kind: 'failure', body: RESTART_NOTE };
  if (note && row.resolve) note = { ...note, body: `${note.body}\nTo resolve: ${row.resolve(id, b.repo)}` };
  if (effects.includes('note') !== (note !== undefined)) throw new Error(`${event} ${note ? 'takes no' : 'needs a'} note`);
  const noteId = transaction(b.db, () => {
    b.db.prepare(`
      UPDATE tickets SET status = ?, needs_human = coalesce(?, needs_human), blocked_on_deps = coalesce(?, blocked_on_deps),
        retry = retry + ?, merged_at = CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE merged_at END
      WHERE id = ?`).run(to, set.needs_human ?? null, set.blocked_on_deps ?? null, set.retry ? 1 : 0, set.merged ? 1 : 0, id);
    if (!note) return undefined;
    const r = b.db.prepare('INSERT INTO notes (ticket_id, role, kind, body) VALUES (?, ?, ?, ?)').run(id, note.role, note.kind, note.body);
    return Number(r.lastInsertRowid);
  });

  const pending: Promise<void>[] = [];
  for (const e of effects) {
    switch (e) {
      case 'spawn_execute': spawn(b, id, t.template as 'execute' | 'housekeeping'); break;
      case 'spawn_test': spawn(b, id, 'test'); break;
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
  return { ticket: readTicket(b.db, id), noteId, pending };
}

/** An answer is typed into a terminal: a newline would submit half of it, so it becomes one line. */
const oneLine = (s: string) => s.replace(/\s*[\r\n]+\s*/g, ' ').trim();

/** Launches the phase's agent. A launch that fails is an agent that exited without reporting: the ticket is flagged. */
function spawn(b: Board, id: number, template: 'execute' | 'housekeeping' | 'test') {
  try {
    if (b.closing) throw new Error('the daemon is shutting down');
    const settings = runSettings(readTicket(b.db, id), template === 'test' ? 'test' : 'execute');
    launch({ ...b, onExit: (s) => exited(b, s) }, { ticketId: id, template, ...settings });
  } catch (e) {
    apply(b, id, 'exit', { note: { role: TEMPLATES[template].role, kind: 'failure', body: `launch failed: ${(e as Error).message}` } });
  }
}

function exited(b: Board, s: Session) {
  b.db.prepare('UPDATE runs SET outcome = ? WHERE id = ?').run(s.outcome ?? 'exit', s.runId);
  changed(s.ticketId);
  if (s.outcome) return;
  try {
    apply(b, s.ticketId!, 'exit', { note: { role: s.role, kind: 'failure', body: 'agent exited without reporting' } });
  } catch (e) {
    if (!(e instanceof Refused)) throw e; // the ticket has moved on (operator edit); nothing to flag
  }
}

/** A merge refused for a dirty main checkout is tried again every `every` ms and flagged once it has waited `max`. Tests shorten it. */
export const DIRTY_WAIT = { every: 30_000, max: 600_000 };
const waiting = new Map<number, NodeJS.Timeout>();

/**
 * A conflict goes back to the worker (TABLE). A dirty base is the operator's own edits in the main checkout, not the ticket's
 * fault: the merge waits for them to be committed, and only a base still dirty after DIRTY_WAIT.max is flagged.
 */
function queueMerge(b: Board, id: number, since = Date.now()) {
  clearTimeout(waiting.get(id)); // the operator's Retry merge restarts a wait
  waiting.delete(id);
  void enqueue(async () => {
    await Promise.all(sessionsOf(id).map((s) => s.done)); // the tester's pty is still closing
    const t = readTicket(b.db, id);
    if (t.status !== 'done' || t.merged_at) return; // reset or moved by hand while it waited
    const r = await merge(b.repo, id, t.title);
    let out;
    if (r.ok) out = apply(b, id, 'merged');
    else if (r.dirty && Date.now() - since < DIRTY_WAIT.max) {
      waiting.set(id, setTimeout(() => b.closing || queueMerge(b, id, since), DIRTY_WAIT.every).unref());
      return;
    } else if (r.dirty) {
      const body = `merge did not run: the main checkout (${r.base}) still has uncommitted changes after the wait:\n${r.reason}`;
      out = apply(b, id, 'dirty', { note: { role: 'tester', kind: 'failure', body } });
    } else out = apply(b, id, 'conflict', { note: { role: 'tester', kind: 'failure', body: `merge conflict with ${r.base}: ${r.reason}` } });
    await Promise.all(out.pending);
  });
}

function releaseDependents(b: Board, id: number) {
  const rows = b.db.prepare(`
    SELECT t.id FROM tickets t JOIN ticket_deps d ON d.ticket_id = t.id
    WHERE d.depends_on_id = ? AND t.status = 'backlog' AND t.blocked_on_deps = 1 ORDER BY t.id`).all(id) as { id: number }[];
  for (const r of rows) apply(b, r.id, 'launch'); // one still waiting on another dependency stays held
}

/** `<repo>/.kanban95/config.json`, the repo's own board settings (docs/DATA.md); `{}` when absent. */
const repoConfigPath = (repo: string) => join(repo, '.kanban95', 'config.json');
const repoConfig = (repo: string) => (existsSync(repoConfigPath(repo)) ? JSON.parse(readFileSync(repoConfigPath(repo), 'utf8')) : {});

/** `.kanban95/config.json` → `housekeeping_every` (default 10). Merged execute tickets are counted; housekeeping ones are not. */
function maybeHousekeeping(b: Board, t: Ticket) {
  if (t.template !== 'execute') return;
  const file = repoConfigPath(b.repo);
  const every = Number(repoConfig(b.repo).housekeeping_every ?? HOUSEKEEPING_EVERY);
  if (!Number.isInteger(every) || every < 1) throw new Error(`housekeeping_every in ${file} must be a positive integer`);
  const { n } = b.db.prepare("SELECT count(*) AS n FROM tickets WHERE template = 'execute' AND merged_at IS NOT NULL").get() as { n: number };
  if (n % every !== 0) return;
  housekeeping(b, `Scheduled after ${n} tickets reached Done. Follow the housekeeping brief.`);
}

/** Creates a housekeeping ticket and launches it like any other. The Housekeeping button and the automatic trigger both land here. */
export function housekeeping(b: Board, body: string): Ticket {
  const r = b.db.prepare("INSERT INTO tickets (title, body, criteria, template) VALUES (?, ?, ?, 'housekeeping')").run(
    'Clean up stale docs, unused modules and leftover artefacts',
    body,
    'The tests and the build pass exactly as before.\nNo living document is removed.\nEvery deleted or updated path is listed with report_cleanup and a reason.',
  );
  return apply(b, Number(r.lastInsertRowid), 'launch').ticket;
}

/** A session in the repo root without a ticket. It touches no ticket, so the lifecycle has no row for it. */
function rootSession(b: Board, o: Parameters<typeof launchRoot>[1]): Session {
  if (b.closing) throw new Error('the daemon is shutting down');
  const s = launchRoot({ ...b, onExit: () => changed(null) }, o);
  changed(null);
  return s;
}

/** A brainstorm session: a planner with plan-phase settings. */
export const brainstorm = (b: Board) => rootSession(b, { ...runSettings(null, 'plan'), template: 'brainstorm' });

/** An operator terminal: plan-phase settings unless `.kanban95/config.json` has `operator: { model, effort }` (either or both). */
export function operator(b: Board, mission: string): Session {
  const o = repoConfig(b.repo).operator ?? {};
  const where = `${repoConfigPath(b.repo)} operator`;
  if (typeof o !== 'object' || Array.isArray(o)) throw new BadConfig(`${where} must be an object`);
  if (o.model !== undefined && (typeof o.model !== 'string' || !o.model)) throw new BadConfig(`${where}.model must be a non-empty string`);
  if (o.effort !== undefined && !EFFORT.includes(o.effort)) throw new BadConfig(`${where}.effort must be one of ${EFFORT.join(', ')}`);
  const plan = runSettings(null, 'plan');
  return rootSession(b, { ...plan, model: o.model ?? plan.model, effort: (o.effort as Effort) ?? plan.effort, template: 'operator', mission });
}

/** Launch all: every backlog ticket, dependencies before dependents, ids ascending otherwise. Those waiting on a dependency are held. */
export function launchAll(b: Board): Ticket[] {
  const ids = (b.db.prepare("SELECT id FROM tickets WHERE status = 'backlog' ORDER BY id").all() as { id: number }[]).map((r) => r.id);
  const deps = new Map(ids.map((id) => [id, readTicket(b.db, id).depends_on.filter((d) => ids.includes(d))]));
  const order: number[] = [];
  while (order.length < ids.length) {
    const next = ids.find((id) => !order.includes(id) && deps.get(id)!.every((d) => order.includes(d)));
    if (next === undefined) throw new Error('dependency cycle among backlog tickets'); // refused at write time; never expected
    order.push(next);
    apply(b, next, 'launch');
  }
  return order.map((id) => readTicket(b.db, id));
}

export const RESTART_NOTE = 'restarted by the operator; the previous session was ended without reporting. Continue from the state of this worktree: read `git status` and `git log` first';

export const RESTARTED = 'agent exited without reporting (the daemon restarted)';

/**
 * Daemon start: no agent survives a restart. The agent did nothing wrong, so a running, unflagged ticket is resumed once: the
 * note goes into the new prompt and the agent for its phase starts again in the same worktree. If that agent then exits
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
