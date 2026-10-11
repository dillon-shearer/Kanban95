// Merge conflicts and the merge queue on a fake `claude` (board.ts): two branches on one file, main merged into the worktree
// on submit, a dirty main checkout.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { worktreePath } from '../src/git.ts';
import { sessionsOf } from '../src/launcher.ts';
import { DIRTY_WAIT, MAX_RETRY } from '../src/lifecycle.ts';
import { git, landed, launchTogether, mergeInProgress, notes, post, repo, runs, setRun, sounds, srv, t, ticket, until } from './board.ts';

/** A path as a literal inside a RegExp. */
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('lifecycle', { timeout: 60_000 }, () => {
  it('merge conflict: the worker merges the base in its kept worktree and both tickets land with no operator action', async () => {
    const one = ticket('Write shared one', { model: 'conflict' });
    const two = ticket('Write shared two', { model: 'conflict' });
    await launchTogether(2);
    await until(() => [one, two].some((id) => t(id).retry === 1), 'the conflict sent back');
    const [won, lost] = t(one).retry === 1 ? [two, one] : [one, two];
    await landed(won);
    await landed(lost);
    expect(notes(lost, 'failure')).toEqual([expect.stringMatching(/^merge conflict with main: [^]*CONFLICT[^]*shared\.txt/)]);
    expect(runs(lost).map((x) => x.phase)).toEqual(['execute', 'test', 'execute', 'test']);
    expect(runs(lost)[2].prompt_rendered).toMatch(/merge conflict with main: [^]*git merge main/); // the note, and the brief's base
    expect([one, two].map((id) => t(id).flags.needs_human)).toEqual([false, false]);
    expect(git('show', 'HEAD:shared.txt')).toBe('both');
    expect(mergeInProgress(repo)).toBe(false);
    expect(sounds.filter((s) => s.sound === 'chord')).toEqual([]);
  });

  it('merge conflict at the retry cap: flagged with the worktree kept, the base clean, the fix in the note and the Inbox; a retried merge lands it', async () => {
    const one = ticket('Write shared one', { model: 'conflict', retry: MAX_RETRY });
    const two = ticket('Write shared two', { model: 'conflict', retry: MAX_RETRY });
    await launchTogether(2);
    await until(() => [one, two].every((id) => t(id).status === 'done') && [one, two].some((id) => t(id).flags.needs_human), 'both done, one flagged');
    const [won, lost] = t(one).merged_at ? [one, two] : [two, one];
    await landed(won);
    expect(t(lost)).toMatchObject({ status: 'done', merged_at: null, retry: MAX_RETRY, flags: { needs_human: true } });
    expect(notes(lost, 'failure')).toEqual([expect.stringMatching(new RegExp(`^merge conflict with main: [^]*\\nTo resolve: in ${esc(worktreePath(repo, lost))} .*Retry merge\\.$`))]);
    const inbox = await (await fetch(`http://127.0.0.1:${srv.port}/api/inbox`, { headers: { cookie: `k95=${srv.secret}` } })).json();
    expect(inbox).toEqual([expect.objectContaining({ ticket_id: lost, kind: 'failure', status: 'done', merged_at: null, body: notes(lost, 'failure')[0] })]);
    expect(existsSync(worktreePath(repo, lost))).toBe(true);
    expect(git('status', '--porcelain', '--untracked-files=no')).toBe('');
    expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(mergeInProgress(worktreePath(repo, lost))).toBe(false); // the conflict was met and aborted there
    expect(git('show', 'HEAD:shared.txt')).toBe(`t-${won}`);
    expect(sounds.filter((s) => s.sound === 'chord')).toEqual([{ sound: 'chord', ticket: lost }]);

    // The operator resolves it in the worktree, then retries the merge.
    const wt = worktreePath(repo, lost);
    try {
      execFileSync('git', ['merge', '-q', 'main'], { cwd: wt, stdio: 'ignore' });
    } catch {
      writeFileSync(join(wt, 'shared.txt'), 'both\n');
      execFileSync('git', ['commit', '-qam', 'Resolve shared'], { cwd: wt });
    }
    expect((await post(`/api/tickets/${lost}/merge`)).status).toBe(200);
    await landed(lost);
    expect(t(lost).flags.needs_human).toBe(false);
    expect(git('show', 'HEAD:shared.txt')).toBe('both');
    expect((await post(`/api/tickets/${lost}/merge`)).status).toBe(409); // already merged
  });

  describe('main merged into the worktree on submit', () => {
    beforeEach(() => {
      writeFileSync(join(repo, 'lines.txt'), '1\n2\n3\n4\n5\n');
      git('add', 'lines.txt');
      git('commit', '-qm', 'Add lines');
    });
    const answer = async (id: number, text: string) => {
      await until(() => t(id).flags.needs_human, `ticket ${id}'s question`);
      expect((await post(`/api/tickets/${id}/answer`, { answer: text })).status).toBe(200);
    };
    // B forks before A lands and submits after it: B's branch is stale when its worker submits.
    // The runner is on, so a conflict goes straight back to the worker (off, it is held: see the last test here). A hanging
    // ticket keeps it on while b waits on its question, which does not count as running.
    const aLandsWhileBWorks = async (a: number, b: number) => {
      for (const id of [b, a]) expect((await post(`/api/tickets/${id}/launch`)).status).toBe(200);
      ticket('Keep the runner on', { model: 'hang' });
      await setRun(true);
      await answer(a, '1 one');
      await landed(a);
    };
    const sentBack = (id: number) => until(() => runs(id).length === 2 && runs(id)[0].outcome === 'conflict', 'sent back to the worker');

    it('a clean merge: a merge commit from main by the operator, tested combined, landed with no conflict note', async () => {
      const a = ticket('Edit line one', { model: 'lines' });
      const b = ticket('Edit line five', { model: 'lines' });
      await aLandsWhileBWorks(a, b);
      await answer(b, '5 five');
      await landed(b);
      expect(notes(b, 'failure')).toEqual([]);
      expect(runs(b).map((x) => [x.phase, x.outcome])).toEqual([['execute', 'submit'], ['test', 'pass']]);
      expect(notes(b, 'summary')).toEqual([`PASS: every criterion passes (tested: Merge main into ticket/${b})`]); // synced before the tester ran
      expect(git('log', '-1', '--format=%an <%ae>|%s', 'HEAD^2')).toBe(`Op Erator <op@example.com>|Merge main into ticket/${b}`);
      expect(git('rev-list', '--parents', '-1', 'HEAD^2').split(' ')).toHaveLength(3); // a real merge commit
      expect(git('show', 'HEAD:lines.txt')).toBe('one\n2\n3\n4\nfive');
    });

    it('a conflict: back to the worker in its kept worktree, retry + 1, no tester round, no merge left in progress', async () => {
      const a = ticket('Edit line one', { model: 'lines' });
      const b = ticket('Also edit line one', { model: 'lines' });
      await aLandsWhileBWorks(a, b);
      await answer(b, '1 uno');
      await sentBack(b);
      const wt = worktreePath(repo, b);
      expect(t(b)).toMatchObject({ status: 'in_progress', retry: 1, flags: { needs_human: false } });
      expect(notes(b, 'failure')).toEqual([expect.stringMatching(/^merge conflict with main: [^]*CONFLICT[^]*lines\.txt/)]);
      expect(runs(b).map((x) => x.phase)).toEqual(['execute', 'execute']);
      expect(runs(b)[1].prompt_rendered).toMatch(/merge conflict with main: [^]*git merge main/);
      expect(sessionsOf(b)).toHaveLength(1);
      expect(mergeInProgress(wt)).toBe(false);
      expect(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: wt, encoding: 'utf8' })).toBe('');
      expect(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: wt, encoding: 'utf8' }).trim()).toBe('Add lines.txt');
    });

    it('uncommitted tracked changes: back to the worker with a note saying so, the changes untouched', async () => {
      const id = ticket('Leave it half done', { model: 'dirty' });
      expect((await post(`/api/tickets/${id}/launch`)).status).toBe(200);
      await setRun(true);
      await sentBack(id);
      expect(t(id)).toMatchObject({ status: 'in_progress', retry: 1, flags: { needs_human: false } });
      expect(notes(id, 'failure')).toEqual(['worktree has uncommitted changes; commit or discard them, then submit again:\n M a.txt']);
      expect(readFileSync(join(worktreePath(repo, id), 'a.txt'), 'utf8')).toBe('half done\n');
      expect(runs(id).map((x) => x.phase)).toEqual(['execute', 'execute']);
    });

    it('while the runner is off the conflict waits: in progress with no agent and no flag, and the worker starts on Run', async () => {
      const id = ticket('Leave it half done', { model: 'dirty' });
      expect((await post(`/api/tickets/${id}/launch`)).status).toBe(200);
      await until(() => t(id).retry === 1, 'the conflict');
      await until(() => !sessionsOf(id).length, 'the worker ended');
      expect(t(id)).toMatchObject({ status: 'in_progress', flags: { needs_human: false } });
      expect(runs(id).map((x) => x.outcome)).toEqual(['conflict']);
      await setRun(true);
      expect(runs(id).map((x) => x.phase)).toEqual(['execute', 'execute']);
      expect(sessionsOf(id)).toHaveLength(1);
    });
  });

  describe('a dirty main checkout', () => {
    const wait0 = { ...DIRTY_WAIT };
    afterEach(() => Object.assign(DIRTY_WAIT, wait0));
    // Dirtied once the worktree exists (a dirty base refuses the launch itself) and long before the tester passes.
    const launchThenDirty = async (id: number) => {
      expect((await post(`/api/tickets/${id}/launch`)).status).toBe(200);
      writeFileSync(join(repo, 'a.txt'), 'the operator is editing\n');
    };

    it('flags nothing and retries by itself; the merge lands once the base is clean, with the edits untouched until then', async () => {
      Object.assign(DIRTY_WAIT, { every: 50, max: 60_000 });
      const id = ticket('Add while dirty');
      await launchThenDirty(id);
      await until(() => t(id).status === 'done', 'done');
      await new Promise((r) => setTimeout(r, 500)); // several refused tries
      expect(t(id)).toMatchObject({ merged_at: null, flags: { needs_human: false } });
      expect(notes(id, 'failure')).toEqual([]);
      expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('the operator is editing\n'); // no merge --abort over it
      git('checkout', 'a.txt');
      await landed(id);
      expect(t(id).flags.needs_human).toBe(false);
      expect(sounds).toEqual([{ sound: 'done', ticket: id }, { sound: 'ding', ticket: id }]);
    });

    it('the operator commits instead: the queue merges the new main into the worktree first, then lands it', async () => {
      Object.assign(DIRTY_WAIT, { every: 50, max: 60_000 });
      const id = ticket('Add behind main');
      await launchThenDirty(id);
      await until(() => t(id).status === 'done', 'done');
      git('commit', '-qam', 'Edit a');
      await landed(id);
      expect(notes(id, 'failure')).toEqual([]);
      expect(git('log', '-1', '--format=%an <%ae>|%s', 'HEAD^2')).toBe(`Op Erator <op@example.com>|Merge main into ticket/${id}`);
      expect(git('log', '-1', '--format=%s', 'HEAD')).toBe('Add behind main');
      expect(git('show', 'HEAD:a.txt')).toBe('the operator is editing');
      expect(mergeInProgress(repo)).toBe(false);
    });

    it('still dirty after the wait: flagged with the changed files and the fix; Retry merge lands it once clean', async () => {
      Object.assign(DIRTY_WAIT, { every: 50, max: 300 });
      const id = ticket('Add while dirty for long');
      await launchThenDirty(id);
      await until(() => t(id).flags.needs_human, 'the flag');
      expect(t(id)).toMatchObject({ status: 'done', merged_at: null });
      expect(notes(id, 'failure')).toEqual([expect.stringMatching(/^merge did not run: the main checkout \(main\) still has uncommitted changes after the wait:\n M a\.txt\nTo resolve: commit or stash those changes in the main checkout .*Retry merge/)]);
      expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('the operator is editing\n');
      git('checkout', 'a.txt');
      expect((await post(`/api/tickets/${id}/merge`)).status).toBe(200);
      await landed(id);
    });
  });
});
