// Shared setup for the lifecycle-*.test.ts files: a fake `claude` first on PATH, and for every test a fresh repo and a
// daemon on it. Importing this file registers the hooks for the importing test file. Exports are live bindings (as in
// ui.ts), so `srv`, `db` and `repo` are the current test's; a test that restarts the daemon calls `boot()` after `srv.close()`.
// The scenarios are split over several files so they run in parallel: one file of them was the suite's critical path.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import { readTicket } from '../src/api.ts';
import { worktreePath } from '../src/git.ts';
import { sessions } from '../src/launcher.ts';
import { events } from '../src/lifecycle.ts';
import { start } from '../src/server.ts';

// Fake `claude` first on PATH: a scripted agent that talks to /mcp like the real CLI and stays up until the board ends it.
// The brief's heading says which phase it is in; the model name says how it behaves (see `behave` below).
// Like Claude Code it keeps a transcript per --session-id under ~/.claude/projects. Started with --resume it records its argv
// and bearer in resumed.json in the worktree and stays up.
const bin = mkdtempSync(join(tmpdir(), 'k95-bin-'));
const FAKE = `
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
const argv = process.argv.slice(2);
const model = argv[argv.indexOf('--model') + 1];
const mcp = JSON.parse(readFileSync(argv[argv.indexOf('--mcp-config') + 1], 'utf8')).mcpServers.kanban95;
let transcript;
if (argv.includes('--session-id')) {
  const project = process.env.USERPROFILE + '/.claude/projects/' + process.cwd().replace(/[^A-Za-z0-9]/g, '-');
  mkdirSync(project, { recursive: true });
  transcript = project + '/' + argv[argv.indexOf('--session-id') + 1] + '.jsonl';
  writeFileSync(transcript, '{}\\n');
}
if (argv.includes('--resume')) {
  writeFileSync('resumed.json', JSON.stringify({ argv, auth: mcp.headers.Authorization }));
  console.log('FAKE RESUMED');
  await new Promise(() => process.stdin.resume());
}
const brief = argv.includes('--resume') ? '' : readFileSync(/^Read (\\S+) in full/.exec(argv.at(-1))[1], 'utf8');
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
  mkdirSync(dirname(file), { recursive: true });
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
} else if (model === 'chatty' || model === 'nap') {
  // chatty: a transcript line every 100 ms, like an agent at work. nap: quiet for 1.5 s first, then the same.
  if (model === 'nap') await new Promise((r) => setTimeout(r, 1500));
  setInterval(() => appendFileSync(transcript, '{}\\n'), 100);
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
  } else if (model.startsWith('touch-')) commit(model.slice(6) + '/' + name + '.txt', 'done\\n'); // touch-daemon: a change under daemon/
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

export let repo: string;
export let srv: Awaited<ReturnType<typeof start>>;
export let db: DatabaseSync;
export let sounds: { sound: string; ticket: number }[];
const onEvent = (e: { sound: string; ticket: number }) => sounds.push(e);
export const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
export const models = (o: { execute?: string; test?: string } = {}) =>
  writeFileSync(join(process.env.USERPROFILE!, '.kanban95', 'models.json'), JSON.stringify({
    cli: 'claude',
    claude: { execute: { model: o.execute ?? 'work', effort: 'low' }, test: { model: o.test ?? 'pass', effort: 'low' } },
  }));
export const ticket = (title: string, cols: Record<string, unknown> = {}) => {
  const keys = ['title', ...Object.keys(cols)];
  const r = db.prepare(`INSERT INTO tickets (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(title, ...(Object.values(cols) as never[]));
  return Number(r.lastInsertRowid);
};
export const t = (id: number) => readTicket(db, id);
export const runs = (id: number) => db.prepare('SELECT phase, model, outcome, prompt_rendered, started_at, session_id FROM runs WHERE ticket_id = ? ORDER BY id').all(id) as
  { phase: string; model: string; outcome: string | null; prompt_rendered: string; started_at: string; session_id: string | null }[];
export const notes = (id: number, kind: string) => (db.prepare('SELECT body FROM notes WHERE ticket_id = ? AND kind = ? ORDER BY id').all(id, kind) as { body: string }[]).map((r) => r.body);
export const send = (method: string) => (path: string, body?: unknown) =>
  fetch(`http://127.0.0.1:${srv.port}${path}`, { method, headers: { 'content-type': 'application/json', cookie: `k95=${srv.secret}` }, body: body === undefined ? undefined : JSON.stringify(body) });
export const post = send('POST');
export const patch = send('PATCH');
export const setRun = (on: boolean) => send('PUT')('/api/runner', { on });
export const until = async (f: () => unknown, what: string, ms = 30_000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};
// Every backlog ticket at once, in one request (so none can finish before the last starts): the runner with room for all.
export const launchTogether = (n: number) =>
  fetch(`http://127.0.0.1:${srv.port}/api/runner`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie: `k95=${srv.secret}` }, body: JSON.stringify({ on: true, concurrency: n }) });
export const mergeInProgress = (dir: string) => {
  try {
    execFileSync('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: dir, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
export const landed = (id: number) => until(() => t(id).merged_at && !existsSync(worktreePath(repo, id)), `ticket ${id} merged and cleaned`);
/** Starts the daemon on `repo`, again after a test's `srv.close()`: `srv` and `db` are then the new daemon's. */
export async function boot() {
  srv = await start({ repo });
  db = srv.db;
}

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
  await boot();
  sounds = [];
  events.on('event', onEvent);
});
afterEach(async () => {
  events.off('event', onEvent);
  // close() kills every pty. Killed before its fake printed, the pty's cmd.exe dies but the node it was starting lives on,
  // orphaned, holding its worktree under the test home: the home's removal then fails the file with EPERM.
  await until(() => [...sessions.values()].every((s) => s.scrollback().includes('FAKE')), 'every agent to print before the kill', 20_000);
  await srv.close();
  // A killed agent's process can hold the repo for seconds after its pty exits when the full suite loads the machine: EPERM
  // with the default 5 x 100 ms. Up to about 14 s here, inside the pty project's 30 s hook limit.
  rmSync(repo, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 });
});
