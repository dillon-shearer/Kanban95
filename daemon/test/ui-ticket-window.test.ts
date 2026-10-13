// In headless Edge or Chrome against a running daemon (setup in ui.ts): the Ticket window: attachments and restart.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { until } from './cdp.ts';
import { repo, db, page, base, ticket, column } from './ui.ts';

describe('ui-ticket-window', { timeout: 60_000 }, () => {
  it('attaches a pasted screenshot and a dropped PNG to the Ticket window, with thumbnails, and removes one', async () => {
    const id = ticket('Screenshot me');
    await page.goto(base);
    await until(() => column(id), 'the card');
    await page.evaluate(`document.querySelector('.card[data-id="${id}"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    const win = `[data-win="ticket-${id}"]`;
    await until(() => page.evaluate(`!!document.querySelector('${win} .k95-attachments')`), 'the Ticket window');
    // A 1x1 PNG, as the clipboard hands a screenshot over (Chromium names it image.png).
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const file = (name: string) => `(() => { const d = new DataTransfer(); d.items.add(new File([Uint8Array.from(atob('${png}'), (c) => c.charCodeAt(0))], '${name}', { type: 'image/png' })); return d; })()`;
    await page.evaluate(`document.activeElement?.blur(); document.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: ${file('image.png')} }))`);
    await page.evaluate(`document.querySelector('${win} .window-body').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: ${file('dropped.png')} }))`);

    const dir = join(repo, '.kanban95', 'attachments', String(id));
    await until(() => existsSync(join(dir, 'image.png')) && existsSync(join(dir, 'dropped.png')), 'both files on disk');
    const thumbs = `[...document.querySelectorAll('${win} .k95-attachment img')]`;
    await until(() => page.evaluate(`${thumbs}.length === 2 && ${thumbs}.every((i) => i.complete && i.naturalWidth === 1)`), 'two loaded thumbnails', 5000);

    await page.evaluate(`[...document.querySelectorAll('${win} .k95-attachment')].find((r) => r.textContent.includes('dropped.png')).querySelector('button').click()`);
    await until(() => page.evaluate(`${thumbs}.length === 1`), 'the removed row to go');
    expect(existsSync(join(dir, 'dropped.png'))).toBe(false);
    expect(existsSync(join(dir, 'image.png'))).toBe(true);
  });

  it('Ctrl+R in a focused Ticket window asks to restart a running ticket; the window button too; Cancel starts nothing', async () => {
    const id = ticket('Stuck', { status: 'in_progress' });
    try {
      await page.goto(base);
      await until(() => column(id), 'the card');
      await page.evaluate(`document.querySelector('.card[data-id="${id}"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
      const win = `[data-win="ticket-${id}"]`;
      await until(() => page.evaluate(`!!document.querySelector('${win}')`), 'the Ticket window');
      const confirm = `End the running agent for #${id} and start a new one in the same phase?`;
      const cancel = async () => {
        await until(() => page.evaluate(`!!document.querySelector('dialog[open]')`), 'the Restart confirm');
        expect(await page.evaluate(`document.querySelector('dialog[open]').textContent`)).toContain(confirm);
        await page.evaluate(`[...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === 'Cancel').click()`);
        await until(() => page.evaluate(`!document.querySelector('dialog[open]')`), 'the confirm to close');
      };
      await page.evaluate(`dispatchEvent(new KeyboardEvent('keydown', { key: 'r', ctrlKey: true, bubbles: true }))`);
      await cancel();
      await page.evaluate(`[...document.querySelectorAll('${win} button')].find((b) => b.textContent === 'Restart').click()`);
      await cancel();
      expect(db.prepare('SELECT COUNT(*) AS n FROM runs WHERE ticket_id = ?').get(id)).toEqual({ n: 0 });
    } finally {
      db.prepare("UPDATE tickets SET status = 'done', merged_at = 'x' WHERE id = ?").run(id);
    }
  });
});
