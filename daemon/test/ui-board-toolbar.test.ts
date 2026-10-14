import './home.ts';
import { describe, expect, it } from 'vitest';
import { changed } from '../src/lifecycle.ts';
import { until } from './cdp.ts';
import { srv, db, page, base, click, ticket } from './ui.ts';

const key = async (key: string, code: string, vk: number, modifiers = 0) => {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers, windowsVirtualKeyCode: vk });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers, windowsVirtualKeyCode: vk });
};

describe('ui-board-toolbar', { timeout: 60_000 }, () => {
  it('the Filter box is the last child of the toolbar, after Housekeeping; Ctrl+F focuses it and Esc clears it, the Board stays', async () => {
    const id = ticket('Toolbar filter');
    await page.goto(base);
    await until(() => page.evaluate(`!!document.querySelector('.card[data-id="${id}"]')`), 'the card');
    expect(await page.evaluate(`(() => {
      const f = document.querySelector('.k95-board .k95-filter');
      return [f.parentElement.className, f.previousElementSibling.textContent, f === f.parentElement.lastElementChild, !!f.closest('.status-bar')];
    })()`)).toEqual(['k95-toolbar', 'Housekeeping', true, false]);
    await click(`.card[data-id="${id}"]`);
    await key('f', 'KeyF', 70, 2);
    expect(await page.evaluate(`document.activeElement === document.querySelector('.k95-filter')`)).toBe(true);
    await page.send('Input.insertText', { text: 'zzz' });
    await until(() => page.evaluate(`!document.querySelector('.card[data-id="${id}"]')`), 'the card filtered out');
    await key('Escape', 'Escape', 27);
    expect(await page.evaluate(`document.querySelector('.k95-filter').value`)).toBe('');
    expect(await page.evaluate(`!!document.querySelector('[data-win="board"]')`)).toBe(true);
    await until(() => page.evaluate(`!!document.querySelector('.card[data-id="${id}"]')`), 'the card back');
    db.prepare("UPDATE tickets SET status = 'done', merged_at = 'x' WHERE id = ?").run(id);
  });

  it('at 1000px and 360px with release, not pushed and held all shown, the counts are whole and only last action and runner are cut', async () => {
    const dep = ticket('Dep');
    const held = ticket('Held');
    db.prepare('INSERT INTO ticket_deps VALUES (?, ?)').run(held, dep);
    db.prepare('UPDATE tickets SET blocked_on_deps = 1 WHERE id = ?').run(held);
    srv.board.release = { since: 'v1.2.3', commits: 12 };
    srv.board.unpushed = 34;
    try {
      await page.goto(base);
      await until(() => page.evaluate(`!document.querySelector('.k95-held').hidden && !document.querySelector('.k95-unpushed').hidden
        && !document.querySelector('.k95-release-pending').hidden`), 'the three counts');
      await page.evaluate(`(() => {
        const s = document.querySelector('.k95-status');
        s.textContent = s.title = 'A long last action that cannot fit in what the counts leave of the status bar, '.repeat(3);
      })()`);
      for (const width of [1000, 360]) {
        await page.evaluate(`document.querySelector('[data-win="board"]').style.width = '${width}px'`);
        const cut = await page.evaluate<Record<string, boolean>>(`Object.fromEntries(['k95-status', 'k95-runner', 'k95-release-pending', 'k95-unpushed', 'k95-held']
          .map((c) => { const f = document.querySelector('.' + c); return [c, f.scrollWidth > f.clientWidth]; }))`);
        expect(cut, `${width}px`).toEqual({ 'k95-status': true, 'k95-runner': false, 'k95-release-pending': false, 'k95-unpushed': false, 'k95-held': false });
      }
      expect(await page.evaluate(`document.querySelector('.k95-release-pending').textContent`)).toBe('release: 12 commits');
    } finally {
      srv.board.release = undefined;
      srv.board.unpushed = 0;
      db.prepare(`UPDATE tickets SET status = 'done', merged_at = 'x', blocked_on_deps = 0 WHERE id IN (${dep}, ${held})`).run();
      changed(null);
    }
  });
});
