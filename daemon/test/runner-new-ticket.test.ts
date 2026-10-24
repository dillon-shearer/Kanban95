import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readTicket } from '../src/api.ts';
import { entryPath } from '../src/boards.ts';
import { mint } from '../src/grants.ts';
import { runner } from '../src/lifecycle.ts';
import { start } from '../src/server.ts';
import './memory.ts';
import { writeConfig } from '../src/settings.ts';
import { removeTemp } from './home.ts';
import { fakeCli } from './fake-cli.ts';

vi.mock('../src/pty.ts', async (orig) => {
  const real = await orig<typeof import('../src/pty.ts')>();
  const standIn = () => {
    const exits = new Set<(e: { exitCode: number }) => void>();
    let ended = false;
    const pty = {
      pid: 0,
      onData: () => ({ dispose() {} }),
      onExit: (f: (e: { exitCode: number }) => void) => (exits.add(f), { dispose: () => exits.delete(f) }),
      write() {},
      resize() {},
      kill() {
        if (ended) return;
        ended = true;
        setImmediate(() => { for (const f of exits) f({ exitCode: 1 }); });
      },
    };
    return { pty: pty as unknown as import('node-pty').IPty, scrollback: () => 'FAKE hang\r\n' };
  };
  return { ...real, spawnPty: () => standIn() };
});

const bin = mkdtempSync(join(tmpdir(), 'k95-bin-'));
const PATH0 = process.env.PATH;
let repo: string;
let srv: Awaited<ReturnType<typeof start>>;
let worker: Client;
let own: number;

const request = (method: string, path: string, body?: unknown) => fetch(`http://127.0.0.1:${srv.port}${path}`, {
  method, headers: { 'content-type': 'application/json', cookie: `k95=${srv.secret}` }, body: body === undefined ? undefined : JSON.stringify(body),
});
const status = (id: number) => readTicket(srv.db, id).status;
async function createTicket(title: string): Promise<number> {
  const r = (await worker.callTool({ name: 'create_ticket', arguments: { title } })) as { isError?: boolean; content: { text: string }[] };
  expect(r.isError, r.content[0].text).not.toBe(true);
  return JSON.parse(r.content[0].text).id;
}
async function fileTicket(title: string): Promise<number> {
  const key = JSON.parse(readFileSync(entryPath(process.pid), 'utf8')).key as string;
  const r = await fetch(`http://127.0.0.1:${srv.port}/api/boards/file`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-k95-key': key }, body: JSON.stringify({ from: 'Other #7', title }),
  });
  expect(r.status).toBe(201);
  return ((await r.json()) as { id: number }).id;
}

beforeAll(() => {
  writeFileSync(join(bin, 'fake.mjs'), '');
  fakeCli(bin, 'claude', 'fake.mjs');
  process.env.PATH = bin + delimiter + PATH0;
  mkdirSync(process.env.KANBAN95_HOME!, { recursive: true });
  writeConfig('models', { cli: 'claude', claude: { execute: { model: 'hang', effort: 'low' }, test: { model: 'hang', effort: 'low' } } });
  writeConfig('settings', { concurrency: 5 });
});
afterAll(() => {
  process.env.PATH = PATH0;
  removeTemp(bin);
});
beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'k95-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Op Erator');
  git('config', 'user.email', 'op@example.com');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git('add', 'a.txt');
  git('commit', '-qm', 'init');
  srv = await start({ repo });
  own = Number(srv.db.prepare("INSERT INTO tickets (title, status) VALUES ('own', 'in_progress')").run().lastInsertRowid);
  const g = mint(srv.db, { ticket: own, role: 'worker', ttlMs: 60_000 });
  worker = new Client({ name: 'test', version: '0' });
  await worker.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${g.token}` } } }));
});
afterEach(async () => {
  await worker.close();
  await srv.close();
  removeTemp(repo);
}, 30_000);

describe('a new ticket and the runner', { timeout: 60_000 }, () => {
  it('with the runner on, a ticket from create_ticket, file_on_board or the UI launches with no other ticket changing state', async () => {
    const first = Number(srv.db.prepare("INSERT INTO tickets (title) VALUES ('first')").run().lastInsertRowid);
    expect((await (await request('PUT', '/api/runner', { on: true })).json()).running).toEqual([own, first]);
    const created = await createTicket('made by create_ticket');
    expect(status(created)).toBe('in_progress');
    const filed = await fileTicket('filed from another board');
    expect(status(filed)).toBe('in_progress');
    const r = await request('POST', '/api/tickets', { title: 'made in the UI' });
    expect(r.status).toBe(201);
    expect(status(((await r.json()) as { id: number }).id)).toBe('in_progress');
    expect(runner(srv.board).on).toBe(true);
  });

  it('with the runner off, a new ticket stays in Backlog', async () => {
    expect(runner(srv.board).on).toBe(false);
    const created = await createTicket('made by create_ticket');
    const filed = await fileTicket('filed from another board');
    for (const id of [created, filed]) expect(status(id)).toBe('backlog');
  });
});
