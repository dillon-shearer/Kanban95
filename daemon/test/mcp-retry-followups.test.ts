import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mint } from '../src/grants.ts';
import { start } from '../src/server.ts';

let repo: string;
let srv: Awaited<ReturnType<typeof start>>;
let url: URL;
const clients: Client[] = [];
let first: Client, retry: Client, other: Client, planner: Client;

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
const row = (id: number) => srv.db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as Record<string, unknown> | undefined;
const ids = (list: { id: number }[]) => list.map((t) => t.id);

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'k95-'));
  srv = await start({ repo });
  url = new URL(`http://127.0.0.1:${srv.port}/mcp`);
  for (const t of ['own', 'unrelated']) srv.db.prepare("INSERT INTO tickets (title, status) VALUES (?, 'in_progress')").run(t);
  const grants = [
    mint(srv.db, { ticket: 1, role: 'worker', ttlMs: 60_000 }),
    mint(srv.db, { ticket: 1, role: 'worker', ttlMs: 60_000 }),
    mint(srv.db, { ticket: 2, role: 'worker', ttlMs: 60_000 }),
    mint(srv.db, { ticket: null, role: 'planner', ttlMs: 60_000 }),
  ];
  [first, retry, other, planner] = await Promise.all(grants.map((g) => connect(g.token)));
});
afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await srv.close();
  rmSync(repo, { recursive: true, force: true });
});

describe('a retry worker and its ticket\x27s earlier follow-ups', () => {
  it('lists and reads a Backlog follow-up an earlier session filed, and not one another ticket or the planner filed', async () => {
    const { json: mine } = await call(first, 'create_ticket', { title: 'review findings', body: 'v1' });
    const { json: theirs } = await call(other, 'create_ticket', { title: 'not yours' });
    const { json: planned } = await call(planner, 'create_ticket', { title: 'planned' });
    expect(ids((await call(retry, 'list_tickets', { status: 'backlog' })).json)).toEqual([mine.id]);
    expect((await call(retry, 'get_ticket', { ticket_id: mine.id })).json).toMatchObject({ id: mine.id, body: 'Filed by #1\n\nv1' });
    for (const id of [theirs.id, planned.id, 2]) {
      const r = await call(retry, 'get_ticket', { ticket_id: id });
      expect(r.denied).toBe(true);
      expect(r.text).toMatch(/scoped to ticket 1/);
    }
    expect(ids((await call(other, 'list_tickets')).json)).toEqual([2, theirs.id]);
  });

  it('updates it with the creator\x27s fields and is refused the same fields the creator is', async () => {
    const { json: t } = await call(first, 'create_ticket', { title: 'sync me' });
    const ok = await call(retry, 'update_ticket', { ticket_id: t.id, title: 't', body: 'v2', criteria: 'c', tags: ['review'], depends_on: [2] });
    expect(ok.json).toMatchObject({ title: 't', body: 'v2', criteria: 'c', tags: 'review', depends_on: [2] });
    const targets = await call(retry, 'update_ticket', { ticket_id: t.id, targets: [{ id: 2 }] });
    expect(targets.denied).toBe(true);
    expect(targets.text).toMatch(/on a follow-up; not targets/);
    expect((await call(other, 'update_ticket', { ticket_id: t.id, body: 'x' })).denied).toBe(true);
    expect(row(t.id)!.body).toBe('v2');
  });

  it('may not edit or delete it once it left Backlog, but still reads it', async () => {
    const { json: t } = await call(first, 'create_ticket', { title: 'launched' });
    srv.db.prepare("UPDATE tickets SET status = 'in_progress' WHERE id = ?").run(t.id);
    expect((await call(retry, 'update_ticket', { ticket_id: t.id, body: 'x' })).denied).toBe(true);
    expect((await call(retry, 'delete_ticket', { ticket_id: t.id })).text).toMatch(/is in in_progress/);
    expect((await call(retry, 'get_ticket', { ticket_id: t.id })).json.status).toBe('in_progress');
  });

  it('deletes it; a worker of another ticket may not', async () => {
    const { json: t } = await call(first, 'create_ticket', { title: 'duplicate' });
    expect((await call(other, 'delete_ticket', { ticket_id: t.id })).denied).toBe(true);
    expect((await call(retry, 'delete_ticket', { ticket_id: t.id })).json).toEqual({ id: t.id });
    expect(row(t.id)).toBeUndefined();
  });
});
