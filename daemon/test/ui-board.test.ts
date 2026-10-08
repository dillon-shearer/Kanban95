// In headless Edge or Chrome against a running daemon (setup in ui.ts): the Board window: drag and drop, redraws, launch refusals and the runner button.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { until } from './cdp.ts';
import { repo, srv, db, page, base, git, ticket, statusOf, column, statusBar, click } from './ui.ts';

describe('ui-board', { timeout: 60_000 }, () => {
  it('snaps an illegal drop back and names the allowed targets; a legal drop moves the card without a reload', async () => {
    const id = ticket('Drag me');
    await page.goto(base);
    await until(() => column(id), 'the card');
    await page.evaluate('window.__noReload = true');

    await page.drag(await page.center(`.card[data-id="${id}"]`), await page.center('[data-status="testing"] .cards'));
    await until(async () => (await statusBar()).includes('cannot be dragged'), 'the status-bar message');
    expect(await statusBar()).toBe(`#${id} cannot be dragged from Backlog to Testing. Allowed: In Progress.`);
    expect(await column(id)).toBe('backlog');
    expect(statusOf(id)).toBe('backlog');

    await page.drag(await page.center(`.card[data-id="${id}"]`), await page.center('[data-status="in_progress"] .cards'));
    await until(async () => (await column(id)) === 'in_progress', 'the card in In Progress');
    expect(statusOf(id)).toBe('in_progress');
    expect(await page.evaluate('window.__noReload')).toBe(true);
    db.prepare("UPDATE tickets SET status = 'done', merged_at = 'x' WHERE id = ?").run(id); // out of the way of the next tests
  });

  it('keeps column scroll and the focused card across an event redraw', async () => {
    const ids = Array.from({ length: 30 }, (_, i) => ticket(`Long ${i}`));
    const last = ids.at(-1)!;
    try {
      await page.goto(base);
      await until(() => column(last), 'the cards');
      const top = await page.evaluate<number>(`(() => { const c = document.querySelector('[data-status="backlog"] .cards'); c.scrollTop = c.scrollHeight; document.querySelector('.card[data-id="${last}"]').focus(); return c.scrollTop; })()`);
      expect(top).toBeGreaterThan(0);
      await page.evaluate(`fetch('/api/tickets/${ids[0]}', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Renamed' }) })`);
      await until(() => page.evaluate<boolean>(`document.querySelector('.card[data-id="${ids[0]}"]').textContent.includes('Renamed')`), 'the redraw');
      expect(await page.evaluate<number>(`document.querySelector('[data-status="backlog"] .cards').scrollTop`)).toBe(top);
      expect(await page.evaluate<string>(`document.activeElement.dataset.id`)).toBe(String(last));
    } finally {
      for (const id of ids) db.prepare("UPDATE tickets SET status = 'done', merged_at = 'x' WHERE id = ?").run(id);
    }
  });

  it('names the reason in the status bar when a launch is refused, not "launched"', async () => {
    const id = ticket('Refused');
    await page.goto(base);
    await until(() => column(id), 'the card');
    writeFileSync(join(repo, 'a.txt'), 'dirty\n'); // the board refuses to launch from a dirty base
    try {
      await click(`.card[data-id="${id}"]`);
      await page.evaluate(`[...document.querySelectorAll('.k95-board button')].find((b) => b.textContent === 'Launch').click()`);
      await until(async () => (await statusBar()).startsWith(`#${id} needs you:`), 'the reason in the status bar');
      await new Promise((r) => setTimeout(r, 300)); // a late "launched" would land here
      expect(await statusBar()).toMatch(new RegExp(`^#${id} needs you: launch failed: base branch main has uncommitted changes`));
    } finally {
      git('checkout', 'a.txt');
      db.prepare("UPDATE tickets SET status = 'done', merged_at = 'x' WHERE id = ?").run(id);
    }
  });

  it('Run and Ctrl+L toggle the runner; the button and its status line redraw from /events; it says when it stopped itself', async () => {
    db.prepare("UPDATE tickets SET status = 'done', merged_at = coalesce(merged_at, 'x'), needs_human = 0").run(); // earlier tests' leftovers
    const id = ticket('Run me');
    const button = `[...document.querySelectorAll('.k95-toolbar button')].find((b) => b.title === 'Ctrl+L')`;
    const label = () => page.evaluate<string>(`${button}.textContent`);
    const line = () => page.evaluate<string>(`document.querySelector('.k95-runner').textContent`);
    await page.goto(base);
    await until(() => column(id), 'the card');
    await page.evaluate('window.__noReload = true');
    expect(await label()).toBe('Run');

    await page.evaluate(`${button}.click()`);
    await until(async () => (await line()) === `Running: #${id} (0 of 0 candidates left)`, 'the running line');
    expect(await label()).toBe('Stop');
    // Stopped from outside the page: only /events can tell it.
    await fetch(`${base}api/runner`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie: `k95=${srv.secret}` }, body: '{"on":false}' });
    await until(async () => (await label()) === 'Run', 'the button back to Run');
    expect(await line()).toBe('');

    await fetch(`${base}api/tickets/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: `k95=${srv.secret}` }, body: '{"status":"backlog"}' }); // stops its agent
    db.prepare("UPDATE tickets SET status = 'done', merged_at = 'x' WHERE id = ?").run(id);
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'l', code: 'KeyL', modifiers: 2, windowsVirtualKeyCode: 76 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'l', code: 'KeyL', modifiers: 2, windowsVirtualKeyCode: 76 });
    await until(async () => (await line()) === 'Runner stopped: nothing left to launch', 'the stopped line');
    expect(await label()).toBe('Run');
    expect(await page.evaluate('window.__noReload')).toBe(true);
  });
});
