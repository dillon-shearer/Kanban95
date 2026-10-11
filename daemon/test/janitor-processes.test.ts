// The janitor's sweep kills an agent process that outlived its session (a daemon crash, a hard reset), found by the session
// dir on its command line, and leaves a live session's process and another board's alone.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.ts';
import { sweep } from '../src/janitor.ts';
import { sessions, type Session } from '../src/launcher.ts';
import { removeTemp } from './home.ts';

let repo: string;
let other: string;
let db: DatabaseSync;
const children: ChildProcess[] = [];

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const agent = (root: string, key: number) => {
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', join(root, '.kanban95', 'sessions', String(key), 'prompt.md')], { stdio: 'ignore', windowsHide: true });
  children.push(c);
  return c.pid!;
};

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'k95-orphans-'));
  other = mkdtempSync(join(tmpdir(), 'k95-orphans-other-'));
  db = openDb(repo);
});
afterAll(() => {
  for (const c of children) c.kill();
  sessions.delete(7001);
  db.close();
  removeTemp(repo);
  removeTemp(other);
});

describe('orphaned agent processes', () => {
  it("kills one naming a session dir no session holds, and leaves a live session's and another repo's alone", async () => {
    sessions.set(7001, { key: 7001 } as Session);
    const orphan = agent(repo, 7002);
    const live = agent(repo, 7001);
    const foreign = agent(other, 7003);
    await sweep({ db, repo });
    const end = Date.now() + 5000;
    while (alive(orphan) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    expect(alive(orphan)).toBe(false);
    expect(alive(live)).toBe(true);
    expect(alive(foreign)).toBe(true);
    const rows = db.prepare("SELECT args_summary AS args, outcome FROM audit WHERE tool = 'janitor.process'").all() as { args: string; outcome: string }[];
    expect(rows).toEqual([{ args: JSON.stringify({ pid: orphan, key: 7002 }), outcome: 'ok' }]);
  });
});
