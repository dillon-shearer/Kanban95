// In headless Edge or Chrome against a running daemon (setup in ui.ts): the Settings window.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { until } from './cdp.ts';
import { page, base, statusBar } from './ui.ts';

describe('ui-settings', { timeout: 60_000 }, () => {
  it('saves preferences from Settings > Prompts and shows a refusal over 16 KB', async () => {
    const file = join(process.env.USERPROFILE!, '.kanban95', 'preferences.md');
    await page.goto(base);
    await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
    await page.evaluate(`document.querySelector('[data-icon="Settings"]').dispatchEvent(new MouseEvent('dblclick'))`);
    await page.evaluate(`[...document.querySelectorAll('[data-win="settings"] [role=tab] a')].find((t) => t.textContent === 'Prompts').click()`);
    await until(() => page.evaluate(`!!document.querySelector('#preferences')`), 'the Prompts tab');
    const save = (text: string) => page.evaluate(`(() => { document.querySelector('#preferences').value = ${JSON.stringify(text)};
      [...document.querySelectorAll('[data-win="settings"] button')].find((b) => b.textContent === 'Save').click(); })()`);
    await save('no em dashes');
    await until(() => existsSync(file) && readFileSync(file, 'utf8') === 'no em dashes', 'preferences.md');
    await save('x'.repeat(16 * 1024 + 1));
    await until(async () => (await statusBar()).includes('over 16 KB'), 'the refusal in the status bar');
    expect(readFileSync(file, 'utf8')).toBe('no em dashes');
    rmSync(file);
  });
});
