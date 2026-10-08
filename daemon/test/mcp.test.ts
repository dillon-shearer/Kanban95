import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mint, revoke } from '../src/grants.ts';
import { MCP_DOC, renderMcpDoc } from '../src/mcp-doc.ts';
import { TOOLS } from '../src/mcp.ts';
import { start } from '../src/server.ts';

let repo: string;
let srv: Awaited<ReturnType<typeof start>>;
let url: URL;
const clients: Client[] = [];
// Fixtures: tickets 1..4, ticket 3 depends on 2. Grants: planner, worker and tester on 3, worker on 4.
let planner: Client, worker3: Client, tester3: Client, worker4: Client;
let grantIds: Record<string, number>;

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
const lastAudit = () =>
  srv.db.prepare('SELECT grant_id, ticket_id, tool, outcome FROM audit ORDER BY id DESC LIMIT 1').get() as Record<string, unknown>;
const auditCount = () => (srv.db.prepare('SELECT count(*) AS n FROM audit').get() as { n: number }).n;

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'k95-'));
  srv = await start({ repo });
  url = new URL(`http://127.0.0.1:${srv.port}/mcp`);
  for (const t of ['one', 'two', 'three', 'four']) srv.db.prepare('INSERT INTO tickets (title) VALUES (?)').run(t);
  srv.db.prepare('INSERT INTO ticket_deps VALUES (3, 2)').run();
  const g = {
    planner: mint(srv.db, { ticket: null, role: 'planner', ttlMs: 60_000 }),
    worker3: mint(srv.db, { ticket: 3, role: 'worker', ttlMs: 60_000 }),
    tester3: mint(srv.db, { ticket: 3, role: 'tester', ttlMs: 60_000 }),
    worker4: mint(srv.db, { ticket: 4, role: 'worker', ttlMs: 60_000 }),
  };
  grantIds = Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v.id]));
  [planner, worker3, tester3, worker4] = await Promise.all([g.planner.token, g.worker3.token, g.tester3.token, g.worker4.token].map(connect));
});
afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await srv.close();
  rmSync(repo, { recursive: true, force: true });
});

describe('bearer', () => {
  it('refuses missing, malformed, expired and revoked tokens with 401 and no audit row', async () => {
    const before = auditCount();
    const post = (auth?: string) =>
      fetch(url, { method: 'POST', headers: auth ? { authorization: auth } : {}, body: '{}' }).then((r) => r.status);
    expect(await post()).toBe(401);
    expect(await post('Basic abc')).toBe(401);
    expect(await post('Bearer not a token')).toBe(401);
    expect(await post('Bearer ' + 'a'.repeat(43))).toBe(401);
    const expired = mint(srv.db, { ticket: 3, role: 'worker', ttlMs: -1 });
    expect(await post(`Bearer ${expired.token}`)).toBe(401);
    const revoked = mint(srv.db, { ticket: 3, role: 'worker', ttlMs: 60_000 });
    revoke(srv.db, revoked.id);
    expect(await post(`Bearer ${revoked.token}`)).toBe(401);
    await expect(connect(revoked.token)).rejects.toThrow(/unauthorized/);
    expect(auditCount()).toBe(before);
  });

  it('exposes every tool with a description', async () => {
    const { tools } = await planner.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(TOOLS).sort());
    for (const t of tools) expect(t.description!.length).toBeGreaterThan(80);
  });
});

describe('role matrix: every "no" cell is refused and audited as denied', () => {
  const cells: [string, () => Client, string, Record<string, unknown>][] = [
    ['planner', () => planner, 'move_ticket', { ticket_id: 1, status: 'testing' }],
    ['planner', () => planner, 'report_test', { ticket_id: 1, passed: true, summary: 'x' }],
    ['planner', () => planner, 'report_cleanup', { ticket_id: 1, items: [{ path: 'a', action: 'deleted', reason: 'r' }] }],
    ['worker', () => worker3, 'create_ticket', { title: 'x' }],
    ['worker', () => worker3, 'report_test', { passed: true, summary: 'x' }],
    ['tester', () => tester3, 'create_ticket', { title: 'x' }],
    ['tester', () => tester3, 'update_ticket', { body: 'x' }],
    ['tester', () => tester3, 'report_cleanup', { items: [{ path: 'a', action: 'deleted', reason: 'r' }] }],
  ];
  for (const [role, client, tool, args] of cells) {
    it(`${role} cannot call ${tool}`, async () => {
      const r = await call(client(), tool, args);
      expect(r.denied).toBe(true);
      expect(r.text).toBe(`a ${role} may not call ${tool}`);
      expect(lastAudit()).toMatchObject({ grant_id: grantIds[role === 'planner' ? 'planner' : role + '3'], tool, outcome: 'denied' });
    });
  }
});

