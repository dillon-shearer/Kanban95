import './home.ts';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { worktreePath } from '../src/git.ts';
import { git, models, notes, post, repo, runs, send, srv, t, ticket, until } from './board.ts';

const del = send('DELETE');
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('worktree_setup terminal', { timeout: 60_000 }, () => {
  const wt = (id: number, file: string) => join(worktreePath(repo, id), file);
  const marker = (id: number) => resolve(worktreePath(repo, id), execFileSync('git', ['rev-parse', '--git-path', 'kanban95-setup-done'], { cwd: worktreePath(repo, id), encoding: 'utf8' }).trim());
  const pids = (id: number) => existsSync(wt(id, 'pids.log')) ? readFileSync(wt(id, 'pids.log'), 'utf8').split(/\s+/).filter(Boolean).map(Number) : [];
  const setups = async (): Promise<{ ticket_id: number }[]> => (await (await send('GET')('/api/runner')).json()).setup;
  let started: number[] = [];

  const watch = (id: number) => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/pty/setup/${id}`, { origin: `http://127.0.0.1:${srv.port}`, headers: { cookie: `k95=${srv.secret}` } });
    const term = { text: '', closed: false, ws };
    ws.on('message', (d) => (term.text += String(d)));
    ws.on('close', () => (term.closed = true));
    return term;
  };

  beforeEach(() => {
    writeFileSync(join(repo, 'setup.mjs'), `import { appendFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
const g = spawn(process.execPath, ['-e', "setInterval(() => require('fs').existsSync('go') && process.exit(), 25)"], { detached: process.platform === 'win32', stdio: 'ignore' });
appendFileSync('pids.log', process.pid + ' ' + g.pid + '\\n');
console.log('setup step one');
while (!existsSync('go')) await new Promise((r) => setTimeout(r, 25));
if (existsSync('fail')) {
  console.log('setup broke');
  process.exit(1);
}
console.log('setup finished');
`);
    git('add', 'setup.mjs');
    git('commit', '-qm', 'Add setup script');
    writeFileSync(join(repo, '.kanban95', 'config.json'), JSON.stringify({ worktree_setup: 'node setup.mjs' }));
    models({ execute: 'hang' });
    started = [];
  });
  afterEach(() => {
    for (const p of started) if (alive(p)) process.kill(p);
  });

  const launched = async (title: string) => {
    const id = ticket(title);
    expect((await post(`/api/tickets/${id}/launch`)).status).toBe(200);
    const term = watch(id);
    await until(() => term.text.includes('setup step one'), 'the setup output on the terminal');
    started = pids(id);
    return { id, term };
  };

  it('streams the setup on the ticket terminal before it ends, then the agent on the same socket below it', async () => {
    const { id, term } = await launched('Setup then agent');
    expect(term.text).toContain('> node setup.mjs\r\n');
    expect((await setups()).map((s) => s.ticket_id)).toEqual([id]);
    expect(runs(id)).toEqual([]);

    term.ws.send(JSON.stringify({ data: 'typed during setup\r' }));
    writeFileSync(wt(id, 'go'), '');
    await until(() => term.text.includes('FAKE hang'), 'the agent output on the same terminal');
    expect(term.closed).toBe(false);
    expect(term.text.indexOf('setup finished')).toBeGreaterThan(term.text.indexOf('setup step one'));
    expect(term.text.indexOf('FAKE hang')).toBeGreaterThan(term.text.indexOf('setup finished'));
    expect(term.text).not.toContain('typed during setup');
    expect(runs(id)).toHaveLength(1);
    expect(existsSync(marker(id))).toBe(true);
    term.ws.close();
  });

  it('a failing setup leaves its output on the terminal, closes it and flags the ticket', async () => {
    const { id, term } = await launched('Setup fails');
    writeFileSync(wt(id, 'fail'), '');
    writeFileSync(wt(id, 'go'), '');
    await until(() => term.closed, 'the terminal to end');
    expect(term.text).toContain('setup step one');
    expect(term.text).toContain('setup broke');
    await until(() => t(id).flags.needs_human, 'the flag');
    expect(notes(id, 'failure')).toEqual([expect.stringMatching(/^launch failed: worktree_setup "node setup.mjs" failed \(1\)/)]);
    expect(runs(id)).toEqual([]);
  });

  it('ending the terminal during setup kills the setup tree, writes no marker and flags the ticket', async () => {
    const { id, term } = await launched('Setup ended');
    expect(started).toHaveLength(2);
    expect((await del(`/api/tickets/${id}/setup`)).status).toBe(204);
    await until(() => !started.some(alive), 'the setup tree to be gone', 5_000);
    await until(() => term.closed, 'the terminal to end');
    expect(existsSync(marker(id))).toBe(false);
    expect(t(id).flags.needs_human).toBe(true);
    expect(notes(id, 'failure')).toEqual([expect.stringMatching(/^ended by the operator from the terminal window/)]);
    expect(await setups()).toEqual([]);
    await new Promise((r) => setTimeout(r, 500));
    expect(runs(id)).toEqual([]);
    expect((await del(`/api/tickets/${id}/setup`)).status).toBe(404);
  });
});
