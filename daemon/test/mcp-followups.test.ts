import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attachmentDir, saveAttachment } from '../src/attachments.ts';
import { mint } from '../src/grants.ts';
import { start } from '../src/server.ts';

// Follow-up tickets: who created a ticket decides who may edit and delete it (docs/SECURITY.md → What a grant can do).
let repo: string;
let srv: Awaited<ReturnType<typeof start>>;
let url: URL;
const clients: Client[] = [];
// Fixtures: tickets 1 (worker A's own) and 2 (worker B's own). Grants: planner, worker A on 1, worker B on 2.
let planner: Client, workerA: Client, workerB: Client;
let grantA: number;

async function connect(token: string): Promise<Client> {
  const c = new Client({ name: 'test', version: '0' });
  await c.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  clients.push(c);
  return c;
}
async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  const text = r.content[0].text;
  return { denied: r.isError === true, text, json: r.isError ? undefined : JSON.parse(text) };
}
const lastAudit = () => srv.db.prepare('SELECT grant_id, ticket_id, tool, outcome FROM audit ORDER BY id DESC LIMIT 1').get() as Record<string, unknown>;
const row = (id: number) => srv.db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as Record<string, unknown> | undefined;
const api = (path: string, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${srv.port}${path}`, { ...init, headers: { cookie: `k95=${srv.secret}`, 'content-type': 'application/json' } });

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'k95-'));
  srv = await start({ repo });
  url = new URL(`http://127.0.0.1:${srv.port}/mcp`);
  for (const t of ['own A', 'own B']) srv.db.prepare("INSERT INTO tickets (title, status) VALUES (?, 'in_progress')").run(t);
  const p = mint(srv.db, { ticket: null, role: 'planner', ttlMs: 60_000 });
  const a = mint(srv.db, { ticket: 1, role: 'worker', ttlMs: 60_000 });
  const b = mint(srv.db, { ticket: 2, role: 'worker', ttlMs: 60_000 });
  grantA = a.id;
  [planner, workerA, workerB] = await Promise.all([p.token, a.token, b.token].map(connect));
});
afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await srv.close();
  rmSync(repo, { recursive: true, force: true });
});

