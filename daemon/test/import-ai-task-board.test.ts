import './home.ts';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importBoard } from '../src/import-ai-task-board.ts';

let dir: string;
let oldPath: string;
let target: string;
let first: { code: number; lines: string[] };
let db: DatabaseSync;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'k95-import-'));
  const repo = join(dir, 'oldrepo');
  mkdirSync(join(repo, 'brain', 'knowledge'), { recursive: true });
  writeFileSync(join(repo, 'brain', 'knowledge', 'lesson.live.md'), '---\ntype: knowledge\nchannel: gotcha\ntitle: "Live lesson title"\ntags: [infra, sqlite]\n---\n\n# Live\n\nKeep this.\n');
  writeFileSync(join(repo, 'brain', 'knowledge', 'lesson.old.md'), '---\ntype: knowledge\nchannel: gotcha\ntitle: "Old lesson"\nstatus: superseded\nsuperseded_by: knowledge/lesson.live\n---\n\nGone.\n');

  oldPath = join(dir, 'tasks.db');
  const old = new DatabaseSync(oldPath);
  old.exec(`
    CREATE TABLE boards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      project_number INTEGER NOT NULL DEFAULT 0,
      repo_paths TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      board_id INTEGER NOT NULL,
      task_number INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('backlog', 'in_progress', 'completed', 'closed')),
      tags TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      deliverable TEXT NOT NULL DEFAULT '',
      session_handoff TEXT NOT NULL DEFAULT '',
      relevant_files TEXT NOT NULL DEFAULT '',
      agent_context TEXT NOT NULL DEFAULT '',
      acceptance_checks TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      author TEXT NOT NULL CHECK (author IN ('human', 'agent')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    );
    CREATE TABLE traps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      board_id INTEGER NOT NULL,
      file_key TEXT NOT NULL,
      content TEXT NOT NULL,
      source_ref TEXT NOT NULL DEFAULT '',
      superseded_by INTEGER
    );
  `);
  old.prepare('INSERT INTO boards (id, name, project_number, repo_paths) VALUES (1, ?, 1, ?), (2, ?, 3, ?)').run('Other', join(dir, 'none'), 'Mine', `${repo}\nC:/second`);
  const task = old.prepare('INSERT INTO tasks (id, board_id, task_number, title, description, status, tags, deliverable, agent_context, acceptance_checks, created_at, updated_at) VALUES (?, 2, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  task.run(10, 145, 'Completed one', 'Old description.', 'completed', '["UI","depends:P1-T3","depends:P3-T7","bad tag"]', 'A deliverable', 'Some context', '[]', '2026-07-12 05:34:56', '2026-07-23 04:03:56');
  task.run(11, 7, 'In progress one', '', 'in_progress', '[]', '', '', '[]', '2026-07-12 05:39:59', '2026-07-12 05:39:59');
  task.run(12, 9, 'Closed one', '', 'closed', '[]', '', '', '[{"cmd":"npm test","expect":0,"note":"from root"}]', '2026-07-12 05:39:59', '2026-07-12 05:39:59');
  old.prepare("INSERT INTO comments (task_id, author, content) VALUES (10, 'human', 'Operator said'), (11, 'agent', 'Agent said')").run();
  old.prepare("INSERT INTO traps (board_id, file_key, content, source_ref) VALUES (2, 'src/db.ts', 'Watch the WAL.', 'P3-T145')").run();
  old.close();

  target = join(dir, 'target');
  first = importBoard(oldPath, 'Mine', target);
  db = new DatabaseSync(join(target, '.kanban95', 'board.db'));
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const ticket = (id: number) => db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as Record<string, string>;

describe('import-ai-task-board', () => {
  it('imports and prints one line per table', () => {
    expect(first.code).toBe(0);
    expect(first.lines.slice(0, 3)).toEqual(['3 tasks -> 3 tickets', '2 comments -> 2 notes', '2 vault notes + 1 traps -> 2 brain rows']);
    expect(first.lines).toContain('dropped: knowledge/lesson.old.md (status: superseded)');
    expect(existsSync(`${oldPath}-wal`)).toBe(false);
  });

  it('keeps task numbers as ids and maps statuses', () => {
    expect((db.prepare('SELECT id, status FROM tickets ORDER BY id').all() as Record<string, unknown>[]).map((r) => ({ ...r })))
      .toEqual([{ id: 7, status: 'backlog' }, { id: 9, status: 'done' }, { id: 145, status: 'done' }]);
    expect(ticket(145).created_at).toBe('2026-07-12T05:34:56.000Z');
    expect(ticket(145).updated_at).toBe('2026-07-23T04:03:56.000Z');
  });

  it('writes the body sections, tags, criteria and dependencies', () => {
    expect(ticket(145).body).toBe('Imported from AI Task Board P3-T145\n\nOld description.\n\n## Deliverable\n\nA deliverable\n\n## Task context\n\nSome context\n\nDepended on P1-T3 on another board');
    expect(ticket(145).tags).toBe('ui');
    expect(first.lines).toContain('dropped: P3-T145 tag bad tag (not a-z, 0-9 and -)');
    expect(ticket(9).criteria).toBe('npm test -- from root');
    expect(db.prepare('SELECT ticket_id, depends_on_id FROM ticket_deps').all().map((r) => ({ ...r }))).toEqual([{ ticket_id: 145, depends_on_id: 7 }]);
  });

  it('maps comment authors to note roles', () => {
    expect(db.prepare('SELECT ticket_id, role, kind, body FROM notes ORDER BY id').all().map((r) => ({ ...r }))).toEqual([
      { ticket_id: 145, role: 'operator', kind: 'decision', body: 'Operator said' },
      { ticket_id: 7, role: 'worker', kind: 'decision', body: 'Agent said' },
    ]);
  });

  it('imports the live vault note and the trap, not the superseded note', () => {
    expect(db.prepare('SELECT title, body, tags FROM brain ORDER BY id').all().map((r) => ({ ...r }))).toEqual([
      { title: 'Live lesson title', body: '# Live\n\nKeep this.', tags: 'infra sqlite gotcha' },
      { title: 'Trap: src/db.ts', body: 'Watch the WAL.\nSource: P3-T145', tags: 'trap src/db.ts' },
    ]);
  });

  it('refuses a target that already has tickets, and an unknown board', () => {
    const again = importBoard(oldPath, 'Mine', target);
    expect(again.code).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM tickets').get() as { n: number }).n).toBe(3);
    const unknown = importBoard(oldPath, 'Nope', join(dir, 'other'));
    expect(unknown.code).toBe(1);
    expect(unknown.lines.slice(1)).toEqual(['  Mine', '  Other']);
    expect(existsSync(join(dir, 'other'))).toBe(false);
  });

  it('says so when the board has no vault', () => {
    const r = importBoard(oldPath, 'Other', join(dir, 'other-target'));
    expect(r.code).toBe(0);
    expect(r.lines).toContain(`no vault: ${join(dir, 'none', 'brain')} does not exist, brain notes skipped`);
  });
});
