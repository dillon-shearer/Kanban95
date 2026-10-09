// In headless Edge or Chrome against a running daemon (setup in ui.ts): live terminals tile into the slots left of the
// action column (`SLOTS` in ui/wm.js), and every window scales with the desktop.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { rmSync, writeFileSync } from 'node:fs';
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
const GRID: Record<number, [number, number]> = { 1: [1, 1], 2: [2, 1], 3: [3, 1], 4: [2, 2], 5: [3, 2], 6: [3, 2], 12: [4, 3] };

/** The first `n` slots of the grid for `n` terminals in a region `R` wide and `H` high, in reading order. */
function slots(n: number, R: number, H: number): Box[] {
  const [cols, rows] = GRID[n];
  return Array.from({ length: n }, (_, i) => {
    const [c, r] = [i % cols, Math.floor(i / cols)];
    return [Math.round((c * R) / cols), Math.round((r * H) / rows), Math.round(((c + 1) * R) / cols), Math.round(((r + 1) * H) / rows)];
  });
}
const sorted = (bs: Box[]) => [...bs].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
/** The region's right edge: the left edge of the leftmost action-column window. */
const edge = async () => Math.min(...(await Promise.all(['board', 'inbox', 'notepad'].map(box))).map((b) => b[0]));

/** Waits until the shown terminals fill the region's slots for their count, none over another or the action column. */
async function tiled(n: number) {
  const [, H] = await desk();
  const R = await edge();
  await until(async () => JSON.stringify(sorted(await terms())) === JSON.stringify(sorted(slots(n, R, H))), `${n} terminals in their slots`, 1000);
  const ts = await terms();
  for (let i = 0; i < ts.length; i++) {
    for (const w of ['board', 'inbox', 'notepad']) expect(overlap(ts[i], await box(w)), `terminal ${i} over ${w}`).toBe(0);
    for (let j = i + 1; j < ts.length; j++) expect(overlap(ts[i], ts[j]), `terminal ${i} over ${j}`).toBe(0);
  }
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
  it('tiles 1 to 6 terminals left of the action column, re-tiles on close, minimize, a moved Board and a resized desktop', async () => {
    const settings = join(process.env.USERPROFILE!, '.kanban95', 'settings.json');
    writeFileSync(settings, JSON.stringify({ terminals: { auto: ['execute'] } }));
    try {
      await page.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
      const ids = Array.from({ length: 7 }, (_, i) => ticket(`Slot ${i + 1}`));
      // A fresh profile, also on a retry: no window has a place of its own yet.
      await fetch(`${base}api/ui`, { method: 'PUT', headers: { cookie: `k95=${srv.secret}`, 'content-type': 'application/json' }, body: '{}' });
      await page.goto(base + '?slots');
      await until(() => page.evaluate(`['board', 'inbox', 'notepad'].every((w) => document.querySelector('[data-win="' + w + '"]'))`), 'the action column');

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
      }
      // Closing one gives its slot to the rest.
      await wm(`close('${wids.shift()}')`);
      await tiled(3);
      for (const id of ids.slice(4)) wids.push(await launch(id));
      await tiled(6);

      // Minimized, a terminal leaves its slot; restored, it takes one again.
      await wm(`minimize('${wids[2]}')`);
      await tiled(5);
      await wm(`focus('${wids[2]}')`);
      await tiled(6);

      // A dragged terminal goes back to its slot at the next re-tile.
      const t = await page.center(`[data-win="${wids[0]}"] .title-bar-text`);
      await page.drag(t, { x: t.x + 300, y: t.y + 300 });
      await tiled(6);

      // Twelve tiled (six more windows opened with `tile`), then a 13th opens at the least-covered spot and the twelve stay put.
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
      for (let k = 1; k <= 6; k++) await wm(`close('slot-${k}')`);
      await wm(`close('extra')`);
      await tiled(6);

      // The Board moved left: the region ends at its new left edge.
      const bar = await page.center('[data-win="board"] .title-bar-text');
      await page.drag(bar, { x: bar.x - 200, y: bar.y });
      expect(await edge()).toBe(W / 2 - 200);
      await tiled(6);

      // Start → Close ended terminals closes the ended one and leaves the live ones tiled.
      const ended = await until(async () => (await (await api('/sessions')).json()).find((s: { id: number }) => `term-${s.id}` === wids[1]), 'the session');
      await api(`/grants/${ended.grant_id}`, 'DELETE');
      await until(() => page.evaluate(`document.querySelector('[data-win="${wids[1]}"]').classList.contains('ended')`), 'the ended terminal');
      await click('#start');
      await menuPick('Close ended terminals');
      await until(() => page.evaluate(`!document.querySelector('[data-win="${wids[1]}"]')`), 'the ended terminal to close');
      await tiled(5);

      // A larger desktop (full screen on a bigger monitor): the action column keeps its proportions, nothing leaves a bar of
      // empty desktop, and the terminals re-tile into the new region.
      await page.send('Emulation.setDeviceMetricsOverride', { width: 2400, height: 1350, deviceScaleFactor: 1, mobile: false });
      await until(async () => (await desk())[0] === 2400 && (await box('inbox'))[2] === 2400, 'the windows to scale');
      const [W2, H2] = await desk();
      const [b2, i2] = [await box('board'), await box('inbox')];
      expect(Math.abs(b2[0] - Math.round(((W / 2 - 200) * W2) / W))).toBeLessThanOrEqual(1);
      expect(Math.abs(i2[2] - W2)).toBeLessThanOrEqual(1);
      expect(Math.abs(i2[3] - H2)).toBeLessThanOrEqual(1);
      await tiled(5);
    } finally {
      rmSync(settings, { force: true });
      for (const { id } of db.prepare('SELECT id FROM grants WHERE revoked_at IS NULL AND ticket_id IS NOT NULL').all() as { id: number }[]) await api(`/grants/${id}`, 'DELETE');
      await until(() => sessions.size === 0, 'the agents to exit');
      db.prepare('DELETE FROM tickets').run();
    }
  });
});
