import './home.ts';
import { afterEach, describe, expect, it } from 'vitest';
import { until } from './cdp.ts';
import { VERSION } from '../src/update.ts';
import { base, db, menuItems, page, srv, ticket } from './ui.ts';

const q = <T>(js: string) => page.evaluate<T>(js);
const hold = async (ms: number): Promise<{ identifier: string }> => {
  await page.send('Page.enable');
  return page.send('Page.addScriptToEvaluateOnNewDocument', { source: `{
  const f = window.fetch;
  window.fetch = (url, ...a) => /^\\/api\\/(update|config\\/models)(\\?|$)/.test(url)
    ? new Promise((r) => setTimeout(r, ${ms})).then(() => f(url, ...a)) : f(url, ...a);
  new MutationObserver((_, o) => {
    if (!document.querySelector('[data-win="board"] .card')) return;
    window.__paint = performance.now();
    o.disconnect();
  }).observe(document, { childList: true, subtree: true });
}` });
};
const modelBadge = (id: number) => q<string | null>(`document.querySelector('.card[data-id="${id}"] .badge')?.textContent ?? null`);
const dialog = () => q<boolean>(`!!document.querySelector('#update-dialog[open]')`);

describe('ui-first-paint', { timeout: 60_000 }, () => {
  let script: string | undefined;
  afterEach(async () => {
    if (script) await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: script });
    script = undefined;
    srv.board.update = undefined;
    db.exec('DELETE FROM tickets');
  });

  it('draws the Board with its cards while /update and models are held, then fills in the version and model names', async () => {
    const id = ticket('Draw me first');
    script = (await hold(3000)).identifier;
    await page.goto(base);
    await until(() => q(`!!window.__paint`), 'the board with its cards');
    expect(await q<number>('window.__paint')).toBeLessThan(1000);
    expect(await modelBadge(id)).toBe('no model');
    await q(`document.getElementById('start').click()`);
    expect(await menuItems()).toContain('Kanban95');

    await until(async () => (await modelBadge(id)) === 'work', 'the model name on the card');
    await q(`document.getElementById('start').click()`);
    await until(async () => (await menuItems()).includes(`Kanban95 v${VERSION}`), 'the version in the Start menu');
    expect(page.logs.some((l) => /^First paint: \d+ ms$/.test(l))).toBe(true);
  });

  it('opens the update offer dialog when /update answers after the first paint', async () => {
    ticket('Board before the offer');
    srv.board.update = { state: 'available', version: '9.0.0', current: VERSION } as typeof srv.board.update;
    script = (await hold(1500)).identifier;
    await page.goto(base);
    await until(() => q(`!!window.__paint`), 'the board with its cards');
    expect(await dialog()).toBe(false);
    await until(dialog, 'the update dialog');
  });
});
