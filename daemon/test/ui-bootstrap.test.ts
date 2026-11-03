import './home.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { until } from './cdp.ts';
import { base, click, column, db, page, repo } from './ui.ts';

const shown = (sel: string) => page.evaluate<boolean>(`(() => { const e = document.querySelector('.k95-board ${sel}'); return !!e && !e.hidden; })()`);
const uiJson = () => { try { return JSON.parse(readFileSync(join(repo, '.kanban95', 'ui.json'), 'utf8')); } catch { return {}; } };

it('Start blank hides the empty-board panel, shows the columns and stays after a reload', { timeout: 60_000 }, async () => {
  await page.goto(base);
  await until(() => shown('.k95-empty'), 'the empty-board panel', 30_000);
  const buttons = await page.evaluate<string[]>(`[...document.querySelectorAll('.k95-board .k95-empty button')].map((b) => b.textContent)`);
  expect(buttons).toEqual(['Set up this board', 'Start blank']);
  await click('.k95-board .k95-empty button:nth-of-type(2)');
  await until(async () => !(await shown('.k95-empty')) && (await shown('.k95-columns')), 'the columns', 30_000);
  expect(await page.evaluate<number>(`document.querySelectorAll('.k95-board .k95-columns .col').length`)).toBe(4);
  await until(() => uiJson()['k95.blank'] === true, 'k95.blank in ui.json', 30_000);
  await page.goto(base);
  await until(() => shown('.k95-columns'), 'the columns after reload', 30_000);
  expect(await shown('.k95-empty')).toBe(false);
  expect((db.prepare('SELECT COUNT(*) AS n FROM tickets').get() as { n: number }).n).toBe(0);
  const rest = { ...uiJson() };
  delete rest['k95.blank'];
  writeFileSync(join(repo, '.kanban95', 'ui.json'), JSON.stringify(rest));
});

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
