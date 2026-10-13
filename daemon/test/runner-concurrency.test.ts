import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runner } from '../src/lifecycle.ts';
import { start } from '../src/server.ts';
import './memory.ts';
import { readConfig, writeConfig } from '../src/settings.ts';
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

type Srv = Awaited<ReturnType<typeof start>>;
const bin = mkdtempSync(join(tmpdir(), 'k95-bin-'));
const PATH0 = process.env.PATH;
const repos: string[] = [];
const boards: Srv[] = [];

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'k95-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Op Erator');
  git('config', 'user.email', 'op@example.com');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git('add', 'a.txt');
  git('commit', '-qm', 'init');
  repos.push(repo);
  return repo;
}
const request = (srv: Srv, method: string, path: string, body?: unknown) => fetch(`http://127.0.0.1:${srv.port}${path}`, {
  method, headers: { 'content-type': 'application/json', cookie: `k95=${srv.secret}` }, body: body === undefined ? undefined : JSON.stringify(body),
});
const tickets = (srv: Srv, n: number) => Array.from({ length: n }, (_, i) => Number(srv.db.prepare('INSERT INTO tickets (title) VALUES (?)').run(`T${i}`).lastInsertRowid));
const run = async (srv: Srv) => (await request(srv, 'PUT', '/api/runner', { on: true })).json();

beforeAll(() => {
  writeFileSync(join(bin, 'fake.mjs'), '');
  fakeCli(bin, 'claude', 'fake.mjs');
  process.env.PATH = bin + delimiter + PATH0;
  mkdirSync(process.env.KANBAN95_HOME!, { recursive: true });
  writeConfig('models', { cli: 'claude', claude: { execute: { model: 'hang', effort: 'low' }, test: { model: 'hang', effort: 'low' } } });
  writeConfig('settings', { concurrency: 3 });
});
afterAll(async () => {
  for (const b of boards) await b.close();
  process.env.PATH = PATH0;
  for (const r of [...repos, bin]) removeTemp(r);
}, 60_000);

describe('runner concurrency', { timeout: 60_000 }, () => {
  it('settings.json takes 1 to 10, 3 by default, and refuses 0 and 11', () => {
    expect(readConfig('settings', makeRepo()).concurrency).toBe(3);
    for (const n of [1, 10]) expect(writeConfig('settings', { concurrency: n }).concurrency).toBe(n);
    for (const n of [0, 11, 2.5]) expect(() => writeConfig('settings', { concurrency: n })).toThrow(/concurrency/);
    writeConfig('settings', { concurrency: 3 });
  });

  it('a project copy with 1 keeps one running on its repo while the global 3 runs three on a repo with no copy', async () => {
    const [a, b] = [makeRepo(), makeRepo()];
    writeConfig('settings', { concurrency: 1 }, a);
    const [srvA, srvB] = [await start({ repo: a }), await start({ repo: b })];
    boards.push(srvA, srvB);
    const onA = tickets(srvA, 4);
    const onB = tickets(srvB, 4);
    expect(await run(srvA)).toMatchObject({ concurrency: 1, running: onA.slice(0, 1) });
    expect(await run(srvB)).toMatchObject({ concurrency: 3, running: onB.slice(0, 3) });
    const live = (srv: Srv) => (srv.db.prepare("SELECT count(*) AS n FROM tickets WHERE status = 'in_progress'").get() as { n: number }).n;
    expect([live(srvA), live(srvB)]).toEqual([1, 3]);
  });

  it('a concurrency left in an old runner.json is ignored: the value comes from settings.json', async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, '.kanban95'), { recursive: true });
    writeFileSync(join(repo, '.kanban95', 'runner.json'), JSON.stringify({ on: false, concurrency: 1 }));
    const srv = await start({ repo });
    boards.push(srv);
    expect(runner(srv.board)).toEqual({ on: false });
    expect(await (await request(srv, 'GET', '/api/runner')).json()).toMatchObject({ concurrency: 3 });
    const ids = tickets(srv, 4);
    expect(await run(srv)).toMatchObject({ concurrency: 3, running: ids.slice(0, 3) });
    expect((await request(srv, 'PUT', '/api/runner', { concurrency: 1 })).status).toBe(400);
  });
});
