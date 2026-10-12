// In headless Edge or Chrome against a running daemon (setup in ui.ts): the tray's Switch board popup, Start → Projects
// submenus and the switch keys, with the board posing as one of several hosted by shell 123.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { entryPath, register } from '../src/boards.ts';
import { sessions } from '../src/launcher.ts';
import { writeProjects } from '../src/settings.ts';
import { until } from './cdp.ts';
import { base, click, column, page, repo, srv, statusBar, ticket } from './ui.ts';

const dir = (p: string) => realpathSync.native(mkdtempSync(join(tmpdir(), p)));
let own: string, other: string, third: string, idle: string;
let ownEntry: { repo: string; port: number; shell: number | null };
const sleepers: ChildProcess[] = [];
const fake = (repo: string, agents = 0) => {
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  sleepers.push(c);
  writeFileSync(entryPath(c.pid!), JSON.stringify({ pid: c.pid, repo, port: 1, started: '', shell: 123, agents }));
  return c.pid!;
};
const write = process.stdout.write.bind(process.stdout);

beforeAll(() => {
  own = realpathSync.native(repo);
  [other, third, idle] = [dir('k95-other-'), dir('k95-third-'), dir('k95-idle-')];
  writeProjects([{ path: other, colour: 200 }, { path: own, colour: '#123456' }, { path: third, colour: 300 }, { path: idle, colour: 100 }], own);
  srv.board.shellId = 123;
  srv.board.shell = true;
  ownEntry = JSON.parse(readFileSync(entryPath(process.pid), 'utf8'));
  register(ownEntry.repo, ownEntry.port, 123);
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...rest) => (String(chunk).startsWith('KANBAN95 ') ? true : write(chunk, ...(rest as []))));
});
afterAll(() => {
  vi.restoreAllMocks();
  register(ownEntry.repo, ownEntry.port, ownEntry.shell);
  for (const c of sleepers) {
    rmSync(entryPath(c.pid!), { force: true });
    c.kill();
  }
  srv.board.shellId = null;
  srv.board.shell = false;
  for (const d of [other, third, idle]) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

const board = () => until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
const load = async () => {
  await page.goto(base);
  await board();
  await page.evaluate(`(() => { window.posts = []; window.lists = 0; const f = window.fetch;
    window.fetch = (u, o) => {
      if (o?.method === 'POST' && u.startsWith('/api/projects/')) window.posts.push([u, JSON.parse(o.body)]);
      if (o?.method === 'GET' && u === '/api/projects') window.lists++;
      return f(u, o); }; })()`);
};
const posts = () => page.evaluate<[string, Record<string, string>][]>('window.posts');
const popup = () => page.evaluate<boolean>(`!!document.querySelector('.k95-switch')`);
const rows = () => page.evaluate<{ path: string; label: string; bg: string; run: boolean; x: boolean }[]>(`[...document.querySelectorAll('.k95-switch-row')].map((r) =>
  ({ path: r.dataset.project, label: r.querySelector('.name').textContent, bg: getComputedStyle(r).backgroundColor, run: !!r.querySelector('.run'), x: !!r.querySelector('.x') }))`);
const openPopup = async () => {
  await click('#switch');
  await until(popup, 'the popup');
  return rows();
};
const row = (path: string) => `.k95-switch-row[data-project="${path.replace(/\\/g, '\\\\')}"]`;
const key = async (key: string, code: string, vk: number) => {
  for (const type of ['rawKeyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk });
};
const KEYS = { Tab: ['Tab', 9], '1': ['Digit1', 49], '2': ['Digit2', 50] } as const;
const ctrl = async (key: keyof typeof KEYS, shift = false) => {
  const [code, vk] = KEYS[key];
  for (const type of ['rawKeyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, modifiers: shift ? 10 : 2 });
};
const dialogButton = (label: string) => page.evaluate(`[...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === ${JSON.stringify(label)}).click()`);

describe('ui-project-switcher', { timeout: 90_000 }, () => {
  it('has no taskbar switcher, shows the Switch board button first in the tray with one project hosted, and lists the other projects', async () => {
    await load();
    expect(await page.evaluate(`!!document.getElementById('projects')`)).toBe(false);
    expect(await page.evaluate(`(() => { const b = document.querySelector('#tray > :first-child');
      return [b.id, b.title, b.getAttribute('aria-label'), getComputedStyle(b).display !== 'none', !!b.querySelector('svg')]; })()`)).toEqual(['switch', 'Switch board', 'Switch board', true, true]);
    expect(await openPopup()).toEqual([
      { path: other, label: basename(other), bg: 'rgb(0, 85, 128)', run: false, x: false },
      { path: third, label: basename(third), bg: 'rgb(128, 0, 128)', run: false, x: false },
      { path: idle, label: basename(idle), bg: 'rgb(43, 128, 0)', run: false, x: false },
    ]);
    await ctrl('Tab');
    expect(await posts()).toEqual([]);
  });

  it('fetches the project list on each opening and not while closed', async () => {
    await load();
    await new Promise((r) => setTimeout(r, 500));
    expect(await page.evaluate('window.lists')).toBe(0);
    await openPopup();
    expect(await page.evaluate('window.lists')).toBe(1);
    await click('#switch');
    await until(async () => !(await popup()), 'the popup closed by its button');
    await new Promise((r) => setTimeout(r, 500));
    expect(await page.evaluate('window.lists')).toBe(1);
  });

  it('marks running rows, offers X only on a hosted board with no agents, and switches or opens here on a click', async () => {
    fake(other);
    fake(third, 2);
    await load();
    expect(await openPopup()).toEqual([
      { path: other, label: basename(other), bg: 'rgb(0, 85, 128)', run: true, x: true },
      { path: third, label: basename(third), bg: 'rgb(128, 0, 128)', run: true, x: false },
      { path: idle, label: basename(idle), bg: 'rgb(43, 128, 0)', run: false, x: false },
    ]);
    await click(`${row(other)} .name`);
    await until(async () => (await posts()).length === 1, 'the switch request');
    expect(await popup()).toBe(false);
    await openPopup();
    await click(`${row(idle)} .name`);
    await until(async () => (await posts()).length === 2, 'the open request');
    expect(await popup()).toBe(false);
    expect(await posts()).toEqual([['/api/projects/switch', { path: other }], ['/api/projects/open', { path: idle, where: 'here' }]]);
    await until(async () => (await statusBar()) === `Opening ${basename(idle)}…`, 'the opening status');
  });

  it('X closes the board after a confirm', async () => {
    await load();
    await openPopup();
    await click(`${row(other)} .x`);
    await until(() => page.evaluate(`!!document.querySelector('dialog[open]')`), 'the confirm');
    expect(await popup()).toBe(false);
    expect(await page.evaluate(`document.querySelector('dialog[open] .window-body').textContent`)).toBe(`Close ${basename(other)}?CloseCancel`);
    await dialogButton('Close');
    await until(async () => (await posts()).length === 1, 'the close request');
    expect(await posts()).toEqual([['/api/projects/close', { path: other }]]);
  });

  it('closes on Esc and on a click outside, and only one of it and the Start menu is open at a time', async () => {
    await load();
    await openPopup();
    await key('Escape', 'Escape', 27);
    await until(async () => !(await popup()), 'the popup closed by Esc');
    await openPopup();
    await click('#clock');
    await until(async () => !(await popup()), 'the popup closed by a click outside');
    await openPopup();
    await click('#start');
    await until(() => page.evaluate(`!!document.querySelector('.k95-menu')`), 'the Start menu');
    expect(await popup()).toBe(false);
    await openPopup();
    expect(await page.evaluate(`!!document.querySelector('.k95-menu')`)).toBe(false);
    expect(await posts()).toEqual([]);
  });

  it('arrow keys move between rows and Enter activates', async () => {
    await load();
    await openPopup();
    const at = () => page.evaluate<string>(`document.activeElement.dataset.project`);
    expect(await at()).toBe(other);
    await key('ArrowDown', 'ArrowDown', 40);
    expect(await at()).toBe(third);
    await key('ArrowUp', 'ArrowUp', 38);
    await key('ArrowUp', 'ArrowUp', 38);
    expect(await at()).toBe(idle);
    await key('Enter', 'Enter', 13);
    await until(async () => (await posts()).length === 1, 'the open request');
    expect(await posts()).toEqual([['/api/projects/open', { path: idle, where: 'here' }]]);
    expect(await popup()).toBe(false);
  });

  it('Start → Projects has a submenu per project, Open here disabled on this board, and Open here sends where: here', async () => {
    await load();
    await click('#start');
    const subs = () => page.evaluate<[string, [string, boolean][]][]>(`[...[...document.querySelectorAll('.k95-menu > li.sub')]
      .find((li) => li.firstChild.textContent === 'Projects').lastChild.children].map((li) =>
      [li.firstChild?.textContent ?? '', [...(li.querySelector('ul')?.children ?? [])].map((x) => [x.textContent, x.hasAttribute('aria-disabled')])])`);
    const want = [
      [`${basename(other)} (running)`, [['Open here', false], ['Open in new window', false], ['Close board', false]]],
      [`${basename(own)} (this board)`, [['Open here', true], ['Open in new window', false], ['Close board', false]]],
      [`${basename(third)} (running)`, [['Open here', false], ['Open in new window', false], ['Close board', false]]],
      [basename(idle), [['Open here', false], ['Open in new window', false]]],
      ['', []],
      ['Add project board…', []],
    ];
    expect(await subs()).toEqual(want);
    const pick = (project: string, label: string) => page.evaluate(`[...document.querySelectorAll('.k95-menu > li.sub > ul > li.sub')]
      .find((li) => li.firstChild.textContent === ${JSON.stringify(project)}).querySelectorAll('li').forEach((li) => li.textContent === ${JSON.stringify(label)} && li.click())`);
    await pick(`${basename(own)} (this board)`, 'Open here');
    await pick(basename(idle), 'Open here');
    await until(async () => (await posts()).length === 1, 'the open request');
    expect(await posts()).toEqual([['/api/projects/open', { path: idle, where: 'here' }]]);
    await click('#start');
    await pick(`${basename(other)} (running)`, 'Open in new window');
    await until(async () => (await posts()).length === 2, 'the pop out request');
    expect((await posts())[1]).toEqual(['/api/projects/popout', { path: other }]);
  });

  it('Ctrl+Tab, Ctrl+Shift+Tab and Ctrl+1 switch to the right project, also inside a terminal', async () => {
    const id = ticket('Switch keys');
    await load();
    await openPopup();
    await key('Escape', 'Escape', 27);
    await ctrl('Tab');
    await ctrl('Tab', true);
    await ctrl('1');
    await ctrl('2');
    await until(async () => (await posts()).length === 3, 'three switches');
    expect(await posts()).toEqual([['/api/projects/switch', { path: third }], ['/api/projects/switch', { path: other }], ['/api/projects/switch', { path: other }]]);

    await until(() => column(id), 'the card');
    await fetch(`${base}api/tickets/${id}/launch`, { method: 'POST', headers: { cookie: `k95=${srv.secret}` } });
    const wid = await until(() => page.evaluate<string>(`document.querySelector('[data-win^="term-"]:not(.ended) .xterm')?.closest('[data-win]').dataset.win`), 'the terminal');
    await click(`[data-task="${wid}"]`);
    await page.evaluate(`(() => { window.sent = []; const s = WebSocket.prototype.send;
      WebSocket.prototype.send = function (d) { window.sent.push(d); return s.call(this, d); }; })()`);
    await click(`[data-win="${wid}"] .xterm-screen`);
    await until(() => page.evaluate(`!!document.activeElement?.classList.contains('xterm-helper-textarea')`), 'the terminal focused');
    await page.evaluate('window.sent.length = 0');
    await ctrl('Tab');
    await ctrl('Tab', true);
    await ctrl('1');
    await until(async () => (await posts()).length === 6, 'three switches from the terminal');
    expect((await posts()).slice(3)).toEqual([['/api/projects/switch', { path: third }], ['/api/projects/switch', { path: other }], ['/api/projects/switch', { path: other }]]);
    expect(await page.evaluate(`window.sent.filter((d) => JSON.parse(d).data !== undefined)`)).toEqual([]);
    await fetch(`${base}api/tickets/${id}`, { method: 'DELETE', headers: { cookie: `k95=${srv.secret}` } });
    await until(() => sessions.size === 0, 'the agent to exit');
  });
});
