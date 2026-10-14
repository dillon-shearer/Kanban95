import './home.ts';
import { expect, it } from 'vitest';
import { until } from './cdp.ts';
import { base, db, page, ticket } from './ui.ts';

it('the card shows its level, and the Ticket window sets the level and read-all flag on the row', { timeout: 60_000 }, async () => {
  const id = ticket('Tidy the board', { agent_level: 2 });
  const win = `[data-win="ticket-${id}"]`;
  await page.goto(base);
  await until(() => page.evaluate(`document.querySelector('.card[data-id="${id}"] .badge.level')?.textContent === 'L2'`), 'the L2 badge', 30_000);
  await page.evaluate(`document.querySelector('.card[data-id="${id}"]').dispatchEvent(new MouseEvent('dblclick'))`);
  await until(() => page.evaluate(`!!document.querySelector('${win} .k95-level')`), 'the level select', 30_000);
  expect(await page.evaluate(`[document.querySelector('${win} .k95-level').value, document.querySelector('${win} .k95-read-all').checked]`)).toEqual(['2', false]);
  await page.evaluate(`(() => {
    document.querySelector('${win} .k95-level').value = '3';
    document.querySelector('${win} .k95-read-all').checked = true;
    [...document.querySelectorAll('${win} button')].find((b) => b.textContent === 'Save').click();
  })()`);
  const row = () => db.prepare('SELECT agent_level, read_all FROM tickets WHERE id = ?').get(id) as { agent_level: number; read_all: number };
  await until(async () => row().agent_level === 3, 'the saved level', 30_000);
  expect(row()).toEqual({ agent_level: 3, read_all: 1 });
  await until(() => page.evaluate(`document.querySelector('.card[data-id="${id}"] .badge.level')?.textContent === 'L3'`), 'the L3 badge', 30_000);
});
