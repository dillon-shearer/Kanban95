// In headless Edge or Chrome against a running daemon (setup in ui.ts): live terminals tile into the slots between the
// desktop icons and the action column (`SLOTS` in ui/wm.js) and keep their slot until moved, and every window scales with
// the desktop.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sessions } from '../src/launcher.ts';
import { until } from './cdp.ts';
import { srv, db, page, base, ticket, column, click, menuPick } from './ui.ts';

type Box = [number, number, number, number]; // left, top, right, bottom
const boxes = (sel: string) => page.evaluate<Box[]>(`[...document.querySelectorAll('${sel}')].filter((e) => !e.hidden)
  .map((e) => [e.offsetLeft, e.offsetTop, e.offsetLeft + e.offsetWidth, e.offsetTop + e.offsetHeight])`);
const box = async (wid: string) => (await boxes(`[data-win="${wid}"]`))[0];
const TILED = '[data-win^="term-"], [data-win^="slot-"]';
const terms = () => boxes(TILED);
const overlap = (a: Box, b: Box) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
const desk = () => page.evaluate<[number, number]>(`(() => { const d = document.getElementById('desktop'); return [d.clientWidth, d.clientHeight]; })()`);
const wm = (call: string) => page.evaluate(`import('/wm.js').then((m) => m.${call})`);
const api = (path: string, method = 'GET') => fetch(`${base}api${path}`, { method, headers: { cookie: `k95=${srv.secret}` } });
// The table as the ticket gives it: terminals → [columns, rows].
const GRID: Record<number, [number, number]> = { 1: [1, 1], 2: [2, 1], 3: [3, 1], 4: [2, 2], 5: [3, 2], 6: [3, 2], 9: [3, 3], 12: [4, 3] };

/** Slot `i` (0-based, reading order) of the grid for `n` terminals in a region from `L` to `R` and `H` high. */
function slot(i: number, n: number, L: number, R: number, H: number): Box {
  const [cols, rows] = GRID[n];
  const [c, r] = [i % cols, Math.floor(i / cols)];
  return [L + Math.round((c * (R - L)) / cols), Math.round((r * H) / rows), L + Math.round(((c + 1) * (R - L)) / cols), Math.round(((r + 1) * H) / rows)];
}
/** The first `n` slots of the grid for `n` terminals. */
const slots = (n: number, L: number, R: number, H: number) => Array.from({ length: n }, (_, i) => slot(i, n, L, R, H));
const sorted = (bs: Box[]) => [...bs].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
/** The desktop icons' column and the region's left edge, 4 px right of it: terminals never cover an icon. */
const icons = async () => (await boxes('#icons'))[0];
const left = async () => (await icons())[2] + 4;
/** The region's right edge: the left edge of the leftmost action-column window. */
const edge = async () => Math.min(...(await Promise.all(['board', 'inbox', 'notepad'].map(box))).map((b) => b[0]));

/** Waits until the shown terminals fill the region's slots for their count, none over another or the action column. */
async function tiled(n: number) {
  const [, H] = await desk();
  const R = await edge();
  const L = await left();
  await until(async () => JSON.stringify(sorted(await terms())) === JSON.stringify(sorted(slots(n, L, R, H))), `${n} terminals in their slots`, 1000);
  const ts = await terms();
  for (let i = 0; i < ts.length; i++) {
    expect(overlap(ts[i], await icons()), `terminal ${i} over the desktop icons`).toBe(0);
    for (const w of ['board', 'inbox', 'notepad']) expect(overlap(ts[i], await box(w)), `terminal ${i} over ${w}`).toBe(0);
    for (let j = i + 1; j < ts.length; j++) expect(overlap(ts[i], ts[j]), `terminal ${i} over ${j}`).toBe(0);
  }
}

