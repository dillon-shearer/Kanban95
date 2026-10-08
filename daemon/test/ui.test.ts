// The UI in headless Edge or Chrome against a running daemon. Only what the UI handoff asks to be automated; the rest of the
// UI is checked by the dogfood cycle, not by DOM tests.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { start } from '../src/server.ts';
import { MANIFEST, modelDir, status } from '../src/voice.ts';
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
  await call('move_ticket', { status: 'done' });
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
const CACHE = resolve(import.meta.dirname, '.cache', 'voice-model');
const WAV = resolve(import.meta.dirname, 'fixtures', 'merge-queue.wav');

let repo: string;
let bin: string;
let srv: Awaited<ReturnType<typeof start>>;
let db: DatabaseSync;
let page: Page;
let base: string;
const PATH0 = process.env.PATH;
const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
const ticket = (title: string, cols: Record<string, unknown> = {}) => {
  const keys = ['title', ...Object.keys(cols)];
  return Number(db.prepare(`INSERT INTO tickets (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(title, ...(Object.values(cols) as never[])).lastInsertRowid);
};
const statusOf = (id: number) => (db.prepare('SELECT status FROM tickets WHERE id = ?').get(id) as { status: string }).status;
const column = (id: number) => page.evaluate<string | null>(`document.querySelector('.card[data-id="${id}"]')?.closest('[data-status]')?.dataset.status ?? null`);
const statusBar = () => page.evaluate<string>(`document.querySelector('.k95-board .status-bar-field').textContent`);
const click = async (selector: string) => {
  const { x, y } = await page.center(selector);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
};

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
    cli: 'claude', claude: { execute: { model: 'work', effort: 'low' }, test: { model: 'pass', effort: 'low' } },
  }));
  srv = await start({ repo });
  db = srv.db;
  base = `http://127.0.0.1:${srv.port}/`;
  page = await browser();
  // As the shell does: open on ?k95=<secret>, which the daemon trades for a cookie and redirects to /.
  await page.send('Page.navigate', { url: `${base}?k95=${srv.secret}` });
  await until(() => page.evaluate(`document.readyState === 'complete' && location.href === ${JSON.stringify(base)}`), 'the redirect to /');
}, 30_000);
afterAll(async () => {
  await page?.close();
  await srv?.close();
  process.env.PATH = PATH0;
  rmSync(bin, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true, maxRetries: 5 });
});

