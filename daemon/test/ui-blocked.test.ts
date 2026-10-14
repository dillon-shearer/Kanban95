import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { expect, it } from 'vitest';
import { until } from './cdp.ts';
import { base, click, db, menuItems, menuPick, page, rightClick, ticket } from './ui.ts';

const ADD = process.platform === 'darwin' ? 4 : 2; // CDP modifiers: 4 Meta (Cmd), 2 Ctrl
const blocked = (id: number) => (db.prepare('SELECT blocked FROM tickets WHERE id = ?').get(id) as { blocked: number }).blocked;
const badges = (id: number) => page.evaluate<string[]>(`[...document.querySelectorAll('.card[data-id="${id}"] .badge')].map((b) => b.className)`);

it('Block and Unblock on several cards at once, from the Ticket window, and is:blocked in the filter', { timeout: 60_000 }, async () => {
  const [a, b, c] = [ticket('First'), ticket('Second'), ticket('Third', { needs_human: 1 })];
  await page.goto(base);
  await until(() => page.evaluate(`!!document.querySelector('.card[data-id="${c}"]')`), 'the cards');

  await click(`.card[data-id="${a}"]`);
  await click(`.card[data-id="${b}"]`, ADD);
  await rightClick(`.card[data-id="${b}"]`);
  expect(await menuItems()).toEqual(expect.arrayContaining(['Block', 'Unblock']));
  await menuPick('Block');
  await until(() => blocked(a) && blocked(b), 'both Blocked');
  expect(blocked(c)).toBe(0);
  await until(async () => (await badges(a)).includes('badge blocked'), 'the Blocked badge');
  expect(await badges(c)).toContain('badge flag');
  expect(await badges(c)).not.toContain('badge blocked');

  await page.evaluate(`(() => {
    const f = document.querySelector('.k95-filter');
    f.value = 'is:blocked';
    f.dispatchEvent(new Event('input'));
  })()`);
  await until(() => page.evaluate(`!document.querySelector('.card[data-id="${c}"]')`), 'the unblocked card filtered out');
  expect(await page.evaluate(`[...document.querySelectorAll('.card')].map((x) => Number(x.dataset.id)).sort()`)).toEqual([a, b]);

  const win = `[data-win="ticket-${a}"]`;
  const button = () => page.evaluate<string | null>(`document.querySelector('${win} .k95-block')?.textContent ?? null`);
  await page.evaluate(`document.querySelector('.card[data-id="${a}"]').dispatchEvent(new MouseEvent('dblclick'))`);
  await until(async () => (await button()) === 'Unblock', 'the Unblock button');
  await page.evaluate(`document.querySelector('${win} .k95-block').click()`);
  await until(() => !blocked(a), 'a unblocked');
  await until(async () => (await button()) === 'Block', 'the button turned to Block');
  expect(blocked(b)).toBe(1);

  await page.evaluate(`(() => {
    const f = document.querySelector('.k95-filter');
    f.value = '';
    f.dispatchEvent(new Event('input'));
  })()`);
  db.prepare(`UPDATE tickets SET status = 'done', merged_at = 'x', blocked = 0, needs_human = 0 WHERE id IN (${a}, ${b}, ${c})`).run();
});
