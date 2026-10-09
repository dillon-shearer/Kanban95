// The runner (docs/LIFECYCLE.md → The runner) end to end, with a scripted fake `claude` that works, tests and passes.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readTicket } from '../src/api.ts';
import { createWorktree } from '../src/git.ts';
import { sessionsOf } from '../src/launcher.ts';
import { candidates, events, runner } from '../src/lifecycle.ts';
import { start } from '../src/server.ts';

// Model `hang` stays up doing nothing; any other model commits a file and submits. A test run passes.
const FAKE = `
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
const argv = process.argv.slice(2);
const model = argv[argv.indexOf('--model') + 1];
const mcp = JSON.parse(readFileSync(argv[argv.indexOf('--mcp-config') + 1], 'utf8')).mcpServers.kanban95;
const brief = readFileSync(/^Read (\\S+) in full/.exec(argv.at(-1))[1], 'utf8');
let n = 0;
const call = (name, args = {}) => fetch(mcp.url, {
  method: 'POST',
  headers: { ...mcp.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } }),
}).then((r) => r.json());
console.log('FAKE ' + model); // ConPTY may not end a kill on a console that has printed nothing yet
if (brief.startsWith('# Test')) {
  await call('report_test', { passed: true, summary: 'ok' });
} else if (model !== 'hang') {
  const file = basename(process.cwd()) + '.txt';
  writeFileSync(file, 'done\\n');
  execFileSync('git', ['add', file]);
  execFileSync('git', ['commit', '-qm', 'Add ' + file]);
  await call('move_ticket', { status: 'testing' });
}
process.stdin.resume();
`;
const bin = mkdtempSync(join(tmpdir(), 'k95-bin-'));
const PATH0 = process.env.PATH;
beforeAll(() => {
  writeFileSync(join(bin, 'fake.mjs'), FAKE);
  writeFileSync(join(bin, 'claude.cmd'), `@node "%~dp0fake.mjs" %*\r\n`);
  process.env.PATH = bin + delimiter + PATH0;
  mkdirSync(join(process.env.USERPROFILE!, '.kanban95'), { recursive: true });
  writeFileSync(join(process.env.USERPROFILE!, '.kanban95', 'models.json'), JSON.stringify({
    cli: 'claude', claude: { execute: { model: 'work', effort: 'low' }, test: { model: 'pass', effort: 'low' } },
  }));
});
afterAll(() => {
  process.env.PATH = PATH0;
  rmSync(bin, { recursive: true, force: true });
});