describe('ticket scope', () => {
  it('a worker on ticket 3 cannot read, move, or note ticket 4, and the attempt is audited against 4', async () => {
    for (const [tool, args] of [
      ['get_ticket', { ticket_id: 4 }],
      ['move_ticket', { ticket_id: 4, status: 'testing' }],
      ['add_note', { ticket_id: 4, kind: 'plan', body: 'x' }],
      ['update_ticket', { ticket_id: 4, body: 'x' }],
      ['set_model', { ticket_id: 4, effort: 'low' }],
      ['ask_operator', { ticket_id: 4, question: 'x' }],
    ] as const) {
      const r = await call(worker3, tool, args);
      expect(r.denied, tool).toBe(true);
      expect(r.text).toMatch(/scoped to ticket 3/);
      expect(lastAudit()).toMatchObject({ grant_id: grantIds.worker3, ticket_id: 4, tool, outcome: 'denied' });
    }
    expect(srv.db.prepare('SELECT count(*) AS n FROM notes WHERE ticket_id = 4').get()).toEqual({ n: 0 });
  });

  it('a worker reads its own ticket and its dependencies, nothing else', async () => {
    expect((await call(worker3, 'get_ticket')).json).toMatchObject({ id: 3, depends_on: [2], notes: [] });
    expect((await call(worker3, 'get_ticket', { ticket_id: 2 })).json).toMatchObject({ id: 2 });
    expect((await call(worker3, 'get_ticket', { ticket_id: 1 })).denied).toBe(true);
    expect((await call(worker3, 'list_tickets')).json.map((t: { id: number }) => t.id)).toEqual([3, 2]);
    expect((await call(tester3, 'get_ticket', { ticket_id: 2 })).denied).toBe(true);
    expect((await call(tester3, 'list_tickets')).json.map((t: { id: number }) => t.id)).toEqual([3]);
    expect((await call(planner, 'list_tickets')).json.length).toBe(4);
  });

  it('a worker may update body and criteria of its ticket but not title or dependencies', async () => {
    expect((await call(worker3, 'update_ticket', { body: 'refined', criteria: 'c' })).json).toMatchObject({ body: 'refined', criteria: 'c' });
    const r = await call(worker3, 'update_ticket', { title: 'renamed', body: 'again' });
    expect(r.denied).toBe(true);
    expect(r.text).toMatch(/not title/);
    expect((await call(worker3, 'update_ticket', { depends_on: [1] })).denied).toBe(true);
    expect(lastAudit()).toMatchObject({ outcome: 'denied' });
    expect((await call(planner, 'get_ticket', { ticket_id: 3 })).json).toMatchObject({ title: 'three', body: 'refined', depends_on: [2] });
  });

  it('a planner must name a ticket and gets an error, not a denial, for a missing one', async () => {
    expect((await call(planner, 'add_note', { kind: 'plan', body: 'x' })).text).toMatch(/ticket_id is required/);
    expect(lastAudit()).toMatchObject({ grant_id: grantIds.planner, ticket_id: null, outcome: 'error' });
    expect((await call(planner, 'add_note', { ticket_id: 99, kind: 'plan', body: 'x' })).text).toBe('no such ticket');
    expect(lastAudit()).toMatchObject({ ticket_id: null, tool: 'add_note', outcome: 'error' });
  });
});

