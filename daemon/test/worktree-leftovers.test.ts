import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { openDb } from '../src/db.ts';
import { createWorktree, worktreePath, worktreesRoot } from '../src/git.ts';
import { sweep } from '../src/janitor.ts';
import { addProject, repoKey } from '../src/settings.ts';

vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>();
  const execFile = (...args: unknown[]) => {
    const cb = args.findLast((a) => typeof a === 'function') as ((e: Error | null, out: string, err: string) => void) | undefined;
    setImmediate(() => cb?.(null, '', ''));
    return {};
  };
  return { ...real, execFile };
});

let repo: string;
let other: string;
let db: DatabaseSync;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const roots = () => dirname(worktreesRoot(repo));
const leftover = (dir: string) => {
  mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'x', 'index.js'), 'x');
};

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'k95-leftover-'));
  other = mkdtempSync(join(tmpdir(), 'k95-leftover-other-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Op Erator');
  git(repo, 'config', 'user.email', 'op@example.com');
  writeFileSync(join(repo, 'a.txt'), 'x');
  writeFileSync(join(repo, '.gitignore'), '.kanban95/\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
  db = openDb(repo);
  addProject(repo);
  addProject(other);
});
afterAll(() => {
  db.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(other, { recursive: true, force: true });
});

describe('leftover worktree folders', { timeout: 30_000 }, () => {
  it('sweep removes a root of no registered project whose folders have no .git entry', async () => {
    const dead = join(roots(), 'Gone-0badf00d');
    leftover(join(dead, 't-139'));
    leftover(join(dead, 't-143'));
    writeFileSync(join(dead, 'test-out.txt'), 'x');
    await sweep({ db, repo });
    expect(existsSync(dead)).toBe(false);
  });

  it('sweep leaves a root of no registered project that holds one folder with a .git entry', async () => {
    const kept = join(roots(), 'Moved-12345678');
    leftover(join(kept, 't-1'));
    mkdirSync(join(kept, 't-2'));
    writeFileSync(join(kept, 't-2', '.git'), 'gitdir: elsewhere\n');
    await sweep({ db, repo });
    expect(existsSync(join(kept, 't-1', 'node_modules', 'x', 'index.js'))).toBe(true);
    expect(existsSync(join(kept, 't-2', '.git'))).toBe(true);
  });

  it('sweep leaves the root of a registered project, even with no real worktree in it', async () => {
    const theirs = join(roots(), repoKey(other));
    leftover(join(theirs, 't-7'));
    await sweep({ db, repo });
    expect(existsSync(join(theirs, 't-7', 'node_modules', 'x', 'index.js'))).toBe(true);
  });

  it('sweep removes a .git-less folder of a merged ticket in the current root', async () => {
    const id = Number(db.prepare('INSERT INTO tickets (title, status, merged_at) VALUES (?, ?, ?)').run('t', 'done', '2026-01-01T00:00:00.000Z').lastInsertRowid);
    const path = worktreePath(repo, id);
    leftover(path);
    await sweep({ db, repo });
    expect(existsSync(path)).toBe(false);
    expect(existsSync(worktreesRoot(repo))).toBe(true);
  });

  it('createWorktree replaces a ticket folder that has no .git entry with a working worktree', () => {
    const id = Number(db.prepare('INSERT INTO tickets (title, status) VALUES (?, ?)').run('t', 'in_progress').lastInsertRowid);
    const path = worktreePath(repo, id);
    leftover(path);
    expect(createWorktree(repo, id).path).toBe(path);
    expect(existsSync(join(path, '.git'))).toBe(true);
    expect(existsSync(join(path, 'node_modules'))).toBe(false);
    expect(git(path, 'status', '--porcelain')).toBe('');
    expect(git(path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(`ticket/${id}`);
  });
});
