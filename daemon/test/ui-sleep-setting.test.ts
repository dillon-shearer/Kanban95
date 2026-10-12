import './home.ts';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { until } from './cdp.ts';
import { projectPath } from '../src/settings.ts';
import { page, base, repo } from './ui.ts';

const globalFile = () => join(process.env.KANBAN95_HOME!, 'settings.json');
const ownFile = () => projectPath('settings', repo);
const W = '[data-win="settings"]';
const read = (f: string) => JSON.parse(readFileSync(f, 'utf8'));
const bar = () => page.evaluate<string | null>(`document.querySelector('${W} .k95-scope-bar[data-file=settings] button')?.textContent ?? null`);
const field = () => page.evaluate<string>(`document.querySelector('#sleep-after').value`);
const saveSleep = (n: number) => page.evaluate(`(() => { const f = document.querySelector('#sleep-after'); f.value = '${n}'; f.closest('fieldset').querySelector('button').click(); })()`);

describe('ui-sleep-setting', { timeout: 60_000 }, () => {
  afterEach(() => { for (const f of [globalFile(), ownFile()]) rmSync(f, { force: true }); });

  it('Settings -> Board shows sleepAfterMinutes and saves it to the global file and to a project copy', async () => {
    await page.goto(base);
    await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
    await page.evaluate(`document.querySelector('[data-icon="Settings"]').dispatchEvent(new MouseEvent('dblclick'))`);
    await until(() => page.evaluate(`!!document.querySelector('#scope-project')`), 'the switch');
    await page.evaluate(`[...document.querySelectorAll('${W} [role=tab] a')].find((t) => t.textContent === 'Board').click()`);
    await until(() => page.evaluate(`!!document.querySelector('#sleep-after')`), 'the sleep field');
    expect(await field()).toBe('30');
    await saveSleep(45);
    await until(() => { try { return read(globalFile()).sleepAfterMinutes === 45; } catch { return false; } }, 'the global value');

    await page.evaluate(`(() => { const r = document.querySelector('#scope-project'); r.checked = true; r.dispatchEvent(new Event('change')); })()`);
    await until(async () => (await bar()) === 'Customize for this project', 'the Customize button');
    await page.evaluate(`document.querySelector('${W} .k95-scope-bar[data-file=settings] button').click()`);
    await until(async () => (await bar()) === 'Use the global settings again', 'the project copy');
    expect(await field()).toBe('45');
    await saveSleep(0);
    await until(() => { try { return read(ownFile()).sleepAfterMinutes === 0; } catch { return false; } }, 'the project value');
    expect(read(globalFile()).sleepAfterMinutes).toBe(45);
  });
});
