// Per-repo SQLite board: <repo>/.kanban95/board.db, migrated from daemon/migrations/*.sql.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const MIGRATIONS_DIR = resolve(import.meta.dirname, '../migrations');
const INNER_GITIGNORE = 'board.db\nboard.db-*\nsessions/\n';

export function openDb(repo: string, opts: { migrationsDir?: string } = {}): DatabaseSync {
  const dir = join(repo, '.kanban95');
  mkdirSync(dir, { recursive: true });
  const ignore = join(dir, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, INNER_GITIGNORE);

  const db = new DatabaseSync(join(dir, 'board.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  try {
    migrate(db, opts.migrationsDir ?? MIGRATIONS_DIR);
  } catch (e) {
    db.close();
    throw e;
  }
  return db;
}

/** Applies each unapplied *.sql in name order, one transaction per file. A failing file is rolled back and stops the run. */
export function migrate(db: DatabaseSync, dir: string): string[] {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const done = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version as string));
  const applied: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    db.exec('BEGIN');
    try {
      db.exec(readFileSync(join(dir, file), 'utf8'));
      db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(file, new Date().toISOString());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${file} failed: ${(e as Error).message}`, { cause: e });
    }
    applied.push(file);
  }
  return applied;
}

/** SQLite constraint violations (primary result code 19) are the caller's fault, not the daemon's. */
export function isConstraintError(e: unknown): e is Error {
  return e instanceof Error && 'errcode' in e && ((e.errcode as number) & 0xff) === 19;
}
