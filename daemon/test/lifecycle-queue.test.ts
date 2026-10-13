// After the merge on a fake `claude` (board.ts): five tickets through one queue, push to the upstream.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { worktreePath, worktreesRoot } from '../src/git.ts';
import { sessionsOf } from '../src/launcher.ts';
import { git, landed, launchTogether, notes, post, repo, sounds, t, ticket, until } from './board.ts';

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

});

describe('push after merge', { timeout: 60_000 }, () => {
  let bare: string;
  const remote = (...a: string[]) => execFileSync('git', a, { cwd: bare, encoding: 'utf8' }).trim();
  const settings = () => join(process.env.KANBAN95_HOME!, 'settings.json');
  const commitOnBase = (f: string) => {
    writeFileSync(join(repo, `${f}.txt`), `${f}\n`);
    git('add', `${f}.txt`);
    git('commit', '-qm', `Add ${f} on the base`);
  };
  const refuse = () => writeFileSync(join(bare, 'hooks', 'pre-receive'), '#!/bin/sh\necho "denied by the remote" >&2\nexit 1\n', { mode: 0o755 });
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

});
