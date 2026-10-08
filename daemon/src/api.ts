// UI-facing REST under /api. Operator-only (no grant); every mutation writes an audit row.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, extname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { attachmentDir, attachments, MAX_ATTACHMENT, safeName, saveAttachment } from './attachments.js';
import { isConstraintError } from './db.js';
import { ticketDiff } from './git.js';
import { audit, revoke } from './grants.js';
import { killGrantSession, sessions, sessionsOf, type Session } from './launcher.js';
import { apply, brainstorm, changed, housekeeping, operator, Refused, runnerState, setRunner, type Board } from './lifecycle.js';
import { BadConfig, CONFIGS, configPath, knownModels, preferencesPath, readPreferences, writeConfig, writePreferences, type ConfigName } from './settings.js';
import { trustStatus, untrustClaude } from './trust.js';
import { download, status as voiceStatus } from './voice.js';

type Json = Record<string, unknown>;
type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
type Ctx = { board: Board; db: DatabaseSync; params: string[]; body: Json; url: URL; req: IncomingMessage };

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// Column whitelist for ticket writes. Values are checked by the schema's CHECK constraints; types here.
const TICKET_FIELDS: Record<string, 'string' | 'int' | 'bool'> = {
  title: 'string', body: 'string', criteria: 'string', status: 'string', cli: 'string', model: 'string',
  effort: 'string', retry: 'int', needs_human: 'bool', blocked_on_deps: 'bool',
};
const NULLABLE = new Set(['cli', 'model', 'effort']);

function ticketColumns(body: Json): { cols: string[]; vals: unknown[]; deps?: number[] } {
  const cols: string[] = [];
  const vals: unknown[] = [];
  let deps: number[] | undefined;
  for (const [k, v] of Object.entries(body)) {
    if (k === 'depends_on') {
      if (!Array.isArray(v) || !v.every(Number.isInteger)) throw new HttpError(400, 'depends_on must be an array of ticket ids');
      deps = v as number[];
      continue;
    }
    const t = TICKET_FIELDS[k];
    if (!t) throw new HttpError(400, `unknown field ${k}`);
    if (v === null && NULLABLE.has(k)) { cols.push(k); vals.push(null); continue; }
    if (t === 'string' && typeof v !== 'string') throw new HttpError(400, `${k} must be a string`);
    if (t === 'int' && !Number.isInteger(v)) throw new HttpError(400, `${k} must be an integer`);
    if (t === 'bool' && typeof v !== 'boolean') throw new HttpError(400, `${k} must be a boolean`);
    cols.push(k);
    vals.push(t === 'bool' ? Number(v) : v);
  }
  return { cols, vals, deps };
}

export interface Ticket {
  id: number; title: string; body: string; criteria: string; status: string; cli: string | null; model: string | null;
  effort: string | null; retry: number; template: string; merged_at: string | null; created_at: string; updated_at: string;
  flags: { needs_human: boolean; blocked_on_deps: boolean }; depends_on: number[];
}

