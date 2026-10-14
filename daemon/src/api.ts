// UI-facing REST under /api. Operator-only (no grant); every mutation writes an audit row.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { agentsMap, askShell, attentionMap, focusProject, hostedMap, keyOk, missingMap, NotListed, openProject, othersHosted, runningMap, tellShell } from './boards.js';
import { attachmentDir, attachments, MAX_ATTACHMENT, safeName, saveAttachment } from './attachments.js';
import { dismissDeliverable, listDeliverables, openDeliverable } from './deliverables.js';
import { BRAIN_BODY_MAX, BRAIN_RANK, isConstraintError, SCOPES, type Brains, type Scope } from './db.js';
import { hasBranch, ticketDiff } from './git.js';
import { audit, revoke } from './grants.js';
import { cancelSetup, killGrantSession, killSession, sessions, sessionsOf, type Session } from './launcher.js';
import { apply, brainstorm, BUMPS, changed, events, housekeeping, isKanban95, operator, pushBase, Refused, release, releaseInfo, releaseOn, releasePending, relaunch, restartBoard, runnerState, setRunner, tick, type Board, type Bump } from './lifecycle.js';
import { addOverride, BadConfig, boardHome, dropOverride, gone, globalPath, isOverridable, knownModels, project, projectPath, projectsPath, readProjects, setBoardHome, uncatalogued, writeConfig, writeLastBoard, writePreferences, writeProjects, type OverridableName } from './settings.js';
import { isStale, resetTemplate, templatePath, TEMPLATES, unknownVar, VARS, writeTemplate, type TemplateName } from './templates.js';
import { bootstrap } from './bootstrap.js';
import { trustStatus, untrustClaude } from './trust.js';
import { download, status as voiceStatus } from './voice.js';
import { limits } from './limits.js';
import { requirements } from './requirements.js';
import { readiness, readyText } from './ready.js';
import { busy, checkNow, installNow, relay, REPORT, VERSION } from './update.js';
import { finishPick, startPick } from './pick.js';

type Json = Record<string, unknown>;
type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
type Ctx = { board: Board; db: DatabaseSync; params: string[]; body: Json; url: URL; req: IncomingMessage };

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Another project's board: an unlisted path is the caller's mistake (400), anything else the board's state or the OS (409). */
async function other(run: () => Promise<unknown>, status: number): Promise<Reply> {
  try {
    return { status, body: await run() };
  } catch (e) {
    throw new HttpError(e instanceof NotListed ? 400 : 409, (e as Error).message);
  }
}

// Column whitelist for ticket writes. Values are checked by the schema's CHECK constraints; types here.
const TICKET_FIELDS: Record<string, 'string' | 'int' | 'bool'> = {
  title: 'string', body: 'string', criteria: 'string', status: 'string', cli: 'string', model: 'string',
  effort: 'string', retry: 'int', needs_human: 'bool', blocked_on_deps: 'bool', blocked: 'bool', agent_level: 'int', read_all: 'bool',
};
const NULLABLE = new Set(['cli', 'model', 'effort']);
const TAG = /^[a-z0-9-]+$/;
export const PERMISSION = 'PERMISSION';
const permissionOf = (body: string) => {
  const m = /^PERMISSION((?: (?:level=[1-9]|read_all=1))+)$/.exec(body.split('\n', 1)[0]);
  if (!m) return null;
  const level = /level=(\d)/.exec(m[1]);
  return { level: level ? Number(level[1]) : null, read_all: m[1].includes('read_all=1') };
};

/**
 * Tags as stored: distinct lowercase tokens joined by one space. A string splits on commas and whitespace; an array gives
 * one tag per element. A token outside [a-z0-9-] (a quote, a space inside an element) is refused. Shared by REST and MCP.
 */
export function normaliseTags(v: unknown): string {
  let raw: string[];
  if (typeof v === 'string') raw = v.split(/[\s,]+/);
  else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) raw = v.map((x) => x.trim());
  else throw new HttpError(400, 'tags must be a string or an array of strings');
  const tags = [...new Set(raw.filter(Boolean).map((x) => x.toLowerCase()))];
  const bad = tags.filter((x) => !TAG.test(x));
  if (bad.length) throw new HttpError(400, `tags may hold only a-z, 0-9 and -: not ${bad.map((x) => JSON.stringify(x)).join(', ')}`);
  return tags.join(' ');
}

function ticketColumns(body: Json): { cols: string[]; vals: unknown[]; deps?: number[]; targets?: Target[] } {
  const cols: string[] = [];
  const vals: unknown[] = [];
  let deps: number[] | undefined;
  let targets: Target[] | undefined;
  for (const [k, v] of Object.entries(body)) {
    if (k === 'depends_on') {
      if (!Array.isArray(v) || !v.every(Number.isInteger)) throw new HttpError(400, 'depends_on must be an array of ticket ids');
      deps = v as number[];
      continue;
    }
    if (k === 'targets') {
      const ok = (x: unknown) => typeof x === 'object' && x !== null && Number.isInteger((x as Target).id) && typeof ((x as Target).edit ?? false) === 'boolean';
      if (!Array.isArray(v) || !v.every(ok)) throw new HttpError(400, 'targets must be an array of { id, edit }');
      targets = (v as Target[]).map((x) => ({ id: x.id, edit: x.edit ?? false }));
      continue;
    }
    if (k === 'tags') { cols.push(k); vals.push(normaliseTags(v)); continue; }
    const t = TICKET_FIELDS[k];
    if (!t) throw new HttpError(400, `unknown field ${k}`);
    if (v === null && NULLABLE.has(k)) { cols.push(k); vals.push(null); continue; }
    if (t === 'string' && typeof v !== 'string') throw new HttpError(400, `${k} must be a string`);
    if (t === 'int' && !Number.isInteger(v)) throw new HttpError(400, `${k} must be an integer`);
    if (t === 'bool' && typeof v !== 'boolean') throw new HttpError(400, `${k} must be a boolean`);
    cols.push(k);
    vals.push(t === 'bool' ? Number(v) : v);
  }
  return { cols, vals, deps, targets };
}

export interface Ticket {
  id: number; title: string; body: string; criteria: string; status: string; cli: string | null; model: string | null;
  effort: string | null; tags: string; created_by_grant: number | null; retry: number; agent_level: number; read_all: boolean; template: string; merged_at: string | null; created_at: string; updated_at: string;
  flags: { needs_human: boolean; blocked_on_deps: boolean; blocked: boolean }; depends_on: number[]; targets: Target[];
}
/** A ticket this one's worker and tester may read; with edit, its worker may also update its body and criteria. Not a dependency. */
export interface Target { id: number; edit: boolean }

