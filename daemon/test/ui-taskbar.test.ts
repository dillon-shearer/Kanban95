// In headless Edge or Chrome against a running daemon (setup in ui.ts): the taskbar and desktop icons.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { describe, expect, it } from 'vitest';
import { until } from './cdp.ts';
import { page, base, ticket, click } from './ui.ts';

describe('ui-taskbar', { timeout: 60_000 }, () => {
  it('pins a compact tray right after Start on one taskbar row', async () => {
    await page.goto(base);
    await until(() => page.evaluate(`!!document.querySelector('#clock').textContent`), 'the clock');
    const m = await page.evaluate<Record<string, number>>(`(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect(), bar = document.getElementById('taskbar');
      const start = r('#start'), tray = r('#tray'), tasks = r('#tasks');
      return { gap: tray.left - start.right, trayH: tray.height, startH: start.height,
        trayW: tray.width, tasksAfter: tasks.left - tray.right, overflow: bar.scrollWidth - bar.clientWidth,
        font: parseFloat(getComputedStyle(document.getElementById('agents')).fontSize) };
    })()`);
    expect(m.gap).toBeLessThanOrEqual(4);
    expect(m.tasksAfter).toBeGreaterThanOrEqual(0);
    expect(m.trayH).toBeLessThanOrEqual(m.startH);
    expect(m.trayW).toBeLessThan(300); // 98.css's .status-bar-field flex-grow stretched it across the bar
    expect(m.font).toBe(11);
    expect(m.overflow).toBe(0);
  });

  it('scrolls an overflowing taskbar with its arrows, the wheel and focus; buttons stay at least 60px', async () => {
    await page.goto(base);
    await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
    const wm = (js: string) => page.evaluate(`import('/wm.js').then((wm) => { ${js} })`);
    const arrowsShown = () => page.evaluate<boolean>(`!document.getElementById('tasks-right').hidden && !document.getElementById('tasks-left').hidden`);
    const shown = (id: string) => page.evaluate<boolean>(`(() => {
      const t = document.getElementById('tasks').getBoundingClientRect();
      const b = [...document.querySelectorAll('#tasks .task')].find((e) => e.textContent === '${id}').getBoundingClientRect();
      return b.left >= t.left - 0.5 && b.right <= t.right + 0.5;
    })()`);
    const ids = Array.from({ length: 20 }, (_, i) => `scroll-${i}`);
    expect(await arrowsShown()).toBe(false);
    await wm(`${JSON.stringify(ids)}.forEach((id) => wm.open(id, { title: id }));`);
    try {
      expect(await arrowsShown()).toBe(true);
      expect(await page.evaluate<number>(`Math.min(...[...document.querySelectorAll('#tasks .task')].map((b) => b.getBoundingClientRect().width))`)).toBeGreaterThanOrEqual(60);
      expect(await shown('scroll-19')).toBe(true); // the newest window is focused, so its button scrolled into view

      await page.evaluate(`document.getElementById('tasks').scrollLeft = 0`);
      expect(await shown('scroll-19')).toBe(false);
      for (let i = 0; i < 30 && !(await shown('scroll-19')); i++) await click('#tasks-right');
      expect(await shown('scroll-19')).toBe(true);
      await click('#tasks-left');
      expect(await shown('scroll-19')).toBe(false);

      await page.evaluate(`document.getElementById('tasks').scrollLeft = 0`);
      const { x, y } = await page.center('#tasks');
      await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: 100 });
      await until(() => page.evaluate<boolean>(`document.getElementById('tasks').scrollLeft > 0`), 'the wheel to scroll the taskbar');

      await page.evaluate(`document.getElementById('tasks').scrollLeft = 0`);
      await wm(`wm.focus('scroll-19');`);
      expect(await shown('scroll-19')).toBe(true);
    } finally {
      await wm(`${JSON.stringify(ids)}.forEach((id) => wm.close(id));`);
    }
    expect(await arrowsShown()).toBe(false);
  });

  it('opens Settings from a double-clicked desktop icon and Inbox from Enter; icons stay under windows', async () => {
    await page.goto(base);
    await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
    expect(await page.evaluate(`[...document.querySelectorAll('#icons .k95-icon')].map((e) => e.textContent)`))
      .toEqual(['Board', 'Inbox', 'Brain', 'Settings', 'Notepad', 'New ticket', 'New brainstorm']);
    await page.evaluate(`document.querySelector('[data-win="board"] [aria-label="Close"]').click()`); // the board may sit over the icons
    // Every image loaded from our origin: a CSP block or a missing file leaves naturalWidth at 0.
    await until(() => page.evaluate(`[...document.querySelectorAll('#icons img')].every((i) => i.complete && i.naturalWidth === 32)`), 'the icon images');

    const { x, y } = await page.center('[data-icon="Settings"]');
    expect(await page.evaluate(`document.elementFromPoint(${x}, ${y}).closest('.k95-icon')?.dataset.icon ?? null`)).toBe('Settings');
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    expect(await page.evaluate(`document.activeElement.dataset.icon`)).toBe('Settings');
    expect(await page.evaluate(`getComputedStyle(document.activeElement.querySelector('span')).backgroundColor`)).toBe('rgb(0, 0, 128)');
    expect(await page.evaluate(`!!document.querySelector('[data-win="settings"]')`)).toBe(false); // one click only selects
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 2 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 2 });
    await until(() => page.evaluate(`!!document.querySelector('[data-win="settings"]')`), 'the Settings window');

    await page.evaluate(`document.querySelector('[data-icon="Inbox"]').focus()`);
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await until(() => page.evaluate(`!!document.querySelector('[data-win="inbox"]')`), 'the Inbox window');

    // A window dragged over the icons covers them.
    await page.evaluate(`Object.assign(document.querySelector('[data-win="settings"]').style, { left: '0px', top: '0px' })`);
    const s = await page.center('[data-icon="Board"]');
    expect(await page.evaluate(`!!document.elementFromPoint(${s.x}, ${s.y}).closest('[data-win]')`)).toBe(true);
  });
});
