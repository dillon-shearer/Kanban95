// UI-facing REST under /api. Operator-only (no grant); every mutation writes an audit row.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { isConstraintError } from './db.js';
import { audit, revoke } from './grants.js';

type Json = Record<string, unknown>;
type Reply = { status: number; body?: unknown };
type Ctx = { db: DatabaseSync; params: string[]; body: Json; url: URL };

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

function readTicket(db: DatabaseSync, id: number) {
  const row = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as Json | undefined;
  if (!row) throw new HttpError(404, 'no such ticket');
  const { needs_human, blocked_on_deps, ...rest } = row;
  const deps = db.prepare('SELECT depends_on_id FROM ticket_deps WHERE ticket_id = ? ORDER BY depends_on_id').all(id);
  return {
    ...rest,
    flags: { needs_human: needs_human === 1, blocked_on_deps: blocked_on_deps === 1 },
    depends_on: deps.map((d) => d.depends_on_id as number),
  };
}

function setDeps(db: DatabaseSync, id: number, deps: number[]) {
  db.prepare('DELETE FROM ticket_deps WHERE ticket_id = ?').run(id);
  const ins = db.prepare('INSERT INTO ticket_deps (ticket_id, depends_on_id) VALUES (?, ?)');
  for (const d of deps) ins.run(id, d);
}

function transaction<T>(db: DatabaseSync, fn: () => T): T {
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

function ftsQuery(q: string): string {
  // Each whitespace-separated term becomes a quoted phrase, so user input cannot break FTS5 syntax.
  return q.split(/\s+/).filter(Boolean).map((t) => `"${t.replaceAll('"', '""')}"`).join(' ');
}

const routes: [method: string, path: RegExp, mutation: string | null, handler: (c: Ctx) => Reply][] = [
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
  ['DELETE', /^\/api\/tickets\/(\d+)$/, 'tickets.delete', ({ db, params }) => {
    const r = db.prepare('DELETE FROM tickets WHERE id = ?').run(Number(params[0]));
    if (r.changes === 0) throw new HttpError(404, 'no such ticket');
    return { status: 204 };
  }],
  ['GET', /^\/api\/tickets\/(\d+)\/(notes|runs|audit)$/, null, ({ db, params }) => {
    readTicket(db, Number(params[0]));
    return { status: 200, body: db.prepare(`SELECT * FROM ${params[1]} WHERE ticket_id = ? ORDER BY id`).all(Number(params[0])) };
  }],
  ['GET', /^\/api\/brain$/, null, ({ db, url }) => {
    const q = url.searchParams.get('q') ?? '';
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 20) || 20, 100);
    const rows = q.trim()
      ? db.prepare('SELECT b.* FROM brain_fts f JOIN brain b ON b.id = f.rowid WHERE brain_fts MATCH ? ORDER BY rank LIMIT ?').all(ftsQuery(q), limit)
      : db.prepare('SELECT * FROM brain ORDER BY id DESC LIMIT ?').all(limit);
    return { status: 200, body: rows };
  }],
  ['GET', /^\/api\/grants$/, null, ({ db }) => ({
    status: 200,
    body: db.prepare('SELECT id, ticket_id, role, expires_at, revoked_at, created_at FROM grants ORDER BY id').all(),
  })],
  ['DELETE', /^\/api\/grants\/(\d+)$/, 'grants.revoke', ({ db, params }) => {
    if (!revoke(db, Number(params[0]))) throw new HttpError(404, 'no such live grant');
    return { status: 204 };
  }],
];

async function readJson(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1 << 20) throw new HttpError(413, 'body too large');
    chunks.push(c as Buffer);
  }
  if (size === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
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
  const text = JSON.stringify(r.body);
  res.writeHead(r.status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

export async function handleApi(db: DatabaseSync, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
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
    body = await readJson(req);
    out = handler({ db, params, body, url });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : isConstraintError(e) ? 400 : 500;
    if (mutation) {
      // audit.ticket_id is a FK, so an attempt against a missing ticket is attributed by args only.
      const exists = ticketId !== null && db.prepare('SELECT 1 FROM tickets WHERE id = ?').get(ticketId) !== undefined;
      audit(db, { grant_id: null, ticket_id: exists ? ticketId : null, tool: mutation, args: args(body), outcome: 'error' });
    }
    reply(res, { status, body: { error: status === 500 ? 'internal error' : (e as Error).message } });
    return;
  }
  if (mutation) {
    const id = mutation === 'tickets.create' ? (out.body as { id: number }).id : mutation === 'tickets.delete' ? null : ticketId;
    audit(db, { grant_id: null, ticket_id: id, tool: mutation, args: args(body), outcome: 'ok' });
  }
  reply(res, out);
}
