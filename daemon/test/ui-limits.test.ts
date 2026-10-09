// In headless Edge or Chrome against a running daemon (setup in ui.ts): usage limits in the tray and Settings > Limits.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { describe, expect, it } from 'vitest';
import { until } from './cdp.ts';
import { page, base, limitCalls } from './ui.ts';

describe('ui-limits', { timeout: 60_000 }, () => {
  it('shows the most constrained limit in the tray; a click opens Settings > Limits, whose Refresh asks the CLIs again', async () => {
    await page.goto(base);
    const tray = () => page.evaluate<string>(`document.querySelector('#limits').textContent`);
    await until(async () => /^Claude \d+%$/.test(await tray()), 'the tray limit');
    const before = limitCalls;
    await page.evaluate(`document.querySelector('#limits').click()`);
    const panel = `document.querySelector('[data-win="settings"] [role=tabpanel]')`;
    await until(() => page.evaluate(`${panel}?.textContent.includes('Current session')`), 'Settings > Limits');
    expect(await page.evaluate(`document.querySelector('[data-win="settings"] [aria-selected=true]').textContent`)).toBe('Limits');
    expect(await page.evaluate(`${panel}.querySelector('[data-cli="codex"]').textContent`)).toContain('Not available: codex app-server could not start: ENOENT');
    await page.evaluate(`[...${panel}.querySelectorAll('button')].find((b) => b.textContent === 'Refresh').click()`);
    await until(async () => limitCalls === before + 1 && (await tray()) === `Claude ${62 + before}%`, 'the refreshed limit');
    expect(await page.evaluate(`${panel}.querySelector('[data-cli="claude"] td:nth-child(2)').textContent`)).toBe(`${62 + before}%`);
  });
});