export function readTicket(db: DatabaseSync, id: number): Ticket {
  const row = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as Json | undefined;
  if (!row) throw new HttpError(404, 'no such ticket');
  const { needs_human, blocked_on_deps, blocked, read_all, ...rest } = row;
  const deps = db.prepare('SELECT depends_on_id FROM ticket_deps WHERE ticket_id = ? ORDER BY depends_on_id').all(id);
  return {
    ...rest,
    read_all: read_all === 1,
    flags: { needs_human: needs_human === 1, blocked_on_deps: blocked_on_deps === 1, blocked: blocked === 1 },
    depends_on: deps.map((d) => d.depends_on_id as number),
    targets: targetsOf(db, id),
  } as Ticket;
}

export const targetsOf = (db: DatabaseSync, id: number): Target[] =>
  (db.prepare('SELECT target_id, edit FROM ticket_targets WHERE ticket_id = ? ORDER BY target_id').all(id) as { target_id: number; edit: number }[])
    .map((r) => ({ id: r.target_id, edit: r.edit === 1 }));

export function setTargets(db: DatabaseSync, id: number, targets: Target[]) {
  db.prepare('DELETE FROM ticket_targets WHERE ticket_id = ?').run(id);
  const ins = db.prepare('INSERT INTO ticket_targets (ticket_id, target_id, edit) VALUES (?, ?, ?)');
  for (const t of new Map(targets.map((x) => [x.id, x])).values()) {
    if (t.id === id) throw new HttpError(400, `ticket ${id} cannot target itself`);
    if (!db.prepare('SELECT 1 FROM tickets WHERE id = ?').get(t.id)) throw new HttpError(400, `target ${t.id} is not a ticket`);
    ins.run(id, t.id, Number(t.edit));
  }
}

export function setDeps(db: DatabaseSync, id: number, deps: number[]) {
  db.prepare('DELETE FROM ticket_deps WHERE ticket_id = ?').run(id);
  const ins = db.prepare('INSERT INTO ticket_deps (ticket_id, depends_on_id) VALUES (?, ?)');
  for (const d of deps) ins.run(id, d);
  // Callers run this in a transaction, so a cycle rolls the whole write back.
  const cycle = db.prepare(`
    WITH RECURSIVE reach(id) AS (
      SELECT depends_on_id FROM ticket_deps WHERE ticket_id = ?
      UNION SELECT d.depends_on_id FROM ticket_deps d JOIN reach r ON d.ticket_id = r.id)
    SELECT 1 FROM reach WHERE id = ?`).get(id, id);
  if (cycle) throw new HttpError(400, `dependency cycle: ticket ${id} would end up depending on itself`);
}

/**
 * Ends every live session of a ticket and cancels its worktree_setup. The outcome is set before the kill, so exited() records it and flags nothing. A session
 * that already has one is already dying and keeps it.
 */
function endSessions(db: DatabaseSync, id: number, outcome: string) {
  for (const s of sessionsOf(id)) {
    if (s.outcome) continue;
    s.outcome = outcome;
    revoke(db, s.grantId);
    killSession(s);
  }
  void cancelSetup(id);
}

