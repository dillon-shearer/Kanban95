// In headless Edge or Chrome against a running daemon (setup in ui.ts): where a new window with no place of its own opens
// (`place` in wm.js), and a terminal raised when its ticket needs the operator. Terminals take slots instead: ui-slots.test.ts.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { describe, expect, it } from 'vitest';
import { sessions } from '../src/launcher.ts';
import { until } from './cdp.ts';
import { srv, db, page, base, ticket, column, setUi } from './ui.ts';

type Box = [number, number, number, number]; // left, top, right, bottom
const box = (wid: string) => page.evaluate<Box>(`(() => { const e = document.querySelector('[data-win="${wid}"]'); return [e.offsetLeft, e.offsetTop, e.offsetLeft + e.offsetWidth, e.offsetTop + e.offsetHeight]; })()`);
const overlap = (a: Box, b: Box) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
const desk = () => page.evaluate<Box>(`(() => { const d = document.getElementById('desktop'); return [0, 0, d.clientWidth, d.clientHeight]; })()`);
/** Opens a 760×440 window with no remembered place, as a Ticket window opens. */
const openNew = async (id: string) => {
  await page.evaluate(`import('/wm.js').then((m) => { m.open('${id}', { title: '${id}', w: 760, h: 440 }); })`);
  return id;
};
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

describe('ui-placement', { timeout: 60_000 }, () => {
  it('opens three new windows apart from each other and the action column while the desktop has room', async () => {
    await viewport(2400, 1400);
    await boot('roomy');
    const wins = [];
    for (const id of ['one', 'two', 'three']) wins.push(await openNew(id)); // one at a time: each must see the ones before it
    const boxes = [await box('board'), await box('inbox'), await box('notepad'), ...await Promise.all(wins.map(box))];
    const d = await desk();
    for (let i = 0; i < boxes.length; i++) {
      expect(boxes[i][0]).toBeGreaterThanOrEqual(0);
      expect(boxes[i][1]).toBeGreaterThanOrEqual(0);
      expect(boxes[i][2]).toBeLessThanOrEqual(d[2]);
      expect(boxes[i][3]).toBeLessThanOrEqual(d[3]);
      for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i], boxes[j]), `window ${i} over window ${j}`).toBe(0);
    }
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
    const [l, t, r, b] = await box(await openNew('crowded'));
    const d = await desk();
    expect(l).toBeGreaterThanOrEqual(0);
    expect(t).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThanOrEqual(d[2]);
    expect(b).toBeLessThanOrEqual(d[3]);
    // The board (1000×560 at the top left) leaves the bottom-right corner least covered of the candidates.
    const cover = overlap([l, t, r, b], await box('board'));
    expect(cover).toBe(overlap([d[2] - (r - l), d[3] - (b - t), d[2], d[3]], await box('board')));
    await setUi('k95.layout', undefined);
  });
});
