import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, openDb } from '../src/db.ts';
import { mint } from '../src/grants.ts';
import { start } from '../src/server.ts';

// Ticket tags: one normalised form (docs/DATA.md → tickets.tags) whether they come from the UI's REST or an agent's MCP call.
let repo: string;
let srv: Awaited<ReturnType<typeof start>>;
let planner: Client;
let id: number;
const api = (method: string, path: string, body?: unknown) =>
  fetch(`http://127.0.0.1:${srv.port}/api${path}`, {
    method, headers: { cookie: `k95=${srv.secret}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
const stored = (t: number) => (srv.db.prepare('SELECT tags FROM tickets WHERE id = ?').get(t) as { tags: string }).tags;
async function tool(name: string, args: Record<string, unknown>) {
  const r = (await planner.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  return { error: r.isError === true, text: r.content[0].text, json: r.isError ? undefined : JSON.parse(r.content[0].text) };
}

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'k95-'));
  srv = await start({ repo });
  id = Number(srv.db.prepare("INSERT INTO tickets (title) VALUES ('tag me')").run().lastInsertRowid);
  planner = new Client({ name: 'test', version: '0' });
  const { token } = mint(srv.db, { ticket: null, role: 'planner', ttlMs: 60_000 });
  await planner.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
});
afterAll(async () => {
  await planner.close();
  await srv.close();
  rmSync(repo, { recursive: true, force: true });
});

describe('REST', () => {
  it('normalises a comma-and-space string to distinct lowercase tokens joined by one space, and GET returns it', async () => {
    const r = await api('PATCH', `/tickets/${id}`, { tags: ' UI,  Daemon ui,' });
    expect(r.status).toBe(200);
    expect((await r.json()).tags).toBe('ui daemon');
    expect((await (await api('GET', `/tickets/${id}`)).json()).tags).toBe('ui daemon');
    expect((await (await api('GET', '/tickets')).json()).find((t: { id: number }) => t.id === id).tags).toBe('ui daemon');
  });

  it('takes an array on POST, and an empty string clears', async () => {
    const r = await api('POST', '/tickets', { title: 'arr', tags: ['Docs', 'k95-ui'] });
    expect(r.status).toBe(201);
    const t = await r.json();
    expect(t.tags).toBe('docs k95-ui');
    expect((await (await api('PATCH', `/tickets/${t.id}`, { tags: '' })).json()).tags).toBe('');
  });

  it('refuses a quoted tag with a space, a character outside [a-z0-9-], a spaced array element and a non-string, leaving the tags alone', async () => {
    for (const tags of ['ui "two words"', 'ui, c++', 'naïve', ['two words'], ['ui', 3], 7]) {
      const r = await api('PATCH', `/tickets/${id}`, { tags });
      expect(r.status, JSON.stringify(tags)).toBe(400);
    }
    expect(stored(id)).toBe('ui daemon');
    expect((await api('POST', '/tickets', { title: 'bad', tags: 'a_b' })).status).toBe(400);
  });
});

describe('MCP', () => {
  it('create_ticket stores tags; get_ticket and list_tickets return them; update_ticket replaces them', async () => {
    const c = await tool('create_ticket', { title: 'from mcp', tags: ['ui'] });
    expect(c.error).toBe(false);
    expect(stored(c.json.id)).toBe('ui');
    expect((await tool('get_ticket', { ticket_id: c.json.id })).json.tags).toBe('ui');
    expect((await tool('list_tickets', {})).json.find((t: { id: number }) => t.id === c.json.id).tags).toBe('ui');
    expect((await tool('update_ticket', { ticket_id: c.json.id, tags: ['Daemon', 'docs'] })).json.tags).toBe('daemon docs');
  });

  it('refuses an invalid tag and writes nothing', async () => {
    const before = srv.db.prepare('SELECT count(*) AS n FROM tickets').get();
    const r = await tool('create_ticket', { title: 'bad', tags: ['two words'] });
    expect(r.error).toBe(true);
    expect(r.text).toMatch(/a-z, 0-9 and -/);
    expect(srv.db.prepare('SELECT count(*) AS n FROM tickets').get()).toEqual(before);
    expect((await tool('update_ticket', { ticket_id: id, tags: ['ok', 'no!'] })).error).toBe(true);
    expect(stored(id)).toBe('ui daemon');
  });
});

describe('migration', () => {
  it('adds an empty tags column to the tickets of an existing board', () => {
    const old = mkdtempSync(join(tmpdir(), 'k95-'));
    const mig = join(old, 'mig');
    mkdirSync(mig);
    try {
      for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f < '006')) copyFileSync(join(MIGRATIONS_DIR, f), join(mig, f));
      let db = openDb(old, { migrationsDir: mig });
      db.prepare("INSERT INTO tickets (title) VALUES ('old')").run();
      db.close();
      db = openDb(old);
      expect(db.prepare('SELECT title, tags FROM tickets').all()).toEqual([{ title: 'old', tags: '' }]);
      db.close();
    } finally {
      rmSync(old, { recursive: true, force: true });
    }
  });
});
