import './home.ts';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { until } from './cdp.ts';
import { boardHome, normal, pointerPath } from '../src/settings.ts';
import { removeTemp } from './home.ts';
import { page, base, srv } from './ui.ts';

const W = '[data-win="settings"]';
const data = mkdtempSync(join(tmpdir(), 'k95-data-'));
afterAll(() => {
  rmSync(pointerPath(), { force: true });
  removeTemp(data);
});

async function openBoardTab() {
  await page.goto(base);
  await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
  await page.evaluate(`document.querySelector('[data-icon="Settings"]').dispatchEvent(new MouseEvent('dblclick'))`);
  await until(() => page.evaluate(`!!document.querySelector('#scope-project')`), 'the switch');
  await page.evaluate(`[...document.querySelectorAll('${W} [role=tab] a')].find((t) => t.textContent === 'Board').click()`);
  await until(() => page.evaluate(`!!document.querySelector('#zoom')`), 'the Board tab');
}

describe('ui-data-folder', { timeout: 60_000 }, () => {
  it('Settings -> Board shows the data folder, and Use this folder confirms, then PUTs the new path', async () => {
    const shutdown = vi.fn();
    srv.board.shutdown = shutdown;
    try {
      await openBoardTab();
      await until(() => page.evaluate(`!!document.querySelector('#data-folder-current')`), 'the Data folder group');
      expect(await page.evaluate(`document.querySelector('#data-folder-current').value`)).toBe(boardHome());
      expect(await page.evaluate(`document.querySelector('#data-folder-current').readOnly`)).toBe(true);
      await page.evaluate(`document.querySelector('#data-folder').value = ${JSON.stringify(data)}`);
      await page.evaluate(`document.querySelector('#data-folder-use').click()`);
      await until(() => page.evaluate(`!!document.querySelector('.k95-dialog')`), 'the confirm');
      expect(await page.evaluate<string>(`document.querySelector('.k95-dialog').textContent`)).toContain(`Point Kanban95 at ${data}? Every board in this window closes and starts again from that folder. Nothing is copied.`);
      await page.evaluate(`[...document.querySelectorAll('.k95-dialog button')].find((b) => b.textContent === 'OK').click()`);
      await until(() => existsSync(pointerPath()), 'the pointer');
      expect(readFileSync(pointerPath(), 'utf8').trim()).toBe(normal(data));
      await until(() => shutdown.mock.calls.length > 0, 'the restart');
      expect(shutdown).toHaveBeenCalledWith(75);
    } finally {
      srv.board.shutdown = undefined;
      rmSync(pointerPath(), { force: true });
    }
  });

  it('has no Data folder group when the switch is on This project', async () => {
    await openBoardTab();
    await until(() => page.evaluate(`!!document.querySelector('#data-folder-group')`), 'the Data folder group');
    await page.evaluate(`(() => { const r = document.querySelector('#scope-project'); r.checked = true; r.dispatchEvent(new Event('change')); })()`);
    await until(() => page.evaluate(`!!document.querySelector('${W} .k95-scope-bar[data-file=settings]')`), 'the project view');
    expect(await page.evaluate(`!!document.querySelector('#data-folder-group')`)).toBe(false);
  });
});