describe('ui', { timeout: 60_000 }, () => {
  it('snaps an illegal drop back and names the allowed targets; a legal drop moves the card without a reload', async () => {
    const id = ticket('Drag me');
    await page.goto(base);
    await until(() => column(id), 'the card');
    await page.evaluate('window.__noReload = true');

    await page.drag(await page.center(`.card[data-id="${id}"]`), await page.center('[data-status="testing"] .cards'));
    await until(async () => (await statusBar()).includes('cannot be dragged'), 'the status-bar message');
    expect(await statusBar()).toBe(`#${id} cannot be dragged from Backlog to Testing. Allowed: In Progress.`);
    expect(await column(id)).toBe('backlog');
    expect(statusOf(id)).toBe('backlog');

    await page.drag(await page.center(`.card[data-id="${id}"]`), await page.center('[data-status="in_progress"] .cards'));
    await until(async () => (await column(id)) === 'in_progress', 'the card in In Progress');
    expect(statusOf(id)).toBe('in_progress');
    expect(await page.evaluate('window.__noReload')).toBe(true);
    db.prepare("UPDATE tickets SET status = 'done', merged_at = 'x' WHERE id = ?").run(id); // out of the way of the next tests
  });

  it('keeps column scroll and the focused card across an event redraw', async () => {
    const ids = Array.from({ length: 30 }, (_, i) => ticket(`Long ${i}`));
    const last = ids.at(-1)!;
    try {
      await page.goto(base);
      await until(() => column(last), 'the cards');
      const top = await page.evaluate<number>(`(() => { const c = document.querySelector('[data-status="backlog"] .cards'); c.scrollTop = c.scrollHeight; document.querySelector('.card[data-id="${last}"]').focus(); return c.scrollTop; })()`);
      expect(top).toBeGreaterThan(0);
      await page.evaluate(`fetch('/api/tickets/${ids[0]}', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Renamed' }) })`);
      await until(() => page.evaluate<boolean>(`document.querySelector('.card[data-id="${ids[0]}"]').textContent.includes('Renamed')`), 'the redraw');
      expect(await page.evaluate<number>(`document.querySelector('[data-status="backlog"] .cards').scrollTop`)).toBe(top);
      expect(await page.evaluate<string>(`document.activeElement.dataset.id`)).toBe(String(last));
    } finally {
      for (const id of ids) db.prepare("UPDATE tickets SET status = 'done', merged_at = 'x' WHERE id = ?").run(id);
    }
  });

  it('names the reason in the status bar when a launch is refused, not "launched"', async () => {
    const id = ticket('Refused');
    await page.goto(base);
    await until(() => column(id), 'the card');
    writeFileSync(join(repo, 'a.txt'), 'dirty\n'); // the board refuses to launch from a dirty base
    try {
      await click(`.card[data-id="${id}"]`);
      await page.evaluate(`[...document.querySelectorAll('.k95-board button')].find((b) => b.textContent === 'Launch').click()`);
      await until(async () => (await statusBar()).startsWith(`#${id} needs you:`), 'the reason in the status bar');
      await new Promise((r) => setTimeout(r, 300)); // a late "launched" would land here
      expect(await statusBar()).toMatch(new RegExp(`^#${id} needs you: launch failed: base branch main has uncommitted changes`));
    } finally {
      git('checkout', 'a.txt');
      db.prepare("UPDATE tickets SET status = 'done', merged_at = 'x' WHERE id = ?").run(id);
    }
  });

  it('clears the needs_human badge on the card when the Inbox answer is sent', async () => {
    const id = ticket('Ask me', { model: 'ask' });
    await page.goto(base);
    await until(() => column(id), 'the card');
    expect((await fetch(`${base}api/tickets/${id}/launch`, { method: 'POST', headers: { cookie: `k95=${srv.secret}` } })).status).toBe(200);
    const flagged = `.card[data-id="${id}"] .badge.flag`;
    await until(() => page.evaluate(`!!document.querySelector('${flagged}')`), 'the needs human badge');

    await click('#inbox-count');
    const box = `.k95-question[data-ticket="${id}"]`;
    await until(() => page.evaluate(`!!document.querySelector('${box} textarea')`), 'the question in the Inbox');
    await page.evaluate(`document.querySelector('${box} textarea').value = 'Navy blue'`);
    await click(`${box} button:not(.k95-mic)`);

    await until(() => page.evaluate(`!document.querySelector('${flagged}')`), 'the badge to clear', 5000);
    expect(db.prepare("SELECT body FROM notes WHERE ticket_id = ? AND kind = 'answer'").all(id)).toEqual([{ body: 'Navy blue' }]);
    await until(() => (db.prepare('SELECT merged_at FROM tickets WHERE id = ?').get(id) as { merged_at: string | null }).merged_at, 'the merge', 30_000);
    expect(git('show', 'HEAD:answer.txt')).toBe('Navy blue');
  });

  it('pins a compact tray right after Start on one taskbar row', async () => {
    await page.goto(base);
    await until(() => page.evaluate(`!!document.querySelector('#clock').textContent`), 'the clock');
    const m = await page.evaluate<Record<string, number>>(`(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect(), bar = document.getElementById('taskbar');
      const start = r('#start'), tray = r('#tray'), tasks = r('#tasks');
      return { gap: tray.left - start.right, trayH: tray.height, startH: start.height,
        trayW: tray.width, tasksAfter: tasks.left - tray.right, overflow: bar.scrollWidth - bar.clientWidth,
        font: parseFloat(getComputedStyle(document.getElementById('agents')).fontSize) };
    })()`);
    expect(m.gap).toBeLessThanOrEqual(4);
    expect(m.tasksAfter).toBeGreaterThanOrEqual(0);
    expect(m.trayH).toBeLessThanOrEqual(m.startH);
    expect(m.trayW).toBeLessThan(300); // 98.css's .status-bar-field flex-grow stretched it across the bar
    expect(m.font).toBe(11);
    expect(m.overflow).toBe(0);
  });

  it('keeps window positions across a reload', async () => {
    await page.goto(base);
    await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
    const pos = () => page.evaluate<[number, number]>(`(() => { const e = document.querySelector('[data-win="board"]'); return [e.offsetLeft, e.offsetTop]; })()`);
    const [x0, y0] = await pos();
    const bar = await page.center('[data-win="board"] .title-bar-text');
    await page.drag(bar, { x: bar.x + 90, y: bar.y + 50 });
    const moved = await pos();
    expect(moved).toEqual([x0 + 90, y0 + 50]);
    await page.goto(base + '?reloaded');
    await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board after reload');
    expect(await pos()).toEqual(moved);
  });

  it('opens Settings from a double-clicked desktop icon and Inbox from Enter; icons stay under windows', async () => {
    await page.goto(base);
    await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
    expect(await page.evaluate(`[...document.querySelectorAll('#icons .k95-icon')].map((e) => e.textContent)`))
      .toEqual(['Board', 'Inbox', 'Brain', 'Settings', 'New ticket', 'New brainstorm']);
    await page.evaluate(`document.querySelector('[data-win="board"] [aria-label="Close"]').click()`); // the board may sit over the icons
    // Every image loaded from our origin: a CSP block or a missing file leaves naturalWidth at 0.
    await until(() => page.evaluate(`[...document.querySelectorAll('#icons img')].every((i) => i.complete && i.naturalWidth === 32)`), 'the icon images');

    const { x, y } = await page.center('[data-icon="Settings"]');
    expect(await page.evaluate(`document.elementFromPoint(${x}, ${y}).closest('.k95-icon')?.dataset.icon ?? null`)).toBe('Settings');
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    expect(await page.evaluate(`document.activeElement.dataset.icon`)).toBe('Settings');
    expect(await page.evaluate(`getComputedStyle(document.activeElement.querySelector('span')).backgroundColor`)).toBe('rgb(0, 0, 128)');
    expect(await page.evaluate(`!!document.querySelector('[data-win="settings"]')`)).toBe(false); // one click only selects
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 2 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 2 });
    await until(() => page.evaluate(`!!document.querySelector('[data-win="settings"]')`), 'the Settings window');

    await page.evaluate(`document.querySelector('[data-icon="Inbox"]').focus()`);
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await until(() => page.evaluate(`!!document.querySelector('[data-win="inbox"]')`), 'the Inbox window');

    // A window dragged over the icons covers them.
    await page.evaluate(`Object.assign(document.querySelector('[data-win="settings"]').style, { left: '0px', top: '0px' })`);
    const s = await page.center('[data-icon="Board"]');
    expect(await page.evaluate(`!!document.elementFromPoint(${s.x}, ${s.y}).closest('[data-win]')`)).toBe(true);
  });

  it('keeps a window the same size while it is dragged', async () => {
    await page.goto(base + '?resize');
    await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
    const size = () => page.evaluate<[number, number]>(`(() => { const e = document.querySelector('[data-win="board"]'); return [e.offsetWidth, e.offsetHeight]; })()`);
    const before = await size();
    const bar = await page.center('[data-win="board"] .title-bar-text');
    await page.drag(bar, { x: bar.x + 200, y: bar.y });
    expect(await size()).toEqual(before);
  });

  it('shows the download dialog on the first mic press and fetches nothing until OK', async () => {
    rmSync(modelDir(MANIFEST), { recursive: true, force: true });
    await page.goto(base);
    await click('.k95-toolbar button:nth-child(4)'); // New ticket: a window with text fields, so with mics
    await until(() => page.evaluate(`!!document.querySelector('[data-win="ticket-new"] .k95-mic')`), 'a mic button');
    await click('[data-win="ticket-new"] .k95-mic');
    const dlg = await until(() => page.evaluate<string>(`document.querySelector('dialog[open]')?.textContent ?? ''`), 'the download dialog');
    expect(dlg).toContain(MANIFEST.id);
    expect(dlg).toContain(`${MANIFEST.source}/tree/${MANIFEST.revision}`);
    expect(dlg).toContain(MANIFEST.files.find((f) => f.path.includes('decoder'))!.sha256);
    await page.evaluate(`[...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === 'Cancel').click()`);
    await until(() => page.evaluate('!document.querySelector("dialog[open]")'), 'the dialog to close');
    expect(db.prepare("SELECT count(*) AS n FROM audit WHERE tool = 'voice.download'").get()).toEqual({ n: 0 });
    expect(existsSync(modelDir(MANIFEST))).toBe(false);
  });

  it('transcribes the bundled WAV with the local model', { timeout: 600_000 }, async () => {
    if (existsSync(CACHE)) cpSync(CACHE, modelDir(MANIFEST), { recursive: true });
    // The daemon verifies every file's SHA-256, cached or not; a missing or tampered file is fetched again.
    const r = await fetch(`${base}api/voice/download`, { method: 'POST', headers: { cookie: `k95=${srv.secret}` } });
    expect(r.status, await r.clone().text()).toBe(200);
    expect(status().downloaded).toBe(true);
    if (!existsSync(CACHE)) cpSync(modelDir(MANIFEST), CACHE, { recursive: true });

    await page.goto(base);
    const wav = readFileSync(WAV).toString('base64');
    const text = await page.evaluate<string>(`(async () => {
      const { transcribe } = await import('/voice.js');
      const bytes = Uint8Array.from(atob('${wav}'), (c) => c.charCodeAt(0));
      return transcribe(new Blob([bytes], { type: 'audio/wav' }));
    })()`);
    // The fixture is Windows TTS saying "Please add a test for the merge queue."
    expect(text.toLowerCase()).toMatch(/add a test for the merge queue/);
  });
});
