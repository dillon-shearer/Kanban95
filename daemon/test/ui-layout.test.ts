// In headless Edge or Chrome against a running daemon (setup in ui.ts): the startup layout (Start → Save / Reset startup layout).
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { describe, expect, it } from 'vitest';
import { sessions } from '../src/launcher.ts';
import { until } from './cdp.ts';
import { srv, db, page, base, ticket, column, click, menuPick, setUi } from './ui.ts';

type Box = [number, number, number, number]; // left, top, right, bottom
const box = (wid: string) => page.evaluate<Box | null>(`(() => { const e = document.querySelector('[data-win="${wid}"]'); return e && [e.offsetLeft, e.offsetTop, e.offsetLeft + e.offsetWidth, e.offsetTop + e.offsetHeight]; })()`);
const desk = () => page.evaluate<[number, number]>(`(() => { const d = document.getElementById('desktop'); return [d.clientWidth, d.clientHeight]; })()`);
const iconsRight = () => page.evaluate<number>(`(() => { const e = document.getElementById('icons'); return e.offsetLeft + e.offsetWidth; })()`);
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

/** The shipped default (layout B): the Board alone, across the desktop right of the icons, over the top 55% of its height. */
async function expectDefault() {
  const [W, H] = await desk();
  // Clear of the desktop icons, so they stay visible however small the desktop.
  expect(await box('board')).toEqual([(await iconsRight()) + 4, 0, W, Math.round(H * 0.55)]);
  for (const w of ['inbox', 'brain', 'settings']) expect(await box(w), w).toBeNull();
}

describe('ui-layout', { timeout: 60_000 }, () => {
  it('boots a fresh profile with the Board across the top and Done folded, shrunk in proportion on a small screen', async () => {
    await viewport(1920, 1080);
    await boot('fresh');
    await expectDefault();
    expect(await page.evaluate(`[...document.querySelectorAll('.col.collapsed')].map((c) => c.dataset.status)`)).toEqual(['done']);
    await viewport(1024, 600);
    await boot('small');
    await expectDefault();
  });

  it('reopens the saved windows where they were saved, and the default after a reset', async () => {
    await viewport(1920, 1080);
    await boot('save');
    const bar = await page.center('[data-win="board"] .title-bar-text');
    await page.drag(bar, { x: bar.x - 40, y: bar.y + 50 });
    const moved = (await box('board'))!;
    expect(moved[1]).toBe(50);
    await start('Inbox');
    await until(() => box('inbox'), 'the Inbox');
    const inbox = (await box('inbox'))!;
    await start('Save startup layout');
    await until(async () => (await (await api('/ui')).json())['k95.layout']?.map((w: { id: string }) => w.id).join() === 'board,inbox', 'the layout in ui.json');

    await boot('saved');
    expect(await box('board')).toEqual(moved);
    expect(await box('inbox')).toEqual(inbox);

    await start('Reset startup layout');
    await boot('reset');
    await expectDefault();
  });

  it('keeps the folded columns saved, even none, over the default', async () => {
    await boot('folds');
    await setUi('k95.collapsed', []);
    await boot('folds-none');
    expect(await page.evaluate(`document.querySelectorAll('.col.collapsed').length`)).toBe(0);
    await setUi('k95.collapsed', undefined);
  });

  it('opens live sessions\' terminals at boot at their saved place, or in the zone under the Board', async () => {
    await viewport(1920, 1080);
    const [kept, fresh] = [ticket('Kept'), ticket('Fresh')];
    await boot('terms');
    await setUi(`k95.win.term-ticket-${kept}`, { x: 30, y: 40, w: 500, h: 300 });
    const keys: Record<number, number> = {};
    for (const id of [kept, fresh]) {
      await until(() => column(id), 'the card');
      expect((await api(`/tickets/${id}/launch`, 'POST')).status).toBe(200);
      keys[id] = await until(async () => (await (await api('/sessions')).json()).find((x: { ticket_id: number }) => x.ticket_id === id)?.id, 'the session');
    }
    await boot('terms-reload');
    for (const id of [kept, fresh]) await until(() => page.evaluate(`!!document.querySelector('[data-win="term-${keys[id]}"] .xterm')`), 'the terminal');
    expect(await box(`term-${keys[kept]}`)).toEqual([30, 40, 530, 340]);
    const [W, H] = await desk();
    const b = (await box('board'))!;
    expect(await box(`term-${keys[fresh]}`)).toEqual([b[0], b[3], W, H]); // alone in the zone: all of it

    for (const { id } of db.prepare('SELECT id FROM grants WHERE revoked_at IS NULL AND ticket_id IS NOT NULL').all() as { id: number }[]) await api(`/grants/${id}`, 'DELETE');
    await until(() => sessions.size === 0, 'the agents to exit');
    db.prepare('DELETE FROM tickets').run();
  });
});
