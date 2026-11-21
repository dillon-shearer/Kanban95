// In headless Edge or Chrome against a running daemon (setup in ui.ts): a tiled window leaves the grid only when the
// operator drags or resizes it, never because a repack moved it between a press and a release.
import './home.ts';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { until } from './cdp.ts';
import { base, page } from './ui.ts';

const open = (id: string) => page.evaluate(`import('/wm.js').then((m) => { m.open(${JSON.stringify(id)}, { title: ${JSON.stringify(id)}, tile: true }); })`);
const pointer = (id: string, type: string, part: string) => page.evaluate(`document.querySelector('[data-win="${id}"] ${part}')
  .dispatchEvent(new PointerEvent(${JSON.stringify(type)}, { bubbles: true, button: 0, pointerId: 1 }))`);
const geometry = (ids: string[]) => page.evaluate<{ region: { L: number; W: number }; wins: { x: number; y: number; w: number }[] }>(`(() => {
  const icons = document.getElementById('icons');
  const region = { L: icons ? icons.offsetLeft + icons.offsetWidth + 4 : 0, W: document.getElementById('desktop').clientWidth };
  const wins = ${JSON.stringify(ids)}.map((id) => document.querySelector('[data-win="' + id + '"]').style)
    .map((s) => ({ x: parseFloat(s.left), y: parseFloat(s.top), w: parseFloat(s.width) }));
  return { region, wins };
})()`);
/** The windows fill one row of the region in the given order, each a 1/n share of its width. */
const inRow = async (ids: string[]) => {
  const { region: { L, W }, wins } = await geometry(ids);
  const share = (W - L) / ids.length;
  return wins.every((r, i) => r.y === 0 && Math.abs(r.x - (L + i * share)) <= 1 && Math.abs(r.w - share) <= 1);
};
const box = (id: string) => page.evaluate<{ x: number; y: number }>(`(() => { const r = document.querySelector('[data-win="${id}"]').getBoundingClientRect(); return { x: r.left, y: r.top }; })()`);

describe('ui-tiling', { timeout: 60_000 }, () => {
  it('keeps a window in its slot when a repack moves it between a press and a release in its body', async () => {
    await page.goto(base);
    await until(() => page.evaluate(`!!document.querySelector('[data-task="board"]')`), 'the Board taskbar button');
    await page.evaluate(`import('/wm.js').then((m) => { for (const id of ['board', 'inbox', 'notepad']) if (m.isOpen(id)) m.minimize(id); })`);
    await open('t-a');
    await until(() => inRow(['t-a']), 't-a alone at the full region');
    await pointer('t-a', 'pointerdown', '.window-body');
    await open('t-b');
    await until(() => inRow(['t-a', 't-b']), 'two columns');
    await pointer('t-a', 'pointerup', '.window-body');
    await sleep(300);
    expect(await inRow(['t-a', 't-b'])).toBe(true);
  });

  it('keeps a window in its slot on a release with no press on it', async () => {
    await open('t-c');
    await until(() => inRow(['t-a', 't-b', 't-c']), 'three columns');
    await pointer('t-a', 'pointerup', '.window-body');
    await pointer('t-c', 'pointerup', '.title-bar');
    await sleep(300);
    expect(await inRow(['t-a', 't-b', 't-c'])).toBe(true);
    await page.evaluate(`import('/wm.js').then((m) => m.close('t-c'))`);
    await until(() => inRow(['t-a', 't-b']), 'two columns again');
  });

  it('frees a window dragged by its title bar; the other takes the full region', async () => {
    const from = await page.center('[data-win="t-a"] .title-bar-text');
    const start = await box('t-a');
    await page.drag(from, { x: from.x + 120, y: from.y + 150 });
    await until(() => inRow(['t-b']), 't-b alone at the full region');
    await sleep(300);
    const end = await box('t-a');
    expect(Math.abs(end.x - start.x - 120)).toBeLessThanOrEqual(1);
    expect(Math.abs(end.y - start.y - 150)).toBeLessThanOrEqual(1);
    expect(await inRow(['t-b'])).toBe(true);
  });

  it('takes a freed window back into the grid on a title-bar double-click', async () => {
    const { x, y } = await page.center('[data-win="t-a"] .title-bar-text');
    for (const clickCount of [1, 2]) {
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount });
    }
    await until(() => inRow(['t-b', 't-a']), 't-a back in the grid after t-b');
    await page.evaluate(`import('/wm.js').then((m) => { m.close('t-a'); m.close('t-b'); })`);
  });

  it('tiles two windows the board opens side by side left of the Board and Notepad at zoom 1.8', async () => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1011, deviceScaleFactor: 1, mobile: false });
    await until(() => page.evaluate('innerWidth === 1920'), 'the 1920 px viewport');
    await page.evaluate(`new Promise(requestAnimationFrame).then(() => import('/wm.js')).then((m) => {
      m.setZoom(1.8);
      for (const [id, x, y, w, h] of [['notepad', 614, 351, 453, 213], ['board', 616, 0, 451, 377]]) {
        m.focus(id);
        Object.assign(document.querySelector('[data-win="' + id + '"]').style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
      }
      for (const id of ['t-d', 't-e']) m.open(id, { title: id, w: 760, h: 440, tile: true, background: true });
    })`);
    const boxes = () => page.evaluate<{ x: number; y: number; r: number; b: number }[]>(`['t-d', 't-e', 'board', 'notepad', 'icons']
      .map((id) => document.querySelector('[data-win="' + id + '"]') ?? document.getElementById(id))
      .map((el) => ({ x: el.offsetLeft, y: el.offsetTop, r: el.offsetLeft + el.offsetWidth, b: el.offsetTop + el.offsetHeight }))`);
    const tiled = async () => {
      const [d, e, board, notepad, icons] = await boxes();
      const apart = (a: typeof d, o: typeof d) => a.r <= o.x || o.r <= a.x || a.b <= o.y || o.b <= a.y;
      return d.y === 0 && e.y === 0 && d.x >= icons.r && d.r <= e.x && e.r <= notepad.x && [d, e].every((t) => apart(t, board) && apart(t, notepad));
    };
    await sleep(300);
    const ok = await tiled();
    await page.evaluate(`import('/wm.js').then((m) => { m.close('t-d'); m.close('t-e'); m.setZoom(1); })`);
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
    expect(ok).toBe(true);
  });
});
