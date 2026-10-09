import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { readTicket } from '../src/api.ts';
import { createWorktree } from '../src/git.ts';
import { mint } from '../src/grants.ts';
import { sessions, sessionsOf } from '../src/launcher.ts';
import { DIRTY_WAIT, events, MAX_RETRY, Refused, RESTART_NOTE, RESTARTED, TABLE, TO_RESOLVE, transition, type Event, type Facts, type Status } from '../src/lifecycle.ts';
import { start } from '../src/server.ts';

describe('transition table', () => {
  const f = (o: Partial<Facts>): Facts => ({ status: 'backlog', needs_human: false, retry: 0, merged: false, depsMerged: true, passReported: false, live: true, ...o });
  // Written out by hand from docs/LIFECYCLE.md, not derived from TABLE, so a changed row fails here.
  const rows: [string, Partial<Facts>, Event, ReturnType<typeof transition>][] = [
    ['launch, deps merged', { status: 'backlog' }, 'launch', { to: 'in_progress', set: { blocked_on_deps: 0 }, effects: ['spawn_execute'] }],
    ['launch, deps not merged', { status: 'backlog', depsMerged: false }, 'launch', { to: 'backlog', set: { blocked_on_deps: 1 }, effects: [] }],
    ['launch on a running ticket whose agent is gone', { status: 'in_progress', live: false, needs_human: true }, 'launch', { to: 'in_progress', set: { needs_human: 0 }, effects: ['spawn_execute'] }],
    ['launch on a testing ticket whose agent is gone', { status: 'testing', live: false }, 'launch', { to: 'testing', set: { needs_human: 0 }, effects: ['spawn_test'] }],
    ['resume a flagged ticket in progress', { status: 'in_progress', live: false, needs_human: true, retry: 2 }, 'resume', { to: 'in_progress', set: { needs_human: 0 }, effects: ['spawn_execute'] }],
    ['resume a flagged ticket in testing', { status: 'testing', live: false, needs_human: true }, 'resume', { to: 'testing', set: { needs_human: 0 }, effects: ['spawn_test'] }],
    ['restart a live ticket in progress', { status: 'in_progress', retry: 2 }, 'restart', { to: 'in_progress', set: { needs_human: 0 }, effects: ['end_session', 'note', 'spawn_execute'] }],
    ['restart a flagged ticket in testing with no agent', { status: 'testing', live: false, needs_human: true }, 'restart', { to: 'testing', set: { needs_human: 0 }, effects: ['end_session', 'note', 'spawn_test'] }],
    ['worker submits', { status: 'in_progress' }, 'submit', { to: 'testing', set: {}, effects: ['end_session', 'spawn_test'] }],
    ['tester passes after report_test(pass)', { status: 'testing', passReported: true }, 'pass', { to: 'done', set: {}, effects: ['end_session', 'enqueue_merge'] }],
    ['first failure', { status: 'testing', retry: 0 }, 'fail', { to: 'in_progress', set: { retry: '+1' }, effects: ['end_session', 'spawn_execute'] }],
    ['third failure is the last retry', { status: 'testing', retry: MAX_RETRY - 1 }, 'fail', { to: 'in_progress', set: { retry: '+1' }, effects: ['end_session', 'spawn_execute'] }],
    ['fourth failure stops', { status: 'testing', retry: MAX_RETRY }, 'fail', { to: 'in_progress', set: { retry: '+1', needs_human: 1 }, effects: ['end_session', 'note', 'chord'] }],
    ['worker asks', { status: 'in_progress' }, 'ask', { to: 'in_progress', set: { needs_human: 1 }, effects: ['note', 'chord'] }],
    ['tester asks', { status: 'testing' }, 'ask', { to: 'testing', set: { needs_human: 1 }, effects: ['note', 'chord'] }],
    ['operator answers', { status: 'in_progress', needs_human: true }, 'answer', { to: 'in_progress', set: { needs_human: 0 }, effects: ['note', 'answer_pty'] }],
    ['worker exits silently', { status: 'in_progress' }, 'exit', { to: 'in_progress', set: { needs_human: 1 }, effects: ['note', 'chord'] }],
    ['tester exits silently', { status: 'testing', live: false }, 'exit', { to: 'testing', set: { needs_human: 1 }, effects: ['note', 'chord'] }],
    ['merge ok', { status: 'done' }, 'merged', { to: 'done', set: { merged: true, needs_human: 0 }, effects: ['ding', 'remove_worktree', 'release_dependents', 'housekeeping'] }],
    ['base will not merge in on submit: back to the worker', { status: 'in_progress', retry: 0 }, 'conflict', { to: 'in_progress', set: { retry: '+1' }, effects: ['end_session', 'note', 'spawn_execute'] }],
    ['base will not merge in on submit at the retry cap stops', { status: 'in_progress', retry: MAX_RETRY }, 'conflict', { to: 'in_progress', set: { needs_human: 1 }, effects: ['end_session', 'note', 'chord'] }],
    ['merge conflict goes back to the worker', { status: 'done', retry: MAX_RETRY - 1 }, 'conflict', { to: 'in_progress', set: { retry: '+1' }, effects: ['end_session', 'note', 'spawn_execute'] }],
    ['merge conflict at the retry cap stops', { status: 'done', retry: MAX_RETRY }, 'conflict', { to: 'done', set: { needs_human: 1 }, effects: ['note', 'chord'] }],
    ['base still dirty after the wait', { status: 'done' }, 'dirty', { to: 'done', set: { needs_human: 1 }, effects: ['note', 'chord'] }],
    ['operator retries a failed merge', { status: 'done', needs_human: true }, 'merge', { to: 'done', set: {}, effects: ['enqueue_merge'] }],
  ];
  it.each(rows)('%s', (_, facts, event, want) => {
    expect(transition(f(facts), event)).toEqual(want);
  });

  const allowed: Record<Status, Event[]> = {
    backlog: ['launch'],
    in_progress: ['launch', 'resume', 'restart', 'submit', 'ask', 'answer', 'exit', 'conflict'],
    testing: ['launch', 'resume', 'restart', 'pass', 'fail', 'ask', 'answer', 'exit'],
    done: ['merged', 'conflict', 'merge', 'dirty'],
  };
  const EVENTS: Event[] = ['launch', 'submit', 'pass', 'fail', 'ask', 'answer', 'exit', 'merged', 'conflict', 'merge', 'dirty', 'resume', 'restart'];
  it('refuses every other event in every status', () => {
    let n = 0;
    for (const status of Object.keys(allowed) as Status[]) {
      for (const event of EVENTS.filter((e) => !allowed[status].includes(e))) {
        expect(() => transition(f({ status }), event), `${status} ${event}`).toThrow(Refused);
        n++;
      }
    }
    expect(n).toBe(4 * EVENTS.length - 21);
  });

  it('refuses a guarded row whose guard fails, saying why', () => {
    expect(() => transition(f({ status: 'testing' }), 'pass')).toThrow('cannot pass a ticket in testing: call report_test with passed: true first');
    expect(() => transition(f({ status: 'testing', needs_human: false }), 'answer')).toThrow(/no flagged question/);
    expect(() => transition(f({ status: 'testing', needs_human: true, live: false }), 'answer')).toThrow(/no flagged question/);
    expect(() => transition(f({ status: 'done', merged: true }), 'merge')).toThrow('cannot merge a ticket in done: already merged');
    const busy = 'it already has a running agent; open its terminal, or Reset to Backlog to stop it';
    expect(() => transition(f({ status: 'in_progress', needs_human: true }), 'launch')).toThrow(`cannot launch a ticket in in_progress: ${busy}`);
    expect(() => transition(f({ status: 'testing', needs_human: true }), 'resume')).toThrow(`cannot resume a ticket in testing: ${busy}`);
    expect(() => transition(f({ status: 'in_progress', live: false }), 'resume')).toThrow('cannot resume a ticket in in_progress: it is not flagged');
    expect(() => transition(f({ status: 'backlog', needs_human: true, live: false }), 'resume')).toThrow('cannot resume a ticket in backlog');
    expect(() => transition(f({ status: 'done', needs_human: true, live: false }), 'resume')).toThrow('cannot resume a ticket in done');
  });

  it('every row that raises needs_human writes one note, and all but a question end it with what resolves it', () => {
    const flagged = TABLE.filter((r) => r.set?.needs_human === 1);
    expect(flagged.map((r) => r.event)).toEqual(['fail', 'ask', 'exit', 'conflict', 'conflict', 'dirty']);
    for (const r of flagged) {
      expect(r.effects.filter((e) => e === 'note'), r.event).toHaveLength(1);
      expect(r.resolve === undefined, r.event).toBe(r.event === 'ask');
    }
    const fix = (e: Event, from: Status = 'done') => flagged.find((r) => r.event === e && r.from.includes(from))!.resolve!(7, 'C:/repo');
    expect(fix('conflict')).toMatch(/\.worktrees\/t-7 .*Retry merge/);
    expect(fix('conflict', 'in_progress')).toMatch(/\.worktrees\/t-7 .*uncommitted .*git merge .*Resume/);
    expect(fix('dirty')).toMatch(/main checkout \(C:\/repo\).*Retry merge/);
    expect(`To resolve: ${fix('exit', 'in_progress')}`).toBe(TO_RESOLVE);
  });
});

