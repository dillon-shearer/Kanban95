// ~/.kanban95/projects.json: the daemon lists its own repo on start, and /api/project(s) read and write the list.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { start } from '../src/server.ts';
import { projectsPath } from '../src/settings.ts';

const repo = () => {
  const r = realpathSync.native(mkdtempSync(join(tmpdir(), 'k95-proj-')));
  execFileSync('git', ['init', '-q'], { cwd: r });
  return r;
};
let own: string;
let other: string;
let plain: string;
let srv: Awaited<ReturnType<typeof start>>;
beforeAll(() => {
  [own, other] = [repo(), repo()];
  plain = mkdtempSync(join(tmpdir(), 'k95-plain-'));
});
afterAll(async () => {
  await srv?.close();
  for (const d of [own, other, plain]) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

const file = () => JSON.parse(readFileSync(projectsPath(), 'utf8'));
const call = (method: string, path: string, body?: unknown) =>
  fetch(`http://127.0.0.1:${srv.port}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', cookie: `k95=${srv.secret}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

it('a daemon started on an unlisted repo adds it with the default teal, once; a second repo is appended', async () => {
  srv = await start({ repo: own });
  expect(file()).toEqual([{ path: own, colour: '#008080' }]);
  await srv.close();
  srv = await start({ repo: `${own}/` }); // the same repo spelled differently is still one entry
  expect(file()).toEqual([{ path: own, colour: '#008080' }]);
  await srv.close();
  srv = await start({ repo: other });
  expect(file()).toEqual([{ path: own, colour: '#008080' }, { path: other, colour: '#008080' }]);
});

it('GET /api/project is this board: its path, folder name and colour', async () => {
  const r = await call('GET', '/project');
  expect(await r.json()).toEqual({ path: other, name: basename(other), colour: '#008080' });
});

it('PUT /api/projects writes a valid list whole, and /api/project follows the colour', async () => {
  const value = [{ path: other, colour: '#ff0000' }, { path: own, colour: 200 }];
  const r = await call('PUT', '/projects', { value });
  expect(r.status).toBe(200);
  expect(file()).toEqual(value);
  expect((await (await call('GET', '/projects')).json()).value).toEqual(value);
  expect((await (await call('GET', '/project')).json()).colour).toBe('#ff0000');
});

it('PUT /api/projects refuses a path that is not a git repo, a bad colour, a duplicate or dropping this board, and leaves the file alone', async () => {
  const before = readFileSync(projectsPath(), 'utf8');
  const self = { path: other, colour: '#ff0000' };
  for (const [value, error] of [
    [[self, { path: plain, colour: '#00ff00' }], /not a git repo/],
    [[self, { path: join(plain, 'missing'), colour: '#00ff00' }], /not a git repo/],
    [[self, { path: 'relative/repo', colour: '#00ff00' }], /absolute/],
    [[{ ...self, colour: 'teal; background: url(x)' }], /colour/],
    [[{ ...self, colour: 361 }], /colour/],
    [[self, { path: own, colour: 1 }, { path: `${own}/`, colour: 2 }], /listed twice/],
    [[{ path: own, colour: 1 }], /cannot be removed/],
    ['not a list', /expected array/],
  ] as const) {
    const r = await call('PUT', '/projects', { value });
    expect(r.status, JSON.stringify(value)).toBe(400);
    expect((await r.json()).error).toMatch(error);
    expect(readFileSync(projectsPath(), 'utf8')).toBe(before);
  }
});
