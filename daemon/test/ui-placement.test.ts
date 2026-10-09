// In headless Edge or Chrome against a running daemon (setup in ui.ts): where a new window opens (`place` in wm.js) and how
// terminals tile into the zone under the Board (`tile`).
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { describe, expect, it } from 'vitest';
import { sessions } from '../src/launcher.ts';
import { until } from './cdp.ts';
import { srv, db, page, base, ticket, column, setUi } from './ui.ts';

type Box = [number, number, number, number]; // left, top, right, bottom
const box = (wid: string) => page.evaluate<Box>(`(() => { const e = document.querySelector('[data-win="${wid}"]'); return [e.offsetLeft, e.offsetTop, e.offsetLeft + e.offsetWidth, e.offsetTop + e.offsetHeight]; })()`);
const overlap = (a: Box, b: Box) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
const desk = () => page.evaluate<Box>(`(() => { const d = document.getElementById('desktop'); return [0, 0, d.clientWidth, d.clientHeight]; })()`);
const cookie = () => ({ cookie: `k95=${srv.secret}` });

/** Launches ticket `id`'s agent and returns its terminal's window id once the terminal is open. */
async function launch(id: number) {
  await until(() => column(id), 'the card');
  expect((await fetch(`${base}api/tickets/${id}/launch`, { method: 'POST', headers: cookie() })).status).toBe(200);
  const key = await until(async () => (await (await fetch(`${base}api/sessions`, { headers: cookie() })).json()).find((x: { ticket_id: number }) => x.ticket_id === id)?.id, 'the session');
  await until(() => page.evaluate(`!!document.querySelector('[data-win="term-${key}"] .xterm')`), 'the terminal');
  return `term-${key}`;
}

/** Ends every agent (revoking a grant kills it) and waits for them to exit, so the next test starts clean. */
async function endAll() {
  for (const { id } of db.prepare('SELECT id FROM grants WHERE revoked_at IS NULL AND ticket_id IS NOT NULL').all() as { id: number }[])
    await fetch(`${base}api/grants/${id}`, { method: 'DELETE', headers: cookie() });
  await until(() => sessions.size === 0, 'the agents to exit');
  db.prepare('DELETE FROM tickets').run();
}

const viewport = (width: number, height: number) => page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
const boot = async (q: string) => {
  await page.goto(`${base}?${q}`);
  await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
};

describe('ui-placement', { timeout: 90_000 }, () => {
  it('tiles terminals side by side at equal width under the Board, and re-tiles when one closes or is moved out', async () => {
    await viewport(1920, 1080);
    const ids = ['One', 'Two', 'Three', 'Four'].map((t) => ticket(t));
    await boot('zone');
    const board = await box('board');
    const d = await desk();
    const terms: string[] = [];
    for (const id of ids) terms.push(await launch(id));
    const row = async (wids: string[]) => {
      const boxes = await Promise.all(wids.map(box));
      const w = (d[2] - board[0]) / wids.length;
      boxes.forEach((b, i) => {
        expect(b[1]).toBe(board[3]); // straight under the Board, to the desktop's bottom
        expect(b[3]).toBe(d[3]);
        expect(Math.abs(b[0] - (board[0] + i * w))).toBeLessThanOrEqual(1);
        expect(Math.abs(b[2] - b[0] - w)).toBeLessThanOrEqual(1);
        expect(overlap(b, board)).toBe(0);
      });
      expect(boxes.at(-1)![2]).toBe(d[2]);
    };
    await row(terms);
    expect(await page.evaluate(`document.querySelector('[data-task="${terms[0]}"] img').getAttribute('src')`)).toBe('icons/execute.svg');

    // An ended terminal closed: the other three share the width.
    const grant = (db.prepare('SELECT id FROM grants WHERE ticket_id = ? AND revoked_at IS NULL').get(ids[1]) as { id: number }).id;
    await fetch(`${base}api/grants/${grant}`, { method: 'DELETE', headers: cookie() });
    await until(() => page.evaluate(`document.querySelector('[data-win="${terms[1]}"]').classList.contains('ended')`), 'the ended terminal');
    await page.evaluate(`document.querySelector('[data-win="${terms[1]}"] [aria-label="Close"]').click()`);
    await row([terms[0], terms[2], terms[3]]);

    // Dragged out by the operator: it stays where it was dropped and the other two take halves.
    const bar = await page.center(`[data-win="${terms[0]}"] .title-bar-text`);
    await page.drag(bar, { x: bar.x + 40, y: bar.y - 200 });
    const dropped = await box(terms[0]);
    expect(dropped[1]).toBe(board[3] - 200);
    await row([terms[2], terms[3]]);
    expect(await box(terms[0])).toEqual(dropped);
    await endAll();
  });

  it('brings a terminal to the front when its ticket needs you, out of minimized, without taking focus', async () => {
    await viewport(1920, 1080);
    const id = ticket('Ask me');
    await boot('human');
    const wid = await launch(id);
    await page.evaluate(`import('/wm.js').then((wm) => { wm.minimize('${wid}'); wm.focus('board'); })`);
    const z = (w: string) => page.evaluate<number>(`Number(document.querySelector('[data-win="${w}"]').style.zIndex)`);
    expect(await page.evaluate(`document.querySelector('[data-win="${wid}"]').hidden`)).toBe(true);
    const flag = await fetch(`${base}api/tickets/${id}`, { method: 'PATCH', headers: { ...cookie(), 'content-type': 'application/json' }, body: JSON.stringify({ needs_human: true }) });
    expect(flag.status).toBe(200);
    await until(() => page.evaluate(`!document.querySelector('[data-win="${wid}"]').hidden`), 'the terminal back from minimized');
    expect(await z(wid)).toBeGreaterThan(await z('board'));
    expect(await page.evaluate(`document.querySelector('.k95-win.active')?.dataset.win`)).toBe('board');
    db.prepare('UPDATE tickets SET needs_human = 0 WHERE id = ?').run(id);
    await endAll();
  });

  it('opens a new window inside the desktop at its least covered spot when none is free', async () => {
    await viewport(1280, 720);
    // The Board alone at the top left, as the expectation below is worked out for.
    await setUi('k95.layout', [{ id: 'board', x: 0, y: 0, w: 1000, h: 560 }]);
    await boot('full');
    await page.evaluate(`import('/wm.js').then((wm) => wm.open('probe', { title: 'probe', w: 760, h: 440 }))`);
    const [l, t, r, b] = await box('probe');
    const d = await desk();
    expect(l).toBeGreaterThanOrEqual(0);
    expect(t).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThanOrEqual(d[2]);
    expect(b).toBeLessThanOrEqual(d[3]);
    // The board (1000×560 at the top left) leaves the bottom-right corner least covered of the candidates.
    const cover = overlap([l, t, r, b], await box('board'));
    expect(cover).toBe(overlap([d[2] - (r - l), d[3] - (b - t), d[2], d[3]], await box('board')));
    await page.evaluate(`import('/wm.js').then((wm) => wm.close('probe'))`);
    await setUi('k95.layout', undefined);
  });

  it('opens a terminal with a saved position there, even over another window', async () => {
    const id = ticket('Saved');
    await boot('saved');
    await setUi(`k95.win.term-ticket-${id}`, { x: 30, y: 40, w: 500, h: 300 });
    const wid = await launch(id);
    expect(await box(wid)).toEqual([30, 40, 530, 340]);
    await endAll();
  });
});
