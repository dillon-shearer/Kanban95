// In headless Edge or Chrome against a running daemon (setup in ui.ts): a desktop that reports 0x0 for a moment (hidden,
// maybe minimized) leaves every window where it was once it has a real size again.
import './home.ts';
import { describe, expect, it } from 'vitest';
import { until } from './cdp.ts';
import { base, page } from './ui.ts';

type Place = { x: number; y: number; w: number; h: number };
const places = (ids: string[]) => page.evaluate<Place[]>(`${JSON.stringify(ids)}.map((id) => document.querySelector('[data-win="' + id + '"]').style)
  .map((s) => ({ x: parseFloat(s.left), y: parseFloat(s.top), w: parseFloat(s.width), h: parseFloat(s.height) }))`);
const resize = (hidden: boolean) => page.evaluate(`(() => { document.getElementById('desktop').hidden = ${hidden}; dispatchEvent(new Event('resize')); })()`);

describe('ui-resize-zero', { timeout: 60_000 }, () => {
  it('keeps Board, Notepad and a tiled window in place across a 0x0 desktop', async () => {
    await page.goto(base);
    await until(() => page.evaluate(`!!document.querySelector('[data-task="board"]')`), 'the Board taskbar button');
    await page.evaluate(`import('/wm.js').then((m) => {
      for (const id of ['board', 'notepad']) if (!m.isOpen(id)) m.open(id);
      m.open('t-z', { title: 't-z', tile: true });
    })`);
    const ids = ['board', 'notepad', 't-z'];
    await until(async () => (await places(ids)).every((p) => p.w > 0 && p.h > 0), 'all three windows placed');
    await new Promise((r) => setTimeout(r, 300));
    const before = await places(ids);
    await resize(true);
    await resize(false);
    await new Promise((r) => setTimeout(r, 300));
    const after = await places(ids);
    for (const [i, p] of after.entries()) {
      for (const k of ['x', 'y', 'w', 'h'] as const) expect(Math.abs(p[k] - before[i][k]), `${ids[i]} ${k}`).toBeLessThanOrEqual(1);
    }
    await page.evaluate(`import('/wm.js').then((m) => m.close('t-z'))`);
  });
});
