// Daemon restarts and recovery on a fake `claude` (board.ts): the stale flag, the janitor, Resume, Restart and Reject.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorktree, worktreePath, worktreesRoot } from '../src/git.ts';
import { mint } from '../src/grants.ts';
import { RESUME_MESSAGE, sessionsOf } from '../src/launcher.ts';
import { DIRTY_WAIT, RESTART_NOTE, RESTARTED, TO_RESOLVE, type Status } from '../src/lifecycle.ts';
import { boot, db, git, landed, models, notes, post, repo, runs, sounds, srv, t, ticket, until } from './board.ts';

describe('stale daemon after a merge', { timeout: 60_000 }, () => {
  const stale = async () => (await (await fetch(`http://127.0.0.1:${srv.port}/api/runner`, { headers: { cookie: `k95=${srv.secret}` } })).json()).stale;
  const merged = async (dir: string, want: string | false) => {
    models({ execute: `touch-${dir}` });
    const id = ticket(`Change ${dir}`);
    expect(await stale()).toBe(false);
    expect((await post(`/api/tickets/${id}/launch`)).status).toBe(200);
    await landed(id);
    expect(git('show', '--stat', '--format=', 'HEAD')).toContain(`${dir}/`);
    expect(await stale()).toBe(want);
  };
  it.each([['shell', 'shell'], ['ui', false], ['docs', false]] as const)('a merge touching %s/ reports stale: %s', merged);
  // The daemon row, and what a restart then reports: one merge for both.
  it('a merge touching daemon/ reports stale: daemon; a daemon started on the merged commit is not stale', async () => {
    await merged('daemon', 'daemon');
    await srv.close();
    await boot();
    expect(await stale()).toBe(false);
  });
  it('a repo with no commits starts and is not stale', async () => {
    await srv.close();
    rmSync(join(repo, '.git'), { recursive: true, force: true, maxRetries: 5 });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    await boot();
    expect(srv.board.startCommit).toBeUndefined();
    expect(await stale()).toBe(false);
  });
});

describe('janitor on daemon start', () => {
  it('removes orphan worktrees, session dirs, grants and runs; keeps unmerged work and flags its ticket', async () => {
    const kept = ticket('Unfinished', { status: 'in_progress' });
    const merged = ticket('Shipped', { status: 'done', merged_at: '2026-01-01T00:00:00.000Z' });
    const keptWt = createWorktree(repo, kept).path;
    writeFileSync(join(keptWt, 'wip.txt'), 'uncommitted work');
    createWorktree(repo, merged);
    createWorktree(repo, 99); // no such ticket
    mkdirSync(worktreePath(repo, 98));
    writeFileSync(join(worktreePath(repo, 98), 'junk'), 'x');
    mkdirSync(join(repo, '.kanban95', 'sessions', '4242'), { recursive: true });
    const grant = mint(db, { ticket: kept, role: 'worker', ttlMs: 60_000 });
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    const ins = db.prepare("INSERT INTO runs (ticket_id, phase, cli, model, effort, prompt_rendered, ended_at, outcome, scrollback) VALUES (?, 'execute', 'claude', 'm', 'low', 'p', ?, ?, ?)");
    const oldRun = Number(ins.run(kept, old, 'submit', 'old screen').lastInsertRowid);
    const newRun = Number(ins.run(kept, new Date().toISOString(), 'submit', 'new screen').lastInsertRowid);
    const openRun = Number(ins.run(kept, null, null, null).lastInsertRowid);
    await srv.close();

    models({ execute: 'hang' });
    await boot();
    expect(readdirSync(worktreesRoot(repo))).toEqual([`t-${kept}`]);
    expect(readFileSync(join(keptWt, 'wip.txt'), 'utf8')).toBe('uncommitted work');
    expect(git('branch', '--list', 'ticket/99', `ticket/${merged}`)).toBe('');
    expect(readdirSync(join(repo, '.kanban95', 'sessions'))).not.toContain('4242'); // the resumed run has its own
    expect((db.prepare('SELECT revoked_at FROM grants WHERE id = ?').get(grant.id) as { revoked_at: string | null }).revoked_at).not.toBeNull();
    const run = (id: number) => db.prepare('SELECT scrollback, outcome, ended_at FROM runs WHERE id = ?').get(id) as Record<string, unknown>;
    expect(run(oldRun)).toMatchObject({ scrollback: null, outcome: 'submit' });
    expect(run(newRun)).toMatchObject({ scrollback: 'new screen' });
    expect(run(openRun)).toMatchObject({ outcome: 'lost', ended_at: expect.any(String) });
    expect(t(kept).flags.needs_human).toBe(false); // resumed, see 'resume' below
    expect(notes(kept, 'failure')).toEqual([RESTARTED]);
    const tools = (db.prepare("SELECT tool, count(*) AS n FROM audit WHERE tool LIKE 'janitor.%' GROUP BY tool ORDER BY tool").all() as { tool: string; n: number }[]);
    expect(tools).toEqual([
      { tool: 'janitor.grant', n: 1 }, { tool: 'janitor.run', n: 1 }, { tool: 'janitor.scrollback', n: 1 },
      { tool: 'janitor.session', n: 1 }, { tool: 'janitor.worktree', n: 3 },
    ]);
  });
});

