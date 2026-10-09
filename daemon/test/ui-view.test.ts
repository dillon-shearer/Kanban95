// In headless Edge or Chrome against a running daemon (setup in ui.ts): the Board's Filter, Sort and Group.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { describe, expect, it } from 'vitest';
import { until } from './cdp.ts';
import { page, base, ticket, column, click } from './ui.ts';

const key = (key: string, code: string, vk: number, modifiers = 0) =>
  page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, modifiers });
const cards = () => page.evaluate<number[]>(`[...document.querySelectorAll('[data-status="backlog"] .card')].map((el) => Number(el.dataset.id))`);
const legend = () => page.evaluate<string>(`document.querySelector('[data-status="backlog"] legend').textContent`);
const typeFilter = async (text: string) => {
  await page.evaluate(`(() => { const f = document.querySelector('.k95-filter'); f.focus(); f.select(); })()`);
  await page.send('Input.insertText', { text });
};

describe('ui-view', { timeout: 90_000 }, () => {
  it('filters by any field or one field, sorts and groups every column, keeps all three across a reload', async () => {
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

    // Ctrl+F on the focused Board focuses the box; Esc there clears it and leaves the Board open.
    await click(`.card[data-id="${b}"]`);
    await key('f', 'KeyF', 70, 2);
    expect(await page.evaluate<boolean>(`document.activeElement.classList.contains('k95-filter')`)).toBe(true);
    await key('Escape', 'Escape', 27);
    expect(await page.evaluate<string>(`document.querySelector('.k95-filter').value`)).toBe('');
    expect(await page.evaluate<boolean>(`!!document.querySelector('[data-win="board"]')`)).toBe(true);
    await until(async () => (await cards()).length === 4, 'every card back');

    // Effort: max, high, medium (c has none of its own, so it counts as medium, not the default low), low.
    await page.evaluate(`(() => { const s = document.querySelector('.k95-sort'); s.value = 'effort'; s.dispatchEvent(new Event('change')); })()`);
    expect(await cards()).toEqual([b, a, c, d]);

    await page.evaluate(`(() => { const s = document.querySelector('.k95-group'); s.value = 'tag'; s.dispatchEvent(new Event('change')); })()`);
    const groups = `[...document.querySelectorAll('[data-status="backlog"] .cards > *')].map((el) => el.classList.contains('card') ? el.dataset.id : el.textContent)`;
    expect(await page.evaluate<string[]>(groups)).toEqual(['build', String(d), 'docs', String(c), 'ui', String(b), 'untagged', String(a)]);

    await typeFilter('tag:docs');
    await page.goto(base);
    await until(() => column(c), 'the cards after the reload');
    expect(await page.evaluate<string[]>(`[document.querySelector('.k95-filter').value, document.querySelector('.k95-sort').value, document.querySelector('.k95-group').value]`)).toEqual(['tag:docs', 'effort', 'tag']);
    expect(await cards()).toEqual([c]);
    expect(await page.evaluate<string>(`document.querySelector('.k95-view').textContent`)).toBe('Filter: tag:docs · Sort: effort · Group: tag');
    await page.evaluate(`localStorage.removeItem('k95.view')`);
  });
});
