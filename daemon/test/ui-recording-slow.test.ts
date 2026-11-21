import './home.ts';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { events } from '../src/lifecycle.ts';
import { globalPath } from '../src/settings.ts';
import { until } from './cdp.ts';
import { base, page } from './ui.ts';

const idle = { state: 'idle', mode: 'regular', started: null, elapsed: 0, speed: 10, slow: 1, progress: null, output: null, error: null, fastStretches: 0 };
const frame = (r: Record<string, unknown>) => events.emit('event', { recording: { ...idle, ...r } });
const button = () => page.evaluate<{ text: string; title: string }>(`(() => { const m = document.getElementById('rec-mode'); return { text: m.lastChild.textContent, title: m.title }; })()`);
const field = () => page.evaluate<string | null>(`document.querySelector('.k95-board .k95-recording')?.textContent ?? null`);
const saved = () => {
  try {
    return JSON.parse(readFileSync(globalPath('settings'), 'utf8'));
  } catch {
    return null;
  }
};
const tab = async () => {
  await page.evaluate(`document.querySelector('[data-icon="Settings"]').dispatchEvent(new MouseEvent('dblclick'))`);
  await until(() => page.evaluate(`!!document.querySelector('[data-win="settings"] [role=tab]')`), 'the Settings tabs');
  await page.evaluate(`document.querySelector('[data-win="settings"] [role=tab] a').click()`);
  await page.evaluate(`[...document.querySelectorAll('[data-win="settings"] [role=tab] a')].find((t) => t.textContent === 'Recording').click()`);
};

beforeAll(async () => {
  mkdirSync(dirname(globalPath('settings')), { recursive: true });
  writeFileSync(globalPath('settings'), JSON.stringify({ recording: { enabled: true } }));
  await page.goto(base);
  await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
});
afterAll(() => {
  frame({});
  rmSync(globalPath('settings'), { force: true });
});

describe('ui-recording-slow', { timeout: 60_000 }, () => {
  it('the tray speed button reads 2x in regular mode when slow is 2, and 1x when slow is 1', async () => {
    const started = new Date().toISOString();
    await until(async () => {
      frame({ state: 'recording', mode: 'regular', started, slow: 2 });
      return (await button()).text === '2x';
    }, 'the 2x button');
    expect((await button()).title).toBe('Regular 2x. Click for fast');
    expect(await field()).toMatch(/^Recording 0:0\d, regular 2x · /);
    await until(async () => {
      frame({ state: 'recording', mode: 'regular', started, slow: 1 });
      return (await button()).text === '1x';
    }, 'the 1x button');
    expect((await button()).title).toBe('Regular speed. Click for fast');
    expect(await field()).toMatch(/^Recording 0:0\d, regular · /);
    frame({});
  });

  it('Settings -> Recording has a Slow speed field that saves recording.slow', async () => {
    await tab();
    await until(() => page.evaluate(`document.querySelector('#rec-slow')?.value === '1'`), 'the Slow speed field at 1');
    expect(await page.evaluate(`document.querySelector('label[for="rec-slow"]').textContent`)).toBe('Slow speed');
    await page.evaluate(`document.querySelector('#rec-slow').value = '2.5'; document.querySelector('#rec-save').click()`);
    await until(() => saved()?.recording?.slow === 2.5, 'recording.slow 2.5 in settings.json');
  });

  it('the Render again box has a Slow field filled from the setting and sends it as slow', async () => {
    await tab();
    await until(() => page.evaluate(`document.querySelector('#rec-render-slow')?.value === '2.5'`), 'the Slow box at 2.5');
    await page.evaluate(`window.k95Sent = null; const f = window.fetch; window.fetch = (u, o) => { if (String(u).endsWith('/recording/render')) window.k95Sent = JSON.parse(o.body); return f(u, o); }`);
    await page.evaluate(`document.querySelector('#rec-raw').value = 'C:/nope/raw.mkv'; document.querySelector('#rec-render-slow').value = '3'; document.querySelector('#rec-render').click()`);
    await until(() => page.evaluate(`!!window.k95Sent`), 'the render request');
    expect(await page.evaluate(`window.k95Sent`)).toEqual({ raw: 'C:/nope/raw.mkv', speed: 10, slow: 3 });
  });
});
