// In headless Edge or Chrome against a running daemon (setup in ui.ts): where a new window opens (`place` in wm.js).
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { describe, expect, it } from 'vitest';
import { sessions } from '../src/launcher.ts';
import { until } from './cdp.ts';
import { srv, db, page, base, ticket, column, setUi } from './ui.ts';

type Box = [number, number, number, number]; // left, top, right, bottom
const box = (wid: string) => page.evaluate<Box>(`(() => { const e = document.querySelector('[data-win="${wid}"]'); return [e.offsetLeft, e.offsetTop, e.offsetLeft + e.offsetWidth, e.offsetTop + e.offsetHeight]; })()`);
const overlap = (a: Box, b: Box) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
const desk = () => page.evaluate<Box>(`(() => { const d = document.getElementById('desktop'); return [0, 0, d.clientWidth, d.clientHeight]; })()`);

/** Launches ticket `id`'s agent and returns its terminal's window id once the terminal is open. */
async function launch(id: number) {
  await until(() => column(id), 'the card');
  expect((await fetch(`${base}api/tickets/${id}/launch`, { method: 'POST', headers: { cookie: `k95=${srv.secret}` } })).status).toBe(200);
  const key = await until(async () => (await (await fetch(`${base}api/sessions`, { headers: { cookie: `k95=${srv.secret}` } })).json()).find((x: { ticket_id: number }) => x.ticket_id === id)?.id, 'the session');
  await until(() => page.evaluate(`!!document.querySelector('[data-win="term-${key}"] .xterm')`), 'the terminal');
  return `term-${key}`;
}

/** Ends every agent (revoking a grant kills it) and waits for them to exit, so the next test starts clean. */
async function endAll() {
  for (const { id } of db.prepare('SELECT id FROM grants WHERE revoked_at IS NULL AND ticket_id IS NOT NULL').all() as { id: number }[])
    await fetch(`${base}api/grants/${id}`, { method: 'DELETE', headers: { cookie: `k95=${srv.secret}` } });
  await until(() => sessions.size === 0, 'the agents to exit');
  db.prepare('DELETE FROM tickets').run();
}

const viewport = (width: number, height: number) => page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

describe('ui-placement', { timeout: 60_000 }, () => {
  it('opens three new terminals apart from each other and the Board while the desktop has room', async () => {
    await viewport(2400, 1400);
    const ids = ['One', 'Two', 'Three'].map((t) => ticket(t));
    await page.goto(base + '?roomy');
    await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
    const terms = [];
    for (const id of ids) terms.push(await launch(id)); // one at a time: each must see the ones before it
    const boxes = [await box('board'), ...await Promise.all(terms.map(box))];
    const d = await desk();
    for (let i = 0; i < boxes.length; i++) {
      expect(boxes[i][0]).toBeGreaterThanOrEqual(0);
      expect(boxes[i][1]).toBeGreaterThanOrEqual(0);
      expect(boxes[i][2]).toBeLessThanOrEqual(d[2]);
      expect(boxes[i][3]).toBeLessThanOrEqual(d[3]);
      for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i], boxes[j]), `window ${i} over window ${j}`).toBe(0);
    }
    await endAll();
  });

  it('opens a new terminal inside the desktop at its least covered spot when none is free', async () => {
    await viewport(1280, 720);
    const id = ticket('Crowded');
    // The Board alone at the top left, as the expectation below is worked out for.
    await setUi('k95.layout', [{ id: 'board', x: 0, y: 0, w: 1000, h: 560 }]);
    await page.goto(base + '?full');
    await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
    const wid = await launch(id);
    const [l, t, r, b] = await box(wid);
    const d = await desk();
    expect(l).toBeGreaterThanOrEqual(0);
    expect(t).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThanOrEqual(d[2]);
    expect(b).toBeLessThanOrEqual(d[3]);
    // The board (1000×560 at the top left) leaves the bottom-right corner least covered of the candidates.
    const cover = overlap([l, t, r, b], await box('board'));
    const w = r - l;
    const h = b - t;
    expect(cover).toBe(overlap([d[2] - w, d[3] - h, d[2], d[3]], await box('board')));
    await endAll();
  });

  it('opens a terminal with a saved position there, even over another window', async () => {
    const id = ticket('Saved');
    await page.goto(base + '?saved');
    await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
    await setUi(`k95.win.term-ticket-${id}`, { x: 30, y: 40, w: 500, h: 300 });
    const wid = await launch(id);
    expect(await box(wid)).toEqual([30, 40, 530, 340]);
    await endAll();
  });
});
