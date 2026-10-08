import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { readTicket } from '../src/api.ts';
import { createWorktree } from '../src/git.ts';
import { mint } from '../src/grants.ts';
import { sessionsOf } from '../src/launcher.ts';
import { events, MAX_RETRY, Refused, transition, type Event, type Facts, type Status } from '../src/lifecycle.ts';
import { start } from '../src/server.ts';

describe('transition table', () => {
  const f = (o: Partial<Facts>): Facts => ({ status: 'backlog', needs_human: false, retry: 0, merged: false, depsMerged: true, passReported: false, live: true, ...o });
  // Written out by hand from docs/LIFECYCLE.md, not derived from TABLE, so a changed row fails here.
  const rows: [string, Partial<Facts>, Event, ReturnType<typeof transition>][] = [
    ['launch, deps merged', { status: 'backlog' }, 'launch', { to: 'in_progress', set: { blocked_on_deps: 0 }, effects: ['spawn_execute'] }],
    ['launch, deps not merged', { status: 'backlog', depsMerged: false }, 'launch', { to: 'backlog', set: { blocked_on_deps: 1 }, effects: [] }],
    ['worker submits', { status: 'in_progress' }, 'submit', { to: 'testing', set: {}, effects: ['end_session', 'spawn_test'] }],
    ['tester passes after report_test(pass)', { status: 'testing', passReported: true }, 'pass', { to: 'done', set: {}, effects: ['end_session', 'enqueue_merge'] }],
    ['first failure', { status: 'testing', retry: 0 }, 'fail', { to: 'in_progress', set: { retry: '+1' }, effects: ['end_session', 'spawn_execute'] }],
    ['third failure is the last retry', { status: 'testing', retry: MAX_RETRY - 1 }, 'fail', { to: 'in_progress', set: { retry: '+1' }, effects: ['end_session', 'spawn_execute'] }],
    ['fourth failure stops', { status: 'testing', retry: MAX_RETRY }, 'fail', { to: 'in_progress', set: { retry: '+1', needs_human: 1 }, effects: ['end_session', 'chord'] }],
    ['worker asks', { status: 'in_progress' }, 'ask', { to: 'in_progress', set: { needs_human: 1 }, effects: ['note', 'chord'] }],
    ['tester asks', { status: 'testing' }, 'ask', { to: 'testing', set: { needs_human: 1 }, effects: ['note', 'chord'] }],
    ['operator answers', { status: 'in_progress', needs_human: true }, 'answer', { to: 'in_progress', set: { needs_human: 0 }, effects: ['note', 'answer_pty'] }],
    ['worker exits silently', { status: 'in_progress' }, 'exit', { to: 'in_progress', set: { needs_human: 1 }, effects: ['note', 'chord'] }],
    ['tester exits silently', { status: 'testing', live: false }, 'exit', { to: 'testing', set: { needs_human: 1 }, effects: ['note', 'chord'] }],
    ['merge ok', { status: 'done' }, 'merged', { to: 'done', set: { merged: true, needs_human: 0 }, effects: ['ding', 'remove_worktree', 'release_dependents', 'housekeeping'] }],
    ['merge conflict', { status: 'done' }, 'conflict', { to: 'done', set: { needs_human: 1 }, effects: ['note', 'chord'] }],
    ['operator retries a failed merge', { status: 'done', needs_human: true }, 'merge', { to: 'done', set: {}, effects: ['enqueue_merge'] }],
  ];
  it.each(rows)('%s', (_, facts, event, want) => {
    expect(transition(f(facts), event)).toEqual(want);
  });

  const allowed: Record<Status, Event[]> = {
    backlog: ['launch'],
    in_progress: ['submit', 'ask', 'answer', 'exit'],
    testing: ['pass', 'fail', 'ask', 'answer', 'exit'],
    done: ['merged', 'conflict', 'merge'],
  };
  const EVENTS: Event[] = ['launch', 'submit', 'pass', 'fail', 'ask', 'answer', 'exit', 'merged', 'conflict', 'merge'];
  it('refuses every other event in every status', () => {
    let n = 0;
    for (const status of Object.keys(allowed) as Status[]) {
      for (const event of EVENTS.filter((e) => !allowed[status].includes(e))) {
        expect(() => transition(f({ status }), event), `${status} ${event}`).toThrow(Refused);
        n++;
      }
    }
    expect(n).toBe(4 * EVENTS.length - 13);
  });

  it('refuses a guarded row whose guard fails, saying why', () => {
    expect(() => transition(f({ status: 'testing' }), 'pass')).toThrow('cannot pass a ticket in testing: call report_test with passed: true first');
    expect(() => transition(f({ status: 'testing', needs_human: false }), 'answer')).toThrow(/no flagged question/);
    expect(() => transition(f({ status: 'testing', needs_human: true, live: false }), 'answer')).toThrow(/no flagged question/);
    expect(() => transition(f({ status: 'done', merged: true }), 'merge')).toThrow('cannot merge a ticket in done: already merged');
  });
});

