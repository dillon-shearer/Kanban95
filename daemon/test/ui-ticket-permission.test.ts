import './home.ts';
import { expect, it } from 'vitest';
import { sessions, type Session } from '../src/launcher.ts';
import { until } from './cdp.ts';
import { base, db, page, ticket } from './ui.ts';

it('the Ticket window shows a pending permission request with Approve, which raises the level and the form follows', { timeout: 60_000 }, async () => {
  const id = ticket('Asks for level 3', { status: 'in_progress', needs_human: 1 });
  db.prepare("INSERT INTO notes (ticket_id, role, kind, body) VALUES (?, 'worker', 'question', ?)").run(id, 'PERMISSION level=3\nset_model was refused');
  const s = { key: -1000 - id, runId: null, grantId: 0, ticketId: id, role: 'worker', phase: 'execute', started: Date.now(),
    pty: { pid: 0, kill: () => {}, resize: () => {}, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), write: () => {} }, scrollback: () => '' } as unknown as Session;
  sessions.set(s.key, s);
  const win = `[data-win="ticket-${id}"]`;
  const box = `${win} .k95-permission[data-ticket="${id}"]`;
  await page.goto(base);
  await until(() => page.evaluate(`!!document.querySelector('.card[data-id="${id}"]')`), 'the card', 30_000);
  await page.evaluate(`document.querySelector('.card[data-id="${id}"]').dispatchEvent(new MouseEvent('dblclick'))`);
  await until(() => page.evaluate(`!!document.querySelector('${box}')`), 'the request on the Ticket tab', 30_000);
  expect(await page.evaluate(`[...document.querySelectorAll('${box} button')].map((b) => b.textContent)`)).toEqual(['Approve', 'Deny']);
  expect(await page.evaluate(`document.querySelector('${box} pre').textContent`)).toBe('set_model was refused');

  await page.evaluate(`document.querySelector('${box} button').click()`);
  const row = () => db.prepare('SELECT agent_level, needs_human FROM tickets WHERE id = ?').get(id) as { agent_level: number; needs_human: number };
  await until(() => row().needs_human === 0, 'the approved flag to clear', 10_000);
  expect(row().agent_level).toBe(3);
  await until(() => page.evaluate(`!document.querySelector('${box}') && document.querySelector('${win} .k95-level').value === '3'`), 'the request gone and the level select at 3', 10_000);
  sessions.delete(s.key);
});
