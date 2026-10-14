// In headless Edge or Chrome against a running daemon (setup in ui.ts): selecting several cards and taskbar buttons with the
// platform's add-to-selection key, Cmd on macOS (where Ctrl+click is a right click) and Ctrl elsewhere.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { describe, expect, it } from 'vitest';
import { until } from './cdp.ts';
import { db, page, base, ticket, column, click } from './ui.ts';

const ADD = process.platform === 'darwin' ? 4 : 2; // CDP modifiers: 4 Meta (Cmd), 2 Ctrl

describe('ui-multiselect', { timeout: 60_000 }, () => {
  it('the add key toggles a card in and out of the Board selection', async () => {
    const [a, b] = [ticket('First'), ticket('Second')];
    await page.goto(base);
    await until(async () => (await column(a)) && (await column(b)), 'the cards');
    const selected = () => page.evaluate<number[]>(`[...document.querySelectorAll('.card.selected')].map((c) => Number(c.dataset.id))`);

    await click(`.card[data-id="${a}"]`);
    await click(`.card[data-id="${b}"]`, ADD);
    expect((await selected()).sort()).toEqual([a, b].sort());
    await click(`.card[data-id="${a}"]`, ADD);
    expect(await selected()).toEqual([b]);
    await click(`.card[data-id="${a}"]`);
    expect(await selected()).toEqual([a]);
    db.prepare(`UPDATE tickets SET status = 'done', merged_at = 'x' WHERE id IN (${a}, ${b})`).run();
  });

  it('the add key toggles a taskbar button in and out of the selection', async () => {
    await page.goto(base);
    await click('[data-pin="Inbox"]');
    await click('[data-pin="Brain"]');
    await until(() => page.evaluate(`document.querySelectorAll('#tasks [data-task]').length >= 3`), 'three windows');
    const ids = await page.evaluate<string[]>(`[...document.querySelectorAll('#tasks [data-task]')].map((b) => b.dataset.task)`);
    const selected = () => page.evaluate<string[]>(`[...document.querySelectorAll('#tasks [data-task].selected')].map((b) => b.dataset.task)`);
    const at = (id: string) => `#tasks [data-task="${id}"]`;

    await click(at(ids[0]), ADD);
    await click(at(ids[2]), ADD);
    expect(await selected()).toEqual([ids[0], ids[2]]);
    await click(at(ids[0]), ADD);
    expect(await selected()).toEqual([ids[2]]);
    expect(await page.evaluate(`!!document.querySelector('.k95-menu')`)).toBe(false);
  });
});
