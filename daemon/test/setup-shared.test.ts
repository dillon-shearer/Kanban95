import './home.ts';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { removeTemp } from './home.ts';
import { worktreePath } from '../src/git.ts';
import { prepareWorktree, sessions, type Session } from '../src/launcher.ts';

const repo = mkdtempSync(join(tmpdir(), 'k95-'));
afterAll(() => removeTemp(repo));
const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo });
const lock = (text: string) => {
  writeFileSync(join(repo, 'lock'), text);
  git('add', 'lock');
  git('commit', '-qm', text);
};
git('init', '-q', '-b', 'main');
lock('one');

const RUN = 'node -e "const fs=require(\'fs\');fs.appendFileSync(\'ran\',fs.readFileSync(\'lock\',\'utf8\')+\';\')"';
const root = dirname(worktreePath(repo, 1));
const ran = (dir: string) => (existsSync(join(dir, 'ran')) ? readFileSync(join(dir, 'ran'), 'utf8') : '');
const setup = (id: number, command = RUN) => prepareWorktree(repo, id, command, undefined, undefined, ['lock']);

describe('worktree_setup_shared', { timeout: 60_000 }, () => {
  it('a failed shared setup fails the launch and the next launch runs it again', async () => {
    await expect(setup(1, 'node -e "process.exit(3)"')).rejects.toThrow(/failed \(3\)/);
    await setup(1);
    expect(ran(root)).toBe('one;');
    expect(ran(worktreePath(repo, 1))).toBe('');
  });

  it('runs once for worktrees whose files match, with no link and nothing installed in the worktree', async () => {
    await Promise.all([setup(2), setup(3)]);
    expect(ran(root)).toBe('one;');
    expect(ran(worktreePath(repo, 2)) + ran(worktreePath(repo, 3))).toBe('');
    expect(setup(2)).toBeNull();
    for (const d of [root, worktreePath(repo, 2)]) for (const n of readdirSync(d)) expect(lstatSync(join(d, n)).isSymbolicLink()).toBe(false);
  });

  it('with an agent working under the root, changed files run the setup in the new worktree and leave the shared result alone', async () => {
    lock('two');
    sessions.set(-9, { cwd: worktreePath(repo, 2) } as Session);
    try {
      await setup(4);
    } finally {
      sessions.delete(-9);
    }
    expect(ran(root)).toBe('one;');
    expect(ran(worktreePath(repo, 4))).toBe('two;');
  });

  it('with no agent under the root, changed files run the shared setup again', async () => {
    await setup(5);
    expect(ran(root)).toBe('one;two;');
    expect(ran(worktreePath(repo, 5))).toBe('');
  });

  it('a worktree whose files differ from the main checkout runs the setup in itself', async () => {
    git('checkout', '-q', '-b', 'ticket/6');
    lock('three');
    git('checkout', '-q', 'main');
    await setup(6);
    expect(ran(root)).toBe('one;two;');
    expect(ran(worktreePath(repo, 6))).toBe('three;');
  });
});
