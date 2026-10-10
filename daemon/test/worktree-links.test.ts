// A junction or symlink inside a worktree must be unlinked, never followed, when the worktree is removed: a junction to the
// main checkout's node_modules once let `git worktree remove --force` empty main's daemon/.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, type PathLike } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../src/db.ts';
import { createWorktree, removeWorktree, worktreePath } from '../src/git.ts';
import { sweep } from '../src/janitor.ts';

// unlinkSync refuses this one path, as Windows does for a link something holds open.
const stuck = vi.hoisted(() => ({ path: '' }));
vi.mock('node:fs', async (orig) => {
  const fs = await orig<typeof import('node:fs')>();
  const unlinkSync = (p: PathLike) => {
    if (String(p) === stuck.path) throw Object.assign(new Error(`EPERM: operation not permitted, unlink '${p}'`), { code: 'EPERM' });
    fs.unlinkSync(p);
  };
  return { ...fs, unlinkSync, default: { ...fs, unlinkSync } };
});

let repo: string;
let db: DatabaseSync;
let target: string; // the main checkout's node_modules
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
// 'junction' on Windows; ignored elsewhere, where it makes a directory symlink.
const link = (path: string) => {
  mkdirSync(join(path, '..'), { recursive: true });
  symlinkSync(target, path, 'junction');
  expect(lstatSync(path).isSymbolicLink()).toBe(true);
};
const ticket = (merged: boolean) =>
  Number(db.prepare('INSERT INTO tickets (title, status, merged_at) VALUES (?, ?, ?)').run('t', 'done', merged ? '2026-01-01T00:00:00.000Z' : null).lastInsertRowid);
const targetIntact = () => expect(readFileSync(join(target, 'pkg', 'index.js'), 'utf8')).toBe('main');

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'k95-links-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  git('config', 'user.name', 'Op Erator');
  git('config', 'user.email', 'op@example.com');
  mkdirSync(join(repo, 'daemon'));
  writeFileSync(join(repo, 'daemon', 'a.ts'), 'x');
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n.kanban95/\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  target = join(repo, 'node_modules');
  db = openDb(repo);
});
beforeEach(() => {
  stuck.path = '';
  mkdirSync(join(target, 'pkg'), { recursive: true });
  writeFileSync(join(target, 'pkg', 'index.js'), 'main');
});
afterAll(() => {
  db.close();
  rmSync(repo, { recursive: true, force: true });
});

describe('removing a worktree with links into the main checkout', () => {
  it('unlinks a node_modules junction at the root and removes the worktree', () => {
    const id = ticket(true);
    const wt = createWorktree(repo, id).path;
    link(join(wt, 'node_modules'));
    removeWorktree(repo, id, true);
    expect(existsSync(wt)).toBe(false);
    targetIntact();
  });

  it('unlinks a junction nested below the root', () => {
    const id = ticket(true);
    const wt = createWorktree(repo, id).path;
    link(join(wt, 'daemon', 'node_modules'));
    removeWorktree(repo, id, true);
    expect(existsSync(wt)).toBe(false);
    targetIntact();
    expect(readFileSync(join(repo, 'daemon', 'a.ts'), 'utf8')).toBe('x');
  });

  it("the janitor's sweep of an unregistered leftover directory leaves the link's target alone", () => {
    const dir = worktreePath(repo, 900);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'junk'), 'x');
    link(join(dir, 'daemon', 'node_modules'));
    sweep({ db, repo });
    expect(existsSync(dir)).toBe(false);
    targetIntact();
    const row = db.prepare("SELECT args_summary AS args, outcome FROM audit WHERE tool = 'janitor.worktree' ORDER BY id DESC LIMIT 1").get() as { args: string; outcome: string };
    expect(row.outcome).toBe('ok');
    expect(row.args).toContain('"registered":false');
  });

  it('refuses, leaving everything in place, when a link into the main checkout cannot be unlinked', () => {
    const id = ticket(true);
    const wt = createWorktree(repo, id).path;
    writeFileSync(join(wt, 'build.log'), 'left over');
    stuck.path = join(wt, 'node_modules');
    link(stuck.path);
    sweep({ db, repo });
    expect(lstatSync(stuck.path).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(wt, 'build.log'), 'utf8')).toBe('left over');
    targetIntact();
    const row = db.prepare("SELECT ticket_id, args_summary AS args, outcome FROM audit WHERE tool = 'janitor.worktree' ORDER BY id DESC LIMIT 1").get() as { ticket_id: number; args: string; outcome: string };
    expect(row).toMatchObject({ ticket_id: id, outcome: 'error' });
    expect(row.args).toContain('"error":"refusing to remove '); // args_summary is cut at 200 characters
    stuck.path = '';
    removeWorktree(repo, id, true); // once the link lets go, the next sweep can finish
    expect(existsSync(wt)).toBe(false);
    targetIntact();
  });
});

// Before worktrees moved to the board home they lived in <repo>/.worktrees, where a synced folder (OneDrive) uploaded and locked them.
describe('worktrees left under the repo by the old layout', () => {
  const legacy = (id: number) => join(repo, '.worktrees', `t-${id}`);
  const addLegacy = (id: number) => git('worktree', 'add', '-q', '-b', `ticket/${id}`, legacy(id));

  it("the janitor removes a merged ticket's worktree and a leftover there, then the empty directory", () => {
    const id = ticket(true);
    addLegacy(id);
    writeFileSync(join(legacy(id), 'build.log'), 'left over');
    mkdirSync(legacy(901));
    writeFileSync(join(legacy(901), 'junk'), 'x');
    sweep({ db, repo });
    expect(existsSync(join(repo, '.worktrees'))).toBe(false);
    expect(git('branch', '--list', `ticket/${id}`)).toBe('');
    expect(git('worktree', 'list', '--porcelain')).not.toContain(`t-${id}`);
  });

  it("keeps an unmerged ticket's worktree, and its next launch moves it to the board home with its work", () => {
    const id = ticket(false);
    addLegacy(id);
    writeFileSync(join(legacy(id), 'wip.txt'), 'uncommitted');
    sweep({ db, repo });
    expect(readFileSync(join(legacy(id), 'wip.txt'), 'utf8')).toBe('uncommitted');
    const wt = createWorktree(repo, id);
    expect(wt.path).toBe(worktreePath(repo, id));
    expect(readFileSync(join(wt.path, 'wip.txt'), 'utf8')).toBe('uncommitted');
    expect(git('-C', wt.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(`ticket/${id}`);
    sweep({ db, repo });
    expect(existsSync(join(repo, '.worktrees'))).toBe(false);
    expect(existsSync(wt.path)).toBe(true);
  });
});
