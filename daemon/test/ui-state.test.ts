// In headless Edge or Chrome against a running daemon (setup in ui.ts): UI state lives in <repo>/.kanban95/ui.json, so a daemon
// restarted on another port (a new origin, whose browser storage starts empty) opens the board as the operator left it.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { describe, expect, it } from 'vitest';
import { start } from '../src/server.ts';
import { until } from './cdp.ts';
import { srv, page, base, repo, click, menuPick } from './ui.ts';

const box = (wid: string) => page.evaluate<number[] | null>(`(() => { const e = document.querySelector('[data-win="${wid}"]'); return e && [e.offsetLeft, e.offsetTop, e.offsetWidth, e.offsetHeight]; })()`);
const board = () => until(() => page.evaluate(`!!document.querySelector('[data-win="board"] [data-status="done"]')`), 'the board');
const state = async () => (await fetch(`${base}api/ui`, { headers: { cookie: `k95=${srv.secret}` } })).json();

/** Opens the board on a second daemon on the same repo, which binds another port, runs `check` there, then stops it. */
async function restarted(check: () => Promise<void>) {
  const srv2 = await start({ repo });
  try {
    expect(srv2.port).not.toBe(srv.port);
    const base2 = `http://127.0.0.1:${srv2.port}/`;
    await page.send('Page.navigate', { url: `${base2}?k95=${srv2.secret}` });
    await until(() => page.evaluate(`location.href === ${JSON.stringify(base2)}`), 'the redirect to /');
    await board();
    expect(await page.evaluate(`localStorage.length`)).toBe(0);
    await check();
  } finally {
    await srv2.close();
    // Each daemon sets its own cookie (k95-<port>), so the second's login left the first's in place: no new login.
    await page.send('Page.navigate', { url: base });
    await board();
  }
}

// The writes waited for are the debounced ones, not a pagehide flush: a restart is a new daemon, not a reload.
describe('ui-state', { timeout: 60_000 }, () => {
  let moved: number[];

  it('opens the Board where it was moved, at its size, with its folded columns, after a restart on another port', async () => {
    await page.goto(base);
    await board();
    await page.evaluate(`Object.assign(document.querySelector('[data-win="board"]').style, { width: '900px', height: '400px' })`);
    const bar = await page.center('[data-win="board"] .title-bar-text');
    await page.drag(bar, { x: bar.x - 100, y: bar.y + 60 });
    moved = (await box('board'))!;
    expect(moved.slice(1)).toEqual([60, 900, 400]);
    await click('[data-status="testing"] > legend');
    await until(async () => {
      const s = await state();
      return s['k95.collapsed']?.includes('testing') && JSON.stringify(s['k95.win.board']) === JSON.stringify({ x: moved[0], y: moved[1], w: moved[2], h: moved[3] });
    }, 'ui.json');
    expect((await state())['k95.layout']).toBeUndefined(); // no layout saved: the default's Board, at its own place

    await restarted(async () => {
      expect(await box('board')).toEqual(moved);
      expect(await box('inbox')).toBeNull(); // the default layout opens the Board alone
      expect(await page.evaluate(`document.querySelector('[data-status="testing"]').classList.contains('collapsed')`)).toBe(true);
    });
  });

  it('opens the windows of the saved startup layout after a restart on another port', async () => {
    await page.goto(base);
    await board();
    await page.evaluate(`document.querySelector('[data-win="inbox"] [aria-label="Close"]')?.click()`);
    await click('#start');
    await menuPick('Save startup layout');
    await until(async () => (await state())['k95.layout']?.map((w: { id: string }) => w.id).join() === 'board', 'the layout in ui.json');

    await restarted(async () => {
      expect(await box('board')).toEqual(moved);
      expect(await box('inbox')).toBeNull();
    });
  });
});
