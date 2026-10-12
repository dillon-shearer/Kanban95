import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openDb } from '../src/db.ts';
import { runnerState, type Board } from '../src/lifecycle.ts';

vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>();
  return { ...real, execFileSync: vi.fn(real.execFileSync) };
});
const spawned = vi.mocked(execFileSync);
const gits = () => spawned.mock.calls.filter(([cmd]) => cmd === 'git').length;

let repo: string;
let b: Board;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
const ticket = (status: string, body: string) =>
  Number(b.db.prepare('INSERT INTO tickets (title, body, status) VALUES (?, ?, ?)').run('t', body, status).lastInsertRowid);
const commitOn = (branch: string, file: string) => {
  git('checkout', '-q', branch);
  writeFileSync(join(repo, file), `${Date.now()}\n`);
  git('add', file);
  git('commit', '-qm', `Edit ${file}`);
  git('checkout', '-q', 'main');
};

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'k95-files-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 't');
  git('config', 'user.email', 't@t');
  mkdirSync(join(repo, 'src'));
  for (const f of ['src/a.ts', 'src/b.ts', 'src/c.ts']) writeFileSync(join(repo, f), 'x\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  const db = openDb(repo);
  b = { db, brain: db, repo, port: 0 };
});
afterEach(() => {
  b.db.close();
  rmSync(repo, { recursive: true, force: true });
});

it('spawns no git on a second runnerState with no ticket or branch change', () => {
  for (let i = 0; i < 4; i++) ticket('in_progress', 'src/a.ts');
  git('branch', 'ticket/1');
  commitOn('ticket/1', 'src/b.ts');
  for (let i = 0; i < 6; i++) ticket('backlog', 'src/c.ts');
  spawned.mockClear();
  const first = runnerState(b);
  expect(gits()).toBeGreaterThan(0);
  spawned.mockClear();
  expect(runnerState(b)).toEqual(first);
  expect(gits()).toBe(0);
  git('pack-refs', '--all');
  spawned.mockClear();
  expect(runnerState(b)).toEqual(first);
  expect(gits()).toBe(0);
});

it('sees a changed ticket body and a new commit on a branch, loose or packed', () => {
  const a = ticket('in_progress', 'src/a.ts');
  const c = ticket('backlog', 'src/c.ts');
  git('branch', `ticket/${a}`);
  expect(runnerState(b).waits).toEqual([]);
  b.db.prepare('UPDATE tickets SET body = ? WHERE id = ?').run('src/a.ts', c);
  expect(runnerState(b).waits).toEqual([{ id: c, on: a }]);
  b.db.prepare('UPDATE tickets SET body = ? WHERE id = ?').run('src/b.ts', c);
  expect(runnerState(b).waits).toEqual([]);
  commitOn(`ticket/${a}`, 'src/b.ts');
  expect(runnerState(b).waits).toEqual([{ id: c, on: a }]);
  b.db.prepare('UPDATE tickets SET body = ? WHERE id = ?').run('src/c.ts', c);
  git('pack-refs', '--all');
  expect(runnerState(b).waits).toEqual([]);
  commitOn(`ticket/${a}`, 'src/c.ts');
  git('pack-refs', '--all');
  expect(runnerState(b).waits).toEqual([{ id: c, on: a }]);
});
