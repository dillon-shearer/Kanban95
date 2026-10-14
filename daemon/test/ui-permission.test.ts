import './home.ts';
import { describe, expect, it } from 'vitest';
import { sessions, type Session } from '../src/launcher.ts';
import { until } from './cdp.ts';
import { db, page, base, ticket, click } from './ui.ts';

const asking = (title: string) => {
  const id = ticket(title, { status: 'in_progress', needs_human: 1 });
  db.prepare("INSERT INTO notes (ticket_id, role, kind, body) VALUES (?, 'worker', 'question', ?)").run(id, 'PERMISSION level=3\nupdate_ticket on #9 was refused');
  const written: string[] = [];
  const s = { key: -1000 - id, runId: null, grantId: 0, ticketId: id, role: 'worker', phase: 'execute', started: Date.now(),
    pty: { pid: 0, kill: () => {}, resize: () => {}, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), write: (d: string) => { written.push(d); } }, scrollback: () => '' } as unknown as Session;
  sessions.set(s.key, s);
  return { id, written, end: () => sessions.delete(s.key) };
};
const ticketRow = (id: number) => db.prepare('SELECT agent_level, needs_human FROM tickets WHERE id = ?').get(id) as { agent_level: number; needs_human: number };
const answers = (id: number) => db.prepare("SELECT body FROM notes WHERE ticket_id = ? AND kind = 'answer'").all(id);

describe('ui-permission', { timeout: 60_000 }, () => {
  it('shows Approve and Deny for a permission request; Approve raises the level and answers, Deny answers and leaves it', async () => {
    const yes = asking('Approve me');
    const no = asking('Deny me');
    try {
      await page.goto(base);
      await click('#inbox-count');
      const box = (id: number) => `.k95-permission[data-ticket="${id}"]`;
      await until(() => page.evaluate(`!!document.querySelector('${box(no.id)}')`), 'the requests in the Inbox');
      expect(await page.evaluate(`[...document.querySelectorAll('${box(yes.id)} button')].map((b) => b.textContent)`)).toEqual(['Approve', 'Deny']);
      expect(await page.evaluate(`!!document.querySelector('${box(yes.id)} textarea')`)).toBe(false);
      expect(await page.evaluate(`document.querySelector('${box(yes.id)} .note-head').textContent`)).toContain('asks for level 3');
      expect(await page.evaluate(`document.querySelector('${box(yes.id)} pre').textContent`)).toBe('update_ticket on #9 was refused');

      await click(`${box(yes.id)} button`);
      await until(() => ticketRow(yes.id).needs_human === 0, 'the approved flag to clear', 5000);
      expect(ticketRow(yes.id).agent_level).toBe(3);
      expect(answers(yes.id)).toEqual([{ body: 'approved: level 3; retry the refused call now' }]);
      expect(yes.written).toContain('approved: level 3; retry the refused call now');

      await until(() => page.evaluate(`!document.querySelector('${box(yes.id)}') && !!document.querySelector('${box(no.id)}')`), 'the second request alone');
      await click(`${box(no.id)} button:last-child`);
      await until(() => ticketRow(no.id).needs_human === 0, 'the denied flag to clear', 5000);
      expect(ticketRow(no.id).agent_level).toBe(0);
      expect(answers(no.id)).toEqual([{ body: 'denied' }]);
    } finally {
      yes.end();
      no.end();
    }
  });
});
