// The runner's memory hold (docs/LIFECYCLE.md → The runner → Memory hold), with the free-memory source stubbed and a fake
// `claude` that stays up doing nothing.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readTicket } from '../src/api.ts';
import { sessionsOf } from '../src/launcher.ts';
import { memory, runner, tick } from '../src/lifecycle.ts';
import { start } from '../src/server.ts';

const bin = mkdtempSync(join(tmpdir(), 'k95-bin-'));
const PATH0 = process.env.PATH;
const FREE0 = memory.free;
const LOW = 512 * 1024 ** 2; // under any floor: the floor is at least 2 GiB
beforeAll(() => {
  writeFileSync(join(bin, 'fake.mjs'), "console.log('FAKE'); process.stdin.resume();\n");
  writeFileSync(join(bin, 'claude.cmd'), `@node "%~dp0fake.mjs" %*\r\n`);
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
const runs = (id: number) => db.prepare('SELECT id FROM runs WHERE ticket_id = ?').all(id);
const request = (method: string, path: string, body?: unknown) => fetch(`http://127.0.0.1:${srv.port}${path}`, {
  method, headers: { 'content-type': 'application/json', cookie: `k95=${srv.secret}` }, body: body === undefined ? undefined : JSON.stringify(body),
});
const state = async () => (await request('GET', '/api/runner')).json();
const setRun = async (on: boolean) => (await request('PUT', '/api/runner', { on })).json();

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
  memory.free = FREE0;
  await srv.close();
  rmSync(repo, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 });
});

describe('memory hold', { timeout: 60_000 }, () => {
  it('launches nothing while free memory is under the floor and reports the hold; the next tick above it launches', async () => {
    const id = ticket('Candidate');
    memory.free = () => LOW;
    const held = await setRun(true);
    expect(held).toMatchObject({ on: true, running: [], left: 1 });
    expect(held.lowMemory.free).toBe(LOW);
    expect(held.lowMemory.floor).toBeGreaterThanOrEqual(2 * 1024 ** 3);
    expect(runs(id)).toEqual([]);
    expect(readTicket(db, id).status).toBe('backlog');
    expect(srv.board.memoryWait).toBeDefined(); // the 30 s recheck is armed

    memory.free = () => Number.MAX_SAFE_INTEGER;
    tick(srv.board);
    expect(readTicket(db, id).status).toBe('in_progress');
    expect(sessionsOf(id)).toHaveLength(1);
    const after = await state();
    expect(after).toMatchObject({ on: true, running: [id] });
    expect(after.lowMemory).toBeUndefined();
  });

  it('the operator\'s own Launch is not held', async () => {
    const [a, b] = [ticket('Manual'), ticket('Other')];
    memory.free = () => LOW;
    await setRun(true);
    expect((await request('POST', `/api/tickets/${a}/launch`)).status).toBe(200);
    expect(sessionsOf(a)).toHaveLength(1);
    expect(runs(b)).toEqual([]); // the tick after that launch still holds the runner's own
    expect((await state()).lowMemory.free).toBe(LOW);
  });

  it('keeps running tickets running and the runner on during a hold', async () => {
    const a = ticket('Running');
    await request('PUT', '/api/config/settings?scope=project', { concurrency: 1 });
    expect((await setRun(true)).running).toEqual([a]);
    await request('PUT', '/api/config/settings?scope=project', { concurrency: 3 }); // room for more, but memory is tight
    const b = ticket('Waiting');
    memory.free = () => LOW;
    tick(srv.board);
    expect(runs(b)).toEqual([]);
    expect(sessionsOf(a)).toHaveLength(1);
    expect(readTicket(db, a).status).toBe('in_progress');
    expect(runner(srv.board).on).toBe(true);
    expect(await state()).toMatchObject({ on: true, running: [a], lowMemory: { free: LOW } });
  });
});
