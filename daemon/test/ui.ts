// Shared setup for the ui-*.test.ts files: a throwaway repo, a fake `claude` on PATH, a daemon and a headless browser
// logged in to it. Importing this file registers the beforeAll/afterAll for the importing test file. Exports are live
// bindings, so `page`, `db` and the rest are set once beforeAll has run. Only what the UI handoff asks to be automated;
// the rest of the UI is checked by the dogfood cycle, not by DOM tests.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll } from 'vitest';
import { sources } from '../src/limits.ts';
import { start } from '../src/server.ts';
import { browser, until, type Page } from './cdp.ts';

// Fake `claude`: asks the operator a question when its model is `ask`, commits the answer and submits; a test run passes.
const FAKE = `
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
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
const line = () => new Promise((ok) => process.stdin.setEncoding('utf8').once('data', (d) => ok(d.trim())));
console.log('FAKE ' + model);
if (brief.startsWith('# Test')) {
  await call('report_test', { passed: true, summary: 'ok' });
} else if (model === 'ask') {
  await call('ask_operator', { question: 'Which colour?' });
  writeFileSync('answer.txt', await line());
  execFileSync('git', ['add', 'answer.txt']);
  execFileSync('git', ['commit', '-qm', 'Add the answer']);
  await call('move_ticket', { status: 'testing' });
}
process.stdin.resume();
`;
// The speech model is 77 MB: downloaded through the daemon once, then kept here (gitignored) for later runs.
export const CACHE = resolve(import.meta.dirname, '.cache', 'voice-model');
export const WAV = resolve(import.meta.dirname, 'fixtures', 'merge-queue.wav');

export let repo: string;
let bin: string;
export let srv: Awaited<ReturnType<typeof start>>;
export let db: DatabaseSync;
export let page: Page;
export let base: string;
const PATH0 = process.env.PATH;
export let limitCalls = 0;
export const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
export const ticket = (title: string, cols: Record<string, unknown> = {}) => {
  const keys = ['title', ...Object.keys(cols)];
  return Number(db.prepare(`INSERT INTO tickets (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(title, ...(Object.values(cols) as never[])).lastInsertRowid);
};
export const statusOf = (id: number) => (db.prepare('SELECT status FROM tickets WHERE id = ?').get(id) as { status: string }).status;
export const column = (id: number) => page.evaluate<string | null>(`document.querySelector('.card[data-id="${id}"]')?.closest('[data-status]')?.dataset.status ?? null`);
export const statusBar = () => page.evaluate<string>(`document.querySelector('.k95-board .status-bar-field').textContent`);
/** A real click; `modifiers` is CDP's bit field (2 Ctrl, 8 Shift). */
export const click = async (selector: string, modifiers = 0) => {
  const { x, y } = await page.center(selector);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, modifiers, button: 'left', buttons: 1, clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, modifiers, button: 'left', buttons: 0, clickCount: 1 });
};
export const rightClick = async (selector: string) => {
  const { x, y } = await page.center(selector);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1 });
};
export const menuItems = () => page.evaluate<string[]>(`[...document.querySelectorAll('.k95-menu > li[role="menuitem"]')].map((li) => li.textContent)`);
export const menuPick = (label: string) => page.evaluate(`[...document.querySelectorAll('.k95-menu > li')].find((li) => li.textContent === ${JSON.stringify(label)}).click()`);

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'k95-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  git('config', 'user.name', 'Op Erator');
  git('config', 'user.email', 'op@example.com');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git('add', 'a.txt');
  git('commit', '-qm', 'init');
  bin = mkdtempSync(join(tmpdir(), 'k95-bin-'));
  writeFileSync(join(bin, 'fake.mjs'), FAKE);
  writeFileSync(join(bin, 'claude.cmd'), `@node "%~dp0fake.mjs" %*\r\n`);
  process.env.PATH = bin + delimiter + PATH0;
  mkdirSync(join(process.env.USERPROFILE!, '.kanban95'), { recursive: true });
  writeFileSync(join(process.env.USERPROFILE!, '.kanban95', 'models.json'), JSON.stringify({
    cli: 'claude', claude: { plan: { model: 'plan', effort: 'low' }, execute: { model: 'work', effort: 'low' }, test: { model: 'pass', effort: 'low' } },
  }));
  // The tray asks for limits on load: canned answers, never the real CLIs. Claude's count says how often it was asked.
  sources.claude = async () => `Current session: ${62 + limitCalls++}% used · resets Oct 8, 7:59pm (America/New_York)`;
  sources.codex = async () => { throw new Error('codex app-server could not start: ENOENT'); };
  srv = await start({ repo });
  db = srv.db;
  base = `http://127.0.0.1:${srv.port}/`;
  page = await browser();
  // As the shell does: open on ?k95=<secret>, which the daemon trades for a cookie and redirects to /.
  await page.send('Page.navigate', { url: `${base}?k95=${srv.secret}` });
  await until(() => page.evaluate(`document.readyState === 'complete' && location.href === ${JSON.stringify(base)}`), 'the redirect to /');
}, 120_000); // a cold browser start on a loaded machine
afterAll(async () => {
  await page?.close();
  await srv?.close();
  process.env.PATH = PATH0;
  rmSync(bin, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true, maxRetries: 5 });
}, 60_000);
