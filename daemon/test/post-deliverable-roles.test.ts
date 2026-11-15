import './home.ts';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildContext } from '../src/context.ts';
import { mint } from '../src/grants.ts';
import { TOOLS } from '../src/mcp.ts';
import { start } from '../src/server.ts';
import { initTemplates, render } from '../src/templates.ts';

let repo: string;
let data: string;
let srv: Awaited<ReturnType<typeof start>>;
let planner: Client, tester: Client, worker: Client;
const clients: Client[] = [];

async function connect(token: string): Promise<Client> {
  const c = new Client({ name: 'test', version: '0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  clients.push(c);
  return c;
}
async function post(c: Client, args: Record<string, unknown>) {
  const r = (await c.callTool({ name: 'post_deliverable', arguments: args })) as { isError?: boolean; content: { text: string }[] };
  return { failed: r.isError === true, text: r.content[0].text };
}
const dir = (name: string) => {
  const p = join(data, name);
  mkdirSync(p, { recursive: true });
  return p;
};

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'k95-'));
  data = mkdtempSync(join(tmpdir(), 'k95-data-'));
  srv = await start({ repo });
  initTemplates(repo);
  for (const t of ['one', 'two']) srv.db.prepare("INSERT INTO tickets (title, status) VALUES (?, 'testing')").run(t);
  const p = mint(srv.db, { ticket: null, role: 'planner', ttlMs: 60_000 });
  const t = mint(srv.db, { ticket: 1, role: 'tester', ttlMs: 60_000 });
  const w = mint(srv.db, { ticket: 1, role: 'worker', ttlMs: 60_000 });
  [planner, tester, worker] = await Promise.all([p.token, t.token, w.token].map(connect));
});
afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await srv.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
});

describe('post_deliverable for every role', () => {
  it('a planner posts under a named ticket and with no ticket', async () => {
    const a = dir('planner-a');
    const r = await post(planner, { ticket_id: 2, title: 'Plan A', folder: a });
    expect(r.failed, r.text).toBe(false);
    expect(JSON.parse(r.text)).toMatchObject({ folder: a, ticket_id: 2, title: 'Plan A' });

    const b = dir('planner-b');
    const n = await post(planner, { title: 'Mockup', folder: b });
    expect(n.failed, n.text).toBe(false);
    expect(JSON.parse(n.text)).toMatchObject({ folder: b, ticket_id: null, title: 'Mockup' });
  });

  it('a planner naming a ticket that does not exist is refused', async () => {
    const r = await post(planner, { ticket_id: 999, title: 't', folder: dir('nope') });
    expect(r.failed).toBe(true);
  });

  it('a tester posts on its own ticket and is refused on another', async () => {
    const own = await post(tester, { title: 'Evidence', folder: dir('tester') });
    expect(own.failed, own.text).toBe(false);
    expect(JSON.parse(own.text)).toMatchObject({ ticket_id: 1 });
    for (const c of [tester, worker]) {
      const r = await post(c, { ticket_id: 2, title: 't', folder: data });
      expect(r.failed).toBe(true);
      expect(r.text).toMatch(/scoped to ticket 1/);
    }
  });

  it('a planner is still refused a relative or missing path', async () => {
    for (const [folder, msg] of [
      [join(data, 'missing'), 'does not exist'],
      ['rel/path', 'is not an absolute path'],
    ]) {
      const r = await post(planner, { title: 't', folder });
      expect(r.failed, folder).toBe(true);
      expect(r.text).toContain(msg);
    }
  });

  it('the description no longer limits it to operator requests, and brainstorm and test prompts list it', () => {
    expect(TOOLS.post_deliverable.description).not.toContain('only when the operator asks');
    const tools = (out: string) => out.slice(out.indexOf('## Tools you may call'));
    expect(tools(render(repo, 'brainstorm', buildContext(srv.db, repo, null, 'planner')))).toContain('- post_deliverable (');
    expect(tools(render(repo, 'test', buildContext(srv.db, repo, 1, 'tester', { worktree: import.meta.dirname, base: 'HEAD' })))).toContain('- post_deliverable (');
  });
});