let repo: string;
let srv: Awaited<ReturnType<typeof start>>;
let db: DatabaseSync;
let sounds: { sound: string; ticket: number | null }[];
const onEvent = (e: { sound: string; ticket: number | null }) => sounds.push(e);
const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
const ticket = (title: string, cols: Record<string, unknown> = {}) => {
  const keys = ['title', ...Object.keys(cols)];
  return Number(db.prepare(`INSERT INTO tickets (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(title, ...(Object.values(cols) as never[])).lastInsertRowid);
};
const dep = (id: number, on: number) => db.prepare('INSERT INTO ticket_deps VALUES (?, ?)').run(id, on);
const t = (id: number) => readTicket(db, id);
const runs = (id: number) => db.prepare('SELECT started_at FROM runs WHERE ticket_id = ? ORDER BY id').all(id) as { started_at: string }[];
const request = (method: string, path: string, body?: unknown) => fetch(`http://127.0.0.1:${srv.port}${path}`, {
  method, headers: { 'content-type': 'application/json', cookie: `k95=${srv.secret}` }, body: body === undefined ? undefined : JSON.stringify(body),
});
const setRun = async (on: boolean) => (await request('PUT', '/api/runner', { on })).json();
const setMax = async (concurrency: unknown) => request('PUT', '/api/runner', { concurrency });
/** Commits files at these repo paths, so a ticket naming one names an existing file. */
const commit = (...files: string[]) => {
  for (const f of files) {
    mkdirSync(dirname(join(repo, f)), { recursive: true });
    writeFileSync(join(repo, f), 'x\n');
  }
  git('add', ...files);
  git('commit', '-qm', 'files');
};
const until = async (f: () => unknown, what: string, ms = 30_000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};
const landed = (id: number) => until(() => t(id).merged_at && !existsSync(join(repo, '.worktrees', `t-${id}`)), `ticket ${id} merged and cleaned`);
const STOPPED = { on: false, why: 'nothing left to launch' };

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'k95-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  git('config', 'user.name', 'Op Erator');
  git('config', 'user.email', 'op@example.com');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git('add', 'a.txt');
  git('commit', '-qm', 'init');
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

describe('runner', { timeout: 60_000 }, () => {
  it('orders candidates by effort, then criteria lines, then id; skips flagged and unmerged-dependency tickets', () => {
    const high = ticket('high', { effort: 'high' });
    const max = ticket('max', { effort: 'max' });
    const unset = ticket('unset counts as medium', { criteria: 'a\nb\nc' });
    const medium = ticket('medium', { effort: 'medium', criteria: 'a' });
    const low2 = ticket('low, blank lines do not count', { effort: 'low', criteria: 'a\n\nb\n  \n' });
    const low2later = ticket('low, same size, later id', { effort: 'low', criteria: 'x\ny' });
    const low3 = ticket('low, longer', { effort: 'low', criteria: 'a\nb\nc' });
    ticket('flagged', { effort: 'low', needs_human: 1 });
    dep(ticket('on an unmerged ticket', { effort: 'low' }), max);
    const merged = ticket('merged', { status: 'done', merged_at: '2026-01-01T00:00:00.000Z' });
    const onMerged = ticket('on a merged ticket', { effort: 'low', criteria: 'a\nb\nc\nd' });
    dep(onMerged, merged);
    expect(candidates(srv.board)).toEqual([low2, low2later, low3, onMerged, medium, unset, high, max]);
  });

  it('with concurrency 1 launches exactly one and the next only after the first merged, then turns itself off with a ding', async () => {
    const a = ticket('First');
    const b = ticket('Second');
    await setMax(1);
    expect(await setRun(true)).toEqual({ on: true, concurrency: 1, running: [a], left: 1, backlog: 1, waits: [], stale: false, unpushed: 0 });
    expect(t(b).status).toBe('backlog');
    expect(runs(b)).toEqual([]);
    await landed(a);
    await landed(b);
    expect(runs(b)[0].started_at >= t(a).merged_at!).toBe(true);
    expect(runner(srv.board)).toEqual({ ...STOPPED, concurrency: 1 });
    expect(sounds).toEqual([{ sound: 'ding', ticket: a }, { sound: 'ding', ticket: b }, { sound: 'ding', ticket: null }]);
    expect((await request('GET', '/api/runner')).status).toBe(200);
    expect((await request('POST', '/api/tickets/launch-all')).status).toBe(404);
  });

  it('with no concurrency in runner.json keeps 3 running; config.json\'s runner_concurrency is ignored', async () => {
    writeFileSync(join(repo, '.kanban95', 'config.json'), JSON.stringify({ runner_concurrency: 1 }));
    const ids = [1, 2, 3, 4].map((n) => ticket(`Hang ${n}`, { model: 'hang' }));
    const state = await setRun(true);
    expect(state).toMatchObject({ concurrency: 3, running: ids.slice(0, 3) });
    expect(ids.map((id) => sessionsOf(id).length)).toEqual([1, 1, 1, 0]);
  });

  it('PUT concurrency is validated and stored; a raise launches at once, a cut starts nothing new', async () => {
    for (const bad of [0, 11, 1.5, '2', null]) expect((await setMax(bad)).status).toBe(400);
    expect((await request('PUT', '/api/runner', {})).status).toBe(400);
    expect(await (await setMax(1)).json()).toMatchObject({ on: false, concurrency: 1 });
    expect(JSON.parse(readFileSync(join(repo, '.kanban95', 'runner.json'), 'utf8'))).toEqual({ on: false, concurrency: 1 });
    expect(await (await request('GET', '/api/runner')).json()).toMatchObject({ concurrency: 1 });

    const [a, b, c] = ['A', 'B', 'C'].map((x) => ticket(x, { model: 'hang' }));
    expect((await setRun(true)).running).toEqual([a]);
    expect((await (await setMax(2)).json()).running).toEqual([a, b]);
    expect((await (await setMax(1)).json()).running).toEqual([a, b]);
    expect((await request('PATCH', `/api/tickets/${a}`, { status: 'backlog' })).status).toBe(200); // running drops to 1: not below 1
    await setMax(1);
    expect(runs(c)).toEqual([]);
    expect(runs(a)).toHaveLength(1);
    expect(runner(srv.board)).toEqual({ on: true, concurrency: 1 });
  });

  it('defers a candidate that shares a non-doc file with a running ticket and launches an unrelated one instead', async () => {
    commit('src/x.ts', 'src/y.ts');
    const a = ticket('Edit x', { model: 'hang', body: 'Change `src/x.ts`.' });
    const b = ticket('Also x', { model: 'hang', body: 'Then ./src/x.ts again.' });
    const c = ticket('Unrelated', { model: 'hang', body: 'Edit src/y.ts, not missing.ts.' });
    await setMax(1);
    expect((await setRun(true)).running).toEqual([a]);
    expect(await (await setMax(2)).json()).toMatchObject({ running: [a, c], waits: [{ id: b, on: a }] });
    expect(runs(b)).toEqual([]);
  });

  it('launches the first candidate anyway when every one shares a file with a running ticket', async () => {
    commit('src/x.ts');
    const a = ticket('Edit x', { model: 'hang', body: 'src/x.ts' });
    const b = ticket('Also x', { model: 'hang', body: 'src/x.ts still builds' });
    const c = ticket('Again x', { model: 'hang', body: 'src/x.ts' });
    await setMax(1);
    await setRun(true);
    expect((await (await setMax(2)).json()).running).toEqual([a, b]);
    expect(runs(c)).toEqual([]);
  });

  it('a running branch\'s changed files count; an overlap only in docs/** or *.md does not defer', async () => {
    commit('docs/guide.md', 'README.md', 'src/x.ts');
    const a = ticket('Docs', { model: 'hang', body: 'docs/guide.md and README.md' });
    const b = ticket('Edits x', { model: 'hang', body: 'src/x.ts' });
    const c = ticket('Same docs', { model: 'hang', body: 'docs/guide.md and README.md' });
    await setMax(1);
    await setRun(true);
    // a's branch changes src/x.ts without naming it: b overlaps through the diff and waits; c shares only docs and launches.
    const wt = join(repo, '.worktrees', `t-${a}`);
    writeFileSync(join(wt, 'src', 'x.ts'), 'changed\n');
    execFileSync('git', ['commit', '-qam', 'x'], { cwd: wt });
    expect(await (await setMax(2)).json()).toMatchObject({ running: [a, c], waits: [{ id: b, on: a }] });
  });

  it('never launches a flagged ticket or one on an unmerged dependency, goes on past a failed launch, and waits for a running dependency', async () => {
    const broken = ticket('Bad cli', { cli: 'nope', effort: 'low' });
    const flagged = ticket('Flagged', { effort: 'low', needs_human: 1 });
    const stuck = ticket('Stuck', { status: 'in_progress', needs_human: 1 });
    const onStuck = ticket('On stuck', { effort: 'low' });
    dep(onStuck, stuck);
    const ok = ticket('Fine', { effort: 'high' });
    const after = ticket('After fine', { effort: 'low' });
    dep(after, ok);
    await setRun(true);
    expect(t(broken)).toMatchObject({ status: 'in_progress', flags: { needs_human: true } });
    expect(t(ok).status).toBe('in_progress');
    await landed(ok);
    expect(runner(srv.board).on).toBe(true); // `after` was held on a running ticket: not "nothing left"
    await landed(after);
    expect(runs(after)[0].started_at >= t(ok).merged_at!).toBe(true);
    for (const id of [flagged, onStuck]) {
      expect(t(id).status).toBe('backlog');
      expect(runs(id)).toEqual([]);
    }
    expect(runner(srv.board)).toEqual(STOPPED);
  });

  it('survives a restart: the flag stays on, recover resumes the running ticket, then the runner goes on', async () => {
    const cut = ticket('Cut off', { status: 'in_progress' });
    createWorktree(repo, cut);
    const next = ticket('Next');
    await setMax(1);
    expect((await setRun(true)).running).toEqual([cut]); // counted as running though its agent is gone: nothing new starts
    expect(runs(next)).toEqual([]);
    await srv.close();
    srv = await start({ repo });
    db = srv.db;
    expect(runner(srv.board).on).toBe(true);
    expect(runs(cut)).toHaveLength(1);
    expect(runs(next)).toEqual([]);
    await landed(cut);
    await landed(next);
    expect(runner(srv.board)).toEqual({ ...STOPPED, concurrency: 1 });
  });

  it('Stop starts nothing new and clears every hold while the running ticket finishes; a card\'s own Launch still works', async () => {
    const a = ticket('Running');
    const b = ticket('Waiting', { model: 'hang' });
    const gate = ticket('Gate', { needs_human: 1 });
    const held = [ticket('Held one', { blocked_on_deps: 1 }), ticket('Held two', { blocked_on_deps: 1 })];
    for (const id of held) dep(id, gate);
    await setMax(1);
    await setRun(true);
    expect(await setRun(false)).toEqual({ on: false, concurrency: 1, running: [a], left: 1, backlog: 4, waits: [], stale: false, unpushed: 0, cleared: 2 });
    expect(held.map((id) => t(id).flags.blocked_on_deps)).toEqual([false, false]);
    expect((await request('PUT', '/api/runner', { on: 'yes' })).status).toBe(400);
    await landed(a);
    expect(t(b).status).toBe('backlog');
    expect(runs(b)).toEqual([]);
    expect(sounds).toEqual([{ sound: 'ding', ticket: a }]); // no "nothing left" ding: the operator stopped it
    expect((await request('POST', `/api/tickets/${b}/launch`)).status).toBe(200);
    expect(sessionsOf(b)).toHaveLength(1);
    expect(runner(srv.board)).toEqual({ on: false, concurrency: 1 });
  });
});