describe('move_ticket', () => {
  it('refuses a transition the role may not make, naming the allowed targets', async () => {
    const w = await call(worker3, 'move_ticket', { status: 'done' });
    expect(w.denied).toBe(true);
    expect(w.text).toBe('a worker may only move its ticket to: testing');
    const t = await call(tester3, 'move_ticket', { status: 'backlog' });
    expect(t.denied).toBe(true);
    expect(t.text).toBe('a tester may only move its ticket to: done, in_progress');
    expect(lastAudit()).toMatchObject({ grant_id: grantIds.tester3, ticket_id: 3, tool: 'move_ticket', outcome: 'denied' });
    expect((await call(planner, 'get_ticket', { ticket_id: 3 })).json.status).toBe('backlog');
  });

  it('goes through the lifecycle: a move the state machine does not have is denied, an allowed one moves the ticket', async () => {
    // Ticket 3 is in backlog: only Launch moves it out. Lifecycle details are in lifecycle.test.ts.
    expect(await call(worker3, 'move_ticket', { status: 'testing' })).toMatchObject({ denied: true, text: 'cannot submit a ticket in backlog' });
    expect(lastAudit()).toMatchObject({ grant_id: grantIds.worker3, ticket_id: 3, tool: 'move_ticket', outcome: 'denied' });
    srv.db.prepare("UPDATE tickets SET status = 'in_progress' WHERE id = 3").run();
    // This repo is not a git repo, so the tester launch fails and flags the ticket instead of leaving it unattended.
    expect((await call(worker3, 'move_ticket', { status: 'testing' })).json).toMatchObject({ status: 'testing', flags: { needs_human: true } });
    expect(lastAudit()).toMatchObject({ grant_id: grantIds.worker3, ticket_id: 3, tool: 'move_ticket', outcome: 'ok' });
    expect((await call(tester3, 'move_ticket', { status: 'done' })).text).toBe('cannot pass a ticket in testing: call report_test with passed: true first');
  });
});

