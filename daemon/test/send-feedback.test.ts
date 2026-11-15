import './home.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { running } from '../src/boards.ts';
import { openDb } from '../src/db.ts';
import { mint } from '../src/grants.ts';
import { TOOLS } from '../src/mcp.ts';
import { start } from '../src/server.ts';
import { addProject, same, writeConfig } from '../src/settings.ts';

const temps: string[] = [];
const temp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};
let srv: Awaited<ReturnType<typeof start>>;
let repo: string;
let worker: Client, tester: Client;
const clients: Client[] = [];
const DETAILS = '- What happened: the merge queue stopped\n- What the operator said: "why is it stuck"\n- Repro: merge two tickets at once';

async function connect(token: string): Promise<Client> {
  const c = new Client({ name: 'test', version: '0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  clients.push(c);
  return c;
}
async function send(c: Client, args: Record<string, unknown>) {
  const r = (await c.callTool({ name: 'send_feedback', arguments: { type: 'bug', details: DETAILS, ...args } })) as { isError?: boolean; content: { text: string }[] };
  return { error: r.isError === true, text: r.content[0].text, out: r.isError ? null : JSON.parse(r.content[0].text) };
}
const api = (method: string, path: string, body?: unknown) =>
  fetch(`http://127.0.0.1:${srv.port}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie: `k95=${srv.secret}` }, body: body === undefined ? undefined : JSON.stringify(body) });
const rows = (db: DatabaseSync) => db.prepare('SELECT * FROM feedback ORDER BY id').all() as Record<string, unknown>[];

beforeAll(async () => {
  repo = temp('k95-sf-');
  srv = await start({ repo });
  srv.db.prepare("INSERT INTO tickets (title, status) VALUES ('own', 'in_progress')").run();
  srv.db.prepare("INSERT INTO tickets (title, status) VALUES ('other', 'testing')").run();
  worker = await connect(mint(srv.db, { ticket: 1, role: 'worker', ttlMs: 60_000 }).token);
  tester = await connect(mint(srv.db, { ticket: 2, role: 'tester', ttlMs: 60_000 }).token);
});
afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await srv.close();
  for (const d of temps) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

it('the tool description carries the when-to-file triggers and the no-invention, no-secrets, no-names rules', () => {
  const d = TOOLS.send_feedback.description;
  for (const s of ['frustrated', 'reproduce', 'missing capability', 'had to retract', 'stopping short', 'never interrupts', 'at most one report per distinct issue', 'invent nothing', 'No secrets', 'no names', 'by role', 'never paraphrased']) expect(d).toContain(s);
  expect(Object.keys(TOOLS.send_feedback.access).sort()).toEqual(['operator', 'planner', 'tester', 'worker']);
});

it('with feedback_board not registered, a worker report stays on its own board, with the source board and ticket filled in, not as a ticket', async () => {
  writeConfig('settings', { feedback_board: 'no-such-board' });
  const tickets = srv.db.prepare('SELECT count(*) AS n FROM tickets').get();
  const r = await send(worker, { title: 'Merge queue stalls', area: 'merge queue', failure_mode: 'stopping_short', task_category: 'debug' });
  expect(r.error, r.text).toBe(false);
  expect(r.out).toMatchObject({ project: basename(repo), count: 1, grouped: false });
  expect(r.out.note).toContain('is not in projects.json');
  expect(rows(srv.db)).toEqual([expect.objectContaining({
    type: 'bug', title: 'Merge queue stalls', area: 'merge queue', failure_mode: 'stopping_short', task_category: 'debug',
    details: DETAILS, sources: `${basename(repo)} #1 (worker)`, count: 1, status: 'open',
  })]);
  expect(srv.db.prepare('SELECT count(*) AS n FROM tickets').get()).toEqual(tickets);
});

it('a repeat report with the same title in other case and spacing is grouped: count 2, both sources, both details', async () => {
  const r = await send(tester, { title: '  merge QUEUE   stalls. ', details: '- What happened: stuck again' });
  expect(r.error, r.text).toBe(false);
  expect(r.out).toMatchObject({ count: 2, grouped: true });
  const [f] = rows(srv.db);
  expect(f.count).toBe(2);
  expect(f.sources).toBe(`${basename(repo)} #1 (worker)\n${basename(repo)} #2 (tester)`);
  expect(f.details).toContain(DETAILS);
  expect(f.details).toContain('- What happened: stuck again');
  const list = await (await api('GET', '/feedback')).json();
  expect(list).toEqual([expect.objectContaining({ id: f.id, count: 2 })]);
});

