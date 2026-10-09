// In headless Edge or Chrome against a running daemon (setup in ui.ts): window geometry: positions, drag, maximize.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { describe, expect, it } from 'vitest';
import { until } from './cdp.ts';
import { page, base, click, menuPick } from './ui.ts';

// The Board reopens where the startup layout says (ui-layout.test.ts); Brain is not in the default layout, so it opens from
// its own remembered place.
const openBrain = async (q: string) => {
  await page.goto(base + q);
  await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
  await click('#start');
  await menuPick('Brain');
  await until(() => page.evaluate(`!!document.querySelector('[data-win="brain"]')`), 'the brain');
};

describe('ui-windows', { timeout: 60_000 }, () => {
  it('keeps window positions across a reload', async () => {
    await openBrain('');
    const pos = () => page.evaluate<[number, number]>(`(() => { const e = document.querySelector('[data-win="brain"]'); return [e.offsetLeft, e.offsetTop]; })()`);
    const [x0, y0] = await pos();
    const bar = await page.center('[data-win="brain"] .title-bar-text');
    await page.drag(bar, { x: bar.x + 90, y: bar.y + 50 });
    const moved = await pos();
    expect(moved).toEqual([x0 + 90, y0 + 50]);
    await openBrain('?reloaded');
    expect(await pos()).toEqual(moved);
  });

  it('keeps a window the same size while it is dragged', async () => {
    await page.goto(base + '?resize');
    await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
    const size = () => page.evaluate<[number, number]>(`(() => { const e = document.querySelector('[data-win="board"]'); return [e.offsetWidth, e.offsetHeight]; })()`);
    const before = await size();
    const bar = await page.center('[data-win="board"] .title-bar-text');
    await page.drag(bar, { x: bar.x + 200, y: bar.y });
    expect(await size()).toEqual(before);
  });

  it('maximizes to the desktop, ignores drags, restores the exact geometry and survives a reload', async () => {
    await openBrain('?max');
    const box = () => page.evaluate<number[]>(`(() => { const e = document.querySelector('[data-win="brain"]'); return [e.offsetLeft, e.offsetTop, e.offsetWidth, e.offsetHeight]; })()`);
    const desk = await page.evaluate<number[]>(`(() => { const d = document.getElementById('desktop'); return [0, 0, d.clientWidth, d.clientHeight]; })()`);
    expect(await page.evaluate(`[...document.querySelectorAll('[data-win="brain"] .title-bar-controls button')].slice(-3).map((b) => b.getAttribute('aria-label'))`))
      .toEqual(['Minimize', 'Maximize', 'Close']);
    const before = await box();
    await page.evaluate(`document.querySelector('[data-win="brain"] [aria-label="Maximize"]').click()`);
    expect(await box()).toEqual(desk);
    expect(await page.evaluate(`!!document.querySelector('[data-win="brain"] [aria-label="Restore"]')`)).toBe(true);
    const bar = await page.center('[data-win="brain"] .title-bar-text');
    await page.drag(bar, { x: bar.x + 120, y: bar.y + 60 });
    expect(await box()).toEqual(desk);

    await openBrain('?max-reload');
    expect(await box()).toEqual(desk);

    await page.evaluate(`document.querySelector('[data-win="brain"] [aria-label="Restore"]').click()`);
    expect(await box()).toEqual(before);
    await page.evaluate(`document.querySelector('[data-win="brain"] .title-bar-text').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    expect(await box()).toEqual(desk);
    await page.evaluate(`document.querySelector('[data-win="brain"] .title-bar-text').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    expect(await box()).toEqual(before);
  });
});
