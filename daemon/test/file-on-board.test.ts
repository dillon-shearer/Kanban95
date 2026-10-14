import './home.ts';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { entryPath, running } from '../src/boards.ts';
import { openDb } from '../src/db.ts';
import { mint } from '../src/grants.ts';
import { start } from '../src/server.ts';
import { addProject, same } from '../src/settings.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const temps: string[] = [];
const temp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};
let a: Awaited<ReturnType<typeof start>>;
let b: ChildProcess;
let bPort: number;
let bDb: DatabaseSync;
let worker: Client;
let repoA: string, repoB: string;

async function call(c: Client, args: Record<string, unknown>) {
  const r = (await c.callTool({ name: 'file_on_board', arguments: args })) as { isError?: boolean; content: { text: string }[] };
  return { error: r.isError === true, text: r.content[0].text };
}
const count = (db: DatabaseSync, sql: string) => (db.prepare(sql).get() as { n: number }).n;
const post = (headers: Record<string, string>, body: string) =>
  fetch(`http://127.0.0.1:${bPort}/api/boards/file`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

beforeAll(async () => {
  execSync('npm run build', { cwd: ROOT, stdio: 'ignore' });
  repoA = temp('k95-fa-');
  repoB = temp('k95-fb-');
  a = await start({ repo: repoA });
  const { KANBAN95_SHELL: _, ...env } = process.env;
  b = spawn(process.execPath, [join(ROOT, 'daemon/dist/server.js'), repoB], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...env, KANBAN95_SECRET: 'c'.repeat(64) } });
  const [chunk] = await once(b.stdout!, 'data');
  bPort = Number(/port=(\d+)/.exec(String(chunk))![1]);
  bDb = new DatabaseSync(join(repoB, '.kanban95', 'board.db'));
  a.db.prepare("INSERT INTO tickets (title, status) VALUES ('own', 'in_progress')").run();
  const g = mint(a.db, { ticket: 1, role: 'worker', ttlMs: 60_000 });
  worker = new Client({ name: 'test', version: '0' });
  await worker.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${a.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${g.token}` } } }));
}, 60_000);
afterAll(async () => {
  await worker?.close();
  bDb?.close();
  if (b && b.exitCode === null) {
    const exited = once(b, 'exit');
    b.stdin!.end();
    await exited;
  }
  await a?.close();
  for (const d of temps) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
}, 30_000);

it('a worker on board A files a Backlog ticket on running board B by folder name, audited once on each board', async () => {
  const r = await call(worker, { project: basename(repoB), title: 'gap in B', body: 'details', criteria: 'c1' });
  expect(r.error, r.text).toBe(false);
  expect(JSON.parse(r.text).started).toBe(false);
  const id = JSON.parse(r.text).ticket.id;
  const t = bDb.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as Record<string, unknown>;
  expect(t).toMatchObject({ title: 'gap in B', status: 'backlog', model: null, effort: null, criteria: 'c1' });
  expect(String(t.body).startsWith(`Filed from ${basename(repoA)} #1`)).toBe(true);
  expect(a.db.prepare("SELECT grant_id IS NOT NULL AS g, outcome FROM audit WHERE tool = 'file_on_board'").all()).toEqual([{ g: 1, outcome: 'ok' }]);
  expect(bDb.prepare("SELECT grant_id, ticket_id, outcome FROM audit WHERE tool = 'boards.file'").all()).toEqual([{ grant_id: null, ticket_id: id, outcome: 'ok' }]);
});

it('filing on a registered board that is not running opens it, files the ticket and leaves it not running; B stays running', async () => {
  const idle = temp('k95-fc-');
  openDb(idle).close();
  addProject(idle);
  const r = await call(worker, { project: basename(idle), title: 'gap in C', body: 'details', criteria: 'c1', tags: ['bug'] });
  expect(r.error, r.text).toBe(false);
  const out = JSON.parse(r.text);
  expect(out).toMatchObject({ project: basename(idle), started: true, ticket: { title: 'gap in C', status: 'backlog', model: null, effort: null } });
  const cDb = new DatabaseSync(join(idle, '.kanban95', 'board.db'));
  try {
    const t = cDb.prepare('SELECT * FROM tickets WHERE id = ?').get(out.ticket.id) as Record<string, unknown>;
    expect(t).toMatchObject({ title: 'gap in C', status: 'backlog', criteria: 'c1', tags: 'bug' });
    expect(String(t.body).startsWith(`Filed from ${basename(repoA)} #1`)).toBe(true);
    expect(cDb.prepare("SELECT grant_id, outcome FROM audit WHERE tool = 'boards.file'").all()).toEqual([{ grant_id: null, outcome: 'ok' }]);
  } finally {
    cDb.close();
  }
  expect(running().some((e) => same(e.repo, idle))).toBe(false);
  expect(running().some((e) => same(e.repo, repoB))).toBe(true);
});

it('an unregistered name or a registered board whose folder is gone fails, names the registered boards and creates nothing', async () => {
  const lost = temp('k95-fd-');
  addProject(lost);
  rmSync(lost, { recursive: true, force: true });
  const before = [count(a.db, 'SELECT count(*) AS n FROM tickets'), count(bDb, 'SELECT count(*) AS n FROM tickets')];
  for (const [project, says] of [['no-such-board', 'is not in projects.json'], [basename(lost), 'is missing']]) {
    const r = await call(worker, { project, title: 'x' });
    expect(r.error).toBe(true);
    expect(r.text).toContain(says);
    expect(r.text).toContain('Registered boards:');
    expect(r.text).toContain(basename(repoB));
    expect(r.text).toContain(basename(lost));
  }
  expect(existsSync(lost)).toBe(false);
  expect([count(a.db, 'SELECT count(*) AS n FROM tickets'), count(bDb, 'SELECT count(*) AS n FROM tickets')]).toEqual(before);
});

it('filing on its own board is create_ticket for a worker', async () => {
  const r = await call(worker, { project: repoA, title: 'own board' });
  expect(r.error, r.text).toBe(false);
  expect(JSON.parse(r.text).ticket).toMatchObject({ status: 'backlog', body: 'Filed by #1\n\n', model: null, effort: null });
});

it('the route refuses a missing or wrong key with 401 and a body over 64 KB with 413, creating nothing', async () => {
  const key = JSON.parse(readFileSync(entryPath(b.pid!), 'utf8')).key as string;
  const before = count(bDb, 'SELECT count(*) AS n FROM tickets');
  const body = JSON.stringify({ from: 'x #1', title: 't' });
  expect((await post({}, body)).status).toBe(401);
  expect((await post({ 'x-k95-key': 'f'.repeat(64) }, body)).status).toBe(401);
  expect((await post({ 'x-k95-key': key }, JSON.stringify({ from: 'x #1', title: 't', body: 'y'.repeat(65 * 1024) }))).status).toBe(413);
  expect(count(bDb, 'SELECT count(*) AS n FROM tickets')).toBe(before);
});

it('register writes a key; running() still reads an entry without one', async () => {
  expect(JSON.parse(readFileSync(entryPath(process.pid), 'utf8')).key).toMatch(/^[0-9a-f]{64}$/);
  const old = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    writeFileSync(entryPath(old.pid!), JSON.stringify({ pid: old.pid, repo: repoB, port: 1, started: new Date().toISOString() }));
    expect(running().find((e) => e.pid === old.pid)).toMatchObject({ pid: old.pid, port: 1 });
  } finally {
    old.kill();
    rmSync(entryPath(old.pid!), { force: true });
  }
});
