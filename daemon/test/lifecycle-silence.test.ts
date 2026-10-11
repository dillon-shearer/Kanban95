// Silent agents and worktree_setup on a fake `claude` (board.ts).
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { worktreePath } from '../src/git.ts';
import { sessionsOf } from '../src/launcher.ts';
import { SILENCE } from '../src/lifecycle.ts';
import { db, git, models, notes, post, repo, runs, sounds, t, ticket, until } from './board.ts';

describe('silent agents', { timeout: 60_000 }, () => {
  // One minute of idle_minutes lasts 400 ms here; the watch looks every 50 ms. Set before the outer beforeEach starts the daemon.
  const silence0 = { ...SILENCE };
  const settingsFile = () => join(process.env.USERPROFILE!, '.kanban95', 'settings.json');
  beforeAll(() => Object.assign(SILENCE, { every: 50, minute: 400 }));
  afterAll(() => Object.assign(SILENCE, silence0));
  beforeEach(() => writeFileSync(settingsFile(), JSON.stringify({ idle_minutes: 1 })));
  afterEach(() => rmSync(settingsFile(), { force: true }));

  it('a live agent whose transcript gains no line for idle_minutes is flagged once, with the minutes and its last terminal lines', async () => {
    const id = ticket('Frozen', { model: 'hang' });
    const at = Date.now();
    await post(`/api/tickets/${id}/launch`);
    await until(() => t(id).flags.needs_human, 'the silence flag', 10_000);
    expect(Date.now() - at).toBeGreaterThanOrEqual(400);
    const [note] = notes(id, 'failure');
    expect(note).toMatch(/^agent silent for 1 min: its transcript has had no new line since \d{4}-\d\d-\d\dT[\d:.]+Z\. Last lines of its terminal:\n```\n/);
    expect(note).toMatch(/\nFAKE hang\n```\nTo resolve: open its terminal .*Restart/);
    expect(sounds).toEqual([{ sound: 'chord', ticket: id }]);
    expect(sessionsOf(id)).toHaveLength(1); // flagged, not ended: the operator decides
    await new Promise((r) => setTimeout(r, 1000)); // more than twice the limit again
    expect(notes(id, 'failure')).toHaveLength(1);
    expect(sounds).toHaveLength(1);
  });

  it('an agent that keeps writing to its transcript is not flagged, however long it runs', async () => {
    const id = ticket('Busy', { model: 'chatty' });
    await post(`/api/tickets/${id}/launch`);
    await until(() => sessionsOf(id).length === 1, 'the agent');
    await new Promise((r) => setTimeout(r, 2000)); // five times the limit
    expect(t(id).flags.needs_human).toBe(false);
    expect(notes(id, 'failure')).toEqual([]);
    expect(sounds).toEqual([]);
  });

  it('a flagged agent that writes again is unflagged by itself; the note stays as the record', async () => {
    const id = ticket('Slow start', { model: 'nap' });
    await post(`/api/tickets/${id}/launch`);
    await until(() => t(id).flags.needs_human, 'the silence flag', 10_000);
    await until(() => !t(id).flags.needs_human, 'the flag cleared', 10_000);
    expect(notes(id, 'failure')).toHaveLength(1);
    expect(sessionsOf(id)).toHaveLength(1);
  });

  it('a flag raised by a question is not cleared when the transcript grows', async () => {
    const id = ticket('Asks while slow', { model: 'nap' });
    await post(`/api/tickets/${id}/launch`);
    await until(() => t(id).flags.needs_human, 'the silence flag', 10_000);
    db.prepare("INSERT INTO notes (ticket_id, role, kind, body) VALUES (?, 'worker', 'question', 'Which colour?')").run(id); // as ask_operator writes it
    await new Promise((r) => setTimeout(r, 2500)); // the nap is over and the transcript grows
    expect(t(id).flags.needs_human).toBe(true);
  });
});

describe('worktree_setup', { timeout: 60_000 }, () => {
  // setup.mjs logs the first PATH entry and waits for a `go` file in the worktree; fail.mjs prints 30 lines and exits 2.
  beforeEach(() => {
    writeFileSync(join(repo, 'setup.mjs'), `import { appendFileSync, existsSync } from 'node:fs';
appendFileSync('setup.log', process.env.PATH.split(${JSON.stringify(delimiter)})[0] + '\\n');
while (!existsSync('go')) await new Promise((r) => setTimeout(r, 25));
`);
    writeFileSync(join(repo, 'fail.mjs'), "for (let i = 0; i < 30; i++) console.log('line ' + i);\nprocess.exit(2);\n");
    git('add', 'setup.mjs', 'fail.mjs');
    git('commit', '-qm', 'Add setup scripts');
  });
  const setup = (command: string) => writeFileSync(join(repo, '.kanban95', 'config.json'), JSON.stringify({ worktree_setup: command }));
  const wt = (id: number, file: string) => join(worktreePath(repo, id), file);

  it('runs once in a new worktree before the first agent, with the agent PATH; a resumed run in that worktree does not rerun it', async () => {
    models({ execute: 'silent' });
    setup('node setup.mjs');
    const id = ticket('Needs deps');
    expect((await post(`/api/tickets/${id}/launch`)).status).toBe(200);
    await until(() => existsSync(wt(id, 'setup.log')), 'the setup command');
    expect(readFileSync(wt(id, 'setup.log'), 'utf8')).toBe(`${dirname(process.execPath)}\n`);
    expect(runs(id)).toEqual([]); // no agent while setup runs, and a second launch is refused
    expect((await post(`/api/tickets/${id}/launch`)).status).toBe(409);
    writeFileSync(wt(id, 'go'), '');
    await until(() => t(id).flags.needs_human, 'the silent agent to exit');
    expect(runs(id)).toHaveLength(1);

    expect((await post(`/api/tickets/${id}/resume`)).status).toBe(200);
    await until(() => runs(id).length === 2 && existsSync(wt(id, 'resumed.json')), 'the resumed agent'); // the fake stays up when resumed
    expect(readFileSync(wt(id, 'setup.log'), 'utf8').split('\n').filter(Boolean)).toHaveLength(1);
  });

  it('a failing command stops the launch with a note naming it and its last output lines; a retry runs it again', async () => {
    models({ execute: 'silent' });
    setup('node fail.mjs');
    const id = ticket('Broken deps');
    expect((await post(`/api/tickets/${id}/launch`)).status).toBe(200);
    await until(() => t(id).flags.needs_human, 'the setup failure');
    const [note] = notes(id, 'failure');
    expect(note).toMatch(/^launch failed: worktree_setup "node fail\.mjs" failed \(2\) in .*t-1; last output:\nline 10\n/);
    expect(note).toContain('line 29');
    expect(note).not.toContain('line 9\n');
    expect(runs(id)).toEqual([]);
    expect(sessionsOf(id)).toEqual([]);

    setup('node setup.mjs'); // fixed: no marker was left, so the resume runs setup
    expect((await post(`/api/tickets/${id}/resume`)).status).toBe(200);
    await until(() => existsSync(wt(id, 'setup.log')), 'the setup command on resume');
    writeFileSync(wt(id, 'go'), '');
    await until(() => runs(id).length === 1, 'the agent after setup');
  });

  it('a malformed worktree_setup is a launch failure naming the key', async () => {
    setup('');
    const id = ticket('Bad config');
    await post(`/api/tickets/${id}/launch`);
    expect(notes(id, 'failure')[0]).toMatch(/^launch failed: .*config\.json worktree_setup must be a non-empty string/);
  });
});
