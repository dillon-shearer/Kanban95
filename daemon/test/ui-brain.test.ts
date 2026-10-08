// In headless Edge or Chrome against a running daemon (setup in ui.ts): the Brain window.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { describe, expect, it } from 'vitest';
import { until } from './cdp.ts';
import { db, page, base } from './ui.ts';

describe('ui-brain', { timeout: 60_000 }, () => {
  it('edits and deletes a brain row from the Brain window; the next search shows the change', async () => {
    const id = Number(db.prepare("INSERT INTO brain (title, body, tags) VALUES ('gutter width', 'old fact', 'layout')").run().lastInsertRowid);
    const body = () => db.prepare('SELECT body FROM brain WHERE id = ?').get(id) as { body: string } | undefined;
    const row = `[...document.querySelectorAll('[data-win="brain"] li.note')].find((l) => l.textContent.startsWith('#${id} '))`;
    const button = (scope: string, label: string) => `[...${scope}.querySelectorAll('button')].find((b) => b.textContent === '${label}').click()`;
    await page.goto(base);
    await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
    await page.evaluate(`document.querySelector('[data-icon="Brain"]').dispatchEvent(new MouseEvent('dblclick'))`);
    await until(() => page.evaluate(`!!${row}`), 'the row in the Brain window');

    await page.evaluate(button(row, 'Edit'));
    await until(() => page.evaluate(`!!document.querySelector('dialog textarea')`), 'the edit dialog');
    expect(await page.evaluate(`document.querySelector('dialog textarea').value`)).toBe('old fact');
    await page.evaluate(`document.querySelector('dialog textarea').value = 'new fact'`);
    await page.evaluate(button(`document.querySelector('dialog')`, 'Save'));
    await until(() => body()?.body === 'new fact', 'the edit in the db');
    await until(() => page.evaluate(`${row}?.querySelector('pre').textContent === 'new fact'`), 'the edit in the window');

    await page.evaluate(button(row, 'Delete'));
    await until(() => page.evaluate(`!!document.querySelector('dialog')`), 'the delete confirm');
    await page.evaluate(button(`document.querySelector('dialog')`, 'Delete'));
    await until(() => body() === undefined, 'the row deleted');
    await until(() => page.evaluate(`!${row}`), 'the row gone from the window');
  });
});