export function readTicket(db: DatabaseSync, id: number): Ticket {
  const row = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as Json | undefined;
  if (!row) throw new HttpError(404, 'no such ticket');
  const { needs_human, blocked_on_deps, ...rest } = row;
  const deps = db.prepare('SELECT depends_on_id FROM ticket_deps WHERE ticket_id = ? ORDER BY depends_on_id').all(id);
  return {
    ...rest,
    flags: { needs_human: needs_human === 1, blocked_on_deps: blocked_on_deps === 1 },
    depends_on: deps.map((d) => d.depends_on_id as number),
  } as Ticket;
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

/** Ranked FTS5 search over the brain; an empty query lists the newest rows. Shared by REST and MCP. */
export function brainSearch(db: DatabaseSync, q: string, limit: number) {
  return q.trim()
    ? db.prepare('SELECT b.* FROM brain_fts f JOIN brain b ON b.id = f.rowid WHERE brain_fts MATCH ? ORDER BY rank LIMIT ?').all(ftsQuery(q), limit)
    : db.prepare('SELECT * FROM brain ORDER BY id DESC LIMIT ?').all(limit);
}

function ftsQuery(q: string): string {
  // Each whitespace-separated term becomes a quoted phrase, so user input cannot break FTS5 syntax.
  return q.split(/\s+/).filter(Boolean).map((t) => `"${t.replaceAll('"', '""')}"`).join(' ');
}

const NOTEPAD_MAX = 256 * 1024;
const notepadPath = (board: Board) => join(board.repo, '.kanban95', 'notepad.md');

const UPLOAD = /^\/api\/tickets\/(\d+)\/attachments$/;
const ATTACHMENT = /^\/api\/tickets\/(\d+)\/attachments\/([^/]+)$/;

const routes: [method: string, path: RegExp, mutation: string | null, handler: (c: Ctx) => Reply | Promise<Reply>][] = [
  ['GET', /^\/api\/tickets$/, null, ({ db }) => ({
    status: 200,
    body: (db.prepare('SELECT id FROM tickets ORDER BY id').all() as { id: number }[]).map((r) => readTicket(db, r.id)),
  })],
  ['POST', /^\/api\/tickets$/, 'tickets.create', ({ db, body }) => {
    const { cols, vals, deps } = ticketColumns(body);
    if (!cols.includes('title')) throw new HttpError(400, 'title is required');
    const id = transaction(db, () => {
      const r = db.prepare(`INSERT INTO tickets (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...(vals as never[]));
      const id = Number(r.lastInsertRowid);
      if (deps) setDeps(db, id, deps);
      return id;
    });
    return { status: 201, body: readTicket(db, id) };
  }],
  ['GET', /^\/api\/tickets\/(\d+)$/, null, ({ db, params }) => ({ status: 200, body: readTicket(db, Number(params[0])) })],
  ['PATCH', /^\/api\/tickets\/(\d+)$/, 'tickets.update', ({ db, params, body }) => {
    const id = Number(params[0]);
    readTicket(db, id);
    const { cols, vals, deps } = ticketColumns(body);
    if (cols.length === 0 && !deps) throw new HttpError(400, 'nothing to update');
    transaction(db, () => {
      if (cols.length) db.prepare(`UPDATE tickets SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...(vals as never[]), id);
      if (deps) setDeps(db, id, deps);
    });
    return { status: 200, body: readTicket(db, id) };
  }],
  ['DELETE', /^\/api\/tickets\/(\d+)$/, 'tickets.delete', ({ board, db, params }) => {
    const id = Number(params[0]);
    // Its agents stop with it. The outcome makes their exit expected, so it flags nothing on a ticket that is gone.
    for (const s of sessionsOf(id)) {
      s.outcome = 'deleted';
      revoke(db, s.grantId);
      s.pty.kill();
    }
    const r = db.prepare('DELETE FROM tickets WHERE id = ?').run(id);
    if (r.changes === 0) throw new HttpError(404, 'no such ticket');
    rmSync(attachmentDir(board.repo, id), { recursive: true, force: true });
    return { status: 204 };
  }],
  ['GET', /^\/api\/tickets\/(\d+)\/(notes|runs|audit)$/, null, ({ db, params }) => {
    readTicket(db, Number(params[0]));
    return { status: 200, body: db.prepare(`SELECT * FROM ${params[1]} WHERE ticket_id = ? ORDER BY id`).all(Number(params[0])) };
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
  ['GET', /^\/api\/brain$/, null, ({ db, url }) => {
    const q = url.searchParams.get('q') ?? '';
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 20) || 20, 100);
    const rows = brainSearch(db, q, limit);
    return { status: 200, body: rows };
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
  // The runner (docs/LIFECYCLE.md → The runner): `{on}` turns it on or off; both return what the status bar shows.
  ['GET', /^\/api\/runner$/, null, ({ board }) => ({ status: 200, body: runnerState(board) })],
  ['PUT', /^\/api\/runner$/, 'runner.set', ({ board, body }) => {
    if (typeof body.on !== 'boolean') throw new HttpError(400, 'on must be a boolean');
    setRunner(board, body.on);
    return { status: 200, body: runnerState(board) };
  }],
  ['POST', /^\/api\/tickets\/(\d+)\/merge$/, 'tickets.merge', ({ board, params }) => ({ status: 200, body: apply(board, Number(params[0]), 'merge').ticket })],
  ['POST', /^\/api\/tickets\/housekeeping$/, 'tickets.housekeeping', ({ board }) => ({
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
    body: db.prepare(`
      SELECT n.id, n.ticket_id, n.role, n.kind, n.body, n.created_at, t.title, t.status, t.merged_at FROM notes n JOIN tickets t ON t.id = n.ticket_id
      WHERE t.needs_human = 1 AND (
        (n.kind = 'question' AND NOT EXISTS (SELECT 1 FROM notes a WHERE a.ticket_id = n.ticket_id AND a.kind = 'answer' AND a.id > n.id))
        OR (n.kind = 'failure' AND n.id = (SELECT max(id) FROM notes m WHERE m.ticket_id = n.ticket_id AND m.kind IN ('failure', 'question'))))
      ORDER BY n.id`).all(),
  })],
  ['POST', /^\/api\/brain$/, 'brain.add', ({ db, body }) => {
    const { title, body: text, tags = '' } = body;
    if (typeof title !== 'string' || typeof text !== 'string' || typeof tags !== 'string') throw new HttpError(400, 'title, body and tags must be strings');
    const r = db.prepare('INSERT INTO brain (title, body, tags) VALUES (?, ?, ?)').run(title, text, tags);
    return { status: 201, body: db.prepare('SELECT * FROM brain WHERE id = ?').get(Number(r.lastInsertRowid)) };
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
    s.pty.kill();
    if (s.ticketId !== null) {
      try {
        apply(board, s.ticketId, 'exit', { note: { role: 'operator', kind: 'failure', body: 'ended by the operator from the terminal window' } });
      } catch (e) {
        if (!(e instanceof Refused)) throw e; // the ticket has moved on; nothing to flag
      }
    }
    return { status: 204 };
  }],
  ['POST', /^\/api\/brainstorm$/, 'brainstorm.launch', ({ board }) => ({ status: 201, body: sessionView(brainstorm(board)) })],
  // An operator terminal: the typed mission goes into its brief verbatim (docs/SECURITY.md → Operator terminal).
  ['POST', /^\/api\/operator$/, 'operator.launch', ({ board, body }) => {
    if (typeof body.mission !== 'string' || !body.mission.trim()) throw new HttpError(400, 'mission must be a non-empty string');
    return { status: 201, body: sessionView(operator(board, body.mission)) };
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
  // ~/.kanban95/preferences.md, plain text in `value` both ways ('' when absent). Matched before the JSON config routes.
  ['GET', /^\/api\/config\/preferences$/, null, () => ({ status: 200, body: { path: preferencesPath(), value: readPreferences() } })],
  ['PUT', /^\/api\/config\/preferences$/, 'config.write', ({ body }) => ({ status: 200, body: { path: preferencesPath(), value: writePreferences(body.value) } })],
  // ~/.kanban95/models.json and settings.json. GET shows the file as it is (null when absent); PUT checks it whole, then writes.
  ['GET', /^\/api\/config\/(\w+)$/, null, ({ params }) => {
    const name = configName(params[0]);
    let value = null;
    try {
      value = JSON.parse(readFileSync(configPath(name), 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new HttpError(400, `${configPath(name)}: ${(e as Error).message}`);
    }
    return { status: 200, body: { path: configPath(name), value } };
  }],
  ['PUT', /^\/api\/config\/(\w+)$/, 'config.write', ({ params, body }) => {
    const name = configName(params[0]);
    return { status: 200, body: { path: configPath(name), value: writeConfig(name, body) } };
  }],
  ['GET', /^\/api\/models$/, null, async () => ({ status: 200, body: await knownModels() })],
  ['GET', /^\/api\/trust$/, null, ({ board }) => ({ status: 200, body: trustStatus(board.db, board.repo) })],
  ['DELETE', /^\/api\/trust$/, 'trust.clear', ({ board }) => {
    untrustClaude(board.db, board.repo);
    return { status: 200, body: trustStatus(board.db, board.repo) };
  }],
  ['GET', /^\/api\/voice$/, null, () => ({ status: 200, body: voiceStatus() })],
  // The board's only network call, started by the operator's OK in the download dialog (docs/SECURITY.md → Voice model).
  ['POST', /^\/api\/voice\/download$/, 'voice.download', async () => {
    try {
      await download();
    } catch (e) {
      throw new HttpError(502, `voice model download failed: ${(e as Error).message}`);
    }
    return { status: 200, body: voiceStatus() };
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
  return { id: s.key, ticket_id: s.ticketId, run_id: s.runId, grant_id: s.grantId, role: s.role, phase: s.phase, model: s.model };
}

function configName(s: string): ConfigName {
  if (!(CONFIGS as string[]).includes(s)) throw new HttpError(404, 'not found');
  return s as ConfigName;
}

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
