// In headless Edge or Chrome against a running daemon (setup in ui.ts): the startup layout (Start → Save / Reset startup layout).
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { describe, expect, it } from 'vitest';
import { sessions } from '../src/launcher.ts';
import { until } from './cdp.ts';
import { srv, db, page, base, ticket, column, click, menuPick } from './ui.ts';

type Box = [number, number, number, number]; // left, top, right, bottom
const box = (wid: string) => page.evaluate<Box | null>(`(() => { const e = document.querySelector('[data-win="${wid}"]'); return e && [e.offsetLeft, e.offsetTop, e.offsetLeft + e.offsetWidth, e.offsetTop + e.offsetHeight]; })()`);
const overlap = (a: Box, b: Box) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
const desk = () => page.evaluate<[number, number]>(`(() => { const d = document.getElementById('desktop'); return [d.clientWidth, d.clientHeight]; })()`);
const viewport = (width: number, height: number) => page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
const boot = async (q: string) => {
  await page.goto(`${base}?${q}`);
  await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
};
const start = async (label: string) => {
  await click('#start');
  await menuPick(label);
};
const api = (path: string, method = 'GET') => fetch(`${base}api${path}`, { method, headers: { cookie: `k95=${srv.secret}` } });

/** The shipped default: Board touching the top-right corner, Inbox the bottom-right, apart, both inside the desktop. */
async function expectDefault() {
  const [W, H] = await desk();
  const b = (await box('board'))!;
  const i = (await box('inbox'))!;
  expect([b[1], b[2]]).toEqual([0, W]);
  expect([i[2], i[3]]).toEqual([W, H]);
  expect(Math.min(b[0], i[0])).toBeGreaterThanOrEqual(0);
  expect(overlap(b, i)).toBe(0);
  return { b, i, W };
}

describe('ui-layout', { timeout: 60_000 }, () => {
  it('boots a fresh profile with the Board top right and the Inbox bottom right, also on a small screen', async () => {
    await viewport(1920, 1080);
    await boot('fresh');
    const { b, i } = await expectDefault();
    expect(Math.min(b[0], i[0])).toBeGreaterThanOrEqual(760); // a terminal's width is left free on the left
    await viewport(1024, 600);
    await boot('small');
    await expectDefault();
  });

  it('reopens the saved windows where they were saved, and the default after a reset', async () => {
    await viewport(1920, 1080);
    await boot('save');
    const bar = await page.center('[data-win="board"] .title-bar-text');
    await page.drag(bar, { x: bar.x - 300, y: bar.y + 50 });
    const moved = (await box('board'))!;
    expect(moved[1]).toBe(50);
    await page.evaluate(`document.querySelector('[data-win="inbox"] [aria-label="Close"]').click()`);
    await start('Save startup layout');
    expect(await page.evaluate(`JSON.parse(localStorage.getItem('k95.layout')).map((w) => w.id)`)).toEqual(['board']);

    await boot('saved');
    expect(await box('board')).toEqual(moved);
    expect(await box('inbox')).toBeNull();

    await start('Reset startup layout');
    await boot('reset');
    await expectDefault();
  });

  it('opens live sessions\' terminals at boot at their saved place, or clear of the layout', async () => {
    await viewport(1920, 1080);
    const [kept, fresh] = [ticket('Kept'), ticket('Fresh')];
    await boot('terms');
    await page.evaluate(`localStorage.setItem('k95.win.term-ticket-${kept}', JSON.stringify({ x: 30, y: 40, w: 500, h: 300 }))`);
    const keys: Record<number, number> = {};
    for (const id of [kept, fresh]) {
      await until(() => column(id), 'the card');
      expect((await api(`/tickets/${id}/launch`, 'POST')).status).toBe(200);
      keys[id] = await until(async () => (await (await api('/sessions')).json()).find((x: { ticket_id: number }) => x.ticket_id === id)?.id, 'the session');
    }
    await boot('terms-reload');
    for (const id of [kept, fresh]) await until(() => page.evaluate(`!!document.querySelector('[data-win="term-${keys[id]}"] .xterm')`), 'the terminal');
    expect(await box(`term-${keys[kept]}`)).toEqual([30, 40, 530, 340]);
    const t = (await box(`term-${keys[fresh]}`))!;
    for (const w of ['board', 'inbox']) expect(overlap(t, (await box(w))!), `terminal over ${w}`).toBe(0);

    for (const { id } of db.prepare('SELECT id FROM grants WHERE revoked_at IS NULL AND ticket_id IS NOT NULL').all() as { id: number }[]) await api(`/grants/${id}`, 'DELETE');
    await until(() => sessions.size === 0, 'the agents to exit');
    db.prepare('DELETE FROM tickets').run();
  });
});
