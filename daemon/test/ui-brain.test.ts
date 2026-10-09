// In headless Edge or Chrome against a running daemon (setup in ui.ts): the Brain window.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { describe, expect, it } from 'vitest';
import { until } from './cdp.ts';
import { db, page, base, srv } from './ui.ts';

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

  it('adds a row in the global brain, filters by scope and moves a row to the other brain', async () => {
    const win = `document.querySelector('[data-win="brain"]')`;
    // Each listed row as "scope:title".
    const listed = async () => (await page.evaluate(`[...${win}.querySelectorAll('li.note')].map((l) => l.dataset.scope + ':' + l.querySelector('.note-head').textContent.replace(/^#\\d+ | · .*$/g, ''))`)) as string[];
    const shows = (want: string[]) => async () => JSON.stringify((await listed()).sort()) === JSON.stringify(want);
    const set = (sel: string, v: string) => page.evaluate(`(() => { const el = ${win}.querySelector('${sel}'); el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('change')); })()`);
    const click = (scope: string, label: string) => page.evaluate(`[...${scope}.querySelectorAll('button')].find((b) => b.textContent === '${label}').click()`);
    const global = srv.board.brain;
    db.prepare("INSERT INTO brain (title, body, tags) VALUES ('scope local', 'only this repo', 'scopetest')").run();
    await page.goto(base);
    await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
    await page.evaluate(`document.querySelector('[data-icon="Brain"]').dispatchEvent(new MouseEvent('dblclick'))`);
    await until(() => page.evaluate(`!!${win}?.querySelector('li.note')`), 'the Brain window');

    await set('fieldset input[placeholder="Title"]', 'scope shared');
    await set('fieldset textarea', 'holds in any repo');
    await set('fieldset input[placeholder="tags"]', 'scopetest');
    await set('fieldset select', 'global');
    await click(`${win}.querySelector('fieldset')`, 'Add');
    await until(() => global.prepare("SELECT 1 FROM brain WHERE title = 'scope shared'").get() !== undefined, 'the row in the global brain');
    expect(db.prepare("SELECT 1 FROM brain WHERE title = 'scope shared'").get()).toBeUndefined();

    await set('input[type=search]', 'scopetest');
    await set('.k95-brain-scope', 'global');
    await until(shows(['global:scope shared']), 'only the global row');
    await set('.k95-brain-scope', 'project');
    await until(shows(['project:scope local']), 'only the project row');
    await set('.k95-brain-scope', '');
    await until(shows(['global:scope shared', 'project:scope local']), 'both rows under All');

    // Move the project row to the global brain from its Edit dialog.
    await click(`[...${win}.querySelectorAll('li.note')].find((l) => l.textContent.includes('scope local'))`, 'Edit');
    await until(() => page.evaluate(`!!document.querySelector('dialog select')`), 'the edit dialog');
    await page.evaluate(`(() => { const s = document.querySelector('dialog select'); s.value = 'global'; })()`);
    await click(`document.querySelector('dialog')`, 'Save');
    await until(() => global.prepare("SELECT 1 FROM brain WHERE title = 'scope local'").get() !== undefined, 'the row moved to the global brain');
    expect(db.prepare("SELECT 1 FROM brain WHERE title = 'scope local'").get()).toBeUndefined();
    await until(shows(['global:scope local', 'global:scope shared']), 'both rows listed as global');
  });
});
