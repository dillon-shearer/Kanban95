// In headless Edge or Chrome against a running daemon (setup in ui.ts): a pop-up menu stays inside the desktop, off the taskbar.
import './home.ts';
import { describe, expect, it } from 'vitest';
import { until } from './cdp.ts';
import { base, page, rightClick } from './ui.ts';

const edges = () => page.evaluate<{ menu: DOMRect; desktop: DOMRect }>(`(() => ({
  menu: document.querySelector('.k95-menu').getBoundingClientRect().toJSON(),
  desktop: document.getElementById('desktop').getBoundingClientRect().toJSON(),
}))()`);

describe('ui-menu-clamp', { timeout: 60_000 }, () => {
  it('opens a taskbar button\'s menu above the taskbar, not over it', async () => {
    await page.goto(base);
    await until(() => page.evaluate(`!!document.querySelector('[data-task="board"]')`), 'the Board taskbar button');
    await rightClick('[data-task="board"]');
    await until(() => page.evaluate(`!!document.querySelector('.k95-menu')`), 'the taskbar menu');
    const { menu, desktop } = await edges();
    expect(menu.bottom).toBeLessThanOrEqual(desktop.bottom + 0.5);
    expect(menu.top).toBeGreaterThanOrEqual(0);
    await page.evaluate(`document.querySelector('.k95-menu').remove()`);
  });
});
