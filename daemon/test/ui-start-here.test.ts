// In headless Edge or Chrome against a running daemon (setup in ui.ts): Settings -> Projects -> Start here saves to the global settings.json.
import './home.ts';
import { readFileSync, rmSync } from 'node:fs';
import { afterAll, expect, it } from 'vitest';
import { globalPath, normal } from '../src/settings.ts';
import { until } from './cdp.ts';
import { base, page, repo } from './ui.ts';

afterAll(() => rmSync(globalPath('settings'), { force: true }));

it('picking a project in Start here saves its path to the global settings.json', { timeout: 60_000 }, async () => {
  await page.goto(base);
  await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
  await page.evaluate(`document.querySelector('[data-icon="Settings"]').dispatchEvent(new MouseEvent('dblclick'))`);
  await page.evaluate(`[...document.querySelectorAll('[data-win="settings"] [role=tab] a')].find((t) => t.textContent === 'Projects').click()`);
  await until(() => page.evaluate(`!!document.querySelector('#startup')`), 'the Start here select');
  expect(await page.evaluate(`document.querySelector('#startup').value`)).toBe('last');
  await page.evaluate(`(() => { const s = document.querySelector('#startup'); s.value = ${JSON.stringify(normal(repo))}; s.dispatchEvent(new Event('change')); })()`);
  await until(() => {
    try {
      return JSON.parse(readFileSync(globalPath('settings'), 'utf8')).startup === normal(repo);
    } catch {
      return false;
    }
  }, 'startup in settings.json');
});
