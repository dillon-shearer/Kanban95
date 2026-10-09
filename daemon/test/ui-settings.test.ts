// In headless Edge or Chrome against a running daemon (setup in ui.ts): the Settings window.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { until } from './cdp.ts';
import { srv, db, page, base, repo, ticket, statusBar } from './ui.ts';

describe('ui-settings', { timeout: 60_000 }, () => {
  it('shows the five tabs in order, marks the selected one bold and joined to its panel, and moves the mark when the tab changes', async () => {
    await page.goto(base);
    await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
    await page.evaluate(`document.querySelector('[data-icon="Settings"]').dispatchEvent(new MouseEvent('dblclick'))`);
    await until(() => page.evaluate(`!!document.querySelector('[data-win="settings"] [role=tab]')`), 'the Settings tabs');
    expect(await page.evaluate(`[...document.querySelectorAll('[data-win="settings"] [role=tab]')].map((t) => t.textContent)`))
      .toEqual(['Agents', 'Prompts', 'Board', 'Projects', 'Grants']);
    // Per tab: [name, bold, bottom edge reaches past the panel's top border]
    const look = () => page.evaluate<[string, boolean, boolean][]>(`(() => {
      const panel = document.querySelector('[data-win="settings"] [role=tabpanel]').getBoundingClientRect();
      return [...document.querySelectorAll('[data-win="settings"] [role=tab]')].map((t) => [t.textContent,
        Number(getComputedStyle(t).fontWeight) >= 700, t.getBoundingClientRect().bottom >= panel.top + 2]);
    })()`);
    await page.evaluate(`[...document.querySelectorAll('[data-win="settings"] [role=tab] a')].find((t) => t.textContent === 'Grants').click()`);
    await until(async () => (await look()).some(([n, b]) => n === 'Grants' && b), 'Grants marked');
    for (const [n, bold, joined] of await look()) expect([n, bold, joined]).toEqual([n, n === 'Grants', n === 'Grants']);
    await page.evaluate(`[...document.querySelectorAll('[data-win="settings"] [role=tab] a')].find((t) => t.textContent === 'Board').click()`);
    for (const [n, bold, joined] of await look()) expect([n, bold, joined]).toEqual([n, n === 'Board', n === 'Board']);
  });

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

  it('shows, saves, refuses and resets a template from Settings > Prompts', async () => {
    const file = join(repo, '.kanban95', 'templates', 'test.md');
    const shipped = readFileSync(join(import.meta.dirname, '../../templates/test.md'), 'utf8');
    const click = (label: string) => page.evaluate(`[...document.querySelectorAll('[data-win="settings"] button')].filter((b) => b.textContent === '${label}').at(-1).click()`);
    const text = () => page.evaluate<string>(`document.querySelector('#template-text').value`);
    await page.goto(base);
    await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
    // Settings opens on Agents; hold its /api/models answer until Prompts has drawn, so that late draw must not replace the editor.
    await page.evaluate(`(() => { const f = window.fetch; window.fetch = (u, o) => String(u).endsWith('/api/models')
      ? new Promise((r) => { window.releaseModels = () => { const p = f(u, o); r(p); return p.then((x) => x.clone().text()); }; }) : f(u, o); })()`);
    await page.evaluate(`document.querySelector('[data-icon="Settings"]').dispatchEvent(new MouseEvent('dblclick'))`);
    await page.evaluate(`[...document.querySelectorAll('[data-win="settings"] [role=tab] a')].find((t) => t.textContent === 'Prompts').click()`);
    await until(() => page.evaluate(`!!document.querySelector('#template-text')`), 'the template editor');
    await page.evaluate(`window.releaseModels().then(() => new Promise((r) => setTimeout(r, 100)))`);
    expect(await page.evaluate(`!!document.querySelector('#template-text')`)).toBe(true);
    expect(await page.evaluate<string>(`document.querySelector('#template-vars').textContent`)).toContain('{{ticket}}');
    await page.evaluate(`(() => { const s = document.querySelector('#template'); s.value = 'test'; s.dispatchEvent(new Event('change')); })()`);
    expect(await text()).toBe(shipped);

    await page.evaluate(`document.querySelector('#template-text').value = 'mine {{ticket}}'`);
    await click('Save');
    await until(() => readFileSync(file, 'utf8') === 'mine {{ticket}}', 'test.md saved');
    const marked = () => page.evaluate<[boolean, string]>(`[document.querySelector('#template-stale').hidden, document.querySelector('#template').selectedOptions[0].textContent]`);
    await until(async () => (await marked())[0] === false, 'the differs-from-default mark');
    expect(await marked()).toEqual([false, 'test (differs from default)']);
    await page.evaluate(`document.querySelector('#template-text').value = 'bad {{nope}}'`);
    await click('Save');
    await until(async () => (await statusBar()).includes('{{nope}}'), 'the refusal in the status bar');
    expect(readFileSync(file, 'utf8')).toBe('mine {{ticket}}');

    await click('Reset to default');
    await until(async () => (await text()) === shipped, 'the default in the editor');
    expect(readFileSync(file, 'utf8')).toBe(shipped);
    expect(await marked()).toEqual([true, 'test']);
  });

  it('Settings > Agents sets the runner concurrency; the status line shows the limit and who waits on shared files', async () => {
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
      await page.evaluate(`[...document.querySelectorAll('[data-win="settings"] [role=tab] a')].find((t) => t.textContent === 'Agents').click()`);
      await until(() => page.evaluate(`!!document.querySelector('#concurrency')`), 'the Agents tab');
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

  it('Settings > Agents shows idle_minutes at its default of 20 and saves a new value to settings.json', async () => {
    const file = join(process.env.USERPROFILE!, '.kanban95', 'settings.json');
    rmSync(file, { force: true });
    await page.goto(base);
    await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
    await page.evaluate(`document.querySelector('[data-icon="Settings"]').dispatchEvent(new MouseEvent('dblclick'))`);
    await page.evaluate(`[...document.querySelectorAll('[data-win="settings"] [role=tab] a')].find((t) => t.textContent === 'Agents').click()`);
    await until(() => page.evaluate(`!!document.querySelector('#idle-minutes')`), 'the Agents tab');
    expect(await page.evaluate(`document.querySelector('#idle-minutes').value`)).toBe('20');
    await page.evaluate(`(() => { const f = document.querySelector('#idle-minutes'); f.value = '35'; f.closest('fieldset').querySelector('button').click(); })()`);
    await until(() => existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).idle_minutes === 35, 'the saved idle_minutes');
    rmSync(file, { force: true });
  });
});
