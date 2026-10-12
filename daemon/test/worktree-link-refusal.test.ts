import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync, type PathLike } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../src/db.ts';
import { createWorktree, removeWorktree } from '../src/git.ts';
import { sweep } from '../src/janitor.ts';

const onUnlink = vi.hoisted(() => ({ fn: undefined as undefined | ((p: string) => void) }));
vi.mock('node:fs', async (orig) => {
  const fs = await orig<typeof import('node:fs')>();
  const unlinkSync = (p: PathLike) => {
    fs.unlinkSync(p);
    onUnlink.fn?.(String(p));
  };
  return { ...fs, unlinkSync, default: { ...fs, unlinkSync } };
});

let repo: string;
let db: DatabaseSync;
let target: string;
let nextId = 950;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const isLink = (p: string) => lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
const targetIntact = () => expect(readFileSync(join(target, 'pkg', 'index.js'), 'utf8')).toBe('main');
const worktree = () => {
  const id = nextId++;
  const wt = createWorktree(repo, id).path;
  symlinkSync(target, join(wt, 'node_modules'), 'junction');
  expect(isLink(join(wt, 'node_modules'))).toBe(true);
  expect(isLink(join(wt, 'link.txt'))).toBe(true);
  return { id, wt };
};
const unchanged = (wt: string) => {
  expect(isLink(join(wt, 'node_modules'))).toBe(true);
  expect(isLink(join(wt, 'link.txt'))).toBe(true);
  expect(readlinkSync(join(wt, 'link.txt'))).toBe('a.txt');
  expect(readFileSync(join(wt, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('main');
  targetIntact();
};

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'k95-refusal-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  git(repo, 'config', 'user.name', 'Op Erator');
  git(repo, 'config', 'user.email', 'op@example.com');
  git(repo, 'config', 'core.symlinks', 'true');
  writeFileSync(join(repo, 'a.txt'), 'a');
  symlinkSync('a.txt', join(repo, 'link.txt'), 'file');
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n.kanban95/\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
  expect(git(repo, 'ls-files', '-s', 'link.txt')).toMatch(/^120000 /);
  target = join(repo, 'node_modules');
  db = openDb(repo);
});
beforeEach(() => {
  onUnlink.fn = undefined;
  mkdirSync(join(target, 'pkg'), { recursive: true });
  writeFileSync(join(target, 'pkg', 'index.js'), 'main');
});
afterAll(() => {
  db.close();
  rmSync(repo, { recursive: true, force: true });
});

describe('non-forced worktree removal', () => {
  it("the janitor keeps a deleted ticket's dirty worktree with its files, symlinks and junctions unchanged", () => {
    const { id, wt } = worktree();
    writeFileSync(join(wt, 'wip.txt'), 'uncommitted');
    sweep({ db, repo });
    unchanged(wt);
    expect(readFileSync(join(wt, 'wip.txt'), 'utf8')).toBe('uncommitted');
    expect(git(wt, 'status', '--porcelain')).toBe('?? wip.txt');
    const row = db.prepare("SELECT args_summary AS args, outcome FROM audit WHERE tool = 'janitor.worktree' AND args_summary LIKE ? ORDER BY id DESC LIMIT 1").get(`%t-${id}%`) as { args: string; outcome: string };
    expect(row.outcome).toBe('error');
    removeWorktree(repo, id, true);
  });

  it('removes a clean worktree holding a tracked symlink and a junction, leaving the target alone', () => {
    const { id, wt } = worktree();
    expect(removeWorktree(repo, id)).toEqual({ branchDeleted: true });
    expect(existsSync(wt)).toBe(false);
    targetIntact();
    expect(readlinkSync(join(repo, 'link.txt'))).toBe('a.txt');
  });

  it('puts every link back and refuses when a file appears while links are being unlinked', () => {
    const { id, wt } = worktree();
    onUnlink.fn = () => writeFileSync(join(wt, 'late.txt'), 'late');
    expect(() => removeWorktree(repo, id)).toThrow(/contains modified or untracked files/);
    onUnlink.fn = undefined;
    unchanged(wt);
    expect(git(wt, 'status', '--porcelain')).toBe('?? late.txt');
    removeWorktree(repo, id, true);
  });
});

describe('forced worktree removal', () => {
  it('removes a worktree with a tracked symlink and a junction without reaching through the junction', () => {
    const { id, wt } = worktree();
    writeFileSync(join(wt, 'build.log'), 'left over');
    removeWorktree(repo, id, true);
    expect(existsSync(wt)).toBe(false);
    targetIntact();
  });
});
