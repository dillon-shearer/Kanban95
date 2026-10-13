// In headless Edge or Chrome against a running daemon (setup in ui.ts): the Board's Filter.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { describe, expect, it } from 'vitest';
import { until } from './cdp.ts';
import { page, base, db, ticket, column, click, setUi, uiSaved } from './ui.ts';

const key = (key: string, code: string, vk: number, modifiers = 0) =>
  page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, modifiers });
const cards = () => page.evaluate<number[]>(`[...document.querySelectorAll('[data-status="backlog"] .card')].map((el) => Number(el.dataset.id))`);
const legend = () => page.evaluate<string>(`document.querySelector('[data-status="backlog"] legend').firstChild.textContent`); // without the sort ▾
const typeFilter = async (text: string) => {
  await page.evaluate(`(() => { const f = document.querySelector('.k95-filter'); f.focus(); f.select(); })()`);
  await page.send('Input.insertText', { text });
};

describe('ui-view', { timeout: 90_000 }, () => {
  it('filters by any field or one field from the status bar and keeps the filter across a reload', async () => {
    // From a clean board, so a retry is a real second try and not a count of the first one's cards and filter.
    db.exec('DELETE FROM tickets');
    await setUi('k95.view', undefined);
    // The test home's default execute effort is low and model "work", so "ui" can only come from a title or a tag.
    const a = ticket('Build the UI', { effort: 'high' });
    const b = ticket('Daemon thing', { effort: 'max', tags: 'ui' });
    const c = ticket('Other', { tags: 'docs' });
    const d = ticket('Small one', { effort: 'low', tags: 'build' });
    await page.goto(base);
    await until(() => column(d), 'the cards');
    expect(await legend()).toBe('Backlog (4)');

    // "ui" is in a's title, b's tag and d's tag "build"; c has it nowhere.
    await typeFilter('ui');
    await until(async () => (await cards()).join() === [a, b, d].join(), 'the filtered cards');
    expect(await legend()).toBe('Backlog (3 of 4)');
    await typeFilter('tag:ui');
    await until(async () => (await cards()).join() === String(b), 'only the card tagged ui');
    await typeFilter('UI small');
    await until(async () => (await cards()).join() === String(d), 'every word must match');

    // Ctrl+A selects only what the filter shows.
    await typeFilter('tag:ui');
    await until(async () => (await cards()).join() === String(b), 'only the card tagged ui');
    await click(`.card[data-id="${b}"]`);
    await key('a', 'KeyA', 65, 2);
    expect(await page.evaluate<number[]>(`[...document.querySelectorAll('.card.selected')].map((el) => Number(el.dataset.id))`)).toEqual([b]);

    // Nor a card in a folded column: Done starts folded, and unfolding it shows its card unselected.
    const e = ticket('Shipped ui', { status: 'done', tags: 'ui' });
    await uiSaved('k95.view'); // else the reload can read ui.json before the typed filter reaches it, and Ctrl+A takes every card
    await page.goto(base);
    await until(() => column(b), 'the cards after the reload');
    await click(`.card[data-id="${b}"]`);
    await key('a', 'KeyA', 65, 2);
    await page.evaluate(`document.querySelector('[data-status="done"] legend').click()`);
    await until(() => column(e), 'the unfolded Done column');
    expect(await page.evaluate<number[]>(`[...document.querySelectorAll('.card.selected')].map((el) => Number(el.dataset.id))`)).toEqual([b]);
    await page.evaluate(`document.querySelector('[data-status="done"] legend').click()`);

    // Ctrl+F on the focused Board focuses the box; Esc there clears it and leaves the Board open.
    await click(`.card[data-id="${b}"]`);
    await key('f', 'KeyF', 70, 2);
    expect(await page.evaluate<boolean>(`document.activeElement.classList.contains('k95-filter')`)).toBe(true);
    await key('Escape', 'Escape', 27);
    expect(await page.evaluate<string>(`document.querySelector('.k95-filter').value`)).toBe('');
    expect(await page.evaluate<boolean>(`!!document.querySelector('[data-win="board"]')`)).toBe(true);
    await until(async () => (await cards()).length === 4, 'every card back');

    // The box is in the status bar, not the toolbar, and it alone shows the filter: no "Filter: …" status text.
    expect(await page.evaluate<boolean>(`!!document.querySelector('.k95-board .status-bar .k95-filter') && !document.querySelector('.k95-toolbar input, .k95-toolbar select')`)).toBe(true);
    await typeFilter('tag:docs');
    await uiSaved('k95.view');
    await page.goto(base);
    await until(() => column(c), 'the cards after the reload');
    expect(await page.evaluate<string>(`document.querySelector('.k95-filter').value`)).toBe('tag:docs');
    expect(await cards()).toEqual([c]);
    expect(await page.evaluate<string>(`document.querySelector('.k95-board .status-bar').textContent`)).not.toContain('Filter:');
    await setUi('k95.view', undefined);
  });
});
