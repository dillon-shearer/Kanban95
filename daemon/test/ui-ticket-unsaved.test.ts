// In headless Edge or Chrome against a running daemon (setup in ui.ts): unsaved Ticket form text survives tab switches, and closing asks first.
import './home.ts';
import { describe, expect, it } from 'vitest';
import { until } from './cdp.ts';
import { page, base, ticket, column, click } from './ui.ts';

describe('ui-ticket-unsaved', { timeout: 60_000 }, () => {
  const openWin = async (id: number) => {
    await page.goto(base);
    await until(() => column(id), 'the card');
    await page.evaluate(`document.querySelector('.card[data-id="${id}"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await until(() => page.evaluate(`!!document.querySelector('[data-win="ticket-${id}"] .k95-form')`), 'the Ticket window');
  };
  const field = (id: number, sel: string) => `document.querySelector('[data-win="ticket-${id}"] .k95-form ${sel}')`;
  const type = (id: number, sel: string, text: string) => page.evaluate(`(() => { const f = ${field(id, sel)}; f.focus(); f.value = ${JSON.stringify(text)}; f.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const tab = (id: number, name: string) => page.evaluate(`[...document.querySelectorAll('[data-win="ticket-${id}"] [role="tab"] a')].find((a) => a.textContent === '${name}').click()`);
  const esc = () => page.evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  const isOpen = (id: number) => page.evaluate<boolean>(`!!document.querySelector('[data-win="ticket-${id}"]')`);
  const dialogOpen = () => page.evaluate<boolean>(`!!document.querySelector('dialog[open]')`);

  it('keeps typed Body text across a switch to Notes and back, and through a change event', async () => {
    const id = ticket('Keep me', { body: 'saved body' });
    await openWin(id);
    await type(id, 'textarea[data-field="body"]', 'typed body');
    await tab(id, 'Notes');
    await until(() => page.evaluate(`!document.querySelector('[data-win="ticket-${id}"] .k95-form')`), 'the Notes tab');
    await tab(id, 'Ticket');
    await until(() => page.evaluate(`!!document.querySelector('[data-win="ticket-${id}"] .k95-form')`), 'the Ticket tab');
    expect(await page.evaluate(`${field(id, 'textarea[data-field="body"]')}.value`)).toBe('typed body');

    await page.evaluate(`fetch('/api/tickets/${id}', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Renamed' }) })`);
    await until(() => page.evaluate(`document.querySelector('[data-win="ticket-${id}"] .title-bar-text').textContent.includes('Renamed')`), 'the change event');
    expect(await page.evaluate(`${field(id, 'textarea[data-field="body"]')}.value`)).toBe('typed body');
  });

  it('Esc with edits asks first: Cancel keeps the text, Discard closes; with no edits it closes at once', async () => {
    const id = ticket('Ask me');
    await openWin(id);
    await type(id, 'input', 'edited title');
    await esc();
    await until(dialogOpen, 'the Discard dialog');
    expect(await page.evaluate(`document.querySelector('dialog[open]').textContent`)).toContain('Discard changes?');
    await page.evaluate(`[...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === 'Cancel').click()`);
    await until(async () => !(await dialogOpen()), 'the dialog to close');
    expect(await isOpen(id)).toBe(true);
    expect(await page.evaluate(`${field(id, 'input')}.value`)).toBe('edited title');

    await page.evaluate(`document.querySelector('[data-win="ticket-${id}"] [aria-label="Close"]').click()`);
    await until(dialogOpen, 'the Discard dialog from X');
    await page.evaluate(`[...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === 'Discard').click()`);
    await until(async () => !(await isOpen(id)), 'the window to close');

    await openWin(id);
    await page.evaluate(`${field(id, 'input')}.focus()`);
    await esc();
    await until(async () => !(await isOpen(id)), 'the unedited window to close');
    expect(await dialogOpen()).toBe(false);
  });

  it('a new-ticket window with text asks before closing', async () => {
    await page.goto(base);
    await click('#start');
    await page.evaluate(`[...document.querySelectorAll('.k95-menu li')].find((li) => li.textContent === 'New ticket').click()`);
    const win = `document.querySelector('[data-win="ticket-new"]')`;
    await until(() => page.evaluate(`!!${win}?.querySelector('.k95-form')`), 'the New ticket window');
    await page.evaluate(`(() => { const f = ${win}.querySelector('input'); f.focus(); f.value = 'draft'; })()`);
    await esc();
    await until(dialogOpen, 'the Discard dialog');
    await page.evaluate(`[...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === 'Discard').click()`);
    await until(() => page.evaluate(`!${win}`), 'the window to close');
  });
});
