import './home.ts';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createWorktree } from '../src/git.ts';
import { sessionsOf } from '../src/launcher.ts';
import { QUESTION_GONE, TYPED } from '../src/lifecycle.ts';
import { boot, db, git, landed, models, notes, post, repo, runs, send, srv, t, ticket, until } from './board.ts';

const inbox = async () => (await (await send('GET')('/api/inbox')).json()) as { ticket_id: number; kind: string; body: string }[];
const note = (id: number, role: string, kind: string, body: string) =>
  db.prepare('INSERT INTO notes (ticket_id, role, kind, body) VALUES (?, ?, ?, ?)').run(id, role, kind, body);
const workedOn = (id: number) => {
  const wt = createWorktree(repo, id).path;
  writeFileSync(join(wt, `t-${id}.txt`), 'done\n');
  execFileSync('git', ['add', '.'], { cwd: wt });
  execFileSync('git', ['commit', '-qm', 'Work'], { cwd: wt });
};

describe('stale questions', { timeout: 60_000 }, () => {
  it('the Inbox shows one entry per ticket, its newest open question', async () => {
    const id = ticket('Asked twice', { status: 'in_progress', needs_human: 1 });
    note(id, 'worker', 'question', 'old question');
    note(id, 'worker', 'failure', 'agent exited without reporting');
    note(id, 'worker', 'question', 'new question');
    expect((await inbox()).map((e) => [e.ticket_id, e.body])).toEqual([[id, 'new question']]);
    note(id, 'operator', 'answer', 'yes');
    expect(await inbox()).toEqual([]);
  });

  it('an answer typed in the agent terminal closes its question and the worker moves on', async () => {
    const id = ticket('Paint it', { model: 'ask' });
    await post(`/api/tickets/${id}/launch`);
    await until(() => t(id).flags.needs_human, 'the question');
    const [s] = sessionsOf(id);
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/pty/${s.runId}`, { origin: `http://127.0.0.1:${srv.port}`, headers: { cookie: `k95=${srv.secret}` } });
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ data: 'gr' }));
    await new Promise((r) => setTimeout(r, 200));
    expect(t(id).flags.needs_human).toBe(true);
    ws.send(JSON.stringify({ data: 'een\r' }));
    await until(() => !t(id).flags.needs_human, 'the flag cleared');
    expect(notes(id, 'answer')).toEqual([TYPED]);
    expect(await inbox()).toEqual([]);
    ws.close();
    await landed(id);
    expect(git('show', 'HEAD:answer.txt')).toBe('green');
  });

  it('answering a question whose agent is gone on a ticket in testing starts the tester', async () => {
    const id = ticket('Stuck in testing', { status: 'testing', needs_human: 1 });
    workedOn(id);
    note(id, 'worker', 'question', 'Ship it?');
    expect((await inbox()).map((e) => e.body)).toEqual(['Ship it?']);
    const r = await post(`/api/tickets/${id}/answer`, { answer: 'yes' });
    expect(r.status).toBe(200);
    expect((await r.json()).flags.needs_human).toBe(false);
    expect(notes(id, 'answer')).toEqual(['yes [agent level 0, unchanged]']);
    await landed(id);
    expect(runs(id).map((x) => [x.phase, x.outcome])).toEqual([['test', 'pass']]);
  });

  it('a daemon restart closes an open question whose agent it killed, clears the flag and starts the agent again', async () => {
    models({ test: 'hang' });
    const id = ticket('Asked before the restart', { status: 'testing', needs_human: 1 });
    workedOn(id);
    note(id, 'worker', 'question', 'Ship it?');
    await srv.close();
    await boot();
    expect(notes(id, 'answer')).toEqual([QUESTION_GONE]);
    expect(t(id).flags.needs_human).toBe(false);
    expect(await inbox()).toEqual([]);
    await until(() => sessionsOf(id).length, 'the tester');
    expect(runs(id).map((x) => x.phase)).toEqual(['test']);
  });
});
