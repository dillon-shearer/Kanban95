// In headless Edge or Chrome against a running daemon (setup in ui.ts): the Inbox window: questions and failed merges.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { describe, expect, it } from 'vitest';
import { until } from './cdp.ts';
import { srv, db, page, base, git, ticket, column, click } from './ui.ts';

describe('ui-inbox', { timeout: 60_000 }, () => {
  it('clears the needs_human badge on the card when the Inbox answer is sent', async () => {
    const id = ticket('Ask me', { model: 'ask' });
    await page.goto(base);
    await until(() => column(id), 'the card');
    expect((await fetch(`${base}api/tickets/${id}/launch`, { method: 'POST', headers: { cookie: `k95=${srv.secret}` } })).status).toBe(200);
    const flagged = `.card[data-id="${id}"] .badge.flag`;
    await until(() => page.evaluate(`!!document.querySelector('${flagged}')`), 'the needs human badge');

    await click('#inbox-count');
    const box = `.k95-question[data-ticket="${id}"]`;
    await until(() => page.evaluate(`!!document.querySelector('${box} textarea')`), 'the question in the Inbox');
    await page.evaluate(`document.querySelector('${box} textarea').value = 'Navy blue'`);
    await click(`${box} button:not(.k95-mic)`);

    await until(() => page.evaluate(`!document.querySelector('${flagged}')`), 'the badge to clear', 5000);
    expect(db.prepare("SELECT body FROM notes WHERE ticket_id = ? AND kind = 'answer'").all(id)).toEqual([{ body: 'Navy blue' }]);
    await until(() => (db.prepare('SELECT merged_at FROM tickets WHERE id = ?').get(id) as { merged_at: string | null }).merged_at, 'the merge', 30_000);
    expect(git('show', 'HEAD:answer.txt')).toBe('Navy blue');
  });

  it('lists a failed merge in the Inbox with its note and the buttons that fix it, and counts it in the taskbar', async () => {
    const id = ticket('Stuck merge', { status: 'done', needs_human: 1 });
    const body = `merge conflict with main: CONFLICT (add/add) in shared.txt\nTo resolve: in .worktrees/t-${id} run git merge with the base branch, then Retry merge.`;
    db.prepare("INSERT INTO notes (ticket_id, role, kind, body) VALUES (?, 'tester', 'failure', ?)").run(id, body);
    try {
      await page.goto(base);
      await until(() => page.evaluate(`!!document.querySelector('[data-win="board"] [data-status="done"]')`), 'the board'); // its card is in the folded Done
      const n = (await (await fetch(`${base}api/inbox`, { headers: { cookie: `k95=${srv.secret}` } })).json()).length;
      // The count arrives on its own fetch after the board; under full-suite load it can trail the card.
      await until(async () => (await page.evaluate(`document.getElementById('inbox-count').textContent`)) === `Inbox ${n}`, `the taskbar to say Inbox ${n}`);
      await click('#inbox-count');
      const box = `.k95-flag[data-ticket="${id}"]`;
      await until(() => page.evaluate(`!!document.querySelector('${box}')`), 'the failure in the Inbox');
      expect(await page.evaluate(`document.querySelector('${box} pre').textContent`)).toBe(body);
      expect(await page.evaluate(`[...document.querySelectorAll('${box} button')].map((b) => b.textContent)`)).toEqual(['Open ticket', 'Retry merge']);
      await click(`${box} button`);
      const facts = `[data-win="ticket-${id}"] .k95-facts`;
      await until(() => page.evaluate(`!!document.querySelector('${facts}')`), 'the ticket window');
      expect(await page.evaluate(`document.querySelector('${facts}').textContent`)).toContain('needs human (the Inbox says why)');
    } finally {
      db.prepare("UPDATE tickets SET needs_human = 0, merged_at = 'x' WHERE id = ?").run(id);
    }
  });
});