// Fake `claude` first on PATH: a scripted agent that talks to /mcp like the real CLI and stays up until the board ends it.
// The brief's heading says which phase it is in; the model name says how it behaves (see `behave` below).
const bin = mkdtempSync(join(tmpdir(), 'k95-bin-'));
const FAKE = `
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
const argv = process.argv.slice(2);
const model = argv[argv.indexOf('--model') + 1];
const mcp = JSON.parse(readFileSync(argv[argv.indexOf('--mcp-config') + 1], 'utf8')).mcpServers.kanban95;
const brief = readFileSync(/^Read (\\S+) in full/.exec(argv.at(-1))[1], 'utf8');
const name = basename(process.cwd());
let n = 0;
async function call(tool, args = {}) {
  const r = await fetch(mcp.url, {
    method: 'POST',
    headers: { ...mcp.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name: tool, arguments: args } }),
  });
  const j = await r.json();
  if (j.error || j.result.isError) console.log('REFUSED ' + tool + ' ' + JSON.stringify(j.error ?? j.result.content));
}
const commit = (file, text) => {
  writeFileSync(file, text);
  execFileSync('git', ['add', file]);
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'Add ' + file]); // a retry may rewrite the same content
};
const line = () => new Promise((ok) => process.stdin.setEncoding('utf8').once('data', (d) => ok(d.replace(/[\\r\\n]+$/, ''))));
console.log('FAKE ' + model);
if (brief.startsWith('# Test') && model !== 'hang') {
  if (model === 'escalate') await call('set_model', { model: 'work-big', effort: 'high' });
  const passed = model === 'pass';
  const tested = execFileSync('git', ['log', '-1', '--format=%s'], { encoding: 'utf8' }).trim();
  await call('report_test', { passed, summary: (passed ? 'every criterion passes' : 'criterion 1 fails') + ' (tested: ' + tested + ')' });
} else if (model === 'silent') {
  process.exit(0);
} else if (model !== 'hang') {
  if (model === 'ask') {
    await call('ask_operator', { question: 'Which colour?' });
    commit('answer.txt', await line());
  } else if (model === 'conflict' && brief.includes('merge conflict with main')) {
    try { execFileSync('git', ['merge', '-q', 'main'], { stdio: 'ignore' }); } catch { commit('shared.txt', 'both\\n'); }
  } else if (model === 'conflict') commit('shared.txt', name + '\\n');
  else if (model === 'lines' || model === 'dirty') {
    if (!brief.includes('Retry count: 0 ')) await new Promise(() => process.stdin.resume()); // sent back: stays up for the test to look at
    if (model === 'dirty') writeFileSync('a.txt', 'half done\\n'); // an agent that never committed
    else {
      // The answer "N TEXT" replaces line N of lines.txt.
      await call('ask_operator', { question: 'Which line?' });
      const [n, text] = (await line()).split(' ');
      const lines = readFileSync('lines.txt', 'utf8').split('\\n');
      lines[n - 1] = text;
      commit('lines.txt', lines.join('\\n'));
    }
  } else commit(name + '.txt', 'done\\n');
  await call('move_ticket', { status: 'testing' });
}
process.stdin.resume();
`;
const PATH0 = process.env.PATH;
beforeAll(() => {
  writeFileSync(join(bin, 'fake.mjs'), FAKE);
  writeFileSync(join(bin, 'claude.cmd'), `@node "%~dp0fake.mjs" %*\r\n`);
  process.env.PATH = bin + delimiter + PATH0;
});
afterAll(() => {
  process.env.PATH = PATH0;
  rmSync(bin, { recursive: true, force: true });
});

