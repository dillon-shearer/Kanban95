// In headless Edge or Chrome against a running daemon (setup in ui.ts): the taskbar project switcher, Start → Projects
// submenus and the switch keys, with the board posing as one of several hosted by shell 123.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { entryPath, register } from '../src/boards.ts';
import { sessions } from '../src/launcher.ts';
import { changed } from '../src/lifecycle.ts';
import { writeProjects } from '../src/settings.ts';
import { until } from './cdp.ts';
import { base, click, column, menuItems, menuPick, page, repo, rightClick, srv, statusBar, ticket } from './ui.ts';

const dir = (p: string) => realpathSync.native(mkdtempSync(join(tmpdir(), p)));
let own: string, other: string, third: string, idle: string;
const sleepers: ChildProcess[] = [];
const fake = (repo: string) => {
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  sleepers.push(c);
  writeFileSync(entryPath(c.pid!), JSON.stringify({ pid: c.pid, repo, port: 1, started: '', shell: 123 }));
  return c.pid!;
};
const write = process.stdout.write.bind(process.stdout);

beforeAll(() => {
  own = realpathSync.native(repo);
  [other, third, idle] = [dir('k95-other-'), dir('k95-third-'), dir('k95-idle-')];
  writeProjects([{ path: other, colour: 200 }, { path: own, colour: '#123456' }, { path: third, colour: 300 }, { path: idle, colour: 100 }], own);
  srv.board.shellId = 123;
  srv.board.shell = true;
  register(own, srv.port, 123);
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...rest) => (String(chunk).startsWith('KANBAN95 ') ? true : write(chunk, ...(rest as []))));
});
afterAll(() => {
  vi.restoreAllMocks();
  register(own, srv.port, null);
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
  await page.evaluate(`(() => { window.posts = []; const f = window.fetch;
    window.fetch = (u, o) => { if (o?.method === 'POST' && u.startsWith('/api/projects/')) window.posts.push([u, JSON.parse(o.body)]); return f(u, o); }; })()`);
};
const posts = () => page.evaluate<[string, Record<string, string>][]>('window.posts');
const buttons = () => page.evaluate<{ path: string; label: string; active: boolean; bg: string }[]>(`[...document.querySelectorAll('#projects button')].map((b) =>
  ({ path: b.dataset.project, label: b.textContent, active: b.classList.contains('active'), bg: getComputedStyle(b).backgroundColor }))`);
const shown = () => page.evaluate<boolean>(`getComputedStyle(document.getElementById('projects')).display !== 'none'`);
const KEYS = { Tab: ['Tab', 9], '1': ['Digit1', 49], '2': ['Digit2', 50] } as const;
const ctrl = async (key: keyof typeof KEYS, shift = false) => {
  const [code, vk] = KEYS[key];
  for (const type of ['rawKeyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, modifiers: shift ? 10 : 2 });
};
const dialogButton = (label: string) => page.evaluate(`[...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === ${JSON.stringify(label)}).click()`);

describe('ui-project-switcher', { timeout: 90_000 }, () => {
  it('is hidden while only this board is hosted, and the taskbar keeps its layout', async () => {
    await load();
    const gap = await page.evaluate<number>(`document.getElementById('pinned').getBoundingClientRect().left - document.getElementById('start').getBoundingClientRect().right`);
    expect(await shown()).toBe(false);
    expect(gap).toBe(3);
    await ctrl('Tab');
    expect(await posts()).toEqual([]);
  });

  it('shows a coloured button per hosted project in order, this board pressed in, and switches on a click', async () => {
    fake(other);
    await load();
    await until(async () => (await buttons()).length === 2, 'two switcher buttons');
    expect(await shown()).toBe(true);
    expect(await buttons()).toEqual([
      { path: other, label: basename(other), active: false, bg: 'rgb(0, 85, 128)' },
      { path: own, label: basename(own), active: true, bg: 'rgb(18, 52, 86)' },
    ]);
    const left = await page.evaluate<number[]>(`['#start', '#projects', '#pinned'].map((q) => document.querySelector(q).getBoundingClientRect().left)`);
    expect(left[0] < left[1] && left[1] < left[2]).toBe(true);
    await click('#projects button:first-child');
    await until(async () => (await statusBar()) === `Switching to ${basename(other)}…`, 'the switching status');
    await until(async () => (await posts()).length === 1, 'the switch request');
    expect(await posts()).toEqual([['/api/projects/switch', { path: other }]]);
    await click('#projects button:last-child');
    expect(await posts()).toHaveLength(1);
  });

  it('right-click offers Switch to, Pop out, Dock and Close board, each sends its route, Close board after a confirm', async () => {
    await load();
    await until(async () => (await buttons()).length === 2, 'two switcher buttons');
    await rightClick('#projects button:last-child');
    expect(await menuItems()).toEqual(['Pop out', 'Dock', 'Close board']);
    for (const label of ['Switch to', 'Pop out', 'Dock']) {
      await rightClick('#projects button:first-child');
      expect(await menuItems()).toEqual(['Switch to', 'Pop out', 'Dock', 'Close board']);
      await menuPick(label);
    }
    await until(async () => (await posts()).length === 3, 'three requests');
    expect(await posts()).toEqual([['/api/projects/switch', { path: other }], ['/api/projects/popout', { path: other }], ['/api/projects/dock', { path: other }]]);
    await rightClick('#projects button:last-child');
    await menuPick('Close board');
    await until(() => page.evaluate(`!!document.querySelector('dialog[open]')`), 'the confirm');
    expect(await page.evaluate(`document.querySelector('dialog[open] .window-body').textContent`)).toContain(`Close ${basename(own)}? 0 agents running here will stop.`);
    await dialogButton('Cancel');
    await rightClick('#projects button:first-child');
    await menuPick('Close board');
    await until(() => page.evaluate(`!!document.querySelector('dialog[open]')`), 'the confirm');
    expect(await page.evaluate(`document.querySelector('dialog[open] .window-body').textContent`)).toBe(`Close ${basename(other)}?CloseCancel`);
    await dialogButton('Close');
    await until(async () => (await posts()).length === 4, 'the close request');
    expect((await posts())[3]).toEqual(['/api/projects/close', { path: other }]);
    await until(async () => (await statusBar()) === `Closing ${basename(other)}…`, 'the closing status');
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
      [basename(third), [['Open here', false], ['Open in new window', false]]],
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
    await until(async () => (await statusBar()) === `Opening ${basename(idle)}…`, 'the opening status');
    await click('#start');
    await pick(`${basename(other)} (running)`, 'Open in new window');
    await until(async () => (await posts()).length === 2, 'the pop out request');
    expect((await posts())[1]).toEqual(['/api/projects/popout', { path: other }]);
  });

  it('redraws on a { ticket: null } event without a reload', async () => {
    await load();
    await until(async () => (await buttons()).length === 2, 'two switcher buttons');
    fake(third);
    changed(null);
    await until(async () => (await buttons()).length === 3, 'the third button');
    expect((await buttons()).map((b) => b.path)).toEqual([other, own, third]);
  });

  it('Ctrl+Tab, Ctrl+Shift+Tab and Ctrl+1 switch to the right project, also inside a terminal', async () => {
    const id = ticket('Switch keys');
    await load();
    await until(async () => (await buttons()).length === 3, 'three switcher buttons');
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
