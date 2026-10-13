// After the merge on a fake `claude` (board.ts): five tickets through one queue, housekeeping tickets, push to the upstream.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { worktreePath, worktreesRoot } from '../src/git.ts';
import { sessionsOf } from '../src/launcher.ts';
import { boot, db, git, landed, launchTogether, notes, post, repo, runs, send, sounds, srv, t, ticket, until } from './board.ts';

describe('lifecycle', { timeout: 60_000 }, () => {
  it('five tickets at once: five ptys, one merge queue, every branch lands in a straight line of merges', async () => {
    const ids = [1, 2, 3, 4, 5].map((i) => ticket(`Add file ${i}`));
    await launchTogether(5);
    expect(ids.map((id) => sessionsOf(id).length)).toEqual([1, 1, 1, 1, 1]);
    for (const id of ids) await landed(id);
    expect(ids.map((id) => t(id).flags.needs_human)).toEqual([false, false, false, false, false]);
    expect(git('log', '--first-parent', '--merges', '--format=%s').split('\n').sort()).toEqual(ids.map((i) => `Add file ${i}`));
    expect(git('ls-tree', '--name-only', 'HEAD').split('\n').sort()).toEqual(['a.txt', 't-1.txt', 't-2.txt', 't-3.txt', 't-4.txt', 't-5.txt']);
    expect(readdirSync(worktreesRoot(repo))).toEqual([]);
  });

  it('the 10th merged ticket creates exactly one housekeeping ticket, left in Backlog while the runner is off; the 11th does not', async () => {
    for (let i = 0; i < 9; i++) ticket(`Old ${i}`, { status: 'done', merged_at: '2026-01-01T00:00:00.000Z' });
    const tenth = ticket('Tenth');
    await post(`/api/tickets/${tenth}/launch`);
    await landed(tenth);
    const hk = () => db.prepare("SELECT id FROM tickets WHERE template = 'housekeeping'").all() as { id: number }[];
    expect(hk()).toHaveLength(1);
    expect(t(hk()[0].id).status).toBe('backlog');
    expect(runs(hk()[0].id)).toEqual([]);
    await post(`/api/tickets/${hk()[0].id}/launch`);
    await landed(hk()[0].id);
    expect(runs(hk()[0].id)[0].prompt_rendered).toMatch(/^# Housekeeping/);
    const eleventh = ticket('Eleventh');
    await post(`/api/tickets/${eleventh}/launch`);
    await landed(eleventh);
    expect(hk()).toHaveLength(1);
  });

  it('settings.json housekeeping: switched off files none; `every` sets the interval', async () => {
    const settings = join(process.env.KANBAN95_HOME!, 'settings.json');
    const hk = () => db.prepare("SELECT count(*) AS n FROM tickets WHERE template = 'housekeeping'").get() as { n: number };
    try {
      writeFileSync(settings, JSON.stringify({ housekeeping: { auto: false, every: 1 } }));
      const off = ticket('Off');
      await post(`/api/tickets/${off}/launch`);
      await landed(off);
      expect(hk().n).toBe(0);
      writeFileSync(settings, JSON.stringify({ housekeeping: { every: 2 } }));
      const second = ticket('Second');
      await post(`/api/tickets/${second}/launch`);
      await landed(second);
      expect(hk().n).toBe(1);
    } finally {
      rmSync(settings, { force: true });
    }
  });
});

describe('push after merge', { timeout: 60_000 }, () => {
  let bare: string;
  const remote = (...a: string[]) => execFileSync('git', a, { cwd: bare, encoding: 'utf8' }).trim();
  const settings = () => join(process.env.KANBAN95_HOME!, 'settings.json');
  const runnerState = async () => (await send('GET')('/api/runner')).json();
  const commitOnBase = (f: string) => {
    writeFileSync(join(repo, `${f}.txt`), `${f}\n`);
    git('add', `${f}.txt`);
    git('commit', '-qm', `Add ${f} on the base`);
  };
  const refuse = () => writeFileSync(join(bare, 'hooks', 'pre-receive'), '#!/bin/sh\necho "denied by the remote" >&2\nexit 1\n');
  const restart = async () => {
    await srv.close();
    await boot();
  };
  beforeEach(() => {
    bare = mkdtempSync(join(tmpdir(), 'k95-remote-'));
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: bare });
    git('remote', 'add', 'origin', bare);
    git('push', '-q', '-u', 'origin', 'main');
  });
  afterEach(() => {
    rmSync(settings(), { force: true });
    rmSync(bare, { recursive: true, force: true, maxRetries: 5 });
  });

  it('pushes the landed merge, and an unpushed commit made on the base before it, by the time the ticket is merged', async () => {
    commitOnBase('b');
    const backlog = git('rev-parse', 'HEAD');
    const id = ticket('Add and push');
    await post(`/api/tickets/${id}/launch`);
    await until(() => t(id).merged_at, 'merged_at');
    expect(remote('rev-parse', 'main')).toBe(git('rev-parse', 'HEAD')); // pushed before merged_at was written
    expect(remote('log', '-1', '--format=%s', 'main')).toBe('Add and push');
    expect(remote('merge-base', '--is-ancestor', backlog, 'main')).toBe('');
    await landed(id);
  });

  it("a rejected push keeps the merge, leaves merged_at unset, flags with git's message and a chord; Retry merge pushes again", async () => {
    refuse();
    const before = remote('rev-parse', 'main');
    const id = ticket('Add, push refused');
    await post(`/api/tickets/${id}/launch`);
    await until(() => t(id).flags.needs_human, 'the flag');
    expect(t(id)).toMatchObject({ status: 'done', merged_at: null });
    expect(git('log', '-1', '--format=%s', 'HEAD')).toBe('Add, push refused'); // the merge stays in the base
    expect(remote('rev-parse', 'main')).toBe(before);
    expect(existsSync(worktreePath(repo, id))).toBe(true);
    expect(notes(id, 'failure')).toEqual([expect.stringMatching(/^merged into main, but git push to origin failed, so the ticket is not closed:\n[^]*denied by the remote[^]*\nTo resolve: .*Retry merge; it pushes again\.$/)]);
    expect(sounds).toEqual([{ sound: 'done', ticket: id }, { sound: 'chord', ticket: id }]);

    rmSync(join(bare, 'hooks', 'pre-receive'));
    expect((await post(`/api/tickets/${id}/merge`)).status).toBe(200);
    await landed(id);
    expect(t(id).flags.needs_human).toBe(false);
    expect(remote('rev-parse', 'main')).toBe(git('rev-parse', 'HEAD'));
    expect(git('log', '--merges', '--format=%s').split('\n')).toEqual(['Add, push refused']); // merged once, not again on retry
  });

  it('a base with no upstream merges and closes the ticket without pushing', async () => {
    git('branch', '--unset-upstream');
    const before = remote('rev-parse', 'main');
    const id = ticket('Add, no upstream');
    await post(`/api/tickets/${id}/launch`);
    await landed(id);
    expect(t(id).flags.needs_human).toBe(false);
    expect(remote('rev-parse', 'main')).toBe(before);
  });

  it('with push_after_merge off nothing is pushed and the ticket closes as before', async () => {
    writeFileSync(settings(), JSON.stringify({ push_after_merge: false }));
    const before = remote('rev-parse', 'main');
    const id = ticket('Add, push off');
    await post(`/api/tickets/${id}/launch`);
    await landed(id);
    expect(t(id).flags.needs_human).toBe(false);
    expect(remote('rev-parse', 'main')).toBe(before);
  });

  it('a daemon started ahead of its upstream reports the unpushed count; POST /api/push pushes it and clears it', async () => {
    commitOnBase('b');
    commitOnBase('c');
    await restart();
    await until(async () => (await runnerState()).unpushed === 2, 'the unpushed count');
    const r = await post('/api/push');
    expect(r.status).toBe(200);
    expect((await r.json()).unpushed).toBe(0);
    expect(remote('rev-parse', 'main')).toBe(git('rev-parse', 'HEAD'));
    expect(db.prepare("SELECT outcome FROM audit WHERE tool = 'board.push'").all()).toEqual([{ outcome: 'ok' }]);
  });

  it("a refused Push answers 502 with git's message and keeps the count; with push_after_merge off no count is shown", async () => {
    commitOnBase('b');
    refuse();
    await restart();
    await until(async () => (await runnerState()).unpushed === 1, 'the unpushed count');
    const r = await post('/api/push');
    expect(r.status).toBe(502);
    expect(await r.text()).toContain('denied by the remote');
    expect((await runnerState()).unpushed).toBe(1);

    writeFileSync(settings(), JSON.stringify({ push_after_merge: false }));
    await restart();
    await new Promise((ok) => setTimeout(ok, 300));
    expect((await runnerState()).unpushed).toBe(0);
  });
});
