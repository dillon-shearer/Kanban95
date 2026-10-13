import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readTicket } from '../src/api.ts';
import { sessionsOf } from '../src/launcher.ts';
import { apply, memory, TEST_FLOOR } from '../src/lifecycle.ts';
import { start } from '../src/server.ts';
import './memory.ts';
import { fakeCli } from './fake-cli.ts';

const bin = mkdtempSync(join(tmpdir(), 'k95-bin-'));
const PATH0 = process.env.PATH;
const LOW = TEST_FLOOR - 1;
beforeAll(() => {
  writeFileSync(join(bin, 'fake.mjs'), "console.log('FAKE'); process.stdin.resume();\n");
  fakeCli(bin, 'claude', 'fake.mjs');
  process.env.PATH = bin + delimiter + PATH0;
  mkdirSync(join(process.env.USERPROFILE!, '.kanban95'), { recursive: true });
  writeFileSync(join(process.env.USERPROFILE!, '.kanban95', 'models.json'), JSON.stringify({
    cli: 'claude', claude: { execute: { model: 'hang', effort: 'low' }, test: { model: 'hang', effort: 'low' } },
  }));
});
afterAll(() => {
  process.env.PATH = PATH0;
  rmSync(bin, { recursive: true, force: true });
});

let repo: string;
let srv: Awaited<ReturnType<typeof start>>;
let db: DatabaseSync;
const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
const ticket = (title: string) => Number(db.prepare('INSERT INTO tickets (title) VALUES (?)').run(title).lastInsertRowid);
const live = (id: number) => sessionsOf(id).filter((s) => !s.outcome);
const request = (method: string, path: string, body?: unknown) => fetch(`http://127.0.0.1:${srv.port}${path}`, {
  method, headers: { 'content-type': 'application/json', cookie: `k95=${srv.secret}` }, body: body === undefined ? undefined : JSON.stringify(body),
});
const state = async () => (await request('GET', '/api/runner')).json();
const submitted = async (title: string, free: number) => {
  const id = ticket(title);
  expect((await request('POST', `/api/tickets/${id}/launch`)).status).toBe(200);
  await expect.poll(() => live(id).map((s) => s.role), { timeout: 20_000 }).toEqual(['worker']);
  memory.free = () => free;
  apply(srv.board, id, 'submit');
  expect(readTicket(db, id).status).toBe('testing');
  return id;
};

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'k95-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  git('config', 'user.name', 'Op Erator');
  git('config', 'user.email', 'op@example.com');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git('add', 'a.txt');
  git('commit', '-qm', 'init');
  srv = await start({ repo });
  db = srv.db;
});
afterEach(async () => {
  await srv.close();
  rmSync(repo, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 });
});

describe('tester memory queue', { timeout: 60_000 }, () => {
  it('a submitted ticket under the floor waits for its tester and reports it; above the floor the tester starts', async () => {
    const id = await submitted('Low', LOW);
    expect(live(id)).toEqual([]);
    expect((await state()).lowMemory).toEqual({ free: LOW, floor: TEST_FLOOR, waiting: [id] });
    expect(srv.board.memoryWait).toBeDefined();

    memory.free = () => TEST_FLOOR;
    const other = await submitted('Other', TEST_FLOOR);
    expect(live(id).map((s) => s.role)).toEqual(['tester']);
    expect(live(other)).toEqual([]);
    expect((await state()).lowMemory).toBeUndefined();
  });

  it('workers are never held by memory', async () => {
    const id = ticket('Worker');
    memory.free = () => 0;
    expect((await request('PUT', '/api/runner', { on: true })).status).toBe(200);
    expect(readTicket(db, id).status).toBe('in_progress');
    expect(sessionsOf(id)).toHaveLength(1);
  });

  it('the operator\'s Launch on a waiting ticket starts its tester at once and takes it out of the queue', async () => {
    const id = await submitted('Manual', LOW);
    await expect.poll(() => sessionsOf(id).length, { timeout: 20_000 }).toBe(0);
    expect((await request('POST', `/api/tickets/${id}/launch`)).status).toBe(200);
    expect(live(id).map((s) => s.role)).toEqual(['tester']);
    expect((await state()).lowMemory).toBeUndefined();
  });
});