/** Deletes a ticket with its sessions and attachments. The UI's DELETE route and the delete_ticket tool both come here. */
export function deleteTicket(board: Board, id: number) {
  const { db } = board;
  const r = db.prepare('DELETE FROM tickets WHERE id = ?').run(id);
  if (r.changes === 0) throw new HttpError(404, 'no such ticket');
  // Its agents stop with it. The outcome makes their exit expected, so it flags nothing on a ticket that is gone.
  endSessions(db, id, 'deleted');
  rmSync(attachmentDir(board.repo, id), { recursive: true, force: true });
  tick(board);
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * Ranked FTS5 search over both brains, merged by rank; an empty query lists the newest rows. Every row carries its `scope`.
 * `raw`: `q` is already FTS5 syntax (context.ts's any-word query); otherwise each word is quoted and must match.
 * Shared by REST and MCP, as is everything below that takes `Brains`.
 */
// ponytail: bm25 is computed per file, so a term rare in one brain and common in the other ranks unevenly across them; fine
// while each brain is a few hundred rows. Upgrade: rank on one index (an FTS table rebuilt over both) if the merge misorders.
export function brainSearch(b: Brains, q: string, limit: number, only?: Scope, raw = false) {
  const rows = SCOPES.filter((s) => !only || s === only).flatMap((scope) =>
    (q.trim()
      ? b[scope].prepare(`SELECT b.*, ${BRAIN_RANK} AS rank FROM brain_fts f JOIN brain b ON b.id = f.rowid WHERE brain_fts MATCH ? ORDER BY rank, b.id LIMIT ?`).all(raw ? q : ftsQuery(q), limit)
      : b[scope].prepare('SELECT *, 0 AS rank FROM brain ORDER BY id DESC LIMIT ?').all(limit)
    ).map((r) => ({ scope, ...r }) as BrainRow & { rank: number }));
  // Stable sort: on a tie the project row stays first.
  rows.sort(q.trim() ? (x, y) => x.rank - y.rank : (x, y) => y.created_at.localeCompare(x.created_at));
  return rows.slice(0, limit).map(({ rank: _, ...r }) => r);
}

type BrainRow = { scope: Scope; id: number; title: string; body: string; tags: string; ticket_id: number | null; created_at: string };
type BrainFields = { title?: string; body?: string; tags?: string };

export function brainGet(b: Brains, scope: Scope, id: number): BrainRow | undefined {
  const r = b[scope].prepare('SELECT * FROM brain WHERE id = ?').get(id);
  return r && ({ scope, ...r } as BrainRow);
}

/** A global row never has a ticket: tickets are per repo. */
export function brainAdd(b: Brains, scope: Scope, f: Required<BrainFields>, ticketId: number | null): BrainRow {
  const r = b[scope].prepare('INSERT INTO brain (title, body, tags, ticket_id) VALUES (?, ?, ?, ?)').run(f.title, f.body, f.tags, scope === 'global' ? null : ticketId);
  return brainGet(b, scope, Number(r.lastInsertRowid))!;
}

/**
 * Rows are edited in place, no history: the audit log says who changed what. An id is per file, so `scope` + `id` name a row;
 * unknown in that scope is 404. `to` moves the row to the other brain (insert there, then delete here); it gets a new id.
 */
export function brainUpdate(b: Brains, scope: Scope, id: number, fields: BrainFields, to?: Scope): BrainRow {
  const set = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (set.length === 0 && (!to || to === scope)) throw new HttpError(400, 'give title, body and/or tags, or a scope to move to');
  const row = brainGet(b, scope, id);
  if (!row) throw new HttpError(404, `no such ${scope} brain row`);
  if (!to || to === scope) {
    if (set.length) b[scope].prepare(`UPDATE brain SET ${set.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...set.map(([, v]) => v!), id);
    return brainGet(b, scope, id)!;
  }
  // Two files, so no one transaction: a failed delete takes the copy back out.
  const f = { ...row, ...Object.fromEntries(set) };
  const r = b[to].prepare('INSERT INTO brain (title, body, tags, ticket_id, created_at) VALUES (?, ?, ?, ?, ?)').run(f.title, f.body, f.tags, to === 'global' ? null : row.ticket_id, row.created_at);
  try {
    brainDelete(b, scope, id);
  } catch (e) {
    b[to].prepare('DELETE FROM brain WHERE id = ?').run(r.lastInsertRowid);
    throw e;
  }
  return brainGet(b, to, Number(r.lastInsertRowid))!;
}

export function brainDelete(b: Brains, scope: Scope, id: number) {
  if (b[scope].prepare('DELETE FROM brain WHERE id = ?').run(id).changes === 0) throw new HttpError(404, `no such ${scope} brain row`);
}

/** A board's two brains: its repo's board.db and the shared global one. */
export const brains = (b: Board): Brains => ({ project: b.db, global: b.brain });

/** `scope` from a REST query or body: project when absent. */
function scopeOf(v: unknown, what = 'scope'): Scope {
  if (v === undefined || v === null) return 'project';
  if (!SCOPES.includes(v as Scope)) throw new HttpError(400, `${what} must be project or global`);
  return v as Scope;
}

/** REST body check for POST (all of title and body) and PATCH (any subset). */
function brainFields(body: Record<string, unknown>, partial: boolean): BrainFields {
  const { title, body: text, tags } = body;
  for (const [k, v] of Object.entries({ title, body: text, tags })) {
    if (v === undefined ? !partial && k !== 'tags' : typeof v !== 'string' || (k !== 'tags' && !v.trim())) {
      throw new HttpError(400, 'title and body must be non-empty strings, tags a string');
    }
  }
  if (typeof text === 'string' && text.length > BRAIN_BODY_MAX) throw new HttpError(400, `body over ${BRAIN_BODY_MAX} characters: one fact per row`);
  return { title, body: text, tags } as BrainFields;
}

function ftsQuery(q: string): string {
  // Each whitespace-separated term becomes a quoted phrase, so user input cannot break FTS5 syntax.
  return q.split(/\s+/).filter(Boolean).map((t) => `"${t.replaceAll('"', '""')}"`).join(' ');
}

const NOTEPAD_MAX = 256 * 1024;
const notepadPath = (board: Board) => join(board.repo, '.kanban95', 'notepad.md');
const UI_MAX = 64 * 1024;
const uiPath = (board: Board) => join(board.repo, '.kanban95', 'ui.json');

const UPLOAD = /^\/api\/tickets\/(\d+)\/attachments$/;
const ATTACHMENT = /^\/api\/tickets\/(\d+)\/attachments\/([^/]+)$/;

const routes: [method: string, path: RegExp, mutation: string | null, handler: (c: Ctx) => Reply | Promise<Reply>][] = [
  ['GET', /^\/api\/tickets$/, null, ({ db }) => ({
    status: 200,
    body: (db.prepare('SELECT id FROM tickets ORDER BY id').all() as { id: number }[]).map((r) => readTicket(db, r.id)),
  })],
  ['POST', /^\/api\/tickets$/, 'tickets.create', ({ board, db, body }) => {
    const { cols, vals, deps, targets } = ticketColumns(body);
    if (!cols.includes('title')) throw new HttpError(400, 'title is required');
    const bad = typeof body.model === 'string' && uncatalogued(body.model, typeof body.cli === 'string' ? body.cli : null, board.repo);
    if (bad) throw new HttpError(400, bad);
    const id = transaction(db, () => {
      const r = db.prepare(`INSERT INTO tickets (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...(vals as never[]));
      const id = Number(r.lastInsertRowid);
      if (deps) setDeps(db, id, deps);
      if (targets) setTargets(db, id, targets);
      return id;
    });
    return { status: 201, body: readTicket(db, id) };
  }],
  ['GET', /^\/api\/tickets\/(\d+)$/, null, ({ db, params }) => ({ status: 200, body: readTicket(db, Number(params[0])) })],
  ['PATCH', /^\/api\/tickets\/(\d+)$/, 'tickets.update', ({ board, db, params, body }) => {
    const id = Number(params[0]);
    readTicket(db, id);
    const { cols, vals, deps, targets } = ticketColumns(body);
    if (cols.length === 0 && !deps && !targets) throw new HttpError(400, 'nothing to update');
    if (typeof body.model === 'string') {
      const bad = uncatalogued(body.model, typeof body.cli === 'string' ? body.cli : readTicket(db, id).cli, board.repo);
      if (bad) throw new HttpError(400, bad);
    }
    // A move by hand (docs/LIFECYCLE.md → Moves by hand) stops the ticket's agents, whoever sent it, and clears its flag unless the
    // body sets one. The UI closes the terminals of a ticket it sees in backlog.
    const was = readTicket(db, id);
    const moved = typeof body.status === 'string' && body.status !== was.status;
    transaction(db, () => {
      if (moved) db.prepare('UPDATE tickets SET needs_human = 0 WHERE id = ?').run(id);
      if (cols.length) db.prepare(`UPDATE tickets SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...(vals as never[]), id);
      if (deps) setDeps(db, id, deps);
      if (targets) setTargets(db, id, targets);
    });
    if (moved) endSessions(db, id, body.status === 'backlog' ? 'reset' : 'moved');
    // Into Done unmerged: a branch goes to the merge queue, as a pass would; no branch means nothing to land, so it is closed.
    if (moved && body.status === 'done' && !was.merged_at) {
      if (!hasBranch(board.repo, id)) db.prepare("UPDATE tickets SET merged_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(id);
      else if (!readTicket(db, id).flags.blocked) apply(board, id, 'merge');
    }
    return { status: 200, body: readTicket(db, id) };
  }],
  ['DELETE', /^\/api\/tickets\/(\d+)$/, 'tickets.delete', ({ board, params }) => {
    deleteTicket(board, Number(params[0]));
    return { status: 204 };
  }],
  ['GET', /^\/api\/tickets\/(\d+)\/(notes|audit)$/, null, ({ db, params }) => {
    readTicket(db, Number(params[0]));
    return { status: 200, body: db.prepare(`SELECT * FROM ${params[1]} WHERE ticket_id = ? ORDER BY id`).all(Number(params[0])) };
  }],
  ['GET', /^\/api\/tickets\/(\d+)\/runs$/, null, ({ db, params }) => {
    readTicket(db, Number(params[0]));
    const rows = db.prepare(`SELECT id, ticket_id, phase, cli, model, effort, started_at, ended_at, outcome, session_id,
      scrollback IS NOT NULL AS has_scrollback FROM runs WHERE ticket_id = ? ORDER BY id`).all(Number(params[0])) as { has_scrollback: number }[];
    return { status: 200, body: rows.map((r) => ({ ...r, has_scrollback: !!r.has_scrollback })) };
  }],
  ['GET', /^\/api\/tickets\/(\d+)\/runs\/(\d+)$/, null, ({ db, params }) => {
    readTicket(db, Number(params[0]));
    const run = db.prepare('SELECT * FROM runs WHERE id = ? AND ticket_id = ?').get(Number(params[1]), Number(params[0]));
    if (!run) throw new HttpError(404, 'no such run on this ticket');
    return { status: 200, body: run };
  }],
  // Attachments. The upload is the file's raw bytes with its name in `?name=`; the audit row names the file as stored.
  ['GET', UPLOAD, null, ({ board, params }) => {
    readTicket(board.db, Number(params[0]));
    return { status: 200, body: attachments(board.repo, Number(params[0])) };
  }],
  ['POST', UPLOAD, 'attachments.add', async ({ board, params, body, req }) => {
    const id = Number(params[0]);
    const data = await readRaw(req, MAX_ATTACHMENT, `an attachment may be at most ${MAX_ATTACHMENT >> 20} MB`);
    readTicket(board.db, id);
    const name = typeof body.name === 'string' ? safeName(body.name) : null;
    if (!name) throw new HttpError(400, 'name must be a file name, without a path separator or ..');
    body.name = saveAttachment(board.repo, id, name, data);
    return { status: 201, body: attachments(board.repo, id).find((a) => a.name === body.name) };
  }],
  ['GET', ATTACHMENT, null, ({ board, params }) => {
    const { name, file } = attachmentFile(board, params);
    const type = IMAGE[extname(name).toLowerCase()];
    // Only images render; anything else downloads, so an uploaded page or script never runs on the board's origin.
    return { status: 200, body: readFileSync(file), headers: {
      'Content-Type': type ?? 'application/octet-stream',
      'Content-Disposition': `${type ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
    } };
  }],
  ['DELETE', ATTACHMENT, 'attachments.remove', ({ board, params, body }) => {
    const { name, file } = attachmentFile(board, params);
    rmSync(file);
    body.name = name;
    return { status: 204 };
  }],
  // `scope` (project, global) narrows the list to one brain. A move is a PATCH with `move_to` (docs/AGENTS.md → The brain).
  ['GET', /^\/api\/brain$/, null, ({ board, db, url }) => {
    const q = url.searchParams.get('q') ?? '';
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 20) || 20, 100);
    const only = url.searchParams.get('scope') || undefined; // absent or empty: both
    // The source ticket's status, so the Brain window shows rows written for work that never landed.
    const status = db.prepare('SELECT status FROM tickets WHERE id = ?');
    const rows = brainSearch(brains(board), q, limit, only ? scopeOf(only) : undefined)
      .map((r) => ({ ...r, ticket_status: r.ticket_id === null ? null : (status.get(r.ticket_id) as { status: string } | undefined)?.status ?? null }));
    return { status: 200, body: rows };
  }],
  // `?scope=` names the row's brain (project when absent); it is copied into the body so the audit row records it.
  ['PATCH', /^\/api\/brain\/(\d+)$/, 'brain.update', ({ board, params, body, url }) => {
    const fields = brainFields(body, true);
    body.scope = scopeOf(url.searchParams.get('scope') ?? undefined);
    const to = body.move_to === undefined ? undefined : scopeOf(body.move_to, 'move_to');
    return { status: 200, body: brainUpdate(brains(board), body.scope as Scope, Number(params[0]), fields, to) };
  }],
  ['DELETE', /^\/api\/brain\/(\d+)$/, 'brain.delete', ({ board, params, body, url }) => {
    body.scope = scopeOf(url.searchParams.get('scope') ?? undefined);
    brainDelete(brains(board), body.scope as Scope, Number(params[0]));
    return { status: 204 };
  }],
  ['GET', /^\/api\/grants$/, null, ({ db }) => ({
    status: 200,
    body: db.prepare('SELECT id, ticket_id, role, expires_at, revoked_at, created_at FROM grants ORDER BY id').all(),
  })],
  ['DELETE', /^\/api\/grants\/(\d+)$/, 'grants.revoke', ({ db, params }) => {
    if (!revoke(db, Number(params[0]))) throw new HttpError(404, 'no such live grant');
    killGrantSession(Number(params[0]));
    return { status: 204 };
  }],
  // Lifecycle (docs/LIFECYCLE.md). A transition the table does not have is 409.
  ['POST', /^\/api\/tickets\/(\d+)\/launch$/, 'tickets.launch', ({ board, params }) => ({ status: 200, body: apply(board, Number(params[0]), 'launch').ticket })],
  ['POST', /^\/api\/tickets\/(\d+)\/resume$/, 'tickets.resume', ({ board, params }) => ({ status: 200, body: apply(board, Number(params[0]), 'resume').ticket })],
  ['POST', /^\/api\/tickets\/(\d+)\/restart$/, 'tickets.restart', ({ board, params }) => ({ status: 200, body: apply(board, Number(params[0]), 'restart').ticket })],
  ['POST', /^\/api\/tickets\/(\d+)\/answer$/, 'tickets.answer', ({ board, params, body }) => {
    if (typeof body.answer !== 'string' || !body.answer.trim()) throw new HttpError(400, 'answer must be a non-empty string');
    const id = Number(params[0]);
    readTicket(board.db, id);
    return { status: 200, body: apply(board, id, 'answer', { note: { role: 'operator', kind: 'answer', body: body.answer }, answer: body.answer }).ticket };
  }],
  // The operator's reason goes to the next worker as a failure note (docs/LIFECYCLE.md → Reject).
  ['POST', /^\/api\/tickets\/(\d+)\/reject$/, 'tickets.reject', ({ board, params, body }) => {
    if (typeof body.reason !== 'string' || !body.reason.trim()) throw new HttpError(400, 'reason must be a non-empty string');
    return { status: 200, body: apply(board, Number(params[0]), 'reject', { note: { role: 'operator', kind: 'failure', body: body.reason.trim() } }).ticket };
  }],
  // The runner (docs/LIFECYCLE.md → The runner): `{on}` turns it on or off and returns what the status bar shows, with the
  // resolved `concurrency`. Concurrency is a settings.json value: a body carrying it is a 400 pointing there.
  // `{on: false}` (Stop) also clears every Backlog hold, so nothing staged starts later by itself, and says how many in `cleared`.
  ['GET', /^\/api\/runner$/, null, ({ board }) => ({ status: 200, body: runnerState(board) })],
  ['PUT', /^\/api\/runner$/, 'runner.set', ({ board, body }) => {
    const { on } = body;
    if (body.concurrency !== undefined) throw new HttpError(400, 'concurrency is a settings.json value: PUT /api/config/settings');
    if (typeof on !== 'boolean') throw new HttpError(400, 'on must be a boolean');
    setRunner(board, on);
    if (on !== false) return { status: 200, body: runnerState(board) };
    const held = (board.db.prepare("UPDATE tickets SET blocked_on_deps = 0 WHERE status = 'backlog' AND blocked_on_deps = 1 RETURNING id").all() as { id: number }[]);
    for (const { id } of held) changed(id);
    return { status: 200, body: { ...runnerState(board), cleared: held.length } };
  }],
  // The status bar's Push button: the base to its upstream with the operator's own git credentials (docs/OPERATOR.md → Push).
  ['POST', /^\/api\/push$/, 'board.push', async ({ board }) => {
    const failed = await pushBase(board);
    if (failed) throw new HttpError(502, failed);
    return { status: 200, body: runnerState(board) };
  }],
  ['POST', /^\/api\/tickets\/(\d+)\/merge$/, 'tickets.merge', ({ board, params }) => ({ status: 200, body: apply(board, Number(params[0]), 'merge').ticket })],
  ['POST', /^\/api\/tickets\/bootstrap$/, 'tickets.bootstrap', ({ board }) => ({ status: 201, body: bootstrap(board, null) })],
  ['POST', /^\/api\/tickets\/housekeeping$/,'tickets.housekeeping', ({ board }) => ({
    status: 201, body: housekeeping(board, 'Started by the operator from the Housekeeping button. Follow the housekeeping brief.'),
  })],
  ['GET', /^\/api\/tickets\/(\d+)\/diff$/, null, ({ board, params }) => {
    readTicket(board.db, Number(params[0]));
    return { status: 200, body: { diff: ticketDiff(board.repo, Number(params[0])) } };
  }],
  // What a flagged ticket waits on: questions an agent asked with ask_operator that have no answer yet, and, when no newer
  // question is open, the failure that flagged it. `merged_at` tells the Inbox whether Retry merge applies.
  ['GET', /^\/api\/inbox$/, null, ({ db }) => ({
    status: 200,
    body: (db.prepare(`
      SELECT n.id, n.ticket_id, n.role, n.kind, n.body, n.created_at, t.title, t.status, t.merged_at FROM notes n JOIN tickets t ON t.id = n.ticket_id
      WHERE t.needs_human = 1 AND (
        (n.kind = 'question' AND NOT EXISTS (SELECT 1 FROM notes a WHERE a.ticket_id = n.ticket_id AND a.kind = 'answer' AND a.id > n.id))
        OR (n.kind = 'failure' AND n.id = (SELECT max(id) FROM notes m WHERE m.ticket_id = n.ticket_id AND m.kind IN ('failure', 'question'))))
      ORDER BY n.id`).all() as { kind: string; body: string }[]).map((n) => ({ ...n, permission: n.kind === 'question' ? permissionOf(n.body) : null })),
  })],
  ['GET', /^\/api\/deliverables$/, null, ({ db }) => ({ status: 200, body: listDeliverables(db) })],
  ['DELETE', /^\/api\/deliverables$/, 'deliverables.dismiss', ({ db, body }) => {
    if (!dismissDeliverable(db, String(body.folder))) throw new HttpError(404, 'no such entry');
    changed(null);
    return { status: 204 };
  }],
  ['POST', /^\/api\/deliverables\/open$/, 'deliverables.open', ({ board, db, body }) => {
    try {
      openDeliverable(db, board.repo, String(body.folder));
    } catch (e) {
      throw new HttpError(404, (e as Error).message);
    }
    return { status: 204 };
  }],
  ['POST', /^\/api\/brain$/, 'brain.add', ({ board, body }) => {
    const { title, body: text, tags = '' } = brainFields(body, false);
    return { status: 201, body: brainAdd(brains(board), scopeOf(body.scope), { title: title!, body: text!, tags }, null) };
  }],
  // Live agent terminals, for the UI's terminal windows and the taskbar count. `id` is the /pty/<id> key.
  ['GET', /^\/api\/sessions$/, null, () => ({ status: 200, body: [...sessions.values()].map(sessionView) })],
  // The operator's X on a terminal: the agent stops for good. A ticket's is flagged so it can be resumed; `closed` keeps
  // the exit handler from writing a second note.
  ['DELETE', /^\/api\/sessions\/(-?\d+)$/, 'sessions.end', ({ board, db, params }) => {
    const s = sessions.get(Number(params[0]));
    if (!s) throw new HttpError(404, 'no such session');
    s.outcome = 'closed';
    revoke(db, s.grantId);
    killSession(s);
    if (s.ticketId !== null) {
      try {
        apply(board, s.ticketId, 'exit', { note: { role: 'operator', kind: 'failure', body: 'ended by the operator from the terminal window' } });
      } catch (e) {
        if (!(e instanceof Refused)) throw e; // the ticket has moved on; nothing to flag
      }
    }
    return { status: 204 };
  }],
  // Optional `mission`: the operator's draft (Notepad's selection), put in the planner's brief verbatim.
  ['POST', /^\/api\/brainstorm$/, 'brainstorm.launch', async ({ board, body }) => {
    const { mission = '' } = body;
    if (typeof mission !== 'string') throw new HttpError(400, 'mission must be a string');
    return { status: 201, body: sessionView(brainstorm(board, mission.trim() || undefined, readyText(await readiness(board)))) };
  }],
  // An operator terminal: the typed mission goes into its brief verbatim (docs/SECURITY.md → Operator terminal).
  ['POST', /^\/api\/operator$/, 'operator.launch', async ({ board, body }) => {
    if (typeof body.mission !== 'string' || !body.mission.trim()) throw new HttpError(400, 'mission must be a non-empty string');
    return { status: 201, body: sessionView(operator(board, body.mission, readyText(await readiness(board)))) };
  }],
  // Start → Restart board: rebuild, then close and exit 75 (restartBoard in lifecycle.ts, which the board's own restart after a
  // merge uses too). 409 with the compiler output when the build fails.
  ['POST', /^\/api\/restart$/, 'board.restart', async ({ board }) => {
    if (board.closing || !board.shutdown) throw new HttpError(409, board.closing ? 'the board is already shutting down' : 'restart needs the daemon running as its own process');
    const failed = await restartBoard(board);
    if (failed !== null) throw new HttpError(409, failed);
    return { status: 202, body: { restarting: true, shell: board.shell === true } };
  }],
  ['GET', /^\/api\/data-folder$/, null, () => ({ status: 200, body: { path: boardHome() } })],
  ['PUT', /^\/api\/data-folder$/, 'config.write', ({ board, body }) => {
    const path = typeof body.path === 'string' ? body.path.trim() : '';
    if (!isAbsolute(path)) throw new HttpError(400, `Data folder ${path} is not an absolute path`);
    if (gone(path)) throw new HttpError(400, `Data folder ${path} was not found or is not a folder`);
    const refused = busy(board, 'Data folder not changed', 'Change it');
    if (refused) throw new HttpError(409, refused);
    if (board.closing || !board.shutdown) throw new HttpError(409, board.closing ? 'the board is already shutting down' : 'changing the data folder needs the daemon running as its own process');
    const others = board.shell ? othersHosted(board.shellId) : [];
    setBoardHome(path);
    others.forEach((repo) => tellShell('restart', repo));
    relaunch(board);
    return { status: 202, body: { path: boardHome(), shell: board.shell === true } };
  }],
  ['GET', /^\/api\/update$/, null, ({ board }) => ({ status: 200, body: { version: VERSION, offer: board.update ?? null, release: releaseOn(board.repo), kanban95: isKanban95(board.repo) } })],
  ['POST', /^\/api\/update$/, 'update.answer', ({ board, body }) => {
    if (body.answer === 'later') {
      board.update = undefined;
      return { status: 204 };
    }
    if (!board.shell) throw new HttpError(409, 'Updates come through the Kanban95 app; this board was started without it.');
    if (body.answer === 'check') {
      checkNow(board);
      return { status: 202, body: { asked: 'check' } };
    }
    if (body.answer !== 'now') throw new HttpError(400, 'answer must be now, later or check');
    const refused = installNow(board);
    if (refused) throw new HttpError(409, refused);
    return { status: 202, body: { asked: 'update' } };
  }],
  ['POST', /^\/api\/update\/shell$/, null, ({ board, body, req }) => {
    if (req.headers.origin !== undefined || !board.shell) throw new HttpError(403, 'only the shell reports updates');
    const r = REPORT.safeParse(body);
    if (!r.success) throw new HttpError(400, `bad update report: ${r.error.issues[0]?.message}`);
    relay(board, r.data);
    return { status: 204 };
  }],
  ['POST', /^\/api\/open\/shell$/, null, ({ board, body, req }) => {
    if (req.headers.origin !== undefined || !board.shell) throw new HttpError(403, 'only the shell reports a failed open');
    const { path, error } = body as { path?: unknown; error?: unknown };
    if (typeof path !== 'string' || !path || typeof error !== 'string' || !error || path.length > 4096 || error.length > 2000) {
      throw new HttpError(400, 'bad open report: path and error must be non-empty strings');
    }
    events.emit('event', { type: 'open-failed', folder: basename(path), reason: error.replace(/\s+/g, ' ').trim() });
    return { status: 204 };
  }],
  ['POST', /^\/api\/pick$/, null, ({ board, body }) => startPick(board.shell === true, board.repo, body.kind, (f) => events.emit('event', f))],
  ['POST', /^\/api\/pick\/([0-9a-f]{32})$/, null, ({ params, body, req }) => finishPick(params[0]!, req.headers.origin, body)],
  ['GET', /^\/api\/release$/, null, ({ board }) => ({ status: 200, body: releaseInfo(board) })],
  ['POST', /^\/api\/release$/, 'board.release', async ({ board, body }) => {
    if (!BUMPS.includes(body.bump as Bump)) throw new HttpError(400, `bump must be one of ${BUMPS.join(', ')}`);
    const r = await release(board, body.bump as Bump);
    if ('failed' in r) throw new HttpError(502, r.failed);
    return { status: 200, body: { tag: r.tag, runner: runnerState(board) } };
  }],
  // <repo>/.kanban95/notepad.md, the operator's scratch notes, whole file in `value` both ways ('' when absent).
  // Not audited: it autosaves every pause in typing and is nothing an agent reads.
  ['GET', /^\/api\/notepad$/, null, ({ board }) => {
    try {
      return { status: 200, body: { value: readFileSync(notepadPath(board), 'utf8') } };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { status: 200, body: { value: '' } };
      throw e;
    }
  }],
  ['PUT', /^\/api\/notepad$/, null, ({ board, body }) => {
    if (typeof body.value !== 'string') throw new HttpError(400, 'value must be a string');
    if (Buffer.byteLength(body.value) > NOTEPAD_MAX) throw new HttpError(413, `notepad over ${NOTEPAD_MAX / 1024} KB`);
    const file = notepadPath(board);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, body.value);
    renameSync(`${file}.tmp`, file);
    return { status: 200, body: { value: body.value } };
  }],
  // <repo>/.kanban95/ui.json, the UI's window places, startup layout and folded columns (ui/state.js): one object, {} when absent.
  // Not audited, as the notepad: it is written after every drag.
  ['GET', /^\/api\/ui$/, null, ({ board }) => {
    try {
      return { status: 200, body: JSON.parse(readFileSync(uiPath(board), 'utf8')) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT' || e instanceof SyntaxError) return { status: 200, body: {} };
      throw e;
    }
  }],
  ['PUT', /^\/api\/ui$/, null, ({ board, body }) => {
    const text = JSON.stringify(body);
    if (Buffer.byteLength(text) > UI_MAX) throw new HttpError(400, `UI state over ${UI_MAX / 1024} KB`);
    const file = uiPath(board);
    writeFileSync(`${file}.tmp`, text);
    renameSync(`${file}.tmp`, file);
    return { status: 200, body };
  }],
  // ~/.kanban95/models.json, settings.json and preferences.md, or this repo's copy (?scope=project) in projects/<repo key>/.
  // GET shows the file as it is (null when absent; preferences is text, '' when absent); scope=project shows the global file
  // until a copy exists. PUT checks it whole, then writes; scope=project writes (and starts) the copy. See configView.
  ['GET', /^\/api\/config\/(\w+)$/, null, ({ board, params, url }) => ({ status: 200, body: configView(board, configName(params[0]), url) })],
  ['PUT', /^\/api\/config\/(\w+)$/, 'config.write', ({ board, params, body, url }) => {
    const name = configName(params[0]);
    const repo = configScope(url) === 'project' ? board.repo : undefined;
    const value = name === 'preferences' ? writePreferences(body.value, repo) : writeConfig(name, body, repo);
    if (name === 'settings') settingsChanged(board);
    return { status: 200, body: { path: repo ? projectPath(name, repo) : globalPath(name), value } };
  }],
  // Starts this repo's copy as a copy of the global file (409 when one exists), or removes it (404 when none).
  ['POST', /^\/api\/config\/(\w+)\/override$/, 'config.write', ({ board, params, url }) => {
    const name = configName(params[0]);
    if (!addOverride(name, board.repo)) throw new HttpError(409, `${name} already has a project copy`);
    if (name === 'settings') settingsChanged(board);
    return { status: 200, body: configView(board, name, url, 'project') };
  }],
  ['DELETE', /^\/api\/config\/(\w+)\/override$/, 'config.write', ({ board, params, url }) => {
    const name = configName(params[0]);
    if (!dropOverride(name, board.repo)) throw new HttpError(404, `${name} has no project copy`);
    if (name === 'settings') settingsChanged(board);
    return { status: 200, body: configView(board, name, url, 'project') };
  }],
  ['POST', /^\/api\/last-board$/, null, ({ board, body }) => {
    if (body.window !== 'own') writeLastBoard(board.repo);
    return { status: 204 };
  }],
  // ~/.kanban95/projects.json (Settings → Projects): the whole list in `value` both ways. /api/project is this board's entry,
  // with its folder name, for the wallpaper and the window title. A PUT that drops this board's own project is refused.
  ['GET', /^\/api\/project$/, null, ({ board }) => ({ status: 200, body: project(board.repo) })],
  // `running` maps each listed path to whether a live board serves it (~/.kanban95/running/), apart from `value` so a PUT
  // can send `value` back as it came.
  ['GET', /^\/api\/projects$/, null, ({ board }) => ({ status: 200, body: { path: projectsPath(), value: readProjects(), running: runningMap(), missing: missingMap(), hosted: hostedMap(board.shellId), agents: agentsMap(), attention: attentionMap() } })],
  ['PUT', /^\/api\/projects$/, 'config.write', ({ board, body }) => ({ status: 200, body: { path: projectsPath(), value: writeProjects(body.value, board.repo) } })],
  // Start → Projects: start a board on a listed project that is not running, or bring a running one's window to the front.
  // A path not in projects.json is 400; open on a running one, or focus on one that is not, is 409.
  ['POST', /^\/api\/projects\/open$/, 'projects.open', ({ board, body }) => {
    if (body.where === 'here') return other(async () => askShell(board, 'open', body.path), 202);
    if (body.where !== undefined && body.where !== 'window') throw new HttpError(400, "where must be 'here' or 'window'");
    return other(() => openProject(body.path, board.root ?? resolve(import.meta.dirname, '../..')), 202);
  }],
  ['POST', /^\/api\/projects\/switch$/, 'projects.switch', ({ board, body }) => other(async () => askShell(board, 'switch', body.path), 202)],
  ['POST', /^\/api\/projects\/popout$/, 'projects.popout', ({ board, body }) => other(async () => askShell(board, 'popout', body.path), 202)],
  ['POST', /^\/api\/projects\/dock$/, 'projects.dock', ({ board, body }) => other(async () => askShell(board, 'dock', body.path), 202)],
  ['POST', /^\/api\/projects\/close$/, 'projects.close', ({ board, body }) => other(async () => askShell(board, 'close', body.path), 202)],
  ['POST', /^\/api\/projects\/focus$/, null, ({ body }) => other(() => focusProject(body.path), 200)],
  // <repo>/.kanban95/templates/*.md, the prompt sources. `vars` is the only list of allowed {{variables}}; the UI shows it.
  ['GET', /^\/api\/templates$/, null, ({ board }) => ({ status: 200, body: { vars: VARS, templates: Object.keys(TEMPLATES).map((n) => templateView(board, n as TemplateName)) } })],
  ['PUT', /^\/api\/templates\/(\w+)$/, 'template.write', ({ board, params, body }) => {
    const name = templateName(params[0]);
    if (typeof body.text !== 'string') throw new HttpError(400, 'text must be a string');
    const v = unknownVar(body.text);
    if (v !== null) throw new HttpError(400, `unknown variable {{${v}}}; allowed: ${VARS.join(', ')}`);
    writeTemplate(board.repo, name, body.text);
    return { status: 200, body: templateView(board, name) };
  }],
  ['POST', /^\/api\/templates\/(\w+)\/reset$/, 'template.reset', ({ board, params }) => {
    const name = templateName(params[0]);
    resetTemplate(board.repo, name);
    return { status: 200, body: templateView(board, name) };
  }],
  ['GET', /^\/api\/models$/, null, async ({ board }) => ({ status: 200, body: await knownModels(board.repo) })],
  ['GET', /^\/api\/trust$/, null, ({ board }) => ({ status: 200, body: trustStatus(board.db, board.repo) })],
  ['DELETE', /^\/api\/trust$/, 'trust.clear', ({ board }) => {
    untrustClaude(board.db, board.repo);
    return { status: 200, body: trustStatus(board.db, board.repo) };
  }],
  // The CLIs' account limits, cached 5 min; ?refresh=1 asks again (docs/OPERATOR.md → Limits). Per-CLI failures are in `errors`.
  ['GET', /^\/api\/limits$/, null, async ({ url }) => ({ status: 200, body: await limits(url.searchParams.has('refresh')) })],
  ['GET', /^\/api\/requirements$/, null, async ({ board }) => ({ status: 200, body: await requirements(board.repo) })],
  ['GET', /^\/api\/ready$/, null, async ({ board }) => ({ status: 200, body: await readiness(board) })],
  ['GET', /^\/api\/voice$/, null, async () => ({ status: 200, body: await voiceStatus() })],
  // The board's only network call, started by the operator's OK in the download dialog (docs/SECURITY.md → Voice model).
  ['POST', /^\/api\/voice\/download$/, 'voice.download', async () => {
    try {
      await download();
    } catch (e) {
      throw new HttpError(502, `voice model download failed: ${(e as Error).message}`);
    }
    return { status: 200, body: await voiceStatus() };
  }],
];

const IMAGE: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };

function attachmentFile(board: Board, params: string[]): { name: string; file: string } {
  readTicket(board.db, Number(params[0]));
  let name: string;
  try {
    name = decodeURIComponent(params[1]);
  } catch {
    throw new HttpError(400, 'bad attachment name');
  }
  const safe = safeName(name);
  if (!safe) throw new HttpError(400, 'name must be a file name, without a path separator or ..');
  const file = join(attachmentDir(board.repo, Number(params[0])), name);
  if (safe !== name || !existsSync(file)) throw new HttpError(404, 'no such attachment'); // a name we would never store
  return { name, file };
}

function sessionView(s: Session) {
  return { id: s.key, ticket_id: s.ticketId, run_id: s.runId, grant_id: s.grantId, role: s.role, phase: s.phase, model: s.model, started_at: new Date(s.started).toISOString() };
}

function settingsChanged(board: Board) {
  releasePending(board);
  changed(null);
  tick(board);
}

function configName(s: string): OverridableName {
  if (!isOverridable(s)) throw new HttpError(404, 'not found');
  return s;
}

/** `?scope=` of a config route: global when absent. */
function configScope(url: URL): 'global' | 'project' {
  const v = url.searchParams.get('scope') ?? 'global';
  if (v !== 'global' && v !== 'project') throw new HttpError(400, 'scope must be global or project');
  return v;
}

/**
 * `{ path, value }` of the file a scope reads. Asked with a scope, also `scope` and `overridden` (a project copy exists), so a
 * reply to an unscoped GET keeps its old shape.
 */
function configView(board: Board, name: OverridableName, url: URL, scope = configScope(url)) {
  const own = projectPath(name, board.repo);
  const overridden = existsSync(own);
  const path = scope === 'project' && overridden ? own : globalPath(name);
  let value: unknown = name === 'preferences' ? '' : null;
  try {
    const text = readFileSync(path, 'utf8');
    value = name === 'preferences' ? text : JSON.parse(text);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new HttpError(400, `${path}: ${(e as Error).message}`);
  }
  return url.searchParams.has('scope') || url.pathname.endsWith('/override') ? { path, value, scope, overridden } : { path, value };
}

function templateName(s: string): TemplateName {
  if (!Object.hasOwn(TEMPLATES, s)) throw new HttpError(404, 'no such template');
  return s as TemplateName;
}

// The raw file, not loadTemplate: a copy with a bad variable must still show so the operator can fix it.
const templateView = (board: Board, name: TemplateName) => {
  const text = readFileSync(templatePath(board.repo, name), 'utf8');
  return { name, path: templatePath(board.repo, name), text, stale: isStale(name, text) };
};

/** The whole body. One over `max` bytes is still read to the end (so the client gets the 413, not a reset), then refused. */
async function readRaw(req: IncomingMessage, max: number, tooLarge: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size <= max) chunks.push(c as Buffer);
  }
  if (size > max) throw new HttpError(413, tooLarge);
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<Json> {
  const raw = await readRaw(req, 1 << 20, 'body too large');
  if (raw.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'body is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new HttpError(400, 'body must be an object');
  return parsed as Json;
}

function reply(res: ServerResponse, r: Reply) {
  if (r.body === undefined) {
    res.writeHead(r.status).end();
    return;
  }
  if (Buffer.isBuffer(r.body)) {
    res.writeHead(r.status, { ...r.headers, 'Content-Length': r.body.length }).end(r.body);
    return;
  }
  const text = JSON.stringify(r.body);
  res.writeHead(r.status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

export async function handleApi(board: Board, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const { db } = board;
  const route = routes.find(([m, p]) => m === req.method && p.test(url.pathname));
  if (!route) {
    const known = routes.some(([, p]) => p.test(url.pathname));
    reply(res, { status: known ? 405 : 404, body: { error: known ? 'method not allowed' : 'not found' } });
    return;
  }
  const [, path, mutation, handler] = route;
  const params = url.pathname.match(path)!.slice(1);
  const ticketId = path.source.includes('tickets') && params[0] ? Number(params[0]) : null;
  const args = (body: Json) => (params[0] ? { id: Number(params[0]), ...body } : body);
  let body: Json = {};
  let out: Reply;
  try {
    body = path === UPLOAD && req.method === 'POST' ? { name: url.searchParams.get('name') } : await readJson(req);
    out = await handler({ board, db, params, body, url, req });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : e instanceof Refused ? 409 : isConstraintError(e) || e instanceof BadConfig ? 400 : 500;
    if (mutation) {
      // audit.ticket_id is a FK, so an attempt against a missing ticket is attributed by args only.
      const exists = ticketId !== null && db.prepare('SELECT 1 FROM tickets WHERE id = ?').get(ticketId) !== undefined;
      audit(db, { grant_id: null, ticket_id: exists ? ticketId : null, tool: mutation, args: args(body), outcome: 'error' });
    }
    reply(res, { status, body: { error: status === 500 ? 'internal error' : (e as Error).message } });
    return;
  }
  if (mutation) {
    const created = mutation === 'tickets.create' || mutation === 'tickets.housekeeping';
    const id = created ? (out.body as { id: number }).id : mutation === 'tickets.delete' ? null : ticketId;
    audit(db, { grant_id: null, ticket_id: id, tool: mutation, args: args(body), outcome: 'ok' });
    changed(mutation === 'tickets.delete' ? ticketId : id); // the UI refetches it (a deleted ticket answers 404 and leaves the board)
  }
  reply(res, out);
}

const FILING_MAX = 64 * 1024;

export async function receiveFiling(board: Board, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') return reply(res, { status: 405, body: { error: 'method not allowed' } });
  if (!keyOk(req.headers['x-k95-key'])) return reply(res, { status: 401, body: { error: 'unauthorized' } });
  const { db } = board;
  let f: Json = {};
  try {
    const raw = await readRaw(req, FILING_MAX, `body over ${FILING_MAX / 1024} KB`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new HttpError(400, 'body is not JSON');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new HttpError(400, 'body must be an object');
    f = parsed as Json;
    const text = (k: string): string => {
      const v = f[k];
      if (v !== undefined && typeof v !== 'string') throw new HttpError(400, `${k} must be a string`);
      return v ?? '';
    };
    if (!text('from').trim() || !text('title').trim()) throw new HttpError(400, 'from and title are required');
    const tags = normaliseTags(f.tags ?? []);
    const r = db.prepare('INSERT INTO tickets (title, body, criteria, tags) VALUES (?, ?, ?, ?)')
      .run(text('title'), `Filed from ${text('from')}\n\n${text('body')}`, text('criteria'), tags);
    const id = Number(r.lastInsertRowid);
    audit(db, { grant_id: null, ticket_id: id, tool: 'boards.file', args: { from: f.from, title: f.title }, outcome: 'ok' });
    changed(id);
    reply(res, { status: 201, body: readTicket(db, id) });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    audit(db, { grant_id: null, ticket_id: null, tool: 'boards.file', args: { from: f.from, title: f.title }, outcome: 'error' });
    reply(res, { status, body: { error: status === 500 ? 'internal error' : (e as Error).message } });
  }
}