it('details without the What happened bullet and an unknown type are refused and store nothing', async () => {
  const before = rows(srv.db).length;
  expect((await send(worker, { title: 'x', details: 'it broke' })).error).toBe(true);
  expect((await send(worker, { title: 'x', type: 'complaint' })).error).toBe(true);
  expect(rows(srv.db).length).toBe(before);
});

it('Incorporate makes a Backlog ticket carrying the details; the item leaves the inbox and cannot be incorporated twice', async () => {
  const [f] = rows(srv.db);
  const res = await api('POST', `/feedback/${f.id}/incorporate`);
  expect(res.status).toBe(201);
  const t = await res.json();
  expect(t).toMatchObject({ title: 'Merge queue stalls', status: 'backlog' });
  expect(t.body).toContain(`From feedback #${f.id}`);
  expect(t.body).toContain('Reported 2 times');
  expect(t.body).toContain('Failure mode: stopping_short');
  expect(t.body).toContain(DETAILS);
  expect(rows(srv.db)[0]).toMatchObject({ status: 'incorporated', ticket_id: t.id });
  expect(await (await api('GET', '/feedback')).json()).toEqual([]);
  expect((await api('POST', `/feedback/${f.id}/incorporate`)).status).toBe(409);
});

it('a report after its item was incorporated opens a new item; Drop needs a reason and keeps it', async () => {
  const r = await send(worker, { title: 'Merge queue stalls' });
  expect(r.out).toMatchObject({ count: 1, grouped: false });
  expect((await api('POST', `/feedback/${r.out.id}/drop`, { reason: ' ' })).status).toBe(400);
  expect((await api('POST', `/feedback/${r.out.id}/drop`, { reason: 'fixed by the incorporated one' })).status).toBe(204);
  expect(rows(srv.db).at(-1)).toMatchObject({ status: 'dropped', reason: 'fixed by the incorporated one', ticket_id: null });
  expect((await api('POST', `/feedback/${r.out.id}/drop`, { reason: 'again' })).status).toBe(409);
});

it('feedback_board naming a registered board that is not running writes into that board, audited there', async () => {
  const other = temp('k95-sfo-');
  openDb(other).close();
  addProject(other);
  writeConfig('settings', { feedback_board: basename(other) });
  const r = await send(worker, { type: 'missing_capability', title: 'No way to pause one ticket' });
  expect(r.error, r.text).toBe(false);
  expect(r.out).toMatchObject({ project: basename(other), count: 1 });
  expect(running().some((e) => same(e.repo, other))).toBe(false);
  const db = new DatabaseSync(join(other, '.kanban95', 'board.db'));
  try {
    expect(rows(db)).toEqual([expect.objectContaining({ type: 'missing_capability', title: 'No way to pause one ticket', sources: `${basename(repo)} #1 (worker)` })]);
    expect(db.prepare("SELECT grant_id, outcome FROM audit WHERE tool = 'boards.feedback'").all()).toEqual([{ grant_id: null, outcome: 'ok' }]);
  } finally {
    db.close();
  }
});

it('POST /api/boards/feedback needs the registry key and checks the fields', async () => {
  const url = `http://127.0.0.1:${srv.port}/api/boards/feedback`;
  const body = JSON.stringify({ from: 'elsewhere #9 (worker)', type: 'idea', title: 'Remote idea', details: DETAILS });
  expect((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status).toBe(401);
  const key = running().find((e) => same(e.repo, repo))!.key!;
  const headers = { 'content-type': 'application/json', 'X-K95-Key': key };
  expect((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ from: 'x', type: 'idea', title: 't', details: DETAILS, failure_mode: 'rude' }) })).status).toBe(400);
  const res = await fetch(url, { method: 'POST', headers, body });
  expect(res.status).toBe(201);
  expect(await res.json()).toMatchObject({ count: 1, grouped: false });
  expect(rows(srv.db).at(-1)).toMatchObject({ type: 'idea', title: 'Remote idea', sources: 'elsewhere #9 (worker)', status: 'open' });
});