let repo: string;
let srv: Awaited<ReturnType<typeof start>>;
let db: DatabaseSync;
let sounds: { sound: string; ticket: number }[];
const onEvent = (e: { sound: string; ticket: number }) => sounds.push(e);
const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
const models = (o: { execute?: string; test?: string } = {}) =>
  writeFileSync(join(process.env.USERPROFILE!, '.kanban95', 'models.json'), JSON.stringify({
    cli: 'claude',
    claude: { execute: { model: o.execute ?? 'work', effort: 'low' }, test: { model: o.test ?? 'pass', effort: 'low' } },
  }));
const ticket = (title: string, cols: Record<string, unknown> = {}) => {
  const keys = ['title', ...Object.keys(cols)];
  const r = db.prepare(`INSERT INTO tickets (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(title, ...(Object.values(cols) as never[]));
  return Number(r.lastInsertRowid);
};
const t = (id: number) => readTicket(db, id);
const runs = (id: number) => db.prepare('SELECT phase, model, outcome, prompt_rendered, started_at FROM runs WHERE ticket_id = ? ORDER BY id').all(id) as
  { phase: string; model: string; outcome: string | null; prompt_rendered: string; started_at: string }[];
const notes = (id: number, kind: string) => (db.prepare('SELECT body FROM notes WHERE ticket_id = ? AND kind = ? ORDER BY id').all(id, kind) as { body: string }[]).map((r) => r.body);
const post = (path: string, body?: unknown) =>
  fetch(`http://127.0.0.1:${srv.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: `k95=${srv.secret}` }, body: body === undefined ? undefined : JSON.stringify(body) });
const until = async (f: () => unknown, what: string, ms = 30_000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};
// Every backlog ticket at once, in one request (so none can finish before the last starts): the runner with room for all.
const launchTogether = (n: number) =>
  fetch(`http://127.0.0.1:${srv.port}/api/runner`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie: `k95=${srv.secret}` }, body: JSON.stringify({ on: true, concurrency: n }) });
