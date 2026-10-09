// The global brain (~/.kanban95/brain.db): two boards on two repos share it through one (throwaway) home; project rows stay private.
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildContext } from '../src/context.ts';
import { mint } from '../src/grants.ts';
import { start } from '../src/server.ts';

type Srv = Awaited<ReturnType<typeof start>>;
const repos: string[] = [];
const clients: Client[] = [];
let a: Srv, b: Srv;
let workerA: Client, workerB: Client;

async function connect(srv: Srv, ticket: number): Promise<Client> {
  const { token } = mint(srv.db, { ticket, role: 'worker', ttlMs: 60_000 });
  const c = new Client({ name: 'test', version: '0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  clients.push(c);
  return c;
}
async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  return { denied: r.isError === true, json: r.isError ? undefined : JSON.parse(r.content[0].text) };
}
const rest = (srv: Srv, method: string, path: string, body?: unknown) =>
  fetch(`http://127.0.0.1:${srv.port}/api${path}`, {
    method,
    headers: { cookie: `k95=${srv.secret}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const titles = (rows: { scope: string; title: string }[]) => rows.map((r) => `${r.scope}:${r.title}`);

beforeAll(async () => {
  for (const name of ['a', 'b']) repos.push(mkdtempSync(join(tmpdir(), `k95-${name}-`)));
  a = await start({ repo: repos[0] });
  b = await start({ repo: repos[1] });
  for (const s of [a, b]) s.db.prepare("INSERT INTO tickets (title) VALUES ('one')").run();
  [workerA, workerB] = await Promise.all([connect(a, 1), connect(b, 1)]);
});
afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await a.close();
  await b.close();
  for (const r of repos) rmSync(r, { recursive: true, force: true });
});

describe('global brain', () => {
  it('a global row from board A is found on board B; a project row from A is not; no scope means project', async () => {
    const g = (await call(workerA, 'brain_add', { title: 'vitest pool hangs', body: 'close every client in afterAll', tags: 'vitest', scope: 'global' })).json;
    const p = (await call(workerA, 'brain_add', { title: 'vitest config of repo A', body: 'only true in A', tags: 'vitest' })).json;
    expect(p.scope).toBe('project');
    expect(a.db.prepare('SELECT title, ticket_id FROM brain WHERE id = ?').get(p.id)).toEqual({ title: 'vitest config of repo A', ticket_id: 1 });
    expect(titles((await call(workerB, 'brain_search', { query: 'vitest' })).json)).toEqual(['global:vitest pool hangs']);
    expect(titles((await call(workerA, 'brain_search', { query: 'vitest' })).json).sort()).toEqual(['global:vitest pool hangs', 'project:vitest config of repo A']);
    expect((await call(workerB, 'brain_search', { id: g.id, scope: 'global' })).json).toMatchObject([{ scope: 'global', ticket_id: null }]);
    // Both daemons hold their own connection to the one file, in WAL mode.
    expect(b.board.brain.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
  });

  it('ranks across both files: a title hit in the global brain outranks a body-only hit in the project brain', async () => {
    a.db.prepare("INSERT INTO brain (title, body) VALUES ('misc', ?)").run('conpty '.repeat(3) + 'filler '.repeat(40));
    await call(workerB, 'brain_add', { title: 'conpty resize', body: 'the first resize is lost', tags: 'conpty pty', scope: 'global' });
    const rows = (await call(workerA, 'brain_search', { query: 'conpty' })).json;
    expect(titles(rows)).toEqual(['global:conpty resize', 'project:misc']);
    expect(rows.every((r: { scope?: string }) => r.scope)).toBe(true);
  });

  it('update and delete act on the row in the scope given and refuse an id not in that scope', async () => {
    const g = await (await rest(a, 'POST', '/brain', { title: 'git on windows', body: 'core.autocrlf rewrites', tags: 'git', scope: 'global' })).json();
    expect(g).toMatchObject({ scope: 'global', ticket_id: null });
    // Ids are per file: B's project brain has no row with this id, so naming the wrong scope finds nothing.
    expect(b.db.prepare('SELECT 1 FROM brain WHERE id = ?').get(g.id)).toBeUndefined();
    expect((await rest(b, 'PATCH', `/brain/${g.id}?scope=project`, { body: 'x' })).status).toBe(404);
    expect((await rest(b, 'PATCH', `/brain/${g.id}`, { body: 'x' })).status).toBe(404); // no scope: project
    expect((await rest(b, 'PATCH', `/brain/${g.id}?scope=global`, { body: 'use .gitattributes eol=lf' })).status).toBe(200);
    expect(a.board.brain.prepare('SELECT body FROM brain WHERE id = ?').get(g.id)).toEqual({ body: 'use .gitattributes eol=lf' });
    expect((await rest(b, 'PATCH', `/brain/${g.id}?scope=team`, { body: 'x' })).status).toBe(400);
    expect((await rest(b, 'DELETE', `/brain/${g.id}?scope=project`)).status).toBe(404);
    expect((await rest(b, 'DELETE', `/brain/${g.id}?scope=global`)).status).toBe(204);
    expect(a.board.brain.prepare('SELECT 1 FROM brain WHERE id = ?').get(g.id)).toBeUndefined();
    expect(b.db.prepare("SELECT args_summary FROM audit WHERE tool = 'brain.delete' ORDER BY id DESC LIMIT 1").get()).toEqual({ args_summary: `{"id":${g.id},"scope":"global"}` });
  });

  it('the operator moves a row between brains: inserted there, deleted here, ticket dropped on the way to global', async () => {
    const p = await (await rest(a, 'POST', '/brain', { title: 'node-pty attach', body: 'AttachConsole failed is harmless', tags: 'pty' })).json();
    a.db.prepare('UPDATE brain SET ticket_id = 1 WHERE id = ?').run(p.id);
    const moved = await (await rest(a, 'PATCH', `/brain/${p.id}`, { move_to: 'global' })).json();
    expect(moved).toMatchObject({ scope: 'global', title: 'node-pty attach', ticket_id: null, created_at: p.created_at });
    expect(a.db.prepare('SELECT 1 FROM brain WHERE id = ?').get(p.id)).toBeUndefined();
    expect(titles(await (await rest(b, 'GET', '/brain?q=AttachConsole&scope=global')).json())).toEqual(['global:node-pty attach']);
    expect(await (await rest(b, 'GET', '/brain?q=AttachConsole&scope=project')).json()).toEqual([]);
    const back = await (await rest(b, 'PATCH', `/brain/${moved.id}?scope=global`, { move_to: 'project', title: 'node-pty kill' })).json();
    expect(back).toMatchObject({ scope: 'project', title: 'node-pty kill' });
    expect(b.db.prepare('SELECT title FROM brain WHERE id = ?').get(back.id)).toEqual({ title: 'node-pty kill' });
    expect(a.board.brain.prepare('SELECT 1 FROM brain WHERE id = ?').get(moved.id)).toBeUndefined();
  });

  it("a ticket's brain section includes a matching global row, marked [global], in the same ranking", async () => {
    await call(workerA, 'brain_add', { title: 'fnm exec cannot start npm', body: 'npm is a .cmd shim', tags: 'fnm npm', scope: 'global' });
    const t = Number(b.db.prepare("INSERT INTO tickets (title, body) VALUES ('Switch the fnm setup', 'npm under fnm')").run().lastInsertRowid);
    const { brain } = buildContext(b.db, repos[1], t, 'worker', { global: b.board.brain });
    expect(brain).toMatch(/^- \[global\] \[#\d+\] fnm exec cannot start npm: npm is a \.cmd shim/);
    expect(buildContext(a.db, repos[0], 1, 'worker', { global: a.board.brain }).brain).not.toContain('fnm'); // ticket "one" matches nothing
  });
});

describe('global brain file', () => {
  it('several daemons opening a fresh brain.db at once all succeed and apply the migration once', async () => {
    const home = mkdtempSync(join(tmpdir(), 'k95-gb-'));
    const db = resolve(import.meta.dirname, '../dist/db.js').replaceAll('\\', '/');
    const open = `import('file:///${db}').then((m) => m.openGlobalBrain(process.argv[1]).close())`;
    try {
      await Promise.all(Array.from({ length: 4 }, () => promisify(execFile)(process.execPath, ['-e', open, home])));
      const f = new DatabaseSync(join(home, 'brain.db'));
      expect(f.prepare('SELECT version FROM schema_migrations').all()).toEqual([{ version: '001-brain.sql' }]);
      f.close();
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