/** Waits until each window in `want` is in its slot (0-based) of the grid for `n` terminals, and none of them is over another. */
async function at(want: Record<string, number>, n: number) {
  const [, H] = await desk();
  const R = await edge();
  const L = await left();
  const ids = Object.keys(want);
  const expected = JSON.stringify(ids.map((w) => slot(want[w], n, L, R, H)));
  await until(async () => JSON.stringify(await Promise.all(ids.map(box))) === expected, `${JSON.stringify(want)} in the ${n}-grid`, 1000);
  const bs = await Promise.all(ids.map(box));
  for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) expect(overlap(bs[i], bs[j]), `${ids[i]} over ${ids[j]}`).toBe(0);
}
const settle = () => new Promise((r) => setTimeout(r, 200)); // past the 50 ms re-tile debounce
const dblclick = (wid: string) => page.evaluate(`document.querySelector('[data-win="${wid}"] .title-bar-text').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
/** A fresh page at 1920×1080 with nothing saved: the default action column, no window with a place of its own. */
async function fresh(tag: string) {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await fetch(`${base}api/ui`, { method: 'PUT', headers: { cookie: `k95=${srv.secret}`, 'content-type': 'application/json' }, body: '{}' });
  await page.goto(`${base}?${tag}`);
  await until(() => page.evaluate(`['board', 'inbox', 'notepad'].every((w) => document.querySelector('[data-win="' + w + '"]'))`), 'the action column');
}

/** Launches ticket `id`'s agent and returns its terminal's window id once the terminal is open. */
async function launch(id: number) {
  await until(() => column(id), 'the card');
  expect((await api(`/tickets/${id}/launch`, 'POST')).status).toBe(200);
  const key = await until(async () => (await (await api('/sessions')).json()).find((x: { ticket_id: number }) => x.ticket_id === id)?.id, 'the session');
  await until(() => page.evaluate(`!!document.querySelector('[data-win="term-${key}"] .xterm')`), 'the terminal');
  return `term-${key}`;
}

describe('ui-slots', { timeout: 120_000 }, () => {
  it('tiles 1 to 6 terminals between the desktop icons and the action column, keeps their slots on close and minimize, follows a moved Board and a resized desktop, and stops while Tile terminals is off', async () => {
    const settings = join(process.env.USERPROFILE!, '.kanban95', 'settings.json');
    writeFileSync(settings, JSON.stringify({ terminals: { auto: ['execute'] } }));
    try {
      const ids = Array.from({ length: 7 }, (_, i) => ticket(`Slot ${i + 1}`));
      await fresh('slots'); // also on a retry

      // The default action column: Board top right, Inbox bottom right, Notepad beside it, half the desktop.
      const [W, H] = await desk();
      const [b, i, n] = [await box('board'), await box('inbox'), await box('notepad')];
      expect([b[1], b[2], i[2], i[3], n[3]]).toEqual([0, W, W, H, H]);
      expect(n[1]).toBe(i[1]);
      expect(n[2]).toBeLessThanOrEqual(i[0]);
      expect(await edge()).toBe(W / 2);

      const wids: string[] = [];
      for (const id of ids.slice(0, 4)) {
        wids.push(await launch(id));
        await tiled(wids.length);
        expect(await page.evaluate(`document.querySelector('[data-task="${wids.at(-1)}"] img').getAttribute('src')`)).toBe('icons/execute.svg');
      }
      // Closing the one in slot 0 moves nobody; the next terminals take slot 0, then grow the grid.
      await wm(`close('${wids.shift()}')`);
      await at({ [wids[0]]: 1, [wids[1]]: 2, [wids[2]]: 3 }, 4);
      for (const id of ids.slice(4)) wids.push(await launch(id));
      await at({ [wids[3]]: 0, [wids[0]]: 1, [wids[1]]: 2, [wids[2]]: 3, [wids[4]]: 4, [wids[5]]: 5 }, 6);
      await tiled(6);

      // Minimized, a terminal keeps its slot and nobody moves; restored, it is back in it.
      await wm(`minimize('${wids[1]}')`);
      await settle();
      await at({ [wids[3]]: 0, [wids[0]]: 1, [wids[2]]: 3, [wids[4]]: 4, [wids[5]]: 5 }, 6);
      await wm(`focus('${wids[1]}')`);
      await tiled(6);

      // Settings → General → Tile terminals off: a dragged terminal stays where it was put, also after a re-tile would have
      // run; back on, every terminal, the dragged one too, takes its slot again. Saved in settings.json.
      await page.evaluate(`document.querySelector('[data-icon="Settings"]').dispatchEvent(new MouseEvent('dblclick'))`);
      await page.evaluate(`[...document.querySelectorAll('[data-win="settings"] [role=tab] a')].find((t) => t.textContent === 'General').click()`);
      await until(() => page.evaluate(`!!document.querySelector('#term-tile')`), 'the General tab');
      expect(await page.evaluate(`document.querySelector('#term-tile').checked`)).toBe(true);
      await page.evaluate(`document.querySelector('#term-tile').click()`);
      await until(() => { try { return JSON.parse(readFileSync(settings, 'utf8')).terminals.tile === false; } catch { return false; } }, 'tile off saved');
      await wm(`minimize('settings')`); // out of the way of the drag; its checkbox still clicks
      const before = await box(wids[0]);
      const t2 = await page.center(`[data-win="${wids[0]}"] .title-bar-text`);
      await page.drag(t2, { x: t2.x + 200, y: t2.y + 150 });
      await wm(`minimize('${wids[3]}')`); // would re-tile the rest
      await settle();
      expect(await box(wids[0])).toEqual([before[0] + 200, before[1] + 150, before[2] + 200, before[3] + 150]);
      await wm(`focus('${wids[3]}')`);
      await page.evaluate(`document.querySelector('#term-tile').click()`);
      await until(() => { try { return JSON.parse(readFileSync(settings, 'utf8')).terminals.tile === true; } catch { return false; } }, 'tile on saved');
      await wm(`close('settings')`);
      await at({ [wids[3]]: 0, [wids[0]]: 1, [wids[1]]: 2, [wids[2]]: 3, [wids[4]]: 4, [wids[5]]: 5 }, 6);

      // Twelve tiled (six more windows opened with `tile`), then a 13th opens at the least-covered spot and the twelve stay put;
      // it takes the first slot that frees.
      for (let k = 1; k <= 6; k++) await wm(`open('slot-${k}', { title: 'Slot ${k}', tile: true })`);
      await tiled(12);
      const twelve = await terms();
      await wm(`open('extra', { title: 'Extra', tile: true })`);
      await new Promise((r) => setTimeout(r, 300));
      expect(await terms()).toEqual(twelve);
      const extra = await box('extra');
      expect(extra[0]).toBeGreaterThanOrEqual(0);
      expect(extra[2]).toBeLessThanOrEqual(W);
      expect(extra[3]).toBeLessThanOrEqual(H);
      await wm(`close('slot-1')`);
      await at({ extra: 6, 'slot-2': 7 }, 12);
      for (let k = 2; k <= 6; k++) await wm(`close('slot-${k}')`);
      await wm(`close('extra')`);
      await tiled(6);

      // The Board moved left: the region ends at its new left edge.
      const bar = await page.center('[data-win="board"] .title-bar-text');
      await page.drag(bar, { x: bar.x - 200, y: bar.y });
      expect(await edge()).toBe(W / 2 - 200);
      await tiled(6);

      // Start → Close ended terminals closes the ended one (slot 2) and leaves the live ones in their slots.
      const ended = await until(async () => (await (await api('/sessions')).json()).find((s: { id: number }) => `term-${s.id}` === wids[1]), 'the session');
      await api(`/grants/${ended.grant_id}`, 'DELETE');
      await until(() => page.evaluate(`document.querySelector('[data-win="${wids[1]}"]').classList.contains('ended')`), 'the ended terminal');
      await click('#start');
      await menuPick('Close ended terminals');
      await until(() => page.evaluate(`!document.querySelector('[data-win="${wids[1]}"]')`), 'the ended terminal to close');
      const five = { [wids[3]]: 0, [wids[0]]: 1, [wids[2]]: 3, [wids[4]]: 4, [wids[5]]: 5 };
      await at(five, 6);

      // A larger desktop (full screen on a bigger monitor): the action column keeps its proportions, nothing leaves a bar of
      // empty desktop, and the terminals re-tile into the new region.
      await page.send('Emulation.setDeviceMetricsOverride', { width: 2400, height: 1350, deviceScaleFactor: 1, mobile: false });
      await until(async () => (await desk())[0] === 2400 && (await box('inbox'))[2] === 2400, 'the windows to scale');
      const [W2, H2] = await desk();
      const [b2, i2] = [await box('board'), await box('inbox')];
      expect(Math.abs(b2[0] - Math.round(((W / 2 - 200) * W2) / W))).toBeLessThanOrEqual(1);
      expect(Math.abs(i2[2] - W2)).toBeLessThanOrEqual(1);
      expect(Math.abs(i2[3] - H2)).toBeLessThanOrEqual(1);
      await at(five, 6);
    } finally {
      rmSync(settings, { force: true });
      for (const { id } of db.prepare('SELECT id FROM grants WHERE revoked_at IS NULL AND ticket_id IS NOT NULL').all() as { id: number }[]) await api(`/grants/${id}`, 'DELETE');
      await until(() => sessions.size === 0, 'the agents to exit');
      db.prepare('DELETE FROM tickets').run();
    }
  });

  it('frees a dragged or resized terminal where it was left and puts it back in the lowest empty slot on a double-click', async () => {
    await fresh('sticky');
    const open = (k: string) => wm(`open('slot-${k}', { title: 'Slot ${k}', tile: true })`);
    const id = (k: string) => `slot-${k}`;
    try {
      await open('a');
      await open('b');
      await at({ [id('a')]: 0, [id('b')]: 1 }, 2);

      // Dragged by its title bar, a terminal stays where it was dropped and the other does not move.
      const a0 = await box(id('a'));
      const b0 = await box(id('b'));
      await click(`[data-task="${id('a')}"]`); // in front of the Board, so the drag lands on its title bar
      const t = await page.center(`[data-win="${id('a')}"] .title-bar-text`);
      await page.drag(t, { x: t.x + 100, y: t.y + 150 });
      await settle();
      expect(await box(id('a'))).toEqual([a0[0] + 100, a0[1] + 150, a0[2] + 100, a0[3] + 150]);
      expect(await box(id('b'))).toEqual(b0);

      // The next terminal takes the freed slot 0 and the grid stays the 2-slot row; the free one stays put.
      await open('c');
      await at({ [id('c')]: 0, [id('b')]: 1 }, 2);
      expect(await box(id('a'))).toEqual([a0[0] + 100, a0[1] + 150, a0[2] + 100, a0[3] + 150]);

      // With three tiled, closing the one in slot 1 leaves slots 0 and 2 where they are.
      await open('d');
      await at({ [id('c')]: 0, [id('b')]: 1, [id('d')]: 2 }, 3);
      await wm(`close('${id('b')}')`);
      await settle();
      await at({ [id('c')]: 0, [id('d')]: 2 }, 3);

      // A double-click on the free one puts it in the lowest empty slot; on a tiled one it maximizes, and again restores.
      await dblclick(id('a'));
      await at({ [id('c')]: 0, [id('a')]: 1, [id('d')]: 2 }, 3);
      await dblclick(id('c'));
      expect(await page.evaluate(`document.querySelector('[data-win="${id('c')}"]').classList.contains('max')`)).toBe(true);
      await dblclick(id('c'));
      await at({ [id('c')]: 0, [id('a')]: 1, [id('d')]: 2 }, 3);

      // Resized by its corner, a terminal is freed the same way: it keeps its new size.
      const r = await page.evaluate<{ x: number; y: number }>(`(() => { const r = document.querySelector('[data-win="${id('d')}"]').getBoundingClientRect(); return { x: r.right - 3, y: r.bottom - 3 }; })()`);
      const d0 = await box(id('d'));
      await page.drag(r, { x: r.x - 60, y: r.y - 80 });
      await settle();
      const d1 = await box(id('d'));
      expect(d1).not.toEqual(d0);
      expect([d1[0], d1[1]]).toEqual([d0[0], d0[1]]);
      await at({ [id('c')]: 0, [id('a')]: 1 }, 2); // its slot was the top one, so the grid shrinks
      await open('e'); // takes the freed slot 2
      await at({ [id('c')]: 0, [id('a')]: 1, [id('e')]: 2 }, 3);
      expect(await box(id('d'))).toEqual(d1);

      // Minimized and restored, a terminal is back in the same slot.
      await wm(`minimize('${id('a')}')`);
      await settle();
      await at({ [id('c')]: 0, [id('e')]: 2 }, 3);
      await wm(`focus('${id('a')}')`);
      await at({ [id('c')]: 0, [id('a')]: 1, [id('e')]: 2 }, 3);

      // With no empty slot, one more grows the grid to the 2×2 row; everyone keeps their number in reading order.
      await open('f');
      await at({ [id('c')]: 0, [id('a')]: 1, [id('e')]: 2, [id('f')]: 3 }, 4);
      // The top slot freed, the grid shrinks back.
      await wm(`close('${id('f')}')`);
      await at({ [id('c')]: 0, [id('a')]: 1, [id('e')]: 2 }, 3);
    } finally {
      for (const k of 'abcdef') await wm(`close('${id(k)}')`);
    }
  });
});
