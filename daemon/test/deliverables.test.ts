import './home.ts';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { deliverableFolders, recordDeliverables } from '../src/deliverables.ts';
import { start } from '../src/server.ts';

vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>();
  return { ...real, spawn: vi.fn(() => ({ once() { return this; }, unref() {} })) };
});

let repo: string;
let srv: Awaited<ReturnType<typeof start>>;
const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
const commit = (...files: string[]) => {
  const from = git('rev-parse', 'HEAD');
  for (const f of files) {
    mkdirSync(dirname(join(repo, f)), { recursive: true });
    writeFileSync(join(repo, f), `${f} ${Math.random()}\n`);
  }
  git('add', '-A');
  git('commit', '-qm', 'change');
  return from;
};
const call = (method: string, path: string, body?: unknown) =>
  fetch(`http://127.0.0.1:${srv.port}${path}`, { method, headers: { 'content-type': 'application/json', cookie: `k95=${srv.secret}` }, body: body === undefined ? undefined : JSON.stringify(body) });
const list = async () => (await (await call('GET', '/api/deliverables')).json()) as { folder: string; ticket_id: number; title: string }[];

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'k95-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  git('config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'README.md'), 'x\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  srv = await start({ repo });
});
afterAll(async () => {
  await srv.close();
  rmSync(repo, { recursive: true, force: true });
});

describe('deliverableFolders', () => {
  it('cuts to two segments and skips root files and dotfolders', () => {
    expect(deliverableFolders(['README.md', '.github/ci.yml', 'a/.cache/x', 'docs/x.md', 'als-tdi/r2/index/a.html', 'als-tdi/r2/b.txt', 'r/q3/x.csv']))
      .toEqual(['als-tdi/r2', 'docs', 'r/q3']);
  });
});

describe('deliverables', () => {
  it('one entry per folder: a second merge replaces it, two folders give two, root and dotfolder changes give none, dismiss removes it', async () => {
    expect(recordDeliverables(srv.db, repo, commit('notes.txt', '.kanban95x/a.txt'), 'HEAD', 1, 'Root only')).toEqual([]);
    expect(await list()).toEqual([]);

    recordDeliverables(srv.db, repo, commit('topic/one/a.txt'), 'HEAD', 1, 'First');
    expect(await list()).toMatchObject([{ folder: 'topic/one', ticket_id: 1, title: 'First' }]);

    recordDeliverables(srv.db, repo, commit('topic/one/b.txt', 'topic/two/c/d.txt'), 'HEAD', 2, 'Second');
    expect((await list()).sort((a, b) => a.folder.localeCompare(b.folder))).toMatchObject([
      { folder: 'topic/one', ticket_id: 2, title: 'Second' },
      { folder: 'topic/two', ticket_id: 2, title: 'Second' },
    ]);

    expect((await call('POST', '/api/deliverables/open', { folder: 'topic/two' })).status).toBe(204);
    const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    expect(vi.mocked(spawn)).toHaveBeenLastCalledWith(cmd, [resolve(repo, 'topic/two')], expect.anything());
    expect((await call('POST', '/api/deliverables/open', { folder: '..' })).status).toBe(404);
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);

    expect((await call('DELETE', '/api/deliverables', { folder: 'topic/one' })).status).toBe(204);
    expect((await call('DELETE', '/api/deliverables', { folder: 'topic/one' })).status).toBe(404);
    expect((await list()).map((d) => d.folder)).toEqual(['topic/two']);

    recordDeliverables(srv.db, repo, commit('topic/one/e.txt'), 'HEAD', 3, 'Third');
    expect((await list()).map((d) => [d.folder, d.ticket_id])).toContainEqual(['topic/one', 3]);
  });
});
