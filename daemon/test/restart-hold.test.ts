// Restart after a merge (docs/LIFECYCLE.md): a stale board holds the backlog, finishes what runs, then restarts itself.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { sessions } from '../src/launcher.ts';
import { runner, tick } from '../src/lifecycle.ts';
import { boot, landed, post, repo, runs, send, setRun, srv, t, ticket, until } from './board.ts';

const state = async () => (await send('GET')('/api/runner')).json();
/** As if the Tauri shell ran this daemon; repo as the install root has no daemon/src, so a restart builds nothing. */
const underShell = () => {
  const shutdown = vi.fn();
  Object.assign(srv.board, { shell: true, shutdown, root: repo });
  return shutdown;
};
const settle = () => new Promise((ok) => setTimeout(ok, 300)); // past restartBoard's 50 ms before shutdown

describe('restart after a merge', { timeout: 60_000 }, () => {
  it('holds the backlog while a ticket finishes its test and merge, restarts once, then the runner launches the backlog', async () => {
    const shutdown = underShell();
    const a = ticket('In flight');
    expect((await post(`/api/tickets/${a}/launch`)).status).toBe(200);
    srv.board.stale = 'daemon';
    const b = ticket('Waiting');
    expect(await setRun(true).then((r) => r.json())).toMatchObject({ on: true, running: [a], left: 1, stale: 'daemon', hold: { finish: 1, restart: 'self' } });
    expect(runs(b)).toEqual([]);
    expect(shutdown).not.toHaveBeenCalled();

    await landed(a);
    expect(runs(a).map((r) => [r.phase, r.outcome])).toEqual([['execute', 'submit'], ['test', 'pass']]);
    expect(t(b).status).toBe('backlog');
    expect(runs(b)).toEqual([]);
    await until(() => shutdown.mock.calls.length, 'the restart');
    await settle();
    expect(shutdown.mock.calls).toEqual([[75]]);
    expect(runner(srv.board).on).toBe(true);

    // What exit 75 leads to: the shell starts the daemon again on the merged code, and the runner carries on.
    await srv.close();
    await boot();
    expect(await state()).not.toHaveProperty('hold');
    await until(() => runs(b).length, 'the backlog ticket to launch after the restart');
  });

  it('a shell change holds the backlog and never restarts by itself', async () => {
    const shutdown = underShell();
    srv.board.stale = 'shell';
    const b = ticket('Waiting');
    expect(await setRun(true).then((r) => r.json())).toMatchObject({ on: true, running: [], left: 1, hold: { finish: 0, restart: 'relaunch' } });
    tick(srv.board);
    await settle();
    expect(shutdown).not.toHaveBeenCalled();
    expect(runs(b)).toEqual([]);
    expect(await state()).toMatchObject({ on: true, hold: { finish: 0, restart: 'relaunch' } });
  });

  it('an open operator terminal alone does not delay the restart', async () => {
    writeFileSync(join(process.env.USERPROFILE!, '.kanban95', 'models.json'), JSON.stringify({
      cli: 'claude', claude: { execute: { model: 'work', effort: 'low' }, test: { model: 'pass', effort: 'low' }, operator: { model: 'hang', effort: 'low' } },
    }));
    expect((await post('/api/operator', { mission: 'Look around' })).status).toBe(201);
    await until(() => [...sessions.values()].some((s) => s.ticketId === null && s.scrollback().includes('FAKE')), 'the operator terminal');
    const shutdown = underShell();
    srv.board.stale = 'daemon';
    expect(await state()).toMatchObject({ on: false, hold: { finish: 0, restart: 'self' } });
    tick(srv.board); // what the merge that set stale does next
    await until(() => shutdown.mock.calls.length, 'the restart');
    await settle();
    expect(shutdown.mock.calls).toEqual([[75]]);
    expect(runner(srv.board).on).toBe(false); // a runner that was off stays off
  });
});
