import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../src/db.ts';
import { createWorktree } from '../src/git.ts';
import { cleanTicket, sweep } from '../src/janitor.ts';

const fail = vi.hoisted(() => ({ times: 0, then: () => {} }));
vi.mock('../src/git.ts', async (orig) => {
  const g = await orig<typeof import('../src/git.ts')>();
  const removeWorktree: typeof g.removeWorktree = (...args) => {
    if (fail.times > 0) {
      fail.times--;
      fail.then();
      throw new Error('EBUSY: resource busy or locked');
    }
    return g.removeWorktree(...args);
  };
  return { ...g, removeWorktree };
});

let repo: string;
let db: DatabaseSync;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const MERGED = '2026-01-01T00:00:00.000Z';

const mergedTicket = () => {
  const id = Number(db.prepare('INSERT INTO tickets (title, status, merged_at) VALUES (?, ?, ?)').run('t', 'done', MERGED).lastInsertRowid);
  const wt = createWorktree(repo, id).path;
  writeFileSync(join(wt, `f${id}.txt`), 'shipped');
  execFileSync('git', ['add', '.'], { cwd: wt });
  execFileSync('git', ['commit', '-qm', `ship ${id}`], { cwd: wt });
  git('merge', '-q', '--no-ff', '-m', `merge ${id}`, `ticket/${id}`);
  return { id, wt };
};
const reject = (id: number) => db.prepare("UPDATE tickets SET status = 'in_progress' WHERE id = ?").run(id);
const edit = (wt: string) => {
  writeFileSync(join(wt, 'a.txt'), 'edited');
  writeFileSync(join(wt, 'new.txt'), 'new work');
};
const editsKept = (wt: string) => {
  expect(readFileSync(join(wt, 'a.txt'), 'utf8')).toBe('edited');
  expect(readFileSync(join(wt, 'new.txt'), 'utf8')).toBe('new work');
};
const branchExists = (id: number) => git('branch', '--list', `ticket/${id}`) !== '';
const audits = (id: number) =>
  (db.prepare("SELECT args_summary FROM audit WHERE ticket_id = ? AND tool = 'janitor.worktree'").all(id) as { args_summary: string }[]).map((r) => r.args_summary).join(' ');

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'k95-reopen-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  git('config', 'user.name', 'Op Erator');
  git('config', 'user.email', 'op@example.com');
  writeFileSync(join(repo, 'a.txt'), 'x');
  writeFileSync(join(repo, '.gitignore'), '.kanban95/\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  db = openDb(repo);
});
beforeEach(() => {
  fail.times = 0;
  fail.then = () => {};
});
afterAll(() => {
  db.close();
  rmSync(repo, { recursive: true, force: true });
});

describe('janitor and a merged ticket rejected back to a worker', { timeout: 30_000 }, () => {
  it('startup sweep keeps the reopened worktree and its uncommitted edits', async () => {
    const { id, wt } = mergedTicket();
    reject(id);
    edit(wt);
    await sweep({ db, repo });
    editsKept(wt);
    expect(branchExists(id)).toBe(true);
  });

  it('a rejection during the cleanup retries stops the old cycle from removing the worktree', async () => {
    const { id, wt } = mergedTicket();
    fail.times = 1;
    fail.then = () => {
      reject(id);
      edit(wt);
    };
    await cleanTicket({ db, repo }, id);
    editsKept(wt);
    expect(branchExists(id)).toBe(true);
    expect(audits(id)).toContain('reopened');
  });

  it('a later cycle landing during the retries leaves the cleanup to that cycle', async () => {
    const { id, wt } = mergedTicket();
    fail.times = 1;
    fail.then = () => void db.prepare("UPDATE tickets SET merged_at = '2026-02-01T00:00:00.000Z' WHERE id = ?").run(id);
    await cleanTicket({ db, repo }, id);
    expect(existsSync(wt)).toBe(true);
  });

  it('cleanup of a done merged ticket still removes its worktree and branch after a locked try', async () => {
    const { id, wt } = mergedTicket();
    fail.times = 2;
    await cleanTicket({ db, repo }, id);
    expect(existsSync(wt)).toBe(false);
    expect(branchExists(id)).toBe(false);
  });

  it('sweep still removes a done merged ticket\'s worktree and branch', async () => {
    const { id, wt } = mergedTicket();
    writeFileSync(join(wt, 'build.out'), 'leftover');
    await sweep({ db, repo });
    expect(existsSync(wt)).toBe(false);
    expect(branchExists(id)).toBe(false);
  });
});
