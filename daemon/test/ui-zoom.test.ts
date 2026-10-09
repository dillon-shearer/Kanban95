// In headless Edge or Chrome against a running daemon (setup in ui.ts): the UI zoom (Ctrl+= / Ctrl+- / Ctrl+0, Settings → Board).
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sessions } from '../src/launcher.ts';
import { until } from './cdp.ts';
import { srv, page, base, ticket, column, click, setUi } from './ui.ts';

const KEYS = { '=': ['Equal', 187], '-': ['Minus', 189], '0': ['Digit0', 48] } as const;
/** A real Ctrl+key press, to whatever has focus. */
const ctrl = async (key: keyof typeof KEYS) => {
  const [code, vk] = KEYS[key];
  for (const type of ['rawKeyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, modifiers: 2 });
};
const saved = () => JSON.parse(readFileSync(join(process.env.USERPROFILE!, '.kanban95', 'settings.json'), 'utf8')).zoom;
const zoom = () => page.evaluate<number>(`Number(document.body.style.zoom || 1)`);
type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };
const rect = (sel: string) => page.evaluate<Rect>(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; })()`);
/** The font a toolbar button is drawn in: 98.css's pixel font only at a whole-number zoom. */
const font = () => page.evaluate<string>(`getComputedStyle(document.querySelector('[data-win="board"] button')).fontFamily`);
const board = () => until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
const dblclickIcon = (name: string) => page.evaluate(`document.querySelector('[data-icon="${name}"]').dispatchEvent(new MouseEvent('dblclick'))`);

describe('ui-zoom', { timeout: 90_000 }, () => {
  it('zooms everything by 10% a key, keeps it in settings.json across a reload, and shows it in Settings > Board', async () => {
    await page.goto(base);
    await board();
    // A Board with room to grow: the default's spans the desktop, and zooming in shrinks it to fit.
    await setUi('k95.win.board', { x: 100, y: 0, w: 800, h: 500 });
    await page.goto(base);
    await board();
    const win = await rect('[data-win="board"]');
    const bar = await rect('#taskbar');
    expect(await font()).toMatch(/^"Pixelated MS Sans Serif"/);
    await ctrl('=');
    expect(await zoom()).toBe(1.1);
    expect(await font()).toMatch(/^Tahoma/);
    expect((await rect('[data-win="board"]')).width).toBeCloseTo(win.width * 1.1, 0);
    expect((await rect('#taskbar')).height).toBeCloseTo(bar.height * 1.1, 0);
    await until(() => saved() === 1.1, 'zoom 1.1 in settings.json');
    // A menu is appended to body, outside #desktop: it scales with the rest.
    await click('#start');
    const item = await rect('.k95-menu > li[role="menuitem"]');
    await page.evaluate(`document.querySelector('.k95-menu').remove()`);
    await ctrl('-');
    await ctrl('-');
    expect(await zoom()).toBe(0.9);
    await click('#start');
    const menu = await rect('.k95-menu');
    expect((await rect('.k95-menu > li[role="menuitem"]')).width).toBeCloseTo((item.width * 0.9) / 1.1, 0);
    expect(menu.bottom).toBeLessThanOrEqual((await rect('#start')).top + 0.5); // the Start menu still opens above the button
    await page.evaluate(`document.querySelector('.k95-menu').remove()`);
    await until(() => saved() === 0.9, 'zoom 0.9 in settings.json');

    await page.goto(base);
    await board();
    expect(await zoom()).toBe(0.9);
    expect(await font()).toMatch(/^Tahoma/); // after a reload too
    await dblclickIcon('Settings');
    await page.evaluate(`[...document.querySelectorAll('[data-win="settings"] [role=tab] a')].find((t) => t.textContent === 'Board').click()`);
    await until(() => page.evaluate(`!!document.querySelector('#zoom')`), 'the Board tab');
    expect(await page.evaluate(`document.querySelector('#zoom').selectedOptions[0].textContent`)).toBe('90%');
    await page.evaluate(`(() => { const s = document.querySelector('#zoom'); s.value = '1.5'; s.dispatchEvent(new Event('change')); })()`);
    expect(await zoom()).toBe(1.5);
    await until(() => saved() === 1.5, 'zoom 1.5 from Settings');
    await click('[data-win="settings"] .title-bar-text'); // focus off the select
    await ctrl('0');
    expect(await zoom()).toBe(1);
    expect(await font()).toMatch(/^"Pixelated MS Sans Serif"/);
    expect(await page.evaluate(`document.querySelector('#zoom').value`)).toBe('1');
    await until(() => saved() === 1, 'zoom reset in settings.json');
    for (let i = 0; i < 5; i++) await ctrl('-');
    expect(await zoom()).toBe(0.8); // the floor
    await ctrl('0');
    await until(() => saved() === 1, 'zoom reset');
    await setUi('k95.win.board', undefined);
  });

  it('at 200% keeps every window on the desktop and the taskbar in view at 1280x720', async () => {
    await page.goto(base);
    await board();
    await dblclickIcon('Brain');
    await dblclickIcon('Settings');
    await click('[data-win="settings"] .title-bar-text');
    for (let i = 0; i < 12; i++) await ctrl('=');
    expect(await zoom()).toBe(2); // the ceiling
    expect(await font()).toMatch(/^"Pixelated MS Sans Serif"/); // a whole number: the pixel font scales cleanly
    const desk = await rect('#desktop');
    for (const w of ['board', 'brain', 'settings']) {
      const r = await rect(`[data-win="${w}"]`);
      expect(r.left, w).toBeGreaterThanOrEqual(desk.left - 0.5);
      expect(r.top, w).toBeGreaterThanOrEqual(desk.top - 0.5);
      expect(r.right, w).toBeLessThanOrEqual(desk.right + 0.5);
      expect(r.top + 24 * 2, w).toBeLessThanOrEqual(desk.bottom + 0.5); // the title bar at least
    }
    const bar = await rect('#taskbar');
    expect([bar.left, bar.right, bar.bottom]).toEqual([0, 1280, 720]);
    for (const id of ['start', 'inbox-count', 'limits', 'clock']) {
      const r = await rect(`#${id}`);
      expect(r.left, id).toBeGreaterThanOrEqual(0);
      expect(r.right, id).toBeLessThanOrEqual(1280);
      expect(r.bottom, id).toBeLessThanOrEqual(720);
    }
    // A drag moves the window as far as the pointer went, on screen.
    await page.evaluate(`Object.assign(document.querySelector('[data-win="settings"]').style, { left: '20px', top: '20px', width: '300px' })`);
    const before = await rect('[data-win="settings"]');
    const from = await page.center('[data-win="settings"] .title-bar-text');
    await page.drag(from, { x: from.x + 100, y: from.y + 40 });
    const after = await rect('[data-win="settings"]');
    expect([after.left - before.left, after.top - before.top]).toEqual([100, 40]);
    await ctrl('0');
    await until(() => saved() === 1, 'zoom reset');
  });

  it('scales and refits a terminal with no clipped rows; Ctrl+- inside it goes to the agent', async () => {
    const id = ticket('Zoom terminal');
    await page.goto(base);
    await until(() => column(id), 'the card');
    await fetch(`${base}api/tickets/${id}/launch`, { method: 'POST', headers: { cookie: `k95=${srv.secret}` } });
    const wid = await until(() => page.evaluate<string>(`document.querySelector('[data-win^="term-"]:not(.ended) .xterm')?.closest('[data-win]').dataset.win`), 'the terminal');
    const t = `[data-win="${wid}"]`;
    const fit = () => page.evaluate<{ rowH: number; last: number; body: number }>(`(() => {
      const rows = document.querySelectorAll(${JSON.stringify(`${t} .xterm-rows > div`)});
      return { rowH: rows[0].getBoundingClientRect().height, last: rows[rows.length - 1].getBoundingClientRect().bottom,
        body: document.querySelector(${JSON.stringify(`${t} .window-body`)}).getBoundingClientRect().bottom };
    })()`);
    await click(`[data-task="${wid}"]`); // the board opens it behind the Board window
    const at1 = await fit();
    expect(at1.last).toBeLessThanOrEqual(at1.body + 0.5);
    await click(`${t} .title-bar-text`);
    await ctrl('=');
    await ctrl('=');
    const at12 = await until(async () => { const f = await fit(); return f.rowH > at1.rowH * 1.15 && f; }, 'larger rows');
    expect(Math.abs(at12.rowH - at1.rowH * 1.2)).toBeLessThan(1); // xterm rounds a cell to whole device px
    expect(at12.last).toBeLessThanOrEqual(at12.body + 0.5);

    await page.evaluate(`(() => { window.sent = []; const s = WebSocket.prototype.send;
      WebSocket.prototype.send = function (d) { window.sent.push(d); return s.call(this, d); }; })()`);
    await click(`${t} .xterm-screen`);
    await until(() => page.evaluate(`!!document.activeElement?.classList.contains('xterm-helper-textarea')`), 'the terminal focused');
    // Cancelled keys never reach the webview's own zoom.
    await page.evaluate(`window.cancelled = []; addEventListener('keydown', (e) => e.ctrlKey && window.cancelled.push(e.key + ' ' + e.defaultPrevented))`);
    await ctrl('-');
    await ctrl('=');
    await until(() => page.evaluate(`window.sent.includes(JSON.stringify({ data: String.fromCharCode(31) }))`), 'Ctrl+- sent to the agent');
    expect(await page.evaluate(`window.cancelled`)).toEqual(['- true', '= true']);
    expect(await zoom()).toBe(1.2);
    await click(`${t} .title-bar-text`);
    await ctrl('0');
    expect(await zoom()).toBe(1);
    await until(() => saved() === 1, 'zoom reset');
    await fetch(`${base}api/tickets/${id}`, { method: 'DELETE', headers: { cookie: `k95=${srv.secret}` } });
    await until(() => sessions.size === 0, 'the agent to exit');
  });
});