describe('janitor on a locked leftover', () => {
  it('audits the failure and the daemon still starts', async () => {
    const dir = join(worktreePath(repo, 97), 'target');
    mkdirSync(dir, { recursive: true });
    await srv.close();
    // A live process sitting in the directory is what Windows refuses to delete.
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: dir, stdio: 'ignore' });
    try {
      await boot();
      const row = db.prepare("SELECT outcome FROM audit WHERE tool = 'janitor.worktree' ORDER BY id DESC LIMIT 1").get() as { outcome: string };
      expect(row.outcome).toBe(process.platform === 'win32' ? 'error' : 'ok');
    } finally {
      holder.kill();
    }
  });
});

describe('resume', { timeout: 60_000 }, () => {
  const flagged = (title: string, status: Status, retry = 1) => {
    const id = ticket(title, { status, needs_human: 1, retry });
    createWorktree(repo, id);
    db.prepare("INSERT INTO notes (ticket_id, role, kind, body) VALUES (?, 'worker', 'failure', 'agent exited without reporting')").run(id);
    return id;
  };

  it('starts the phase agent again in the same worktree with the failure note; retry kept, flag cleared; refused while it runs', async () => {
    models({ execute: 'hang', test: 'hang' });
    const work = flagged('Was working', 'in_progress');
    const test = flagged('Was testing', 'testing');
    for (const [id, phase] of [[work, 'execute'], [test, 'test']] as const) {
      expect((await post(`/api/tickets/${id}/resume`)).status).toBe(200);
      expect(t(id)).toMatchObject({ status: phase === 'test' ? 'testing' : 'in_progress', retry: 1, flags: { needs_human: false } });
      expect(runs(id).map((r) => r.phase)).toEqual([phase]);
      expect(runs(id)[0].prompt_rendered).toContain('agent exited without reporting');
      expect(sessionsOf(id)).toHaveLength(1);
    }
    for (const verb of ['resume', 'launch']) {
      const r = await post(`/api/tickets/${work}/${verb}`);
      expect(r.status).toBe(409);
      expect((await r.json()).error).toMatch(/already has a running agent; open its terminal, or Reset to Backlog to stop it/);
    }
  });

  it('Launch on a flagged running ticket with no agent resumes it', async () => {
    models({ execute: 'hang' });
    const id = flagged('Launch me again', 'in_progress', 2);
    expect((await post(`/api/tickets/${id}/launch`)).status).toBe(200);
    expect(t(id)).toMatchObject({ status: 'in_progress', retry: 2, flags: { needs_human: false } });
    expect(sessionsOf(id)).toHaveLength(1);
  });

  it('is refused for an unflagged running ticket, and in backlog and done', async () => {
    const unflagged = ticket('Fine', { status: 'in_progress' });
    const backlog = ticket('Waiting');
    const done = ticket('Shipped', { status: 'done', needs_human: 1 });
    for (const [id, why] of [[unflagged, 'it is not flagged'], [backlog, 'in backlog'], [done, 'in done']] as const) {
      const r = await post(`/api/tickets/${id}/resume`);
      expect(r.status).toBe(409);
      expect((await r.json()).error).toContain(why);
    }
    expect(runs(unflagged)).toEqual([]);
  });

  it('an agent killed by the board shutting down is not flagged, so the next start resumes it (Restart board)', async () => {
    models({ execute: 'hang' });
    const id = ticket('Live');
    expect((await post(`/api/tickets/${id}/launch`)).status).toBe(200);
    await until(() => sessionsOf(id).length, 'the agent');
    await srv.close();
    await boot();
    expect(notes(id, 'failure')).toEqual([RESTARTED]); // no 'agent exited without reporting' from the shutdown
    expect(t(id).flags.needs_human).toBe(false);
    expect(runs(id)).toHaveLength(2);
    expect(runs(id)[1].prompt_rendered).toContain(RESTARTED);
  });

  // The fake keeps a transcript per --session-id; resumed.json is what a session started with --resume saw.
  const resumed = (id: number) => join(worktreePath(repo, id), 'resumed.json');
  const launchedClaude = async (id: number) => {
    expect((await post(`/api/tickets/${id}/launch`)).status).toBe(200);
    const [s] = sessionsOf(id);
    await until(() => s.scrollback().includes('FAKE'), 'the agent');
    return s;
  };
  const transcript = (sessionId: string) => readdirSync(join(process.env.USERPROFILE!, '.claude', 'projects'), { recursive: true, encoding: 'utf8' })
    .find((f) => f.endsWith(`${sessionId}.jsonl`));

  it('a Claude launch carries --session-id and stores the id on its run', async () => {
    models({ execute: 'hang' });
    const id = ticket('Named session');
    await launchedClaude(id);
    const [run] = runs(id);
    expect(run.session_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(transcript(run.session_id!)).toBeDefined(); // the fake got it as --session-id
  });

  it('after Restart board, recovery continues the killed conversation with --resume <stored id> and a new grant', async () => {
    models({ execute: 'hang' });
    const id = ticket('Resume me');
    const old = await launchedClaude(id);
    const sessionId = runs(id)[0].session_id!;
    await srv.close();
    await boot();
    await until(() => existsSync(resumed(id)), 'the resumed session');
    const seen = JSON.parse(readFileSync(resumed(id), 'utf8')) as { argv: string[]; auth: string };
    expect(seen.argv.slice(seen.argv.indexOf('--resume'), seen.argv.indexOf('--resume') + 2)).toEqual(['--resume', sessionId]);
    expect(seen.argv).not.toContain('--session-id');
    expect(seen.argv.at(-1)).toBe(RESUME_MESSAGE);
    expect(runs(id).map((r) => r.session_id)).toEqual([sessionId, sessionId]);
    const [now] = sessionsOf(id);
    expect(now.grantId).not.toBe(old.grantId);
    expect(seen.auth).toMatch(/^Bearer [\w-]{43}$/);
    const grant = (g: number) => db.prepare('SELECT revoked_at FROM grants WHERE id = ?').get(g) as { revoked_at: string | null };
    expect(grant(old.grantId).revoked_at).not.toBeNull();
    expect(grant(now.grantId).revoked_at).toBeNull();
    expect(t(id).flags.needs_human).toBe(false);
  });

  it('Resume of a flagged ticket continues the conversation; Restart starts a fresh one', async () => {
    models({ execute: 'hang' });
    const id = ticket('Crashed');
    const old = await launchedClaude(id);
    const sessionId = runs(id)[0].session_id!;
    old.pty.kill(); // the agent died: exit flags the ticket
    await until(() => t(id).flags.needs_human, 'the flag');
    expect((await post(`/api/tickets/${id}/resume`)).status).toBe(200);
    await until(() => existsSync(resumed(id)), 'the resumed session');
    expect(JSON.parse(readFileSync(resumed(id), 'utf8')).argv).toEqual(expect.arrayContaining(['--resume', sessionId]));
    expect(runs(id)[1].session_id).toBe(sessionId);
    rmSync(resumed(id));
    await until(() => sessionsOf(id)[0]?.scrollback().includes('FAKE RESUMED'), 'the resumed agent to print'); // before its kill (board.ts)
    expect((await post(`/api/tickets/${id}/restart`)).status).toBe(200);
    await until(() => runs(id).length === 3 && sessionsOf(id).length === 1, 'the restarted agent');
    expect(runs(id)[2].session_id).not.toBe(sessionId);
    expect(existsSync(resumed(id))).toBe(false);
  });

  it('a missing transcript falls back to a fresh session with the brief', async () => {
    models({ execute: 'hang' });
    const id = ticket('Transcript gone');
    await launchedClaude(id);
    const sessionId = runs(id)[0].session_id!;
    await srv.close();
    rmSync(join(process.env.USERPROFILE!, '.claude', 'projects', transcript(sessionId)!));
    await boot();
    await until(() => sessionsOf(id).length, 'the fresh agent');
    const [, fresh] = runs(id);
    expect(fresh.session_id).not.toBe(sessionId);
    await until(() => transcript(fresh.session_id!), 'the fresh session id passed as --session-id');
    expect(existsSync(resumed(id))).toBe(false);
    expect(fresh.prompt_rendered).toContain(RESTARTED);
  });

  it('restart resumes a running ticket once by itself; an agent that then exits silently flags it with what to do', async () => {
    const id = ticket('Cut off', { status: 'in_progress', retry: 1 });
    createWorktree(repo, id);
    await srv.close();
    models({ execute: 'silent' });
    await boot();
    expect(runs(id)).toHaveLength(1);
    expect(runs(id)[0].prompt_rendered).toContain(RESTARTED);
    await until(() => t(id).flags.needs_human, 'the flag after the silent exit');
    expect(notes(id, 'failure')).toEqual([RESTARTED, `agent exited without reporting\n${TO_RESOLVE}`]);
    expect(runs(id)).toHaveLength(1); // not resumed again
    expect(t(id).retry).toBe(1);
  });
});

describe('restart', { timeout: 60_000 }, () => {
  it('replaces a live agent in the same phase and worktree: old run ends as restart, no flag, status and retry kept, note in the prompt', async () => {
    models({ execute: 'hang', test: 'hang' });
    for (const [status, phase] of [['in_progress', 'execute'], ['testing', 'test']] as const) {
      const id = ticket(`Stuck ${status}`, { status, retry: 1 });
      const wt = createWorktree(repo, id);
      expect((await post(`/api/tickets/${id}/resume`)).status).toBe(409); // not flagged, so only launch starts it
      expect((await post(`/api/tickets/${id}/launch`)).status).toBe(200);
      const [old] = sessionsOf(id);
      await until(() => old.scrollback().includes('FAKE'), 'the agent to print'); // before its kill (board.ts)
      expect((await post(`/api/tickets/${id}/restart`)).status).toBe(200);
      await old.done;
      await until(() => runs(id)[0].outcome, 'the old run outcome');
      expect(runs(id).map((r) => [r.phase, r.outcome])).toEqual([[phase, 'restart'], [phase, null]]);
      expect(runs(id)[1].prompt_rendered).toContain(RESTART_NOTE);
      expect(sessionsOf(id)).toHaveLength(1);
      expect(sessionsOf(id)[0]).not.toBe(old);
      expect(existsSync(wt.path)).toBe(true);
      expect(t(id)).toMatchObject({ status, retry: 1, flags: { needs_human: false } });
      expect(notes(id, 'failure')).toEqual([RESTART_NOTE]); // the kill wrote no "exited without reporting"
      const audit = db.prepare("SELECT 1 FROM audit WHERE tool = 'tickets.restart'").get();
      expect(audit).toBeDefined();
    }
  });

  it('is refused in backlog', async () => {
    const id = ticket('Not started');
    const r = await post(`/api/tickets/${id}/restart`);
    expect(r.status).toBe(409);
    expect((await r.json()).error).toContain('cannot restart a ticket in backlog');
    expect(runs(id)).toEqual([]);
  });
});

describe('reject', { timeout: 60_000 }, () => {
  const REASON = 'The greeting is in English only.\nDone means it also greets in French.';
  const failed = (prompt: string) => prompt.slice(prompt.indexOf('## What failed on the last attempt'), prompt.indexOf('Retry count:'));

  it('needs a non-empty reason and a done ticket; a refusal changes nothing', async () => {
    const done = ticket('Shipped', { status: 'done' });
    for (const body of [undefined, {}, { reason: '' }, { reason: ' \n ' }, { reason: 3 }]) {
      const r = await post(`/api/tickets/${done}/reject`, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect((await r.json()).error).toBe('reason must be a non-empty string');
    }
    const running = ticket('Running', { status: 'in_progress' });
    const r = await post(`/api/tickets/${running}/reject`, { reason: 'no' });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toContain('cannot reject a ticket in in_progress');
    expect([t(done).status, t(running).status]).toEqual(['done', 'in_progress']);
    expect(runs(done)).toEqual([]);
    expect(db.prepare("SELECT outcome FROM audit WHERE tool = 'tickets.reject'").all()).toHaveLength(6);
    expect(db.prepare("SELECT count(*) AS n FROM notes").get()).toEqual({ n: 0 });
  });

  it('on a merged ticket: a fresh worktree holding the merged commit, retry 0, the reason in the prompt; a pass merges it again', async () => {
    const id = ticket('Add the greeting');
    await post(`/api/tickets/${id}/launch`);
    await landed(id);
    const first = git('rev-parse', 'HEAD');
    db.prepare('UPDATE tickets SET retry = 2 WHERE id = ?').run(id); // an earlier cycle's failed tests
    git('branch', 'ticket/1', first); // a branch left from the earlier cycle must not stop the launch

    models({ test: 'hang' });
    const r = await post(`/api/tickets/${id}/reject`, { reason: REASON });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: 'in_progress', retry: 0, flags: { needs_human: false } });
    expect(sessionsOf(id)).toHaveLength(1);
    const wt = worktreePath(repo, id);
    expect(existsSync(wt)).toBe(true);
    execFileSync('git', ['merge-base', '--is-ancestor', first, 'HEAD'], { cwd: wt }); // throws when the merged work is missing
    const prompt = runs(id).at(-1)!.prompt_rendered;
    expect(runs(id).map((x) => x.phase)).toEqual(['execute', 'test', 'execute']);
    expect(failed(prompt)).toContain(`- [operator] ${REASON.replace('\n', '\n  ')}`);
    expect(prompt).toContain('Retry count: 0 ');
    expect(db.prepare("SELECT outcome FROM audit WHERE tool = 'tickets.reject' AND ticket_id = ?").all(id)).toEqual([{ outcome: 'ok' }]);
    expect(sounds.filter((s) => s.sound === 'chord')).toEqual([]);

    // The tester printed before the restart kills it (board.ts).
    await until(() => t(id).status === 'testing' && sessionsOf(id).some((s) => s.phase === 'test' && s.scrollback().includes('FAKE')), 'the worker submitted again');
    models({ test: 'pass' });
    expect((await post(`/api/tickets/${id}/restart`)).status).toBe(200);
    await until(() => t(id).merged_at && !existsSync(wt) && git('rev-parse', 'HEAD') !== first, 'the second merge');
    expect(git('log', '--merges', '--format=%s', 'main').split('\n')).toEqual(['Add the greeting', 'Add the greeting']);
    expect(git('rev-parse', 'HEAD^1')).toBe(first);
    expect(t(id)).toMatchObject({ status: 'done', retry: 0, flags: { needs_human: false } });
  });

  describe('on a ticket waiting in the merge queue', () => {
    const wait0 = { ...DIRTY_WAIT };
    afterEach(() => Object.assign(DIRTY_WAIT, wait0));

    it('stops the merge from landing and sends it back to a worker in the same worktree', async () => {
      Object.assign(DIRTY_WAIT, { every: 50, max: 60_000 });
      const id = ticket('Add while dirty');
      expect((await post(`/api/tickets/${id}/launch`)).status).toBe(200);
      writeFileSync(join(repo, 'a.txt'), 'the operator is editing\n'); // the merge waits on the main checkout
      await until(() => t(id).status === 'done' && !sessionsOf(id).length, 'done, waiting to merge');
      const head = git('rev-parse', 'HEAD');

      models({ execute: 'hang' });
      expect((await post(`/api/tickets/${id}/reject`, { reason: REASON })).status).toBe(200);
      git('checkout', 'a.txt');
      await new Promise((r) => setTimeout(r, 500)); // several queue retries, each of which would merge a done ticket
      expect(git('rev-parse', 'HEAD')).toBe(head);
      expect(t(id)).toMatchObject({ status: 'in_progress', merged_at: null, retry: 0, flags: { needs_human: false } });
      expect(sessionsOf(id)).toHaveLength(1);
      expect(failed(runs(id).at(-1)!.prompt_rendered)).toContain('[operator] The greeting is in English only.');
      expect(existsSync(worktreePath(repo, id))).toBe(true);
    });
  });
});
