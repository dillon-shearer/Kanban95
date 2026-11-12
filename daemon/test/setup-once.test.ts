import './home.ts';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { removeTemp } from './home.ts';

const calls = vi.hoisted(() => ({ n: 0 }));
vi.mock('../src/git.ts', async (orig) => {
  const g = await orig<typeof import('../src/git.ts')>();
  const createWorktree: typeof g.createWorktree = (...args) => {
    calls.n++;
    return g.createWorktree(...args);
  };
  return { ...g, createWorktree };
});

const { prepareWorktree } = await import('../src/launcher.ts');
const { worktreePath } = await import('../src/git.ts');

const repo = mkdtempSync(join(tmpdir(), 'k95-'));
afterAll(() => removeTemp(repo));
const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo });
git('init', '-q', '-b', 'main');
writeFileSync(join(repo, 'a.txt'), 'a\n');
git('add', 'a.txt');
git('commit', '-qm', 'init');

describe('prepareWorktree', { timeout: 30_000 }, () => {
  it('creates the worktree once for a launch that runs a setup, and not again once the marker is set', async () => {
    calls.n = 0;
    const setup = prepareWorktree(repo, 4, 'node -e "require(\'fs\').writeFileSync(\'ran\', \'\')"');
    expect(setup).not.toBeNull();
    await setup;
    expect(existsSync(join(worktreePath(repo, 4), 'ran'))).toBe(true);
    expect(calls.n).toBe(1);
    await new Promise((r) => setImmediate(r));
    calls.n = 0;
    expect(prepareWorktree(repo, 4, 'node -e "process.exit(1)"')).toBeNull();
    expect(calls.n).toBe(1);
  });
});
