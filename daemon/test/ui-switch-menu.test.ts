// In headless Edge or Chrome against a running daemon (setup in ui.ts): a right click or Shift+F10 on a Switch board popup row opens
// that project's menu; Escape closes the menu before the popup; a left click still posts open or switch.
import './home.ts';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { writeProjects } from '../src/settings.ts';
import { until } from './cdp.ts';
import { base, click, menuItems, page, repo, rightClick } from './ui.ts';

const other = mkdtempSync(join(tmpdir(), 'k95-switch-'));
execFileSync('git', ['init', '-q'], { cwd: other });
afterAll(() => rmSync(other, { recursive: true, force: true, maxRetries: 5 }));

const has = (sel: string) => page.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(sel)})`);
const key = async (key: string, code: number, modifiers = 0) => {
  for (const type of ['rawKeyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: code, modifiers });
};
const popup = async (hosted: boolean) => {
  await page.evaluate(`(() => {
    window.__posts = [];
    const real = window.__realFetch ??= window.fetch;
    window.fetch = async (url, init = {}) => {
      if (init.method === 'POST' && /\\/api\\/projects\\//.test(url)) { window.__posts.push(url); return new Response('{}', { status: 202 }); }
      const r = await real(url, init);
      if (url !== '/api/projects') return r;
      const j = await r.json();
      j.hosted[${JSON.stringify(other)}] = ${hosted};
      return new Response(JSON.stringify(j), { status: 200 });
    };
  })()`);
  await click('#switch');
  await until(() => has('.k95-switch-row'), 'the popup row');
};
const posts = () => page.evaluate<string[]>('window.__posts');

describe('ui-switch-menu', { timeout: 60_000 }, () => {
  it('right click opens the project menu, Close board only when hosted here', async () => {
    writeProjects([{ path: repo, colour: '#008080' }, { path: other, colour: 120 }], repo);
    await page.goto(base);
    await until(() => has('#switch'), 'the switch button');
    await popup(false);
    await rightClick('.k95-switch-row');
    await until(() => has('.k95-menu'), 'the row menu');
    expect(await menuItems()).toEqual(['Open here', 'Open in new window']);
    await key('Escape', 27);
    expect(await has('.k95-menu')).toBe(false);
    await key('Escape', 27);
    expect(await has('.k95-switch')).toBe(false);

    await popup(true);
    await rightClick('.k95-switch-row');
    await until(() => has('.k95-menu'), 'the row menu');
    expect(await menuItems()).toEqual(['Open here', 'Open in new window', 'Close board']);
    await page.evaluate(`[...document.querySelectorAll('.k95-menu > li')].find((li) => li.textContent === 'Open here').click()`);
    await until(async () => (await posts()).length > 0, 'the switch post');
    expect(await posts()).toEqual(['/api/projects/switch']);
    expect(await has('.k95-switch')).toBe(false);
  });

  it('Shift+F10 on a focused row opens the menu; Escape closes it and keeps the popup', async () => {
    await popup(false);
    expect(await page.evaluate<boolean>(`document.activeElement.classList.contains('k95-switch-row')`)).toBe(true);
    await key('F10', 121, 8);
    await until(() => has('.k95-menu'), 'the row menu');
    expect(await menuItems()).toEqual(['Open here', 'Open in new window']);
    await key('Escape', 27);
    expect(await has('.k95-menu')).toBe(false);
    expect(await has('.k95-switch')).toBe(true);
  });

  it('a left click on a row still posts open', async () => {
    await click('.k95-switch-row');
    await until(async () => (await posts()).length > 0, 'the open post');
    expect(await posts()).toEqual(['/api/projects/open']);
    await page.evaluate('window.fetch = window.__realFetch');
  });
});