describe('tools', () => {
  it('create_ticket with deps, set_model with either field, both required to be non-empty', async () => {
    const t = (await call(planner, 'create_ticket', { title: 'five', criteria: 'c', depends_on: [1, 2], effort: 'low' })).json;
    expect(t).toMatchObject({ id: 5, status: 'backlog', effort: 'low', depends_on: [1, 2] });
    expect(lastAudit()).toMatchObject({ grant_id: grantIds.planner, ticket_id: 5, tool: 'create_ticket', outcome: 'ok' });
    expect((await call(planner, 'create_ticket', { title: 'x', depends_on: [99] })).text).toMatch(/FOREIGN KEY/);
    expect((await call(planner, 'set_model', { ticket_id: 5, model: 'm1' })).json).toMatchObject({ model: 'm1', effort: 'low' });
    expect((await call(worker4, 'set_model', { effort: 'high' })).json).toMatchObject({ id: 4, effort: 'high' });
    expect((await call(tester3, 'set_model', { model: 'big', effort: 'max' })).json).toMatchObject({ id: 3, model: 'big', effort: 'max' });
    expect((await call(tester3, 'set_model', {})).text).toBe('give model and/or effort');
    expect(lastAudit()).toMatchObject({ tool: 'set_model', outcome: 'error' });
  });

  it('refuses a dependency cycle at update_ticket, direct or through other tickets, and leaves the deps as they were', async () => {
    // Fixture: 3 depends on 2. A new ticket cannot close a cycle at create_ticket: nothing depends on it yet.
    expect((await call(planner, 'update_ticket', { ticket_id: 2, depends_on: [3] })).text).toBe('dependency cycle: ticket 2 would end up depending on itself');
    expect(lastAudit()).toMatchObject({ grant_id: grantIds.planner, ticket_id: 2, tool: 'update_ticket', outcome: 'error' });
    expect((await call(planner, 'update_ticket', { ticket_id: 1, depends_on: [3] })).json.depends_on).toEqual([3]);
    expect((await call(planner, 'update_ticket', { ticket_id: 2, depends_on: [1] })).text).toMatch(/dependency cycle/); // 2 → 1 → 3 → 2
    expect((await call(planner, 'get_ticket', { ticket_id: 2 })).json.depends_on).toEqual([]);
    const rest = await fetch(`http://127.0.0.1:${srv.port}/api/tickets/2`, { method: 'PATCH', body: JSON.stringify({ depends_on: [1] }) });
    expect(rest.status).toBe(400);
    expect((await call(planner, 'update_ticket', { ticket_id: 1, depends_on: [] })).json.depends_on).toEqual([]);
  });

  it('ask_operator writes a question note, flags needs_human and returns the question id; refused on a ticket not running', async () => {
    const idle = await call(worker4, 'ask_operator', { question: 'which port?' });
    expect(idle).toMatchObject({ denied: true, text: 'cannot ask a ticket in backlog' });
    expect(lastAudit()).toMatchObject({ grant_id: grantIds.worker4, tool: 'ask_operator', outcome: 'denied' });
    srv.db.prepare("UPDATE tickets SET status = 'in_progress' WHERE id = 4").run();
    const { question_id } = (await call(worker4, 'ask_operator', { question: 'which port?' })).json;
    expect(srv.db.prepare('SELECT ticket_id, role, kind, body FROM notes WHERE id = ?').get(question_id)).toEqual({
      ticket_id: 4, role: 'worker', kind: 'question', body: 'which port?',
    });
    expect((await call(worker4, 'get_ticket')).json.flags.needs_human).toBe(true);
  });

  it('report_test stores PASS as a summary note and FAIL as a failure note with evidence', async () => {
    const fail = (await call(tester3, 'report_test', { passed: false, summary: 'criterion 2 fails', evidence: ['npm test: 1 failed'] })).json;
    expect(srv.db.prepare('SELECT role, kind, body FROM notes WHERE id = ?').get(fail.note_id)).toEqual({
      role: 'tester', kind: 'failure', body: 'FAIL: criterion 2 fails\n- npm test: 1 failed',
    });
    const pass = (await call(tester3, 'report_test', { passed: true, summary: 'all green' })).json;
    expect(srv.db.prepare('SELECT kind, body FROM notes WHERE id = ?').get(pass.note_id)).toEqual({ kind: 'summary', body: 'PASS: all green' });
  });

  it('report_cleanup and add_note write notes under the grant role; notes come back in get_ticket order', async () => {
    const before = (await call(worker4, 'get_ticket')).json.notes.length;
    await call(worker4, 'add_note', { kind: 'decision', body: 'kept X' });
    await call(worker4, 'report_cleanup', { items: [{ path: 'old.ts', action: 'deleted', reason: 'no importers' }] });
    const notes = (await call(worker4, 'get_ticket')).json.notes.slice(before);
    expect(notes.map((n: { kind: string; body: string }) => [n.kind, n.body])).toEqual([
      ['decision', 'kept X'],
      ['summary', '- deleted `old.ts`: no importers'],
    ]);
    expect((await call(worker4, 'report_cleanup', { items: [] })).denied).toBe(true); // schema: min(1)
  });
});

describe('brain', () => {
  it('search is ranked, capped at the requested limit, and tagged with the grant ticket', async () => {
    const { id } = (await call(worker4, 'brain_add', { title: 'sqlite wal', body: 'use WAL mode for sqlite', tags: 'sqlite' })).json;
    expect(srv.db.prepare('SELECT ticket_id FROM brain WHERE id = ?').get(id)).toEqual({ ticket_id: 4 });
    await call(planner, 'brain_add', { title: 'ports', body: 'random port, loopback only' });
    await call(planner, 'brain_add', { title: 'sqlite sqlite sqlite', body: 'sqlite everywhere sqlite', tags: 'sqlite db' });
    const all = (await call(tester3, 'brain_search', { query: 'sqlite' })).json;
    expect(all.map((r: { title: string }) => r.title)).toEqual(['sqlite sqlite sqlite', 'sqlite wal']);
    expect((await call(tester3, 'brain_search', { query: 'sqlite', limit: 1 })).json).toHaveLength(1);
    expect((await call(tester3, 'brain_search', { query: 'sqlite', limit: 21 })).denied).toBe(true);
    expect((await call(tester3, 'brain_search', { query: 'nothing-here' })).json).toEqual([]);
    expect((await call(tester3, 'brain_search', { query: 'sqlite" OR "ports' })).json).toEqual([]);
  });
});

describe('docs', () => {
  it('docs/MCP.md is byte-identical to what the tool definitions render', () => {
    expect(readFileSync(MCP_DOC, 'utf8')).toBe(renderMcpDoc());
  });
});
