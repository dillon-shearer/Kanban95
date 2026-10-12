// In headless Edge or Chrome against a running daemon (setup in ui.ts): a ticket window opened before the page's cache has its ticket.
import './home.ts';
import { describe, expect, it } from 'vitest';
import { until } from './cdp.ts';
import { events } from '../src/lifecycle.ts';
import { db, page, base, ticket, click } from './ui.ts';

const form = (wid: string) => `document.querySelector('[data-win="${wid}"] .k95-form')`;
const text = (wid: string) => page.evaluate<string>(`document.querySelector('[data-win="${wid}"] .window-body')?.textContent ?? ''`);

describe('ui-ticket-arrival', { timeout: 60_000 }, () => {
  it('a created ticket opens with its form while the change event is still held back', async () => {
    await page.goto(base);
    await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
    await page.evaluate(`(() => {
      window.held = [];
      const f = window.__fetch ??= window.fetch;
      window.fetch = (u, o) => /^\\/api\\/tickets\\/\\d+$/.test(String(u).split('?')[0]) && o?.method === 'GET'
        ? new Promise((ok) => window.held.push(() => ok(f(u, o)))) : f(u, o);
    })()`);
    await click('#start');
    await page.evaluate(`[...document.querySelectorAll('.k95-menu li')].find((li) => li.textContent === 'New ticket').click()`);
    await until(() => page.evaluate(`!!${form('ticket-new')}`), 'the New ticket window');
    await page.evaluate(`(() => { const f = ${form('ticket-new')}.querySelector('input'); f.value = 'Arrives late'; })()`);
    await page.evaluate(`[...${form('ticket-new')}.querySelectorAll('button')].find((b) => b.textContent === 'Create').click()`);

    const id = await until(() => (db.prepare("SELECT id FROM tickets WHERE title = 'Arrives late'").get() as { id: number } | undefined)?.id, 'the ticket row');
    await until(() => page.evaluate(`!!${form(`ticket-${id}`)}`), 'the new ticket form');
    expect(await page.evaluate(`${form(`ticket-${id}`)}.querySelector('input').value`)).toBe('Arrives late');
    expect(await text(`ticket-${id}`)).not.toContain('This ticket was deleted.');
    await page.evaluate(`(() => { window.fetch = window.__fetch; for (const r of window.held) r(); })()`);
  });

  it('a window opened before its ticket is cached shows the form once the ticket arrives, and keeps edits through later events', async () => {
    const other = ticket('Bystander');
    await page.goto(base);
    await until(() => page.evaluate(`!!document.querySelector('.card[data-id="${other}"]')`), 'the board');
    const id = ticket('Not cached yet', { status: 'done', needs_human: 1 });
    db.prepare("INSERT INTO notes (ticket_id, role, kind, body) VALUES (?, 'tester', 'failure', 'stuck')").run(id);
    try {
      await click('#inbox-count');
      events.emit('event', { ticket: other });
      const box = `.k95-flag[data-ticket="${id}"]`;
      await until(() => page.evaluate(`!!document.querySelector('${box}')`), 'the failure in the Inbox');
      await click(`${box} button`);
      await until(async () => (await text(`ticket-${id}`)).includes('This ticket was deleted.'), 'the window without its ticket');

      events.emit('event', { ticket: id });
      await until(() => page.evaluate(`!!${form(`ticket-${id}`)}`), 'the form after the ticket arrives');
      expect(await text(`ticket-${id}`)).not.toContain('This ticket was deleted.');

      await page.evaluate(`(() => { const f = ${form(`ticket-${id}`)}.querySelector('textarea[data-field="body"]'); f.value = 'typed body'; })()`);
      db.prepare("UPDATE tickets SET title = 'Renamed arrival' WHERE id = ?").run(id);
      events.emit('event', { ticket: id });
      await until(() => page.evaluate(`document.querySelector('[data-win="ticket-${id}"] .title-bar-text').textContent.includes('Renamed arrival')`), 'the change event');
      expect(await page.evaluate(`${form(`ticket-${id}`)}.querySelector('textarea[data-field="body"]').value`)).toBe('typed body');
    } finally {
      db.prepare("UPDATE tickets SET needs_human = 0, merged_at = 'x' WHERE id = ?").run(id);
    }
  });
});