const mergeInProgress = (dir: string) => {
  try {
    execFileSync('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: dir, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const landed = (id: number) => until(() => t(id).merged_at && !existsSync(join(repo, '.worktrees', `t-${id}`)), `ticket ${id} merged and cleaned`);

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'k95-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  git('config', 'user.name', 'Op Erator');
  git('config', 'user.email', 'op@example.com');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git('add', 'a.txt');
  git('commit', '-qm', 'init');
  mkdirSync(join(process.env.USERPROFILE!, '.kanban95'), { recursive: true });
  models();
  srv = await start({ repo });
  db = srv.db;
  sounds = [];
  events.on('event', onEvent);
});
afterEach(async () => {
  events.off('event', onEvent);
  await srv.close();
  rmSync(repo, { recursive: true, force: true, maxRetries: 5 });
});

describe('lifecycle', { timeout: 60_000 }, () => {
  it('launch → execute → test → merge: one plain merge commit by the operator, a ding, and nothing left behind', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/events`, { origin: `http://127.0.0.1:${srv.port}`, headers: { cookie: `k95=${srv.secret}` } });
    const frames: { sound?: string; ticket: number | null }[] = [];
    ws.on('message', (m) => frames.push(JSON.parse(String(m))));
    await new Promise((r) => ws.on('open', r));

    const id = ticket('Add the greeting');
    const r = await post(`/api/tickets/${id}/launch`);
    expect(r.status).toBe(200);
    expect((await r.json()).status).toBe('in_progress');
    expect((await post(`/api/tickets/${id}/launch`)).status).toBe(409); // already running
    await landed(id);

    expect(t(id)).toMatchObject({ status: 'done', flags: { needs_human: false } });
    expect(runs(id).map((x) => [x.phase, x.outcome])).toEqual([['execute', 'submit'], ['test', 'pass']]);
    const [author, parents, ...message] = git('log', '-1', '--format=%an <%ae>%n%P%n%B').split('\n');
    expect(author).toBe('Op Erator <op@example.com>');
    expect(parents.split(' ')).toHaveLength(2); // --no-ff: a real merge commit
    expect(message.join('\n').trim()).toBe('Add the greeting'); // the title, no ids, no trailers
    expect(git('show', 'HEAD:t-1.txt')).toBe('done');

    // Janitor: no worktree, no branch, no session dir, no live grant for the ticket.
    expect(existsSync(join(repo, '.worktrees', 't-1'))).toBe(false);
    expect(git('branch', '--list', 'ticket/1')).toBe('');
    expect(readdirSync(join(repo, '.kanban95', 'sessions'))).toEqual([]);
    expect(db.prepare('SELECT count(*) AS n FROM grants WHERE ticket_id = ? AND revoked_at IS NULL').get(id)).toEqual({ n: 0 });
    expect(db.prepare("SELECT outcome FROM audit WHERE tool = 'janitor.worktree' AND ticket_id = ?").all(id)).toEqual([{ outcome: 'ok' }]);

    await until(() => frames.some((f) => 'sound' in f), 'the ding frame');
    expect(frames.filter((f) => 'sound' in f)).toEqual([{ sound: 'ding', ticket: id }]);
    // A change frame for every transition, so the UI refetches the card instead of reloading.
    expect(frames.filter((f) => !('sound' in f)).length).toBeGreaterThanOrEqual(5);
    expect(frames.every((f) => f.ticket === id)).toBe(true);
    ws.close();
  });

  it('holds a dependent and launches it the moment its last dependency is merged', async () => {
    const b = ticket('Second step');
    const a = ticket('First step');
    db.prepare('INSERT INTO ticket_deps VALUES (?, ?)').run(b, a);
    expect(await (await post(`/api/tickets/${b}/launch`)).json()).toMatchObject({ status: 'backlog', flags: { needs_human: false, blocked_on_deps: true } });
    await post(`/api/tickets/${a}/launch`);
    await landed(a);
    await landed(b);
    expect(runs(b)[0].started_at >= t(a).merged_at!).toBe(true);
    expect(t(b).flags.blocked_on_deps).toBe(false);
  });

  it('retry cap: the first attempt plus exactly three retries, then the operator, and nothing more runs', async () => {
    models({ test: 'fail' });
    const id = ticket('Never quite right');
    await post(`/api/tickets/${id}/launch`);
    await until(() => t(id).flags.needs_human && sessionsOf(id).length === 0, 'the retry cap');
    await new Promise((r) => setTimeout(r, 500));
    expect(runs(id).map((x) => x.phase)).toEqual(['execute', 'test', 'execute', 'test', 'execute', 'test', 'execute', 'test']);
    // The fake tester only calls report_test(false): the report alone ends each test run and sends the ticket back.
    expect(runs(id).filter((x) => x.phase === 'test').map((x) => x.outcome)).toEqual(['fail', 'fail', 'fail', 'fail']);
    expect(t(id)).toMatchObject({ status: 'in_progress', retry: MAX_RETRY + 1, flags: { needs_human: true } });
    expect(sounds).toEqual([{ sound: 'chord', ticket: id }]);
    expect(notes(id, 'failure').at(-1)).toMatch(/^stopped after 4 failed tests\nTo resolve: .*Reset to Backlog and Launch/);
    expect(runs(id)[2].prompt_rendered).toContain('FAIL: criterion 1 fails'); // the retry sees what failed
  });

  it("a tester cannot escalate: its set_model is refused and the retry runs with the ticket's own model", async () => {
    models({ test: 'escalate' });
    const id = ticket('Hard one');
    await post(`/api/tickets/${id}/launch`);
    await until(() => runs(id).filter((x) => x.phase === 'execute').length === 2, 'the retry');
    models({ test: 'pass' });
    await landed(id);
    expect(runs(id).filter((x) => x.phase === 'execute').map((x) => x.model)).toEqual(['work', 'work']);
    expect(t(id)).toMatchObject({ model: null, effort: null, retry: 1 });
  });

  it('ask_operator round trip: chord, the answer reaches the agent as one line and clears the flag', async () => {
    const id = ticket('Paint it', { model: 'ask' });
    await post(`/api/tickets/${id}/launch`);
    await until(() => t(id).flags.needs_human, 'the question');
    expect(notes(id, 'question')).toEqual(['Which colour?']);
    expect(sounds).toEqual([{ sound: 'chord', ticket: id }]);
    expect(sessionsOf(id)).toHaveLength(1); // the pty stays alive
    const pty = sessionsOf(id)[0].pty, writes: string[] = [], write = pty.write.bind(pty);
    pty.write = (d: string) => { writes.push(d); write(d); };

    expect((await post(`/api/tickets/${id}/answer`, { answer: '  ' })).status).toBe(400);
    const r = await post(`/api/tickets/${id}/answer`, { answer: 'blue,\r\nand bold' });
    expect(r.status).toBe(200);
    expect((await r.json()).flags.needs_human).toBe(false);
    expect(notes(id, 'answer')).toEqual(['blue,\r\nand bold']);
    expect((await post(`/api/tickets/${id}/answer`, { answer: 'again' })).status).toBe(409); // nothing is asked now
    await until(() => writes.length === 2, 'the Enter');
    expect(writes).toEqual(['blue, and bold', '\r']); // Enter on its own, or Claude Code takes the burst as a paste

    await landed(id);
    expect(git('show', 'HEAD:answer.txt')).toBe('blue, and bold');
  });

  it('an agent that exits without reporting, or never starts, cannot leave the ticket unflagged', async () => {
    const silent = ticket('Quiet', { model: 'silent' });
    const broken = ticket('Bad cli', { cli: 'nope' });
    await post(`/api/tickets/${silent}/launch`);
    await post(`/api/tickets/${broken}/launch`);
    await until(() => t(silent).flags.needs_human, 'the silent exit');
    expect(t(silent).status).toBe('in_progress');
    expect(notes(silent, 'failure')).toEqual([`agent exited without reporting\n${TO_RESOLVE}`]);
    expect(runs(silent).map((x) => x.outcome)).toEqual(['exit']);
    expect(t(broken)).toMatchObject({ status: 'in_progress', flags: { needs_human: true } });
    expect(notes(broken, 'failure')[0]).toMatch(/^launch failed: unknown cli nope/);
  });

  it("the operator's X ends a session: a ticket's is flagged once with the operator note, a brainstorm's touches no ticket", async () => {
    const del = (key: number) => fetch(`http://127.0.0.1:${srv.port}/api/sessions/${key}`, { method: 'DELETE', headers: { cookie: `k95=${srv.secret}` } });
    expect((await del(9999)).status).toBe(404);
    const id = ticket('Long one', { model: 'hang' });
    await post(`/api/tickets/${id}/launch`);
    await until(() => sessionsOf(id).length === 1, 'the agent');
    expect((await del(sessionsOf(id)[0].key)).status).toBe(204);
    await until(() => sessionsOf(id).length === 0 && runs(id)[0].outcome, 'the session gone');
    expect(t(id)).toMatchObject({ status: 'in_progress', flags: { needs_human: true } });
    expect(runs(id).map((x) => x.outcome)).toEqual(['closed']);
    await new Promise((r) => setTimeout(r, 200)); // a late exit handler would have written its note by now
    expect(notes(id, 'failure')).toEqual([`ended by the operator from the terminal window
${TO_RESOLVE}`]);
    expect((await post(`/api/tickets/${id}/resume`)).status).toBe(200);

    writeFileSync(join(process.env.USERPROFILE!, '.kanban95', 'models.json'), JSON.stringify({ cli: 'claude', claude: { plan: { model: 'hang', effort: 'low' } } }));
    const b = await (await post('/api/brainstorm')).json();
    const before = db.prepare('SELECT count(*) n FROM notes').get();
    expect((await del(b.id)).status).toBe(204);
    await until(() => !sessions.has(b.id), 'the brainstorm gone');
    expect(db.prepare('SELECT count(*) n FROM notes').get()).toEqual(before);
    expect(db.prepare("SELECT tool, outcome FROM audit WHERE tool = 'sessions.end'").all()).toHaveLength(3);
  });

  it('merge conflict: the worker merges the base in its kept worktree and both tickets land with no operator action', async () => {
    const one = ticket('Write shared one', { model: 'conflict' });
    const two = ticket('Write shared two', { model: 'conflict' });
    await launchTogether(2);
    await until(() => [one, two].some((id) => t(id).retry === 1), 'the conflict sent back');
    const [won, lost] = t(one).retry === 1 ? [two, one] : [one, two];
    await landed(won);
    await landed(lost);
    expect(notes(lost, 'failure')).toEqual([expect.stringMatching(/^merge conflict with main: [^]*CONFLICT[^]*shared\.txt/)]);
    expect(runs(lost).map((x) => x.phase)).toEqual(['execute', 'test', 'execute', 'test']);
    expect(runs(lost)[2].prompt_rendered).toMatch(/merge conflict with main: [^]*git merge main/); // the note, and the brief's base
    expect([one, two].map((id) => t(id).flags.needs_human)).toEqual([false, false]);
    expect(git('show', 'HEAD:shared.txt')).toBe('both');
    expect(mergeInProgress(repo)).toBe(false);
    expect(sounds.filter((s) => s.sound === 'chord')).toEqual([]);
  });

  it('merge conflict at the retry cap: flagged with the worktree kept, the base clean, the fix in the note and the Inbox; a retried merge lands it', async () => {
    const one = ticket('Write shared one', { model: 'conflict', retry: MAX_RETRY });
    const two = ticket('Write shared two', { model: 'conflict', retry: MAX_RETRY });
    await launchTogether(2);
    await until(() => [one, two].every((id) => t(id).status === 'done') && [one, two].some((id) => t(id).flags.needs_human), 'both done, one flagged');
    const [won, lost] = t(one).merged_at ? [one, two] : [two, one];
    await landed(won);
    expect(t(lost)).toMatchObject({ status: 'done', merged_at: null, retry: MAX_RETRY, flags: { needs_human: true } });
    expect(notes(lost, 'failure')).toEqual([expect.stringMatching(new RegExp(`^merge conflict with main: [^]*\\nTo resolve: in \\.worktrees/t-${lost} .*Retry merge\\.$`))]);
    const inbox = await (await fetch(`http://127.0.0.1:${srv.port}/api/inbox`, { headers: { cookie: `k95=${srv.secret}` } })).json();
    expect(inbox).toEqual([expect.objectContaining({ ticket_id: lost, kind: 'failure', status: 'done', merged_at: null, body: notes(lost, 'failure')[0] })]);
    expect(existsSync(join(repo, '.worktrees', `t-${lost}`))).toBe(true);
    expect(git('status', '--porcelain', '--untracked-files=no')).toBe('');
    expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(mergeInProgress(join(repo, '.worktrees', `t-${lost}`))).toBe(false); // the conflict was met and aborted there
    expect(git('show', 'HEAD:shared.txt')).toBe(`t-${won}`);
    expect(sounds.filter((s) => s.sound === 'chord')).toEqual([{ sound: 'chord', ticket: lost }]);

    // The operator resolves it in the worktree, then retries the merge.
    const wt = join(repo, '.worktrees', `t-${lost}`);
    try {
      execFileSync('git', ['merge', '-q', 'main'], { cwd: wt, stdio: 'ignore' });
    } catch {
      writeFileSync(join(wt, 'shared.txt'), 'both\n');
      execFileSync('git', ['commit', '-qam', 'Resolve shared'], { cwd: wt });
    }
    expect((await post(`/api/tickets/${lost}/merge`)).status).toBe(200);
    await landed(lost);
    expect(t(lost).flags.needs_human).toBe(false);
    expect(git('show', 'HEAD:shared.txt')).toBe('both');
    expect((await post(`/api/tickets/${lost}/merge`)).status).toBe(409); // already merged
  });

  describe('main merged into the worktree on submit', () => {
    beforeEach(() => {
      writeFileSync(join(repo, 'lines.txt'), '1\n2\n3\n4\n5\n');
      git('add', 'lines.txt');
      git('commit', '-qm', 'Add lines');
    });
    const answer = async (id: number, text: string) => {
      await until(() => t(id).flags.needs_human, `ticket ${id}'s question`);
      expect((await post(`/api/tickets/${id}/answer`, { answer: text })).status).toBe(200);
    };
    // B forks before A lands and submits after it: B's branch is stale when its worker submits.
    const aLandsWhileBWorks = async (a: number, b: number) => {
      for (const id of [b, a]) expect((await post(`/api/tickets/${id}/launch`)).status).toBe(200);
      await answer(a, '1 one');
      await landed(a);
    };
    const sentBack = (id: number) => until(() => runs(id).length === 2 && runs(id)[0].outcome === 'conflict', 'sent back to the worker');

    it('a clean merge: a merge commit from main by the operator, tested combined, landed with no conflict note', async () => {
      const a = ticket('Edit line one', { model: 'lines' });
      const b = ticket('Edit line five', { model: 'lines' });
      await aLandsWhileBWorks(a, b);
      await answer(b, '5 five');
      await landed(b);
      expect(notes(b, 'failure')).toEqual([]);
      expect(runs(b).map((x) => [x.phase, x.outcome])).toEqual([['execute', 'submit'], ['test', 'pass']]);
      expect(notes(b, 'summary')).toEqual([`PASS: every criterion passes (tested: Merge main into ticket/${b})`]); // synced before the tester ran
      expect(git('log', '-1', '--format=%an <%ae>|%s', 'HEAD^2')).toBe(`Op Erator <op@example.com>|Merge main into ticket/${b}`);
      expect(git('rev-list', '--parents', '-1', 'HEAD^2').split(' ')).toHaveLength(3); // a real merge commit
      expect(git('show', 'HEAD:lines.txt')).toBe('one\n2\n3\n4\nfive');
    });

    it('a conflict: back to the worker in its kept worktree, retry + 1, no tester round, no merge left in progress', async () => {
      const a = ticket('Edit line one', { model: 'lines' });
      const b = ticket('Also edit line one', { model: 'lines' });
      await aLandsWhileBWorks(a, b);
      await answer(b, '1 uno');
      await sentBack(b);
      const wt = join(repo, '.worktrees', `t-${b}`);
      expect(t(b)).toMatchObject({ status: 'in_progress', retry: 1, flags: { needs_human: false } });
      expect(notes(b, 'failure')).toEqual([expect.stringMatching(/^merge conflict with main: [^]*CONFLICT[^]*lines\.txt/)]);
      expect(runs(b).map((x) => x.phase)).toEqual(['execute', 'execute']);
      expect(runs(b)[1].prompt_rendered).toMatch(/merge conflict with main: [^]*git merge main/);
      expect(sessionsOf(b)).toHaveLength(1);
      expect(mergeInProgress(wt)).toBe(false);
      expect(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: wt, encoding: 'utf8' })).toBe('');
      expect(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: wt, encoding: 'utf8' }).trim()).toBe('Add lines.txt');
    });

    it('uncommitted tracked changes: back to the worker with a note saying so, the changes untouched', async () => {
      const id = ticket('Leave it half done', { model: 'dirty' });
      expect((await post(`/api/tickets/${id}/launch`)).status).toBe(200);
      await sentBack(id);
      expect(t(id)).toMatchObject({ status: 'in_progress', retry: 1, flags: { needs_human: false } });
      expect(notes(id, 'failure')).toEqual(['worktree has uncommitted changes; commit or discard them, then submit again:\n M a.txt']);
      expect(readFileSync(join(repo, '.worktrees', `t-${id}`, 'a.txt'), 'utf8')).toBe('half done\n');
      expect(runs(id).map((x) => x.phase)).toEqual(['execute', 'execute']);
    });
  });

  describe('a dirty main checkout', () => {
    const wait0 = { ...DIRTY_WAIT };
    afterEach(() => Object.assign(DIRTY_WAIT, wait0));
    // Dirtied once the worktree exists (a dirty base refuses the launch itself) and long before the tester passes.
    const launchThenDirty = async (id: number) => {
      expect((await post(`/api/tickets/${id}/launch`)).status).toBe(200);
      writeFileSync(join(repo, 'a.txt'), 'the operator is editing\n');
    };

    it('flags nothing and retries by itself; the merge lands once the base is clean, with the edits untouched until then', async () => {
      Object.assign(DIRTY_WAIT, { every: 50, max: 60_000 });
      const id = ticket('Add while dirty');
      await launchThenDirty(id);
      await until(() => t(id).status === 'done', 'done');
      await new Promise((r) => setTimeout(r, 500)); // several refused tries
      expect(t(id)).toMatchObject({ merged_at: null, flags: { needs_human: false } });
      expect(notes(id, 'failure')).toEqual([]);
      expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('the operator is editing\n'); // no merge --abort over it
      git('checkout', 'a.txt');
      await landed(id);
      expect(t(id).flags.needs_human).toBe(false);
      expect(sounds).toEqual([{ sound: 'ding', ticket: id }]);
    });

    it('the operator commits instead: the queue merges the new main into the worktree first, then lands it', async () => {
      Object.assign(DIRTY_WAIT, { every: 50, max: 60_000 });
      const id = ticket('Add behind main');
      await launchThenDirty(id);
      await until(() => t(id).status === 'done', 'done');
      git('commit', '-qam', 'Edit a');
      await landed(id);
      expect(notes(id, 'failure')).toEqual([]);
      expect(git('log', '-1', '--format=%an <%ae>|%s', 'HEAD^2')).toBe(`Op Erator <op@example.com>|Merge main into ticket/${id}`);
      expect(git('log', '-1', '--format=%s', 'HEAD')).toBe('Add behind main');
      expect(git('show', 'HEAD:a.txt')).toBe('the operator is editing');
      expect(mergeInProgress(repo)).toBe(false);
    });

    it('still dirty after the wait: flagged with the changed files and the fix; Retry merge lands it once clean', async () => {
      Object.assign(DIRTY_WAIT, { every: 50, max: 300 });
      const id = ticket('Add while dirty for long');
      await launchThenDirty(id);
      await until(() => t(id).flags.needs_human, 'the flag');
      expect(t(id)).toMatchObject({ status: 'done', merged_at: null });
      expect(notes(id, 'failure')).toEqual([expect.stringMatching(/^merge did not run: the main checkout \(main\) still has uncommitted changes after the wait:\n M a\.txt\nTo resolve: commit or stash those changes in the main checkout .*Retry merge/)]);
      expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('the operator is editing\n');
      git('checkout', 'a.txt');
      expect((await post(`/api/tickets/${id}/merge`)).status).toBe(200);
      await landed(id);
    });
  });

  it('five tickets at once: five ptys, one merge queue, every branch lands in a straight line of merges', async () => {
    const ids = [1, 2, 3, 4, 5].map((i) => ticket(`Add file ${i}`));
    await launchTogether(5);
    expect(ids.map((id) => sessionsOf(id).length)).toEqual([1, 1, 1, 1, 1]);
    for (const id of ids) await landed(id);
    expect(ids.map((id) => t(id).flags.needs_human)).toEqual([false, false, false, false, false]);
    expect(git('log', '--first-parent', '--merges', '--format=%s').split('\n').sort()).toEqual(ids.map((i) => `Add file ${i}`));
    expect(git('ls-tree', '--name-only', 'HEAD').split('\n').sort()).toEqual(['a.txt', 't-1.txt', 't-2.txt', 't-3.txt', 't-4.txt', 't-5.txt']);
    expect(readdirSync(join(repo, '.worktrees'))).toEqual([]);
  });

  it('the 10th merged ticket creates exactly one housekeeping ticket, left in Backlog for the runner; the 11th does not', async () => {
    for (let i = 0; i < 9; i++) ticket(`Old ${i}`, { status: 'done', merged_at: '2026-01-01T00:00:00.000Z' });
    const tenth = ticket('Tenth');
    await post(`/api/tickets/${tenth}/launch`);
    await landed(tenth);
    const hk = () => db.prepare("SELECT id FROM tickets WHERE template = 'housekeeping'").all() as { id: number }[];
    expect(hk()).toHaveLength(1);
    expect(t(hk()[0].id).status).toBe('backlog');
    await post(`/api/tickets/${hk()[0].id}/launch`);
    await landed(hk()[0].id);
    expect(runs(hk()[0].id)[0].prompt_rendered).toMatch(/^# Housekeeping/);
    const eleventh = ticket('Eleventh');
    await post(`/api/tickets/${eleventh}/launch`);
    await landed(eleventh);
    expect(hk()).toHaveLength(1);
  });

  it('settings.json housekeeping: switched off files none; `every` sets the interval', async () => {
    const settings = join(process.env.KANBAN95_HOME!, 'settings.json');
    const hk = () => db.prepare("SELECT count(*) AS n FROM tickets WHERE template = 'housekeeping'").get() as { n: number };
    try {
      writeFileSync(settings, JSON.stringify({ housekeeping: { auto: false, every: 1 } }));
      const off = ticket('Off');
      await post(`/api/tickets/${off}/launch`);
      await landed(off);
      expect(hk().n).toBe(0);
      writeFileSync(settings, JSON.stringify({ housekeeping: { every: 2 } }));
      const second = ticket('Second');
      await post(`/api/tickets/${second}/launch`);
      await landed(second);
      expect(hk().n).toBe(1);
    } finally {
      rmSync(settings, { force: true });
    }
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
    mkdirSync(join(repo, '.worktrees', 't-98'));
    writeFileSync(join(repo, '.worktrees', 't-98', 'junk'), 'x');
    mkdirSync(join(repo, '.kanban95', 'sessions', '4242'), { recursive: true });
    const grant = mint(db, { ticket: kept, role: 'worker', ttlMs: 60_000 });
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    const ins = db.prepare("INSERT INTO runs (ticket_id, phase, cli, model, effort, prompt_rendered, ended_at, outcome, scrollback) VALUES (?, 'execute', 'claude', 'm', 'low', 'p', ?, ?, ?)");
    const oldRun = Number(ins.run(kept, old, 'submit', 'old screen').lastInsertRowid);
    const newRun = Number(ins.run(kept, new Date().toISOString(), 'submit', 'new screen').lastInsertRowid);
    const openRun = Number(ins.run(kept, null, null, null).lastInsertRowid);
    await srv.close();

    models({ execute: 'hang' });
    srv = await start({ repo });
    db = srv.db;
    expect(readdirSync(join(repo, '.worktrees'))).toEqual([`t-${kept}`]);
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
    const dir = join(repo, '.worktrees', 't-97', 'target');
    mkdirSync(dir, { recursive: true });
    await srv.close();
    // A live process sitting in the directory is what Windows refuses to delete.
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: dir, stdio: 'ignore' });
    try {
      srv = await start({ repo });
      db = srv.db;
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
    srv = await start({ repo });
    db = srv.db;
    expect(notes(id, 'failure')).toEqual([RESTARTED]); // no 'agent exited without reporting' from the shutdown
    expect(t(id).flags.needs_human).toBe(false);
    expect(runs(id)).toHaveLength(2);
    expect(runs(id)[1].prompt_rendered).toContain(RESTARTED);
  });

  it('restart resumes a running ticket once by itself; an agent that then exits silently flags it with what to do', async () => {
    const id = ticket('Cut off', { status: 'in_progress', retry: 1 });
    createWorktree(repo, id);
    await srv.close();
    models({ execute: 'silent' });
    srv = await start({ repo });
    db = srv.db;
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
