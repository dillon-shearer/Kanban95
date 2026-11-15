import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.ts';
import { createWorktree, oldWorktreesRoot, syncWorktree, worktreePath, worktreesRoot } from '../src/git.ts';
import { cleanTicket, sweep } from '../src/janitor.ts';
import { merge } from '../src/merge.ts';
import { localHome, pointerPath, repoKey } from '../src/settings.ts';
import { removeTemp } from './home.ts';

let repo: string;
let data: string;
let db: DatabaseSync;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const point = (dir: string) => {
  mkdirSync(localHome(), { recursive: true });
  writeFileSync(pointerPath(), dir + '\n');
};
const ticket = (status = 'in_progress', merged: string | null = null) =>
  Number(db.prepare('INSERT INTO tickets (title, status, merged_at) VALUES (?, ?, ?)').run('t', status, merged).lastInsertRowid);
const oldWorktree = (id: number) => {
  const path = join(oldWorktreesRoot(repo), `t-${id}`);
  git(repo, 'worktree', 'add', '-q', '-b', `ticket/${id}`, path);
  return path;
};
const commitIn = (wt: string, file: string) => {
  writeFileSync(join(wt, file), file);
  git(wt, 'add', '.');
  git(wt, 'commit', '-qm', `add ${file}`);
};

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'k95-wtdata-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Op Erator');
  git(repo, 'config', 'user.email', 'op@example.com');
  writeFileSync(join(repo, '.gitignore'), '.kanban95/\n');
  writeFileSync(join(repo, 'a.txt'), 'x');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
  db = openDb(repo);
  data = mkdtempSync(join(tmpdir(), 'k95-data-'));
});
afterEach(() => rmSync(pointerPath(), { force: true }));
afterAll(() => {
  db.close();
  removeTemp(repo);
  removeTemp(data);
});

describe('worktreesRoot', () => {
  it('is <data folder>/worktrees/<repo key> while the pointer names a folder', () => {
    point(data);
    expect(worktreesRoot(repo)).toBe(join(data, 'worktrees', repoKey(repo)));
    expect(oldWorktreesRoot(repo)).toBe(join(localHome(), 'worktrees', repoKey(repo)));
  });

  it('is <local home>/worktrees/<repo key> with no pointer', () => {
    expect(worktreesRoot(repo)).toBe(join(localHome(), 'worktrees', repoKey(repo)));
    expect(worktreesRoot(repo)).toBe(oldWorktreesRoot(repo));
  });

  it('refuses a missing data folder and does not create it', () => {
    const lost = join(data, 'unplugged');
    point(lost);
    expect(() => worktreesRoot(repo)).toThrow(/Data folder .* was not found/);
    expect(existsSync(lost)).toBe(false);
  });
});

describe('with the data folder pointer set', () => {
  it('a new launch creates the worktree under the data folder', () => {
    point(data);
    const id = ticket();
    const { path } = createWorktree(repo, id);
    expect(path).toBe(join(data, 'worktrees', repoKey(repo), `t-${id}`));
    expect(existsSync(join(path, '.git'))).toBe(true);
    expect(existsSync(join(oldWorktreesRoot(repo), `t-${id}`))).toBe(false);
  });

  it('a worktree made under the old local-home root is launched, merged and cleaned up where it is', async () => {
    const id = ticket();
    const old = oldWorktree(id);
    point(data);
    expect(worktreePath(repo, id)).toBe(old);
    expect(createWorktree(repo, id).path).toBe(old);
    commitIn(old, `f${id}.txt`);
    expect(syncWorktree(repo, id)).toEqual({ ok: true });
    expect(await merge(repo, id, 'ship')).toEqual({ ok: true });
    expect(existsSync(join(repo, `f${id}.txt`))).toBe(true);
    db.prepare("UPDATE tickets SET status = 'done', merged_at = ? WHERE id = ?").run('2026-01-01T00:00:00.000Z', id);
    await cleanTicket({ db, repo }, id);
    expect(existsSync(old)).toBe(false);
    expect(git(repo, 'branch', '--list', `ticket/${id}`)).toBe('');
  });

  it('the janitor removes finished worktrees at the old and the new root, then the empty old root', async () => {
    const MERGED = '2026-01-01T00:00:00.000Z';
    const a = ticket('done', MERGED);
    const old = oldWorktree(a);
    point(data);
    const b = ticket('done', MERGED);
    const fresh = createWorktree(repo, b).path;
    const open = ticket();
    const kept = createWorktree(repo, open).path;
    for (let i = 0; i < 3 && (existsSync(dirname(old)) || existsSync(fresh)); i++) await sweep({ db, repo });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(dirname(old))).toBe(false);
    expect(existsSync(fresh)).toBe(false);
    expect(existsSync(kept)).toBe(true);
  });
});
