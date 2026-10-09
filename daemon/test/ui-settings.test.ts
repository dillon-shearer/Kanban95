// In headless Edge or Chrome against a running daemon (setup in ui.ts): the Settings window.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { until } from './cdp.ts';
import { srv, db, page, base, ticket, statusBar } from './ui.ts';

describe('ui-settings', { timeout: 60_000 }, () => {
  it('saves preferences from Settings > Prompts and shows a refusal over 16 KB', async () => {
    const file = join(process.env.USERPROFILE!, '.kanban95', 'preferences.md');
    await page.goto(base);
    await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
    await page.evaluate(`document.querySelector('[data-icon="Settings"]').dispatchEvent(new MouseEvent('dblclick'))`);
    await page.evaluate(`[...document.querySelectorAll('[data-win="settings"] [role=tab] a')].find((t) => t.textContent === 'Prompts').click()`);
    await until(() => page.evaluate(`!!document.querySelector('#preferences')`), 'the Prompts tab');
    const save = (text: string) => page.evaluate(`(() => { document.querySelector('#preferences').value = ${JSON.stringify(text)};
      [...document.querySelectorAll('[data-win="settings"] button')].find((b) => b.textContent === 'Save').click(); })()`);
    await save('no em dashes');
    await until(() => existsSync(file) && readFileSync(file, 'utf8') === 'no em dashes', 'preferences.md');
    await save('x'.repeat(16 * 1024 + 1));
    await until(async () => (await statusBar()).includes('over 16 KB'), 'the refusal in the status bar');
    expect(readFileSync(file, 'utf8')).toBe('no em dashes');
    rmSync(file);
  });

  it('Settings > General sets the runner concurrency; the status line shows the limit and who waits on shared files', async () => {
    db.prepare("UPDATE tickets SET status = 'done', merged_at = coalesce(merged_at, 'x'), needs_human = 0").run(); // earlier tests' leftovers
    const a = ticket('Edits a', { status: 'in_progress', body: 'Change `a.txt`.' }); // counted as running; no agent needed
    const b = ticket('Also edits a', { body: 'a.txt too' });
    const runnerApi = (body?: unknown) => fetch(`${base}api/runner`, { method: body ? 'PUT' : 'GET', headers: { 'content-type': 'application/json', cookie: `k95=${srv.secret}` }, body: body && JSON.stringify(body) }).then((r) => r.json());
    const line = () => page.evaluate<string>(`document.querySelector('.k95-runner').textContent`);
    try {
      await page.goto(base);
      await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
      await page.evaluate('window.__noReload = true');
      await page.evaluate(`document.querySelector('[data-icon="Settings"]').dispatchEvent(new MouseEvent('dblclick'))`);
      await page.evaluate(`[...document.querySelectorAll('[data-win="settings"] [role=tab] a')].find((t) => t.textContent === 'General').click()`);
      await until(() => page.evaluate(`!!document.querySelector('#concurrency')`), 'the General tab');
      expect(await page.evaluate(`document.querySelector('label[for=concurrency]').textContent`)).toBe('Tickets running at once');
      await page.evaluate(`(() => { const f = document.querySelector('#concurrency'); f.value = '1'; f.closest('fieldset').querySelector('button').click(); })()`);
      await until(async () => (await runnerApi()).concurrency === 1, 'the saved concurrency');
      await runnerApi({ on: true });
      await until(async () => (await line()) === `Running: #${a} (1 of 1; 1 of 1 candidates left); #${b} waits: shares files with #${a}`, 'the limit and the deferral');
      expect(await page.evaluate('window.__noReload')).toBe(true);
    } finally {
      await runnerApi({ on: false, concurrency: 3 });
      db.prepare("UPDATE tickets SET status = 'done', merged_at = 'x' WHERE id IN (?, ?)").run(a, b);
    }
  });
});
