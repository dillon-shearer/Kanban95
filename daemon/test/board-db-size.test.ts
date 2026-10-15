import './home.ts';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../src/db.ts';
import { sweep } from '../src/janitor.ts';
import { readOutput } from '../src/output.ts';
import { removeTemp } from './home.ts';

vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>();
  const execFile = (...args: unknown[]) => {
    const cb = args.findLast((a) => typeof a === 'function') as ((e: Error | null, out: string, err: string) => void) | undefined;
    setImmediate(() => cb?.(null, '', ''));
    return {};
  };
  return { ...real, execFile };
});

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'k95-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) removeTemp(d);
});

const MB = 1 << 20;
const size = (repo: string, name: string) => statSync(join(repo, '.kanban95', name)).size;
const screen = (i: number) => `run ${i} `.repeat(MB / 2).slice(0, 2 * MB);

describe('board.db size', () => {
  it('the WAL is cut back after a checkpoint instead of staying at its largest', () => {
    const repo = tmp();
    const db = openDb(repo);
    db.exec('CREATE TABLE big (b TEXT)');
    db.exec('BEGIN');
    for (let i = 0; i < 20; i++) db.prepare('INSERT INTO big VALUES (?)').run(screen(i));
    db.exec('COMMIT');
    expect(size(repo, 'board.db-wal')).toBeGreaterThan(30 * MB);
    db.exec('PRAGMA wal_checkpoint');
    db.exec('DELETE FROM big');
    expect(size(repo, 'board.db-wal')).toBeLessThanOrEqual(16 * MB);
    db.close();
  });

  it('the janitor moves run output out of the db into files, shrinks board.db and empties the WAL, keeping every row', async () => {
    const repo = tmp();
    const db = openDb(repo);
    const ticket = Number(db.prepare("INSERT INTO tickets (title) VALUES ('t')").run().lastInsertRowid);
    db.prepare("INSERT INTO notes (ticket_id, role, kind, body) VALUES (?, 'worker', 'summary', 'done')").run(ticket);
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    const ins = db.prepare("INSERT INTO runs (ticket_id, phase, cli, model, effort, prompt_rendered, ended_at, scrollback) VALUES (?, 'execute', 'claude', 'm', 'low', 'p', ?, ?)");
    const runs = Array.from({ length: 12 }, (_, i) => Number(ins.run(ticket, i ? new Date().toISOString() : old, screen(i)).lastInsertRowid));
    db.exec('PRAGMA wal_checkpoint');
    const before = size(repo, 'board.db');
    expect(before).toBeGreaterThan(20 * MB);

    await sweep({ db, repo });

    expect(db.prepare('SELECT count(*) AS n FROM runs WHERE scrollback IS NOT NULL').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 12 });
    expect(db.prepare('SELECT body FROM notes').all()).toEqual([{ body: 'done' }]);
    expect(readOutput(repo, runs[0])).toBeNull();
    for (const [i, id] of runs.entries()) if (i) expect(readOutput(repo, id)).toBe(screen(i));
    expect(size(repo, 'board.db')).toBeLessThan(MB);
    expect(size(repo, 'board.db-wal')).toBe(0);
    db.close();
  });
});
