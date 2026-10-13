// In headless Edge or Chrome against a running daemon (setup in ui.ts): the compact taskbar fits a normal working set.
import './home.ts';
import { describe, expect, it } from 'vitest';
import { until } from './cdp.ts';
import { page, base } from './ui.ts';

describe('ui-taskbar-fit', { timeout: 60_000 }, () => {
  it('keeps tray text small and no taller than a task button, and fits six windows at 1280px without arrows', async () => {
    await page.goto(base);
    await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
    await page.evaluate(`import('/wm.js').then((wm) => {
      for (const id of ['inbox', 'notepad']) wm.open(id, { title: id[0].toUpperCase() + id.slice(1) });
      for (const n of [1, 2, 3]) wm.open('t' + n, { title: '#10' + n + ' execute — a long terminal title', label: '#10' + n + ' execute', tile: true });
    })`);
    await until(() => page.evaluate<boolean>(`document.querySelectorAll('#tasks .task').length >= 6`), 'six task buttons');
    const m = await page.evaluate<{ vw: number; arrows: boolean; fonts: number[]; heights: number[]; task: number }>(`(() => {
      const task = document.querySelector('#tasks .task').getBoundingClientRect().height;
      const items = [...document.querySelectorAll('#tray > *')];
      document.getElementById('restart-badge').hidden = false;
      return { vw: innerWidth, task,
        arrows: !document.getElementById('tasks-left').hidden || !document.getElementById('tasks-right').hidden,
        fonts: items.map((e) => parseFloat(getComputedStyle(e).fontSize)),
        heights: items.map((e) => e.getBoundingClientRect().height) };
    })()`);
    await page.evaluate(`import('/wm.js').then((wm) => ['inbox', 'notepad', 't1', 't2', 't3'].forEach((id) => wm.close(id)))`);
    await page.evaluate(`document.getElementById('restart-badge').hidden = true`);
    expect(m.vw).toBe(1280);
    expect(m.arrows).toBe(false);
    for (const f of m.fonts) expect(f).toBeLessThan(11);
    for (const h of m.heights) expect(h).toBeLessThanOrEqual(m.task);
  });
});
