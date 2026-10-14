import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapPath, parseBootstrap } from '../src/bootstrap.ts';
import { mint } from '../src/grants.ts';
import { start } from '../src/server.ts';
import { DEFAULTS_DIR } from '../src/templates.ts';

describe('parseBootstrap', () => {
  it('reads the shipped file as four starter tickets, each with a title, a body and criteria', () => {
    const list = parseBootstrap(readFileSync(join(DEFAULTS_DIR, 'bootstrap.md'), 'utf8'));
    expect(list).toHaveLength(4);
    for (const t of list) {
      expect(t.title).not.toBe('');
      expect(t.body).not.toBe('');
      expect(t.body).not.toMatch(/Criteria:/);
      expect(t.criteria.split('\n').filter(Boolean).length).toBeGreaterThan(0);
    }
  });

  it('takes criteria one per line, drops list markers and blank lines, and ignores text before the first title', () => {
    expect(parseBootstrap('intro\n## A\r\nbody a\r\n\r\nCriteria:\r\n- one\r\n\r\ntwo\n## B\nbody b\n')).toEqual([
      { title: 'A', body: 'body a', criteria: 'one\ntwo' },
      { title: 'B', body: 'body b', criteria: '' },
    ]);
  });

  it('refuses a file with no sections', () => {
    expect(() => parseBootstrap('# Starter tickets\n\nnothing here\n')).toThrow(/no "## <title>" sections/);
  });
});

describe('bootstrap on a board', () => {
  let repo: string;
  let srv: Awaited<ReturnType<typeof start>>;
  const clients: Client[] = [];
  const api = (path: string) =>
    fetch(`http://127.0.0.1:${srv.port}${path}`, { method: 'POST', headers: { cookie: `k95=${srv.secret}`, 'content-type': 'application/json' }, body: '{}' });
  const audit = () => srv.db.prepare('SELECT grant_id, tool, outcome FROM audit ORDER BY id DESC LIMIT 1').get();
  async function connect(role: 'planner' | 'worker') {
    if (role === 'worker') srv.db.prepare("INSERT INTO tickets (title, status) VALUES ('own', 'in_progress')").run();
    const ticket = role === 'worker' ? (srv.db.prepare('SELECT max(id) AS id FROM tickets').get() as { id: number }).id : null;
    const g = mint(srv.db, { ticket, role, ttlMs: 60_000 });
    const c = new Client({ name: 'test', version: '0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${g.token}` } } }));
    clients.push(c);
    return { c, id: g.id };
  }
  const call = async (c: Client) => {
    const r = (await c.callTool({ name: 'bootstrap_board', arguments: {} })) as { isError?: boolean; content: { text: string }[] };
    return { denied: r.isError === true, text: r.content[0].text };
  };

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'k95-'));
    srv = await start({ repo });
  });
  beforeEach(() => { srv.db.exec('DELETE FROM ticket_deps; DELETE FROM tickets'); });
  afterAll(async () => {
    await Promise.all(clients.map((c) => c.close()));
    await srv.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it('copies bootstrap.md into the repo templates on start', () => {
    expect(readFileSync(bootstrapPath(repo), 'utf8')).toBe(readFileSync(join(DEFAULTS_DIR, 'bootstrap.md'), 'utf8'));
  });

  it('POST /api/tickets/bootstrap creates the set in Backlog, tagged setup, each depending on the one before; a second call is 409', async () => {
    const r = await api('/api/tickets/bootstrap');
    expect(r.status).toBe(201);
    const list = (await r.json()) as { id: number; title: string; status: string; tags: string; depends_on: number[] }[];
    expect(list.map((t) => t.title)).toEqual(parseBootstrap(readFileSync(bootstrapPath(repo), 'utf8')).map((s) => s.title));
    list.forEach((t, i) => {
      expect(t).toMatchObject({ status: 'backlog', tags: 'setup', depends_on: i ? [list[i - 1].id] : [] });
    });
    expect(audit()).toEqual({ grant_id: null, tool: 'tickets.bootstrap', outcome: 'ok' });
    const again = await api('/api/tickets/bootstrap');
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toMatch(/already has setup tickets/);
    expect(audit()).toEqual({ grant_id: null, tool: 'tickets.bootstrap', outcome: 'error' });
    expect((srv.db.prepare('SELECT count(*) AS n FROM tickets').get() as { n: number }).n).toBe(4);
  });

  it('refuses with 400 and creates nothing when the repo copy has no sections', async () => {
    const file = bootstrapPath(repo);
    const kept = readFileSync(file, 'utf8');
    writeFileSync(file, '# Starter tickets\n');
    try {
      const r = await api('/api/tickets/bootstrap');
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toMatch(/no "## <title>" sections/);
      expect((srv.db.prepare('SELECT count(*) AS n FROM tickets').get() as { n: number }).n).toBe(0);
    } finally {
      writeFileSync(file, kept);
    }
  });

  it('bootstrap_board: a worker grant is refused, a planner grant creates the set once', async () => {
    const worker = await connect('worker');
    const w = await call(worker.c);
    expect(w).toEqual({ denied: true, text: 'a worker may not call bootstrap_board' });
    expect(audit()).toEqual({ grant_id: worker.id, tool: 'bootstrap_board', outcome: 'denied' });

    const planner = await connect('planner');
    const p = await call(planner.c);
    expect(p.denied).toBe(false);
    const list = JSON.parse(p.text) as { tags: string; created_by_grant: number }[];
    expect(list).toHaveLength(4);
    expect(list.every((t) => t.tags === 'setup' && t.created_by_grant === planner.id)).toBe(true);
    expect(audit()).toEqual({ grant_id: planner.id, tool: 'bootstrap_board', outcome: 'ok' });

    const again = await call(planner.c);
    expect(again.denied).toBe(true);
    expect(again.text).toMatch(/already has setup tickets/);
  });
});