// Fake `claude` first on PATH: a scripted agent that talks to /mcp like the real CLI and stays up until the board ends it.
// The brief's heading says which phase it is in; the model name says how it behaves (see `behave` below).
const bin = mkdtempSync(join(tmpdir(), 'k95-bin-'));
const FAKE = `
import { execFileSync } from 'node:child_process';
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
if (brief.startsWith('# Test')) {
  if (model === 'escalate') await call('set_model', { model: 'work-big', effort: 'high' });
  const passed = model === 'pass';
  await call('report_test', { passed, summary: passed ? 'every criterion passes' : 'criterion 1 fails' });
  await call('move_ticket', { status: passed ? 'done' : 'in_progress' });
} else if (model === 'silent') {
  process.exit(0);
} else if (model !== 'hang') {
  if (model === 'ask') {
    await call('ask_operator', { question: 'Which colour?' });
    commit('answer.txt', await line());
  } else if (model === 'conflict') commit('shared.txt', name + '\\n');
  else commit(name + '.txt', 'done\\n');
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

  it('holds a dependent and launches it the moment its last dependency is merged; Launch all goes in dependency order', async () => {
    const b = ticket('Second step');
    const a = ticket('First step');
    db.prepare('INSERT INTO ticket_deps VALUES (?, ?)').run(b, a);
    const r = await post('/api/tickets/launch-all');
    expect((await r.json()).map((x: { id: number; status: string; flags: object }) => [x.id, x.status, x.flags])).toEqual([
      [a, 'in_progress', { needs_human: false, blocked_on_deps: false }],
      [b, 'backlog', { needs_human: false, blocked_on_deps: true }],
    ]);
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
    expect(t(id)).toMatchObject({ status: 'in_progress', retry: MAX_RETRY + 1, flags: { needs_human: true } });
    expect(sounds).toEqual([{ sound: 'chord', ticket: id }]);
    expect(runs(id)[2].prompt_rendered).toContain('FAIL: criterion 1 fails'); // the retry sees what failed
  });

  it("escalation: the tester's set_model is what the retry runs with", async () => {
    models({ test: 'escalate' });
    const id = ticket('Hard one');
    await post(`/api/tickets/${id}/launch`);
    await until(() => runs(id).filter((x) => x.phase === 'execute').length === 2, 'the retry');
    models({ test: 'pass' });
    await landed(id);
    expect(runs(id).filter((x) => x.phase === 'execute').map((x) => x.model)).toEqual(['work', 'work-big']);
    expect(t(id)).toMatchObject({ model: 'work-big', effort: 'high', retry: 1 });
  });

  it('ask_operator round trip: chord, the answer reaches the agent as one line and clears the flag', async () => {
    const id = ticket('Paint it', { model: 'ask' });
    await post(`/api/tickets/${id}/launch`);
    await until(() => t(id).flags.needs_human, 'the question');
    expect(notes(id, 'question')).toEqual(['Which colour?']);
    expect(sounds).toEqual([{ sound: 'chord', ticket: id }]);
    expect(sessionsOf(id)).toHaveLength(1); // the pty stays alive

    expect((await post(`/api/tickets/${id}/answer`, { answer: '  ' })).status).toBe(400);
    const r = await post(`/api/tickets/${id}/answer`, { answer: 'blue,\r\nand bold' });
    expect(r.status).toBe(200);
    expect((await r.json()).flags.needs_human).toBe(false);
    expect(notes(id, 'answer')).toEqual(['blue,\r\nand bold']);
    expect((await post(`/api/tickets/${id}/answer`, { answer: 'again' })).status).toBe(409); // nothing is asked now

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
    expect(notes(silent, 'failure')).toEqual(['agent exited without reporting']);
    expect(runs(silent).map((x) => x.outcome)).toEqual(['exit']);
    expect(t(broken)).toMatchObject({ status: 'in_progress', flags: { needs_human: true } });
    expect(notes(broken, 'failure')[0]).toMatch(/^launch failed: unknown cli nope/);
  });

  it('merge conflict: the second ticket is flagged with its worktree kept and the base clean; a retried merge lands it', async () => {
    const one = ticket('Write shared one', { model: 'conflict' });
    const two = ticket('Write shared two', { model: 'conflict' });
    await post('/api/tickets/launch-all');
    await until(() => [one, two].every((id) => t(id).status === 'done') && [one, two].some((id) => t(id).flags.needs_human), 'both done, one flagged');
    const [won, lost] = t(one).merged_at ? [one, two] : [two, one];
    await landed(won);
    expect(t(lost)).toMatchObject({ status: 'done', merged_at: null, flags: { needs_human: true } });
    expect(notes(lost, 'failure')[0]).toMatch(/^merge failed; the worktree is kept\.\n/);
    expect(existsSync(join(repo, '.worktrees', `t-${lost}`))).toBe(true);
    expect(git('status', '--porcelain', '--untracked-files=no')).toBe('');
    expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(false);
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

  it('five tickets at once: five ptys, one merge queue, every branch lands in a straight line of merges', async () => {
    const ids = [1, 2, 3, 4, 5].map((i) => ticket(`Add file ${i}`));
    await post('/api/tickets/launch-all');
    expect(ids.map((id) => sessionsOf(id).length)).toEqual([1, 1, 1, 1, 1]);
    for (const id of ids) await landed(id);
    expect(ids.map((id) => t(id).flags.needs_human)).toEqual([false, false, false, false, false]);
    expect(git('log', '--first-parent', '--merges', '--format=%s').split('\n').sort()).toEqual(ids.map((i) => `Add file ${i}`));
    expect(git('ls-tree', '--name-only', 'HEAD').split('\n').sort()).toEqual(['a.txt', 't-1.txt', 't-2.txt', 't-3.txt', 't-4.txt', 't-5.txt']);
    expect(readdirSync(join(repo, '.worktrees'))).toEqual([]);
  });

  it('the 10th merged ticket creates exactly one housekeeping ticket, launched like any other; the 11th does not', async () => {
    for (let i = 0; i < 9; i++) ticket(`Old ${i}`, { status: 'done', merged_at: '2026-01-01T00:00:00.000Z' });
    const tenth = ticket('Tenth');
    await post(`/api/tickets/${tenth}/launch`);
    await landed(tenth);
    const hk = () => db.prepare("SELECT id FROM tickets WHERE template = 'housekeeping'").all() as { id: number }[];
    expect(hk()).toHaveLength(1);
    await landed(hk()[0].id);
    expect(runs(hk()[0].id)[0].prompt_rendered).toMatch(/^# Housekeeping/);
    const eleventh = ticket('Eleventh');
    await post(`/api/tickets/${eleventh}/launch`);
    await landed(eleventh);
    expect(hk()).toHaveLength(1);
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

    srv = await start({ repo });
    db = srv.db;
    expect(readdirSync(join(repo, '.worktrees'))).toEqual([`t-${kept}`]);
    expect(readFileSync(join(keptWt, 'wip.txt'), 'utf8')).toBe('uncommitted work');
    expect(git('branch', '--list', 'ticket/99', `ticket/${merged}`)).toBe('');
    expect(readdirSync(join(repo, '.kanban95', 'sessions'))).toEqual([]);
    expect((db.prepare('SELECT revoked_at FROM grants WHERE id = ?').get(grant.id) as { revoked_at: string | null }).revoked_at).not.toBeNull();
    const run = (id: number) => db.prepare('SELECT scrollback, outcome, ended_at FROM runs WHERE id = ?').get(id) as Record<string, unknown>;
    expect(run(oldRun)).toMatchObject({ scrollback: null, outcome: 'submit' });
    expect(run(newRun)).toMatchObject({ scrollback: 'new screen' });
    expect(run(openRun)).toMatchObject({ outcome: 'lost', ended_at: expect.any(String) });
    expect(t(kept).flags.needs_human).toBe(true);
    expect(notes(kept, 'failure')).toEqual(['agent exited without reporting (the daemon restarted)']);
    const tools = (db.prepare("SELECT tool, count(*) AS n FROM audit WHERE tool LIKE 'janitor.%' GROUP BY tool ORDER BY tool").all() as { tool: string; n: number }[]);
    expect(tools).toEqual([
      { tool: 'janitor.grant', n: 1 }, { tool: 'janitor.run', n: 1 }, { tool: 'janitor.scrollback', n: 1 },
      { tool: 'janitor.session', n: 1 }, { tool: 'janitor.worktree', n: 3 },
    ]);
  });
});
