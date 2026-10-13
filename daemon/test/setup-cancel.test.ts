import './home.ts';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { worktreePath } from '../src/git.ts';
import { boot, db, git, models, notes, patch, post, repo, runs, srv, ticket, until } from './board.ts';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('worktree_setup cancellation', { timeout: 60_000 }, () => {
  const wt = (id: number, file: string) => join(worktreePath(repo, id), file);
  const lines = (id: number, file: string) => existsSync(wt(id, file)) ? readFileSync(wt(id, file), 'utf8').split('\n').filter(Boolean) : [];
  const pids = (id: number) => lines(id, 'pids.log').flatMap((l) => l.split(' ').map(Number));
  let started: number[] = [];

  beforeEach(() => {
    writeFileSync(join(repo, 'setup.mjs'), `import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const before = existsSync('pids.log') ? readFileSync('pids.log', 'utf8').split(/\\s+/).filter(Boolean).map(Number) : [];
const end = Date.now() + 2000;
while (before.some(alive) && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
appendFileSync('overlap.log', ['run', ...before.filter(alive)].join(' ') + '\\n');
const g = spawn(process.execPath, ['-e', "setInterval(() => require('fs').existsSync('go') && process.exit(), 25)"], { detached: process.platform === 'win32', stdio: 'ignore' });
appendFileSync('pids.log', process.pid + ' ' + g.pid + '\\n');
while (!existsSync('go')) await new Promise((r) => setTimeout(r, 25));
`);
    git('add', 'setup.mjs');
    git('commit', '-qm', 'Add setup script');
    writeFileSync(join(repo, '.kanban95', 'config.json'), JSON.stringify({ worktree_setup: 'node setup.mjs' }));
    models({ execute: 'silent' });
    started = [];
  });
  afterEach(() => {
    for (const p of started) if (alive(p)) process.kill(p);
  });

  const reaped = (ps: number[]) => until(() => !ps.some(alive), 'the killed setup tree to be reaped', 2_000);
  const blocked = async (id: number, n: number) => {
    await until(() => pids(id).length === 2 * n, `setup ${n} and its grandchild`);
    started = pids(id);
  };

  it('Restart kills the blocked setup tree before the new setup runs; only the new launch starts, with its settings', async () => {
    const id = ticket('Restarted in setup', { model: 'silent' });
    expect((await post(`/api/tickets/${id}/launch`)).status).toBe(200);
    await blocked(id, 1);
    const first = pids(id);
    db.prepare("UPDATE tickets SET model = 'hang' WHERE id = ?").run(id);
    expect((await post(`/api/tickets/${id}/restart`)).status).toBe(200);
    await blocked(id, 2);
    await reaped(first);
    expect(lines(id, 'overlap.log')).toEqual(['run', 'run']);
    writeFileSync(wt(id, 'go'), '');
    await until(() => runs(id).length === 1, 'the agent after setup');
    await new Promise((r) => setTimeout(r, 1000));
    expect(runs(id).map((r) => r.model)).toEqual(['hang']);
    expect(notes(id, 'failure').filter((n) => n.startsWith('launch failed'))).toEqual([]);
  });

  it('Reset then Launch kills the blocked setup tree first, and the old setup flags nothing', async () => {
    const id = ticket('Reset in setup', { model: 'hang' });
    expect((await post(`/api/tickets/${id}/launch`)).status).toBe(200);
    await blocked(id, 1);
    const first = pids(id);
    expect((await patch(`/api/tickets/${id}`, { status: 'backlog' })).status).toBe(200);
    expect((await post(`/api/tickets/${id}/launch`)).status).toBe(200);
    await blocked(id, 2);
    await reaped(first);
    expect(lines(id, 'overlap.log')).toEqual(['run', 'run']);
    writeFileSync(wt(id, 'go'), '');
    await until(() => runs(id).length === 1, 'the agent after setup');
    await new Promise((r) => setTimeout(r, 1000));
    expect(runs(id)).toHaveLength(1);
    expect(notes(id, 'failure')).toEqual([]);
  });

  it('closing the daemon kills a blocked setup tree before close resolves', async () => {
    const id = ticket('Closed in setup');
    expect((await post(`/api/tickets/${id}/launch`)).status).toBe(200);
    await blocked(id, 1);
    await srv.close();
    await reaped(started);
    await boot();
  });
});
