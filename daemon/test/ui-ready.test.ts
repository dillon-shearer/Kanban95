import './home.ts';
import { expect, it } from 'vitest';
import { until } from './cdp.ts';
import { base, click, db, page, statusBar, ticket } from './ui.ts';

it('a not-ready board with a Backlog ticket says "Not ready:" in the status bar, and a click opens the Readiness window', { timeout: 60_000 }, async () => {
  const id = ticket('Waiting to run');
  try {
    await page.goto(base);
    await until(async () => (await statusBar()).startsWith('Not ready:'), 'the Not ready line', 30_000);
    await click('.k95-board .k95-status');
    await until(() => page.evaluate(`document.querySelectorAll('[data-win="readiness"] tr[data-id]').length === 8`), 'the Readiness rows', 30_000);
    const rows = await page.evaluate<string[][]>(`[...document.querySelectorAll('[data-win="readiness"] tr[data-id]')].map((r) => [...r.cells].map((c) => c.textContent))`);
    expect(rows.find((r) => r[0] === 'runner')).toEqual(['runner', 'Not ready', 'Turn the runner on with Run on the Board toolbar (Ctrl+L).']);
    expect(rows.find((r) => r[0] === 'git')).toEqual(['git', 'OK', '']);
    expect(await statusBar()).toBe(`Not ready: ${rows.find((r) => r[1] === 'Not ready')![2]}`);
  } finally {
    db.prepare("UPDATE tickets SET status = 'done', merged_at = 'x' WHERE id = ?").run(id);
  }
});
