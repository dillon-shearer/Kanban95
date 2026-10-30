import './home.ts';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { globalPath } from '../src/settings.ts';
import { until } from './cdp.ts';
import { base, page } from './ui.ts';

const fake = join(homedir(), 'ffmpeg.txt');

const saved = () => {
  try {
    return JSON.parse(readFileSync(globalPath('settings'), 'utf8'));
  } catch {
    return null;
  }
};

beforeAll(() => {
  writeFileSync(fake, 'not a program');
  mkdirSync(dirname(globalPath('settings')), { recursive: true });
  writeFileSync(globalPath('settings'), JSON.stringify({ recording: { ffmpeg: fake } }));
});
afterAll(() => rmSync(globalPath('settings'), { force: true }));

describe('ui-settings-recording', { timeout: 60_000 }, () => {
  it('puts the Recording tab between Board and Projects', async () => {
    await page.goto(base);
    await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
    await page.evaluate(`document.querySelector('[data-icon="Settings"]').dispatchEvent(new MouseEvent('dblclick'))`);
    await until(() => page.evaluate(`!!document.querySelector('[data-win="settings"] [role=tab]')`), 'the Settings tabs');
    const names = await page.evaluate<string[]>(`[...document.querySelectorAll('[data-win="settings"] [role=tab] a')].map((t) => t.textContent)`);
    expect(names.slice(names.indexOf('Board'), names.indexOf('Board') + 3)).toEqual(['Board', 'Recording', 'Projects']);
  });

  it('says not found for an ffmpeg path that does not exist', async () => {
    await page.evaluate(`[...document.querySelectorAll('[data-win="settings"] [role=tab] a')].find((t) => t.textContent === 'Recording').click()`);
    await until(() => page.evaluate(`!!document.querySelector('#rec-found')?.textContent`), 'the ffmpeg line');
    expect(await page.evaluate(`document.querySelector('#rec-found').textContent`)).toBe('not found');
  });

  it('writes recording.speed 12 to settings.json on Save', async () => {
    await page.evaluate(`document.querySelector('#rec-speed').value = '12'; document.querySelector('#rec-save').click()`);
    await until(() => saved()?.recording?.speed === 12, 'recording.speed 12 in settings.json');
    expect(saved().recording.ffmpeg).toBe(fake);
  });

  it('Render again has a speed box filled with the saved Fast speed and posts its value as speed', async () => {
    await page.evaluate(`document.querySelector('[data-win="settings"] [role=tab] a').click()`);
    await page.evaluate(`[...document.querySelectorAll('[data-win="settings"] [role=tab] a')].find((t) => t.textContent === 'Recording').click()`);
    await until(() => page.evaluate(`document.querySelector('#rec-render-speed')?.value === '12'`), 'the speed box at 12');
    await page.evaluate(`window.k95Sent = null; const f = window.fetch; window.fetch = (u, o) => { if (String(u).endsWith('/recording/render')) window.k95Sent = JSON.parse(o.body); return f(u, o); }`);
    await page.evaluate(`document.querySelector('#rec-raw').value = 'C:/nope/raw.mkv'; document.querySelector('#rec-render-speed').value = '3'; document.querySelector('#rec-render').click()`);
    await until(() => page.evaluate(`!!window.k95Sent`), 'the render request');
    expect(await page.evaluate(`window.k95Sent`)).toEqual({ raw: 'C:/nope/raw.mkv', speed: 3 });
  });
});
