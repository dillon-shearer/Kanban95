import './home.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { entryPath, register } from '../src/boards.ts';
import { start } from '../src/server.ts';
import { boardHome, normal, pointerPath } from '../src/settings.ts';
import { removeTemp } from './home.ts';

let srv: Awaited<ReturnType<typeof start>>;
const temps: string[] = [];
const sleepers: ChildProcess[] = [];
const temp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  temps.push(d);
  return d;
};
const fake = (repo: string, shell: number) => {
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  sleepers.push(c);
  mkdirSync(join(boardHome(), 'running'), { recursive: true });
  writeFileSync(entryPath(c.pid!), JSON.stringify({ pid: c.pid, repo: normal(repo), port: 1, started: '', shell, agents: 0, attention: 0 }));
};

beforeAll(async () => {
  srv = await start({ repo: temp('k95-') });
  srv.board.shell = true;
  srv.board.shellId = 123;
  srv.board.shutdown = vi.fn();
  register(srv.board.repo, srv.port, 123);
}, 30_000);
afterAll(async () => {
  rmSync(pointerPath(), { force: true });
  for (const c of sleepers) {
    rmSync(entryPath(c.pid!), { force: true });
    c.kill();
  }
  await srv.close();
  temps.splice(0).forEach(removeTemp);
});

describe('PUT /api/data-folder with several boards in one shell', () => {
  it('tells the shell to restart every other board it hosts, and no board of another shell', async () => {
    const [sibling, stranger] = [temp('k95-sibling-'), temp('k95-stranger-')];
    fake(sibling, 123);
    fake(stranger, 456);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const r = await fetch(`http://127.0.0.1:${srv.port}/api/data-folder`, {
        method: 'PUT', headers: { cookie: `k95=${srv.secret}`, 'content-type': 'application/json' }, body: JSON.stringify({ path: temp('k95-data-') }),
      });
      expect(r.status).toBe(202);
      const lines = out.mock.calls.map(([l]) => String(l)).filter((l) => l.startsWith('KANBAN95 '));
      expect(lines).toEqual([`KANBAN95 restart=${normal(sibling)}\n`]);
    } finally {
      out.mockRestore();
    }
    await new Promise((ok) => setTimeout(ok, 100));
    expect(srv.board.shutdown).toHaveBeenCalledWith(75);
  });
});
