import './home.ts';
import { expect, it } from 'vitest';
import { until } from './cdp.ts';
import { base, click, column, db, page } from './ui.ts';

it('an empty board shows the set-up panel; Set up this board fills Backlog and the panel goes', { timeout: 60_000 }, async () => {
  await page.goto(base);
  const panel = () => page.evaluate<string | null>(`(() => { const p = document.querySelector('.k95-board .k95-empty'); return p && !p.hidden ? p.textContent : null; })()`);
  await until(async () => (await panel()) !== null, 'the empty-board panel', 30_000);
  expect(await panel()).toContain('This board is empty');
  expect(await panel()).toContain('Start menu');
  await click('.k95-board .k95-empty button');
  await until(async () => (await panel()) === null, 'the panel to go', 30_000);
  const ids = (db.prepare("SELECT id FROM tickets WHERE tags = 'setup' ORDER BY id").all() as { id: number }[]).map((r) => r.id);
  expect(ids).toHaveLength(4);
  await until(async () => (await column(ids[0])) === 'backlog', 'the first setup card in Backlog', 30_000);
});
