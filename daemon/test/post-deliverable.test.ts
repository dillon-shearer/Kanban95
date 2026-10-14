import './home.ts';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mint } from '../src/grants.ts';
import { start } from '../src/server.ts';

vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>();
  return { ...real, spawn: vi.fn(() => ({ once() { return this; }, unref() {} })) };
});

let repo: string;
let data: string;
let srv: Awaited<ReturnType<typeof start>>;
let worker: Client, operator: Client;
const clients: Client[] = [];
const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';

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
const api = (method: string, path: string, body?: unknown) =>
  fetch(`http://127.0.0.1:${srv.port}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie: `k95=${srv.secret}` }, body: body === undefined ? undefined : JSON.stringify(body) });
const list = async () => (await (await api('GET', '/deliverables')).json()) as { folder: string; ticket_id: number; title: string }[];

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'k95-'));
  data = mkdtempSync(join(tmpdir(), 'k95-data-'));
  srv = await start({ repo });
  for (const t of ['one', 'two']) srv.db.prepare("INSERT INTO tickets (title, status) VALUES (?, 'in_progress')").run(t);
  const w = mint(srv.db, { ticket: 1, role: 'worker', ttlMs: 60_000 });
  const o = mint(srv.db, { ticket: null, role: 'operator', ttlMs: 60_000 });
  [worker, operator] = await Promise.all([w.token, o.token].map(connect));
});
afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await srv.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
});

describe('post_deliverable', () => {
  it('a worker posts a folder outside the repo; the Inbox lists it and Open opens that folder', async () => {
    const out = join(data, 'als-tdi', 'index', 'r2.5');
    mkdirSync(out, { recursive: true });
    const r = await post(worker, { title: 'Index r2.5\nsecond line', folder: out });
    expect(r.failed).toBe(false);
    expect(JSON.parse(r.text)).toMatchObject({ folder: out, ticket_id: 1, title: 'Index r2.5' });
    expect(await list()).toMatchObject([{ folder: out, ticket_id: 1, title: 'Index r2.5' }]);

    expect((await api('POST', '/deliverables/open', { folder: out })).status).toBe(204);
    expect(vi.mocked(spawn)).toHaveBeenLastCalledWith(cmd, [out], expect.anything());

    expect((await api('DELETE', '/deliverables', { folder: out })).status).toBe(204);
    expect(await list()).toEqual([]);
  });

  it('refuses a missing path, a file and a relative path, and stores nothing', async () => {
    writeFileSync(join(data, 'a.txt'), 'x');
    for (const [folder, msg] of [
      [join(data, 'missing'), 'does not exist'],
      [join(data, 'a.txt'), 'is not a folder'],
      ['als-tdi/index', 'is not an absolute path'],
    ]) {
      const r = await post(worker, { title: 't', folder });
      expect(r.failed, folder).toBe(true);
      expect(r.text).toContain(msg);
    }
    expect(await list()).toEqual([]);
  });

  it('a worker posts only on its own ticket; an operator posts on any', async () => {
    const r = await post(worker, { ticket_id: 2, title: 't', folder: data });
    expect(r.failed).toBe(true);
    expect(r.text).toMatch(/scoped to ticket 1/);
    expect((await post(operator, { ticket_id: 2, title: 'From operator', folder: data })).failed).toBe(false);
    expect(await list()).toMatchObject([{ folder: data, ticket_id: 2, title: 'From operator' }]);
  });

  it('Open reports a posted folder that was removed since', async () => {
    const gone = join(data, 'gone');
    mkdirSync(gone);
    await post(worker, { title: 'Gone', folder: gone });
    rmSync(gone, { recursive: true });
    const before = vi.mocked(spawn).mock.calls.length;
    const res = await api('POST', '/deliverables/open', { folder: gone });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('no longer exists');
    expect(vi.mocked(spawn).mock.calls.length).toBe(before);
  });
});
