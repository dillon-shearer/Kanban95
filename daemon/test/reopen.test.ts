// Reopening a done ticket with move_ticket(in_progress) (docs/LIFECYCLE.md → Reject): the reject row, not a failed test.
import { removeTemp } from './home.ts';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildContext } from '../src/context.ts';
import { mint } from '../src/grants.ts';
import { start } from '../src/server.ts';

let repo: string;
let srv: Awaited<ReturnType<typeof start>>;
const clients: Client[] = [];

const ticket = (title: string, status: string, retry = 0) =>
  Number(srv.db.prepare('INSERT INTO tickets (title, status, retry) VALUES (?, ?, ?)').run(title, status, retry).lastInsertRowid);
const row = (id: number) => srv.db.prepare('SELECT status, retry, needs_human FROM tickets WHERE id = ?').get(id) as Record<string, unknown>;

async function client(grant: Parameters<typeof mint>[1]) {
  const c = new Client({ name: 'test', version: '0' });
  const { token } = mint(srv.db, grant);
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  clients.push(c);
  return async (name: string, args: Record<string, unknown>) => {
    const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { refused: r.isError === true, text: r.content[0].text };
  };
}

beforeAll(async () => {
  // Only a plan model: the reopened worker fails to start and flags its ticket, which these tests do not look at.
  mkdirSync(join(process.env.USERPROFILE!, '.kanban95'), { recursive: true });
  writeFileSync(join(process.env.USERPROFILE!, '.kanban95', 'models.json'), JSON.stringify({ cli: 'claude', claude: { plan: { model: 'plan-m', effort: 'low' } } }));
  repo = mkdtempSync(join(tmpdir(), 'k95-'));
  srv = await start({ repo });
});
afterAll(async () => {
  for (const c of clients) await c.close();
  await srv.close();
  removeTemp(repo);
});

describe('move_ticket from done to in_progress', () => {
  it('an operator grant reopens a done ticket with retry 0, and the next worker prompt carries the notes', async () => {
    const call = await client({ ticket: null, role: 'operator', ttlMs: 60_000 });
    const id = ticket('printed once', 'done', 2);
    expect((await call('add_note', { ticket_id: id, kind: 'failure', body: 'reprint with 0.2 mm layers' })).refused).toBe(false);
    const r = await call('move_ticket', { ticket_id: id, status: 'in_progress' });
    expect(r.refused, r.text).toBe(false);
    expect(row(id)).toMatchObject({ status: 'in_progress', retry: 0 });
    expect(srv.db.prepare("SELECT role, kind FROM notes WHERE ticket_id = ? AND body LIKE 'reopened from Done%'").all(id)).toEqual([{ role: 'operator', kind: 'failure' }]);
    const notes = buildContext(srv.db, repo, id, 'worker').notes;
    expect(notes).toContain('reprint with 0.2 mm layers');
    expect(notes).toContain('reopened from Done');
  });

  it('a worker grant at level 1 reopens another done ticket; at level 0 it is refused before anything changes', async () => {
    const own = ticket('mine', 'in_progress');
    const other = ticket('theirs', 'done');
    const call = await client({ ticket: own, role: 'worker', ttlMs: 60_000 });
    expect(await call('move_ticket', { ticket_id: other, status: 'in_progress' })).toMatchObject({ refused: true });
    expect(row(other).status).toBe('done');
    srv.db.prepare('UPDATE tickets SET agent_level = 1 WHERE id = ?').run(own);
    expect((await call('move_ticket', { ticket_id: other, status: 'in_progress' })).refused).toBe(false);
    expect(row(other).status).toBe('in_progress');
    expect(srv.db.prepare("SELECT role FROM notes WHERE ticket_id = ? AND body LIKE 'reopened%'").get(other)).toEqual({ role: 'worker' });
  });

  it('a Blocked done ticket is refused in plain words and stays done', async () => {
    const call = await client({ ticket: null, role: 'operator', ttlMs: 60_000 });
    const id = ticket('blocked', 'done');
    srv.db.prepare('UPDATE tickets SET blocked = 1 WHERE id = ?').run(id);
    expect(await call('move_ticket', { ticket_id: id, status: 'in_progress' })).toEqual({ refused: true, text: expect.stringMatching(/Unblock it first/) });
    expect(row(id).status).toBe('done');
    expect(srv.db.prepare('SELECT count(*) AS n FROM notes WHERE ticket_id = ?').get(id)).toEqual({ n: 0 });
  });
});
