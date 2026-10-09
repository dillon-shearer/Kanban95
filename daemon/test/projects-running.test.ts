// Start → Projects: the running registry ~/.kanban95/running/<pid>.json, and /api/projects/open and /focus.
import './home.ts';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { boards, entryPath } from '../src/boards.ts';
import { start } from '../src/server.ts';
import { writeProjects } from '../src/settings.ts';

const repo = () => {
  const r = realpathSync.native(mkdtempSync(join(tmpdir(), 'k95-run-')));
  execFileSync('git', ['init', '-q'], { cwd: r });
  return r;
};
let own: string;
let other: string;
let unlisted: string;
let srv: Awaited<ReturnType<typeof start>>;
const started: [string, string[]][] = [];
boards.start = async (cmd, args) => void started.push([cmd, args]);

beforeAll(async () => {
  [own, other, unlisted] = [repo(), repo(), repo()];
  srv = await start({ repo: own });
  writeProjects([{ path: own, colour: '#008080' }, { path: other, colour: 120 }], own);
});
afterAll(async () => {
  await srv?.close();
  for (const d of [own, other, unlisted]) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

const call = (method: string, path: string, body?: unknown) =>
  fetch(`http://127.0.0.1:${srv.port}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', cookie: `k95=${srv.secret}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const running = async () => (await (await call('GET', '/projects')).json()).running;
/** A pid that was real a moment ago and is not any more. */
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid!;
const fake = (pid: number, repo: string) => writeFileSync(entryPath(pid), JSON.stringify({ pid, repo, port: 1, started: new Date().toISOString() }));

it('a started daemon has a running entry naming its repo and port, and close() removes it', async () => {
  const e = JSON.parse(readFileSync(entryPath(process.pid), 'utf8'));
  expect(e).toMatchObject({ pid: process.pid, repo: own, port: srv.port });
  expect(Date.parse(e.started)).not.toBeNaN();
  await srv.close();
  expect(existsSync(entryPath(process.pid))).toBe(false);
  srv = await start({ repo: own });
});

it('GET /api/projects marks a project running only while a live pid serves it, and drops a dead entry', async () => {
  expect(await running()).toEqual({ [own]: true, [other]: false });
  const dead = deadPid();
  fake(dead, other);
  expect(await running()).toEqual({ [own]: true, [other]: false });
  expect(existsSync(entryPath(dead))).toBe(false);
  fake(process.ppid, other); // vitest's own parent: alive, and not this daemon
  expect(await running()).toEqual({ [own]: true, [other]: true });
  rmSync(entryPath(process.ppid));
});

it('open and focus refuse a path not in projects.json, or no path, with 400 and start nothing', async () => {
  for (const verb of ['open', 'focus']) {
    for (const body of [{ path: unlisted }, {}, { path: 'relative' }]) {
      const r = await call('POST', `/projects/${verb}`, body);
      expect(r.status).toBe(400);
    }
  }
  expect(started).toEqual([]);
});

/** A fake install root: a repo checkout (daemon/src, a built shell) or the installer's app/ beside the exe. */
const fakeRoot = (files: string[]) => {
  const d = mkdtempSync(join(tmpdir(), 'k95-root-'));
  for (const f of files) {
    mkdirSync(dirname(join(d, f)), { recursive: true });
    writeFileSync(join(d, f), '');
  }
  return d;
};

it('open starts the board on a listed project that is not running, from a checkout or an install, and refuses one that is', async () => {
  const win = process.platform === 'win32';
  const checkout = fakeRoot(['daemon/src/server.ts', 'shell/target/debug/kanban95-shell.exe', 'Kanban95.command']);
  const install = fakeRoot(['Kanban95.exe', 'uninstall.exe', 'app/daemon/dist/server.js']);
  try {
    srv.board.root = checkout;
    const r = await call('POST', '/projects/open', { path: `${other}/` }); // spelled differently, still the listed project
    expect(r.status).toBe(202);
    expect(started.pop()).toEqual(win ? [join(checkout, 'shell', 'target', 'debug', 'kanban95-shell.exe'), [other]] : ['/bin/bash', [join(checkout, 'Kanban95.command'), other]]);
    if (win) {
      srv.board.root = join(install, 'app');
      expect((await call('POST', '/projects/open', { path: other })).status).toBe(202);
      expect(started.pop()).toEqual([join(install, 'Kanban95.exe'), [other]]);
      srv.board.root = fakeRoot(['daemon/src/server.ts']); // a checkout whose shell was never built
      const none = await call('POST', '/projects/open', { path: other });
      expect(none.status).toBe(409);
      expect((await none.json()).error).toMatch(/Kanban95\.cmd/);
      rmSync(srv.board.root, { recursive: true });
    }
    expect((await call('POST', '/projects/open', { path: own })).status).toBe(409); // this board: running
    expect(started).toEqual([]);
  } finally {
    srv.board.root = undefined;
    for (const d of [checkout, install]) rmSync(d, { recursive: true, force: true });
  }
});

it('focus refuses a listed project that is not running with 409', async () => {
  const r = await call('POST', '/projects/focus', { path: other });
  expect(r.status).toBe(409);
  expect((await r.json()).error).toMatch(/not running/);
});
