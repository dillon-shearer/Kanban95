import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS_DIR, migrate, openDb } from '../src/db.ts';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'k95-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('openDb', () => {
  it('creates .kanban95/board.db and the inner .gitignore on first start', () => {
    const repo = tmp();
    const db = openDb(repo);
    db.close();
    expect(existsSync(join(repo, '.kanban95', 'board.db'))).toBe(true);
    const ignore = readFileSync(join(repo, '.kanban95', '.gitignore'), 'utf8');
    expect(ignore).toMatch(/^board\.db$/m);
    expect(ignore).toMatch(/^sessions\/$/m);
  });

  it('applies nothing on a second start', () => {
    const repo = tmp();
    openDb(repo).close();
    const db = openDb(repo);
    try {
      expect(migrate(db, MIGRATIONS_DIR)).toEqual([]);
      expect(db.prepare('SELECT count(*) AS n FROM schema_migrations').get()).toEqual({ n: readdirSync(MIGRATIONS_DIR).length });
    } finally {
      db.close();
    }
  });

  it('rolls back a failing migration and keeps the previous version', () => {
    const repo = tmp();
    const mig = tmp();
    writeFileSync(join(mig, '001-a.sql'), 'CREATE TABLE a (x);');
    writeFileSync(join(mig, '002-b.sql'), 'CREATE TABLE b (x); INSERT INTO nope VALUES (1);');
    expect(() => openDb(repo, { migrationsDir: mig })).toThrow(/migration 002-b\.sql failed/);
    const db = new DatabaseSync(join(repo, '.kanban95', 'board.db'));
    expect(db.prepare('SELECT version FROM schema_migrations').all()).toEqual([{ version: '001-a.sql' }]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'b'").all()).toEqual([]);
    db.close();
  });
});

describe('schema constraints', () => {
  it('status accepts only the four columns, at the DB level', () => {
    const db = openDb(tmp());
    const ins = db.prepare("INSERT INTO tickets (title, status) VALUES ('t', ?)");
    for (const s of ['backlog', 'in_progress', 'testing', 'done']) expect(() => ins.run(s)).not.toThrow();
    for (const s of ['Backlog', 'review', '', 'needs_human']) expect(() => ins.run(s), s).toThrow(/CHECK constraint/);
    db.close();
  });

  it('depends_on cannot reference a nonexistent ticket', () => {
    const db = openDb(tmp());
    db.prepare("INSERT INTO tickets (title) VALUES ('a')").run();
    expect(() => db.prepare('INSERT INTO ticket_deps VALUES (1, 999)').run()).toThrow(/FOREIGN KEY/);
    expect(() => db.prepare('INSERT INTO ticket_deps VALUES (1, 1)').run()).toThrow(/CHECK constraint/);
    db.close();
  });

  it('a planner grant has no ticket and a worker grant must have one', () => {
    const db = openDb(tmp());
    db.prepare("INSERT INTO tickets (title) VALUES ('a')").run();
    const ins = db.prepare("INSERT INTO grants (token_hash, ticket_id, role, expires_at) VALUES (?, ?, ?, '2999-01-01T00:00:00Z')");
    expect(() => ins.run('h1', 1, 'planner')).toThrow(/CHECK constraint/);
    expect(() => ins.run('h2', null, 'worker')).toThrow(/CHECK constraint/);
    expect(() => ins.run('h3', null, 'planner')).not.toThrow();
    expect(() => ins.run('h4', 1, 'worker')).not.toThrow();
    db.close();
  });

  it('brain_fts follows brain through insert, update and delete', () => {
    const db = openDb(tmp());
    db.prepare("INSERT INTO brain (title, body, tags) VALUES ('sqlite wal', 'use wal mode', 'db')").run();
    const find = (q: string) => db.prepare('SELECT rowid FROM brain_fts WHERE brain_fts MATCH ?').all(q).length;
    expect(find('wal')).toBe(1);
    db.prepare("UPDATE brain SET body = 'use rollback journal' WHERE id = 1").run();
    expect(find('wal')).toBe(1); // title still matches
    expect(find('rollback')).toBe(1);
    db.prepare('DELETE FROM brain WHERE id = 1').run();
    expect(find('wal')).toBe(0);
    db.close();
  });
});
