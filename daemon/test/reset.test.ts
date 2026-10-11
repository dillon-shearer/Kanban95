// Reset to Backlog from a REST client (docs/LIFECYCLE.md → Reset to Backlog): the PATCH alone stops the ticket's agents; so does a move by hand to any other column.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readTicket } from '../src/api.ts';
import { worktreePath } from '../src/git.ts';
import { sessions } from '../src/launcher.ts';
import { start } from '../src/server.ts';

// Stays up doing nothing until it is killed.
const FAKE = `console.log('FAKE');\nprocess.stdin.resume();\n`;
const bin = mkdtempSync(join(tmpdir(), 'k95-bin-'));
const PATH0 = process.env.PATH;
let repo: string;
let srv: Awaited<ReturnType<typeof start>>;
const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
const request = (method: string, path: string, body?: unknown) => fetch(`http://127.0.0.1:${srv.port}${path}`, {
  method, headers: { 'content-type': 'application/json', cookie: `k95=${srv.secret}` }, body: body === undefined ? undefined : JSON.stringify(body),
});
const until = async (f: () => unknown, what: string, ms = 30_000) => {
  const end = Date.now() + ms;
  while (!(await f())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

beforeAll(async () => {
  writeFileSync(join(bin, 'fake.mjs'), FAKE);
  writeFileSync(join(bin, 'claude.cmd'), `@node "%~dp0fake.mjs" %*\r\n`);
  process.env.PATH = bin + delimiter + PATH0;
  mkdirSync(join(process.env.USERPROFILE!, '.kanban95'), { recursive: true });
  writeFileSync(join(process.env.USERPROFILE!, '.kanban95', 'models.json'), JSON.stringify({
    cli: 'claude', claude: { execute: { model: 'work', effort: 'low' }, test: { model: 'test', effort: 'low' } },
  }));
  repo = mkdtempSync(join(tmpdir(), 'k95-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  git('config', 'user.name', 'Op Erator');
  git('config', 'user.email', 'op@example.com');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git('add', 'a.txt');
  git('commit', '-qm', 'init');
  srv = await start({ repo });
});
afterAll(async () => {
  await srv.close();
  process.env.PATH = PATH0;
  rmSync(repo, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 }); // a killed agent can hold it for seconds under load
  rmSync(bin, { recursive: true, force: true });
});

describe('reset to backlog', { timeout: 60_000 }, () => {
  it.each(['in_progress', 'testing'])('a PATCH to backlog from %s ends the agent with outcome reset, unflagged, worktree kept', async (from) => {
    const { db } = srv;
    const id = Number(db.prepare('INSERT INTO tickets (title) VALUES (?)').run(`Reset from ${from}`).lastInsertRowid);
    expect((await request('POST', `/api/tickets/${id}/launch`)).status).toBe(200);
    if (from === 'testing') db.prepare("UPDATE tickets SET status = 'testing' WHERE id = ?").run(id);
    const live = async () => (await (await request('GET', '/api/sessions')).json()) as { ticket_id: number; grant_id: number; run_id: number }[];
    const [s] = (await live()).filter((x) => x.ticket_id === id);
    expect(s).toBeDefined();
    // The fake must have printed before the kill (a kill on a silent console crashes node-pty; Working on the board → Tests).
    const pty = [...sessions.values()].find((x) => x.ticketId === id)!;
    await until(() => pty.scrollback().includes('FAKE'), 'the fake agent');

    expect((await request('PATCH', `/api/tickets/${id}`, { status: 'backlog' })).status).toBe(200);
    const t0 = Date.now();
    await until(async () => !(await live()).some((x) => x.ticket_id === id), 'the session to end', 5_000);
    expect(Date.now() - t0).toBeLessThan(1_000);
    await pty.done;

    expect(db.prepare('SELECT outcome FROM runs WHERE id = ?').get(s.run_id)).toEqual({ outcome: 'reset' });
    expect(db.prepare('SELECT revoked_at IS NOT NULL AS r FROM grants WHERE id = ?').get(s.grant_id)).toEqual({ r: 1 });
    expect(readTicket(db, id)).toMatchObject({ status: 'backlog', flags: { needs_human: false } });
    expect(existsSync(worktreePath(repo, id))).toBe(true);
  });

  it('a PATCH that does not set backlog stops nothing', async () => {
    const { db } = srv;
    const id = Number(db.prepare('INSERT INTO tickets (title) VALUES (?)').run('Edited').lastInsertRowid);
    expect((await request('POST', `/api/tickets/${id}/launch`)).status).toBe(200);
    const pty = [...sessions.values()].find((x) => x.ticketId === id)!;
    await until(() => pty.scrollback().includes('FAKE'), 'the fake agent');
    expect((await request('PATCH', `/api/tickets/${id}`, { title: 'Edited again', status: 'in_progress' })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 500));
    expect(sessions.has(pty.key)).toBe(true);
    expect((await request('PATCH', `/api/tickets/${id}`, { status: 'backlog' })).status).toBe(200);
    await pty.done;
  });

  it('a PATCH to another column ends the agent with outcome moved and clears the flag', async () => {
    const { db } = srv;
    const id = Number(db.prepare('INSERT INTO tickets (title) VALUES (?)').run('Moved by hand').lastInsertRowid);
    expect((await request('POST', `/api/tickets/${id}/launch`)).status).toBe(200);
    const pty = [...sessions.values()].find((x) => x.ticketId === id)!;
    await until(() => pty.scrollback().includes('FAKE'), 'the fake agent');
    db.prepare('UPDATE tickets SET needs_human = 1 WHERE id = ?').run(id);
    expect((await request('PATCH', `/api/tickets/${id}`, { status: 'testing' })).status).toBe(200);
    await pty.done;
    expect(db.prepare('SELECT outcome FROM runs WHERE id = ?').get(pty.runId)).toEqual({ outcome: 'moved' });
    expect(readTicket(db, id)).toMatchObject({ status: 'testing', flags: { needs_human: false } });
    expect(sessions.has(pty.key)).toBe(false);
  });

  it('a PATCH into done with no branch closes the ticket as merged and unflagged', async () => {
    const { db } = srv;
    const id = Number(db.prepare("INSERT INTO tickets (title, status, needs_human) VALUES ('No branch', 'in_progress', 1)").run().lastInsertRowid);
    expect((await request('PATCH', `/api/tickets/${id}`, { status: 'done' })).status).toBe(200);
    expect(readTicket(db, id)).toMatchObject({ status: 'done', flags: { needs_human: false } });
    expect(readTicket(db, id).merged_at).not.toBeNull();
  });
});
