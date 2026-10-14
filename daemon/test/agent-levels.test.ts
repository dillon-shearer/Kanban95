import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { live, mint } from '../src/grants.ts';
import { sessions, type Session } from '../src/launcher.ts';
import { writeConfig } from '../src/settings.ts';
import { start } from '../src/server.ts';

let repo: string;
let srv: Awaited<ReturnType<typeof start>>;
let worker: Client;
const OWN = 1;
const DEP = 2;

const ticket = (title: string, status = 'backlog') => Number(srv.db.prepare('INSERT INTO tickets (title, status) VALUES (?, ?)').run(title, status).lastInsertRowid);
const row = (id: number) => srv.db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as Record<string, unknown> | undefined;
const level = (n: number, readAll = 0) => srv.db.prepare('UPDATE tickets SET agent_level = ?, read_all = ? WHERE id = ?').run(n, readAll, OWN);
async function call(name: string, args: Record<string, unknown> = {}) {
  const r = (await worker.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  const text = r.content[0].text;
  return { denied: r.isError === true, text, json: r.isError ? undefined : JSON.parse(text) };
}
const patch = (id: number, body: unknown) =>
  fetch(`http://127.0.0.1:${srv.port}/api/tickets/${id}`, { method: 'PATCH', headers: { cookie: `k95=${srv.secret}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'k95-'));
  srv = await start({ repo });
  ticket('own', 'in_progress');
  ticket('dependency', 'done');
  srv.db.prepare('INSERT INTO ticket_deps VALUES (?, ?)').run(OWN, DEP);
  const { token } = mint(srv.db, { ticket: OWN, role: 'worker', ttlMs: 60_000 });
  worker = new Client({ name: 'test', version: '0' });
  await worker.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
});
afterEach(() => {
  level(0);
  writeConfig('settings', {});
});
afterAll(async () => {
  await worker.close();
  await srv.close();
  rmSync(repo, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 });
});

describe('agent_level', () => {
  it('level 0: a worker is refused moving another ticket to backlog, and told which level to ask for', async () => {
    const other = ticket('other', 'in_progress');
    const r = await call('move_ticket', { ticket_id: other, status: 'backlog' });
    expect(r).toMatchObject({ denied: true, text: `this grant is scoped to ticket ${OWN}; ask for level 1 with request_permission` });
    expect(row(other)!.status).toBe('in_progress');
  });

  it('level 1: a worker launches another Backlog ticket and is refused moving one to done', async () => {
    level(1);
    const other = ticket('launch me');
    expect((await call('move_ticket', { ticket_id: other, status: 'in_progress' })).denied).toBe(false);
    expect(row(other)!.status).toBe('in_progress');
    const r = await call('move_ticket', { ticket_id: other, status: 'done' });
    expect(r).toMatchObject({ denied: true, text: 'a worker may only move another ticket to: backlog, in_progress; ask for level 2 with request_permission' });
    expect(row(other)!.status).toBe('in_progress');
  });

  it('level 2: a worker closes another in_progress ticket with no tester run, ending its live session', async () => {
    level(2);
    const other = ticket('close me', 'in_progress');
    const g = mint(srv.db, { ticket: other, role: 'worker', ttlMs: 60_000 });
    let killed = false;
    const s = { key: -g.id, runId: null, grantId: g.id, ticketId: other, role: 'worker', phase: 'execute', started: Date.now(),
      pty: { pid: 0, kill: () => { killed = true; } }, scrollback: () => 'working\n' } as unknown as Session;
    sessions.set(s.key, s);
    try {
      const r = await call('move_ticket', { ticket_id: other, status: 'done' });
      expect(r.json).toMatchObject({ id: other, status: 'done', merged_at: null });
      expect(s.outcome).toBe('close');
      expect(killed).toBe(true);
      expect(live(srv.db, g.id)).toBeNull();
      expect(srv.db.prepare("SELECT count(*) AS n FROM runs WHERE ticket_id = ? AND phase = 'test'").get(other)).toEqual({ n: 0 });
    } finally {
      sessions.delete(s.key);
    }
  });

  it('level 3: a worker renames another ticket and deletes an empty Backlog ticket', async () => {
    level(3);
    const other = ticket('old title', 'in_progress');
    expect((await call('update_ticket', { ticket_id: other, title: 'new title' })).json).toMatchObject({ id: other, title: 'new title' });
    const empty = ticket('made by mistake');
    expect((await call('delete_ticket', { ticket_id: empty })).json).toEqual({ id: empty });
    expect(row(empty)).toBeUndefined();
  });

  it('level 4: a worker is still refused report_test', async () => {
    level(4);
    srv.db.prepare("UPDATE tickets SET status = 'testing' WHERE id = ?").run(OWN);
    try {
      expect(await call('report_test', { passed: true, summary: 'x' })).toMatchObject({ denied: true, text: 'a worker may not call report_test' });
      expect(row(OWN)!.status).toBe('testing');
    } finally {
      srv.db.prepare("UPDATE tickets SET status = 'in_progress' WHERE id = ?").run(OWN);
    }
  });
});

describe('read_all', () => {
  const all = () => (srv.db.prepare('SELECT id FROM tickets ORDER BY id').all() as { id: number }[]).map((r) => r.id);
  const listed = async () => (await call('list_tickets')).json.map((t: { id: number }) => t.id);

  it('lists every ticket with read_all, only its own and its dependencies without', async () => {
    const other = ticket('someone else');
    expect(await listed()).toEqual([OWN, DEP]);
    expect((await call('get_ticket', { ticket_id: other })).denied).toBe(true);
    level(0, 1);
    expect(await listed()).toEqual(all());
    expect((await call('get_ticket', { ticket_id: other })).json).toMatchObject({ id: other });
  });

  it("settings.json workers_read: 'all' gives a plain worker grant read of every ticket", async () => {
    const other = ticket('read me');
    writeConfig('settings', { workers_read: 'all' });
    expect(await listed()).toEqual(all());
    expect((await call('get_ticket', { ticket_id: other })).json).toMatchObject({ id: other });
    expect((await call('add_note', { ticket_id: other, kind: 'plan', body: 'x' })).denied).toBe(true);
  });
});

describe('PATCH /api/tickets/:id', () => {
  it('sets agent_level and read_all, audited; a level outside 0-4 is 400 and changes nothing', async () => {
    const id = ticket('levelled');
    const r = await patch(id, { agent_level: 2, read_all: true });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ agent_level: 2, read_all: true });
    expect(row(id)).toMatchObject({ agent_level: 2, read_all: 1 });
    expect(srv.db.prepare('SELECT tool, outcome FROM audit WHERE ticket_id = ? ORDER BY id DESC LIMIT 1').get(id)).toEqual({ tool: 'tickets.update', outcome: 'ok' });
    for (const bad of [5, -1, 1.5]) expect((await patch(id, { agent_level: bad })).status, String(bad)).toBe(400);
    expect((await patch(id, { read_all: 1 })).status).toBe(400);
    expect(row(id)).toMatchObject({ agent_level: 2, read_all: 1 });
  });
});
