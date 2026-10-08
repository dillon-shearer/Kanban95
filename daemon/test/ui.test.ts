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

  it('attaches a pasted screenshot and a dropped PNG to the Ticket window, with thumbnails, and removes one', async () => {
    const id = ticket('Screenshot me');
    await page.goto(base);
    await until(() => column(id), 'the card');
    await page.evaluate(`document.querySelector('.card[data-id="${id}"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    const win = `[data-win="ticket-${id}"]`;
    await until(() => page.evaluate(`!!document.querySelector('${win} .k95-attachments')`), 'the Ticket window');
    // A 1x1 PNG, as the clipboard hands a screenshot over (Chromium names it image.png).
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const file = (name: string) => `(() => { const d = new DataTransfer(); d.items.add(new File([Uint8Array.from(atob('${png}'), (c) => c.charCodeAt(0))], '${name}', { type: 'image/png' })); return d; })()`;
    await page.evaluate(`document.activeElement?.blur(); document.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: ${file('image.png')} }))`);
    await page.evaluate(`document.querySelector('${win} .window-body').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: ${file('dropped.png')} }))`);

    const dir = join(repo, '.kanban95', 'attachments', String(id));
    await until(() => existsSync(join(dir, 'image.png')) && existsSync(join(dir, 'dropped.png')), 'both files on disk');
    const thumbs = `[...document.querySelectorAll('${win} .k95-attachment img')]`;
    await until(() => page.evaluate(`${thumbs}.length === 2 && ${thumbs}.every((i) => i.complete && i.naturalWidth === 1)`), 'two loaded thumbnails', 5000);

    await page.evaluate(`[...document.querySelectorAll('${win} .k95-attachment')].find((r) => r.textContent.includes('dropped.png')).querySelector('button').click()`);
    await until(() => page.evaluate(`${thumbs}.length === 1`), 'the removed row to go');
    expect(existsSync(join(dir, 'dropped.png'))).toBe(false);
    expect(existsSync(join(dir, 'image.png'))).toBe(true);
  });

  it('lists a failed merge in the Inbox with its note and the buttons that fix it, and counts it in the taskbar', async () => {
    const id = ticket('Stuck merge', { status: 'done', needs_human: 1 });
    const body = `merge conflict with main: CONFLICT (add/add) in shared.txt\nTo resolve: in .worktrees/t-${id} run git merge with the base branch, then Retry merge.`;
    db.prepare("INSERT INTO notes (ticket_id, role, kind, body) VALUES (?, 'tester', 'failure', ?)").run(id, body);
    try {
      await page.goto(base);
      await until(() => column(id), 'the card');
      const n = (await (await fetch(`${base}api/inbox`, { headers: { cookie: `k95=${srv.secret}` } })).json()).length;
      expect(await page.evaluate(`document.getElementById('inbox-count').textContent`)).toBe(`Inbox ${n}`);
      await click('#inbox-count');
      const box = `.k95-flag[data-ticket="${id}"]`;
      await until(() => page.evaluate(`!!document.querySelector('${box}')`), 'the failure in the Inbox');
      expect(await page.evaluate(`document.querySelector('${box} pre').textContent`)).toBe(body);
      expect(await page.evaluate(`[...document.querySelectorAll('${box} button')].map((b) => b.textContent)`)).toEqual(['Open ticket', 'Retry merge']);
      await click(`${box} button`);
      const facts = `[data-win="ticket-${id}"] .k95-facts`;
      await until(() => page.evaluate(`!!document.querySelector('${facts}')`), 'the ticket window');
      expect(await page.evaluate(`document.querySelector('${facts}').textContent`)).toContain('needs human (the Inbox says why)');
    } finally {
      db.prepare("UPDATE tickets SET needs_human = 0, merged_at = 'x' WHERE id = ?").run(id);
    }
  });

  it('keeps an ended terminal open while its ticket exists; deleting the ticket closes its terminal and Ticket window', async () => {
    const id = ticket('Delete me');
    await page.goto(base);
    await until(() => column(id), 'the card');
    const win = (wid: string) => page.evaluate<boolean>(`!!document.querySelector('[data-win="${wid}"]')`);
    const tasks = () => page.evaluate<number>(`[...document.querySelectorAll('#tasks .task')].filter((b) => /#${id}\\b/.test(b.textContent)).length`);
    const launchAgent = async () => {
      expect((await fetch(`${base}api/tickets/${id}/launch`, { method: 'POST', headers: { cookie: `k95=${srv.secret}` } })).status).toBe(200);
      await until(() => page.evaluate(`!!document.querySelector('[data-win^="term-"]:not(.ended) .xterm')`), 'the terminal');
      return page.evaluate<string>(`document.querySelector('[data-win^="term-"]:not(.ended)').dataset.win`);
    };

    const first = await launchAgent();
    const grant = (db.prepare('SELECT id FROM grants WHERE ticket_id = ? AND revoked_at IS NULL').get(id) as { id: number }).id;
    await fetch(`${base}api/grants/${grant}`, { method: 'DELETE', headers: { cookie: `k95=${srv.secret}` } });
    await until(() => page.evaluate(`document.querySelector('[data-win="${first}"]').classList.contains('ended')`), 'the ended terminal');
    expect(await page.evaluate<string>(`document.querySelector('[data-win="${first}"] .title-bar-text').textContent`)).toMatch(/\(ended\)$/);

    db.prepare("UPDATE tickets SET status = 'backlog' WHERE id = ?").run(id);
    const second = await launchAgent();
    await page.evaluate(`document.querySelector('.card[data-id="${id}"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await until(() => win(`ticket-${id}`), 'the Ticket window');
    expect(await tasks()).toBe(3);

    expect((await fetch(`${base}api/tickets/${id}`, { method: 'DELETE', headers: { cookie: `k95=${srv.secret}` } })).status).toBe(204);
    await until(async () => !(await win(`ticket-${id}`)) && !(await win(first)) && !(await win(second)), 'the windows to close', 5000);
    expect(await tasks()).toBe(0);
  });

  it('offers Resume in the card menu and the Inbox for a flagged running ticket whose agent is gone; Resume starts it again', async () => {
    const id = ticket('Died', { status: 'in_progress', needs_human: 1, retry: 2 });
    db.prepare("INSERT INTO notes (ticket_id, role, kind, body) VALUES (?, 'worker', 'failure', 'agent exited without reporting')").run(id);
    try {
      // The id may be the one the previous test deleted, whose killed agents can still be closing under load.
      const sessions = async () => (await (await fetch(`${base}api/sessions`, { headers: { cookie: `k95=${srv.secret}` } })).json()) as { ticket_id: number }[];
      await until(async () => !(await sessions()).some((s) => s.ticket_id === id), 'the deleted ticket\'s agents to exit');
      await page.goto(base);
      await until(() => column(id), 'the card');
      const item =(label: string) => `[...document.querySelectorAll('.k95-menu li')].find((li) => li.firstChild.textContent === '${label}')`;
      await page.evaluate(`document.querySelector('.card[data-id="${id}"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 50 }))`);
      expect(await page.evaluate(`${item('Resume')}?.getAttribute('aria-disabled') ?? 'enabled'`)).toBe('enabled');
      expect(await page.evaluate(`${item('Launch')}?.getAttribute('aria-disabled') ?? 'enabled'`)).toBe('enabled');
      await page.evaluate(`document.querySelector('.k95-menu').remove()`);

      await click('#inbox-count');
      const box = `.k95-flag[data-ticket="${id}"]`;
      await until(() => page.evaluate(`!!document.querySelector('${box} button')`), 'the failure in the Inbox');
      expect(await page.evaluate(`document.querySelector('${box} pre').textContent`)).toBe('agent exited without reporting');
      expect(await page.evaluate(`[...document.querySelectorAll('${box} button')].map((b) => b.textContent)`)).toEqual(['Open ticket', 'Resume', 'Reset to Backlog']);
      await click(`${box} button:nth-child(2)`);
      await until(() => !(db.prepare('SELECT needs_human FROM tickets WHERE id = ?').get(id) as { needs_human: number }).needs_human, 'the flag to clear', 5000);
      expect(db.prepare('SELECT status, retry FROM tickets WHERE id = ?').get(id)).toEqual({ status: 'in_progress', retry: 2 });
      expect((db.prepare("SELECT prompt_rendered FROM runs WHERE ticket_id = ? AND phase = 'execute'").get(id) as { prompt_rendered: string }).prompt_rendered)
        .toContain('agent exited without reporting');
    } finally {
      db.prepare("UPDATE tickets SET status = 'done', merged_at = 'x', needs_human = 0 WHERE id = ?").run(id);
    }
  });

  it('Run and Ctrl+L toggle the runner; the button and its status line redraw from /events; it says when it stopped itself', async () => {
    db.prepare("UPDATE tickets SET status = 'done', merged_at = coalesce(merged_at, 'x'), needs_human = 0").run(); // earlier tests' leftovers
    const id = ticket('Run me');
    const button = `[...document.querySelectorAll('.k95-toolbar button')].find((b) => b.title === 'Ctrl+L')`;
    const label = () => page.evaluate<string>(`${button}.textContent`);
    const line = () => page.evaluate<string>(`document.querySelector('.k95-runner').textContent`);
    await page.goto(base);
    await until(() => column(id), 'the card');
    await page.evaluate('window.__noReload = true');
    expect(await label()).toBe('Run');

    await page.evaluate(`${button}.click()`);
    await until(async () => (await line()) === `Running: #${id} (0 of 0 candidates left)`, 'the running line');
    expect(await label()).toBe('Stop');
    // Stopped from outside the page: only /events can tell it.
    await fetch(`${base}api/runner`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie: `k95=${srv.secret}` }, body: '{"on":false}' });
    await until(async () => (await label()) === 'Run', 'the button back to Run');
    expect(await line()).toBe('');

    await fetch(`${base}api/tickets/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: `k95=${srv.secret}` }, body: '{"status":"backlog"}' }); // stops its agent
    db.prepare("UPDATE tickets SET status = 'done', merged_at = 'x' WHERE id = ?").run(id);
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'l', code: 'KeyL', modifiers: 2, windowsVirtualKeyCode: 76 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'l', code: 'KeyL', modifiers: 2, windowsVirtualKeyCode: 76 });
    await until(async () => (await line()) === 'Runner stopped: nothing left to launch', 'the stopped line');
    expect(await label()).toBe('Run');
    expect(await page.evaluate('window.__noReload')).toBe(true);
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
      .toEqual(['Board', 'Inbox', 'Brain', 'Settings', 'Notepad', 'New ticket', 'New brainstorm']);
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

  it('saves preferences from Settings > Prompts and shows a refusal over 16 KB', async () => {
    const file = join(process.env.USERPROFILE!, '.kanban95', 'preferences.md');
    await page.goto(base);
    await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
    await page.evaluate(`document.querySelector('[data-icon="Settings"]').dispatchEvent(new MouseEvent('dblclick'))`);
    await page.evaluate(`[...document.querySelectorAll('[data-win="settings"] [role=tab] a')].find((t) => t.textContent === 'Prompts').click()`);
    await until(() => page.evaluate(`!!document.querySelector('#preferences')`), 'the Prompts tab');
    const save = (text: string) => page.evaluate(`(() => { document.querySelector('#preferences').value = ${JSON.stringify(text)};
      [...document.querySelectorAll('[data-win="settings"] button')].find((b) => b.textContent === 'Save').click(); })()`);
    await save('no em dashes');
    await until(() => existsSync(file) && readFileSync(file, 'utf8') === 'no em dashes', 'preferences.md');
    await save('x'.repeat(16 * 1024 + 1));
    await until(async () => (await statusBar()).includes('over 16 KB'), 'the refusal in the status bar');
    expect(readFileSync(file, 'utf8')).toBe('no em dashes');
    rmSync(file);
  });

  it('autosaves the Notepad, brings the text back after a reload, and drafts a ticket from the selection', async () => {
    const file = join(repo, '.kanban95', 'notepad.md');
    const area = '[data-win="notepad"] textarea';
    const TEXT = 'draft one\nfix the login bug';
    await page.goto(base);
    await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
    await page.evaluate(`document.querySelector('[data-icon="Notepad"]').dispatchEvent(new MouseEvent('dblclick'))`);
    await until(() => page.evaluate(`document.querySelector('${area}')?.readOnly === false`), 'the loaded Notepad');
    expect(await page.evaluate(`document.querySelector('${area}').nextElementSibling?.classList.contains('k95-mic')`)).toBe(true);
    await click(area);
    await page.send('Input.insertText', { text: TEXT });
    await until(() => existsSync(file) && readFileSync(file, 'utf8') === TEXT, 'notepad.md after the pause');

    await page.goto(base + '?notepad');
    await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board after reload');
    await page.evaluate(`document.querySelector('#start').click()`);
    await page.evaluate(`[...document.querySelectorAll('.k95-menu *')].find((e) => e.textContent === 'Notepad').click()`);
    await until(() => page.evaluate(`document.querySelector('${area}')?.value === ${JSON.stringify(TEXT)}`), 'the text after reload');

    await page.evaluate(`document.querySelector('${area}').setSelectionRange(10, 28)`);
    await page.evaluate(`[...document.querySelectorAll('[data-win="notepad"] button')].find((b) => b.textContent === 'New ticket from selection').click()`);
    await until(() => page.evaluate(`document.querySelector('[data-win="ticket-new"] [data-field="body"]')?.value === 'fix the login bug'`), 'the New ticket body');

    // Over 256 KB: the daemon answers 413 and the window says so; the file keeps the last good text.
    await page.evaluate(`(() => { const t = document.querySelector('${area}'); t.value = 'x'.repeat(256 * 1024 + 1); t.dispatchEvent(new Event('input')); })()`);
    await until(() => page.evaluate(`document.querySelector('[data-win="notepad"] .status-bar-field').textContent.includes('256 KB')`), 'the refusal in the Notepad');
    expect(readFileSync(file, 'utf8')).toBe(TEXT);
    rmSync(file);
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

  it('maximizes to the desktop, ignores drags, restores the exact geometry and survives a reload', async () => {
    await page.goto(base + '?max');
    await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
    const box = () => page.evaluate<number[]>(`(() => { const e = document.querySelector('[data-win="board"]'); return [e.offsetLeft, e.offsetTop, e.offsetWidth, e.offsetHeight]; })()`);
    const desk = await page.evaluate<number[]>(`(() => { const d = document.getElementById('desktop'); return [0, 0, d.clientWidth, d.clientHeight]; })()`);
    expect(await page.evaluate(`[...document.querySelectorAll('[data-win="board"] .title-bar-controls button')].slice(-3).map((b) => b.getAttribute('aria-label'))`))
      .toEqual(['Minimize', 'Maximize', 'Close']);
    const before = await box();
    await page.evaluate(`document.querySelector('[data-win="board"] [aria-label="Maximize"]').click()`);
    expect(await box()).toEqual(desk);
    expect(await page.evaluate(`!!document.querySelector('[data-win="board"] [aria-label="Restore"]')`)).toBe(true);
    const bar = await page.center('[data-win="board"] .title-bar-text');
    await page.drag(bar, { x: bar.x + 120, y: bar.y + 60 });
    expect(await box()).toEqual(desk);

    await page.goto(base + '?max-reload');
    await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board after reload');
    expect(await box()).toEqual(desk);

    await page.evaluate(`document.querySelector('[data-win="board"] [aria-label="Restore"]').click()`);
    expect(await box()).toEqual(before);
    await page.evaluate(`document.querySelector('[data-win="board"] .title-bar-text').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    expect(await box()).toEqual(desk);
    await page.evaluate(`document.querySelector('[data-win="board"] .title-bar-text').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    expect(await box()).toEqual(before);
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
