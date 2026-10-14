import './home.ts';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasBranch } from '../src/git.ts';
import { ticketBase } from '../src/lifecycle.ts';
import { removeTemp } from './home.ts';
import { git, landed, post, repo, runs, t, ticket } from './board.ts';

const setup = () => {
  git('branch', 'release');
  writeFileSync(join(repo, 'dev.txt'), 'unreleased\n');
  git('add', 'dev.txt');
  git('commit', '-qm', 'Add unreleased work');
  mkdirSync(join(repo, '.kanban95'), { recursive: true });
  writeFileSync(join(repo, '.kanban95', 'config.json'), JSON.stringify({ bases: { 'release-1': 'release' } }));
};
const has = (ref: string, file: string) => git('ls-tree', '--name-only', ref, file) === file;

describe('ticket base', { timeout: 180_000 }, () => {
  it('a mapped tag: the worktree forks from that branch, the prompts name it, and the ticket lands there without main', async () => {
    setup();
    const main = git('rev-parse', 'main');
    const release = git('rev-parse', 'release');
    const id = ticket('Fix the release', { tags: 'urgent release-1' });
    expect((await post(`/api/tickets/${id}/launch`)).status).toBe(200);
    await landed(id);
    expect(t(id).flags.needs_human).toBe(false);
    expect(git('rev-parse', 'main')).toBe(main);
    expect(git('log', '-1', '--format=%s', 'release')).toBe('Fix the release');
    expect(git('rev-parse', 'release^1')).toBe(release);
    expect(has('release', `t-${id}.txt`)).toBe(true);
    expect(has('release', 'dev.txt')).toBe(false);
    expect(runs(id).map((r) => r.phase)).toEqual(['execute', 'test']);
    for (const r of runs(id)) expect(r.prompt_rendered).toContain('test:changed -- release');
    expect(hasBranch(repo, id)).toBe(false);
  });

  it('a base checked out in another worktree: the merge runs there, so its files match the branch', async () => {
    setup();
    const other = mkdtempSync(join(tmpdir(), 'k95-release-'));
    try {
      git('worktree', 'add', '-q', join(other, 'wt'), 'release');
      const id = ticket('Fix the release there', { tags: 'release-1' });
      expect((await post(`/api/tickets/${id}/launch`)).status).toBe(200);
      await landed(id);
      expect(git('log', '-1', '--format=%s', 'release')).toBe('Fix the release there');
      expect(existsSync(join(other, 'wt', `t-${id}.txt`))).toBe(true);
      expect(execFileSync('git', ['status', '--porcelain'], { cwd: join(other, 'wt'), encoding: 'utf8' })).toBe('');
      expect(has('release', 'dev.txt')).toBe(false);
    } finally {
      git('worktree', 'remove', '--force', join(other, 'wt'));
      removeTemp(other);
    }
  });

  it('no mapped tag, or no bases: no override; tags mapped to two branches are refused', () => {
    expect(ticketBase(repo, 'release-1')).toBeUndefined();
    setup();
    expect(ticketBase(repo, '')).toBeUndefined();
    expect(ticketBase(repo, 'urgent')).toBeUndefined();
    expect(ticketBase(repo, 'urgent release-1')).toBe('release');
    writeFileSync(join(repo, '.kanban95', 'config.json'), JSON.stringify({ bases: { a: 'one', b: 'two', c: 'one' } }));
    expect(ticketBase(repo, 'a c')).toBe('one');
    expect(() => ticketBase(repo, 'a b')).toThrow(/more than one base[^]*one, two/);
    writeFileSync(join(repo, '.kanban95', 'config.json'), JSON.stringify({ bases: ['main'] }));
    expect(() => ticketBase(repo, 'a')).toThrow(/bases must be an object/);
  });
});
