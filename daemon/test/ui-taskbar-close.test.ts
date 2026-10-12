import './home.ts';
import { describe, expect, it } from 'vitest';
import { sessions } from '../src/launcher.ts';
import { until } from './cdp.ts';
import { srv, page, base, ticket, column, click, rightClick, menuItems, menuPick } from './ui.ts';

describe('ui-taskbar-close', { timeout: 60_000 }, () => {
  const openWin = async (id: number) => {
    await until(() => column(id), 'the card');
    await page.evaluate(`document.querySelector('.card[data-id="${id}"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await until(() => page.evaluate(`!!document.querySelector('[data-win="ticket-${id}"] .k95-form')`), 'the Ticket window');
  };
  const field = (id: number) => `document.querySelector('[data-win="ticket-${id}"] .k95-form input')`;
  const type = (id: number, text: string) => page.evaluate(`(() => { const f = ${field(id)}; f.value = ${JSON.stringify(text)}; f.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const isOpen = (wid: string) => page.evaluate<boolean>(`!!document.querySelector('[data-win="${wid}"]')`);
  const dialogOpen = () => page.evaluate<boolean>(`!!document.querySelector('dialog[open]')`);
  const answer = async (label: string) => {
    await until(() => page.evaluate<boolean>(`!!document.querySelector('dialog[open]:not([data-answered])')`), 'the Discard dialog');
    expect(await page.evaluate(`document.querySelector('dialog[open]').textContent`)).toContain('Discard changes?');
    await page.evaluate(`(() => { const d = document.querySelector('dialog[open]'); d.dataset.answered = ''; [...d.querySelectorAll('button')].find((b) => b.textContent === '${label}').click(); })()`);
    await until(() => page.evaluate<boolean>(`!document.querySelector('dialog[data-answered]')`), 'the dialog to close');
  };

  it('taskbar Close on a dirty ticket asks first: Cancel keeps the edits, Discard closes', async () => {
    const id = ticket('Close from taskbar');
    await page.goto(base);
    await openWin(id);
    await type(id, 'edited');
    await rightClick(`[data-task="ticket-${id}"]`);
    await menuPick('Close');
    await answer('Cancel');
    expect(await isOpen(`ticket-${id}`)).toBe(true);
    expect(await page.evaluate(`${field(id)}.value`)).toBe('edited');

    await rightClick(`[data-task="ticket-${id}"]`);
    await menuPick('Close');
    await answer('Discard');
    await until(async () => !(await isOpen(`ticket-${id}`)), 'the window to close');
  });

  it('multi-selection Close asks each dirty ticket in turn and closes the rest', async () => {
    const a = ticket('Keep A');
    const b = ticket('Drop B');
    await page.goto(base);
    await openWin(a);
    await openWin(b);
    await page.evaluate(`import('/wm.js').then((wm) => wm.open('plain-close', { title: 'plain' }))`);
    await type(a, 'edit A');
    await type(b, 'edit B');
    for (const wid of [`ticket-${a}`, `ticket-${b}`, 'plain-close']) await click(`[data-task="${wid}"]`, 2);
    await rightClick(`[data-task="ticket-${a}"]`);
    expect(await menuItems()).toEqual(['Restore', 'Minimize', 'Close']);
    await menuPick('Close');
    await answer('Cancel');
    await answer('Discard');
    await until(async () => !(await isOpen('plain-close')), 'the plain window to close');
    expect(await isOpen(`ticket-${b}`)).toBe(false);
    expect(await isOpen(`ticket-${a}`)).toBe(true);
    expect(await page.evaluate(`${field(a)}.value`)).toBe('edit A');

    await page.evaluate(`import('/wm.js').then((wm) => wm.close('ticket-${a}'))`);
    expect(await isOpen(`ticket-${a}`)).toBe(false);
    expect(await dialogOpen()).toBe(false);
  });

  it('taskbar Close on a terminal closes only the window; the agent keeps running', async () => {
    const id = ticket('Keep my agent');
    await page.goto(base);
    await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
    const cookie = { cookie: `k95=${srv.secret}` };
    expect((await fetch(`${base}api/tickets/${id}/launch`, { method: 'POST', headers: cookie })).status).toBeLessThan(300);
    const s = await until(async () => (await (await fetch(`${base}api/sessions`, { headers: cookie })).json())
      .find((x: { ticket_id: number | null }) => x.ticket_id === id), 'the session');
    await until(() => isOpen(`term-${s.id}`), 'the terminal');
    await rightClick(`[data-task="term-${s.id}"]`);
    await menuPick('Close');
    await until(async () => !(await isOpen(`term-${s.id}`)), 'the terminal window to close');
    expect(await dialogOpen()).toBe(false);
    expect(sessions.has(s.id)).toBe(true);

    await fetch(`${base}api/grants/${s.grant_id}`, { method: 'DELETE', headers: cookie });
    await until(() => sessions.size === 0, 'the agents to exit');
  });
});