describe('worker follow-ups', () => {
  it('a worker creates a Backlog ticket that records its grant and its origin, with no model or effort', async () => {
    const r = await call(workerA, 'create_ticket', { title: 'manual touch', body: 'do the thing', depends_on: [2] });
    expect(r.denied).toBe(false);
    expect(r.json).toMatchObject({ status: 'backlog', body: 'Filed by #1\n\ndo the thing', model: null, effort: null, created_by_grant: grantA, depends_on: [2] });
    expect(lastAudit()).toMatchObject({ grant_id: grantA, ticket_id: r.json.id, tool: 'create_ticket', outcome: 'ok' });
  });

  it('a worker may not give its follow-up a model or effort, and nothing is stored', async () => {
    const before = (srv.db.prepare('SELECT count(*) AS n FROM tickets').get() as { n: number }).n;
    const r = await call(workerA, 'create_ticket', { title: 'x', effort: 'high' });
    expect(r.denied).toBe(true);
    expect(lastAudit()).toMatchObject({ tool: 'create_ticket', outcome: 'denied' });
    expect((srv.db.prepare('SELECT count(*) AS n FROM tickets').get() as { n: number }).n).toBe(before);
  });

  it('the creating worker updates every field of its follow-up; another worker is refused', async () => {
    const { json: t } = await call(workerA, 'create_ticket', { title: 'typo' });
    const ok = await call(workerA, 'update_ticket', { ticket_id: t.id, title: 'fixed', body: 'b', criteria: 'c', depends_on: [] });
    expect(ok.json).toMatchObject({ title: 'fixed', body: 'b', criteria: 'c', depends_on: [] });
    expect(lastAudit()).toMatchObject({ grant_id: grantA, ticket_id: t.id, tool: 'update_ticket', outcome: 'ok' });
    const other = await call(workerB, 'update_ticket', { ticket_id: t.id, title: 'mine now' });
    expect(other.denied).toBe(true);
    expect(row(t.id)!.title).toBe('fixed');
  });

  it('a worker cannot edit a ticket it did not create, nor its follow-up once it left Backlog', async () => {
    expect((await call(workerA, 'update_ticket', { ticket_id: 2, body: 'x' })).denied).toBe(true);
    const { json: t } = await call(workerA, 'create_ticket', { title: 'launched' });
    srv.db.prepare("UPDATE tickets SET status = 'in_progress' WHERE id = ?").run(t.id);
    const r = await call(workerA, 'update_ticket', { ticket_id: t.id, title: 'x' });
    expect(r.denied).toBe(true);
    expect(lastAudit()).toMatchObject({ ticket_id: t.id, tool: 'update_ticket', outcome: 'denied' });
  });

  it('a worker still edits only body and criteria of its own ticket', async () => {
    expect((await call(workerA, 'update_ticket', { title: 'x' })).denied).toBe(true);
    expect((await call(workerA, 'update_ticket', { body: 'refined' })).json.body).toBe('refined');
  });

  it('the creating worker deletes its follow-up with its attachments, as the UI delete does', async () => {
    const { json: t } = await call(workerA, 'create_ticket', { title: 'mistake' });
    saveAttachment(repo, t.id, 'shot.png', Buffer.from('x'));
    expect(existsSync(attachmentDir(repo, t.id))).toBe(true);
    const r = await call(workerA, 'delete_ticket', { ticket_id: t.id });
    expect(r.json).toEqual({ id: t.id });
    expect(row(t.id)).toBeUndefined();
    expect(existsSync(attachmentDir(repo, t.id))).toBe(false);
    // The ticket is gone, so the audit row is attributed by args only.
    expect(lastAudit()).toMatchObject({ grant_id: grantA, ticket_id: null, tool: 'delete_ticket', outcome: 'ok' });
  });

  it('a worker cannot delete a ticket it did not create, its own ticket, or its follow-up once it left Backlog', async () => {
    const { json: t } = await call(workerA, 'create_ticket', { title: 'kept' });
    for (const [c, id] of [[workerB, t.id], [workerA, 1], [workerA, 2]] as const) {
      const r = await call(c, 'delete_ticket', { ticket_id: id });
      expect(r.denied).toBe(true);
      expect(r.text).toMatch(/only delete a ticket its own grant created/);
      expect(row(id)).toBeDefined();
    }
    srv.db.prepare("UPDATE tickets SET status = 'in_progress' WHERE id = ?").run(t.id);
    const r = await call(workerA, 'delete_ticket', { ticket_id: t.id });
    expect(r.text).toMatch(/is in in_progress/);
    expect(lastAudit()).toMatchObject({ grant_id: grantA, ticket_id: t.id, tool: 'delete_ticket', outcome: 'denied' });
    expect(row(t.id)).toBeDefined();
  });
});

describe('planner delete_ticket', () => {
  it('deletes a Backlog ticket with no notes and no runs', async () => {
    const { json: t } = await call(planner, 'create_ticket', { title: 'leftover' });
    expect((await call(planner, 'delete_ticket', { ticket_id: t.id })).json).toEqual({ id: t.id });
    expect(row(t.id)).toBeUndefined();
  });

  it('is refused a ticket with a run, a ticket with a note, and a ticket out of Backlog', async () => {
    const make = async () => (await call(planner, 'create_ticket', { title: 'busy' })).json.id as number;
    const run = await make();
    srv.db.prepare("INSERT INTO runs (ticket_id, phase, cli, model, effort, prompt_rendered) VALUES (?, 'execute', 'claude', 'm', 'low', 'p')").run(run);
    const note = await make();
    await call(planner, 'add_note', { ticket_id: note, kind: 'decision', body: 'kept' });
    for (const [id, why] of [[run, /has runs/], [note, /has notes/], [1, /is in in_progress/]] as const) {
      const r = await call(planner, 'delete_ticket', { ticket_id: id });
      expect(r.denied).toBe(true);
      expect(r.text).toMatch(why);
      expect(lastAudit()).toMatchObject({ ticket_id: id, tool: 'delete_ticket', outcome: 'denied' });
      expect(row(id)).toBeDefined();
    }
  });
});

describe('created_by_grant', () => {
  it('is null for a ticket the UI creates', async () => {
    const res = await api('/api/tickets', { method: 'POST', body: JSON.stringify({ title: 'from the UI' }) });
    const { id } = (await res.json()) as { id: number };
    expect(row(id)!.created_by_grant).toBeNull();
  });
});
