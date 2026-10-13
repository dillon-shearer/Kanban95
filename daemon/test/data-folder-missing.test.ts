import './home.ts';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { start, startSetup } from '../src/server.ts';
import { notFound } from '../src/setup.ts';
import { addProject, localHome, normal, pointerPath, same } from '../src/settings.ts';
import { removeTemp } from './home.ts';

const tmp = mkdtempSync(join(tmpdir(), 'k95-lost-'));
const lost = join(tmp, 'carried');
const other = join(tmp, 'other');
const first = join(tmp, 'first');
const second = join(tmp, 'second');
for (const d of [first, second]) mkdirSync(d);
const servers: { close: () => Promise<void> }[] = [];
afterAll(async () => {
  for (const s of servers) await s.close();
  removeTemp(tmp);
});

const point = (dir: string) => {
  mkdirSync(localHome(), { recursive: true });
  writeFileSync(pointerPath(), dir + '\n');
};
const list = (dir: string, ...repos: string[]) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'projects.json'), JSON.stringify(repos.map((path) => ({ path, colour: '#008080' }))));
};

let done: (string | undefined)[];
let call: (path: string, init?: RequestInit) => Promise<Response>;
beforeEach(async () => {
  point(lost);
  done = [];
  const srv = await startSetup({ done: (repo) => done.push(repo) });
  servers.push(srv);
  call = (path, init) => fetch(`http://127.0.0.1:${srv.port}${path}`, { ...init, headers: { Cookie: `k95=${srv.secret}`, 'Content-Type': 'application/json' } });
});

const boots = async (repo: string | undefined) => {
  const board = await start({ repo });
  try {
    expect(same(board.board.repo, normal(repo!))).toBe(true);
  } finally {
    await board.close();
  }
};

it('serves the not-found page naming the missing folder, and nothing recreates it', async () => {
  const r = await call('/');
  expect(r.status).toBe(200);
  const html = await r.text();
  expect(html).toContain(notFound(lost));
  expect(html).toContain(`value="${lost}"`);
  expect(html).toMatch(/<button id="retry" type="button">/);
  expect(html).toMatch(/<div id="project-row" class="field-row-stacked" hidden>/);
  expect(notFound('X')).not.toMatch(/drive|disk|volume/i);

  const retry = await call('/api/setup/retry', { method: 'POST', body: '{}' });
  expect(retry.status).toBe(400);
  expect((await retry.json()).error).toBe(notFound(lost));
  expect(() => addProject(first)).toThrow(/was not found/);
  expect(() => start({ repo: first })).toThrow(/was not found/);
  expect(existsSync(join(first, '.kanban95'))).toBe(false);
  expect(done).toEqual([]);
  expect(existsSync(lost)).toBe(false);
});

it('Retry after the folder is back starts the board on its first listed project', async () => {
  list(lost, first, second);
  const r = await call('/api/setup/retry', { method: 'POST', body: '{}' });
  expect(r.status).toBe(200);
  expect(done).toEqual([normal(first)]);
  await boots(done[0]);
}, 60_000);

it('Next with another existing folder points there and starts on that folder\'s first listed project, without asking for one', async () => {
  removeTemp(lost);
  list(other, second, first);
  const r = await call('/api/setup', { method: 'POST', body: JSON.stringify({ data: other }) });
  expect(r.status).toBe(200);
  expect(readFileSync(pointerPath(), 'utf8').trim()).toBe(normal(other));
  expect(done).toEqual([normal(second)]);
  expect(existsSync(lost)).toBe(false);
  await boots(done[0]);
}, 60_000);
