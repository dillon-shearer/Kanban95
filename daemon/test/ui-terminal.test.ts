// In headless Edge or Chrome against a running daemon (setup in ui.ts): terminal windows: their lifetime, ending and resuming agents, the Operator terminal.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sessions } from '../src/launcher.ts';
import { until } from './cdp.ts';
import { repo, srv, db, page, base, ticket, column, statusBar, click } from './ui.ts';

describe('ui-terminal', { timeout: 60_000 }, () => {
  it('keeps an ended terminal open while its ticket exists; deleting the ticket closes its terminal and Ticket window', async () => {
    const id = ticket('Delete me');
    await page.goto(base);
    await until(() => column(id), 'the card');
    const win = (wid: string) => page.evaluate<boolean>(`!!document.querySelector('[data-win="${wid}"]')`);
    const tasks = () => page.evaluate<number>(`[...document.querySelectorAll('#tasks .task')].filter((b) => /#${id}\\b/.test(b.textContent)).length`);
    const launchAgent = async () => {
      expect((await fetch(`${base}api/tickets/${id}/launch`, { method: 'POST', headers: { cookie: `k95=${srv.secret}` } })).status).toBe(200);
      await until(() => page.evaluate(`!!document.querySelector('[data-win^="term-"]:not(.ended) .xterm')`), 'the terminal');
      return page.evaluate<string>(`document.querySelector('[data-win^="term-"]:not(.ended)').dataset.win`);
    };

    const first = await launchAgent();
    const grant = (db.prepare('SELECT id FROM grants WHERE ticket_id = ? AND revoked_at IS NULL').get(id) as { id: number }).id;
    await fetch(`${base}api/grants/${grant}`, { method: 'DELETE', headers: { cookie: `k95=${srv.secret}` } });
    await until(() => page.evaluate(`document.querySelector('[data-win="${first}"]').classList.contains('ended')`), 'the ended terminal');
    expect(await page.evaluate<string>(`document.querySelector('[data-win="${first}"] .title-bar-text').textContent`)).toMatch(/\(ended\)$/);

    db.prepare("UPDATE tickets SET status = 'backlog' WHERE id = ?").run(id);
    const second = await launchAgent();
    await page.evaluate(`document.querySelector('.card[data-id="${id}"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await until(() => win(`ticket-${id}`), 'the Ticket window');
    expect(await tasks()).toBe(3);

    expect((await fetch(`${base}api/tickets/${id}`, { method: 'DELETE', headers: { cookie: `k95=${srv.secret}` } })).status).toBe(204);
    await until(async () => !(await win(`ticket-${id}`)) && !(await win(first)) && !(await win(second)), 'the windows to close', 5000);
    expect(await tasks()).toBe(0);
    // The next test's ticket reuses this id; it must not see these agents still exiting as its own.
    await until(() => sessions.size === 0, 'the agents to exit');
  });

  it("X on a running terminal asks first: Cancel keeps the agent, End stops it and flags the ticket", async () => {
    const id = ticket('Stop me');
    await page.goto(base);
    await until(() => column(id), 'the card');
    expect((await fetch(`${base}api/tickets/${id}/launch`, { method: 'POST', headers: { cookie: `k95=${srv.secret}` } })).status).toBe(200);
    // By this ticket's session, not the first terminal: an earlier test's agent may still be dying (ticket ids are reused).
    const key = await until(async () => (await (await fetch(`${base}api/sessions`, { headers: { cookie: `k95=${srv.secret}` } })).json()).find((x: { ticket_id: number }) => x.ticket_id === id)?.id, 'the session');
    const wid = `term-${key}`;
    await until(() => page.evaluate(`!!document.querySelector('[data-win="${wid}"] .xterm')`), 'the terminal');
    const live = async () => (await (await fetch(`${base}api/sessions`, { headers: { cookie: `k95=${srv.secret}` } })).json()).some((x: { id: number }) => `term-${x.id}` === wid);
    const press = (label: string) => page.evaluate(`[...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === '${label}').click()`);
    const x = `[data-win="${wid}"] [aria-label="Close"]`;

    await page.evaluate(`document.querySelector('${x}').click()`);
    const text = await until(() => page.evaluate<string>(`document.querySelector('dialog[open]')?.textContent ?? ''`), 'the confirm');
    expect(text).toContain(`End the agent for #${id}?`);
    expect(text).toContain('Minimize to keep it running');
    await press('Cancel');
    await until(() => page.evaluate('!document.querySelector("dialog[open]")'), 'the dialog to close');
    expect(await page.evaluate(`!!document.querySelector('[data-win="${wid}"]')`)).toBe(true);
    expect(await live()).toBe(true);

    await page.evaluate(`document.querySelector('${x}').click()`);
    await until(() => page.evaluate('!!document.querySelector("dialog[open]")'), 'the confirm');
    await press('End');
    await until(() => page.evaluate(`!document.querySelector('[data-win="${wid}"]')`), 'the window to close');
    await until(async () => !(await live()), 'the session to end');
    expect(db.prepare('SELECT needs_human FROM tickets WHERE id = ?').get(id)).toEqual({ needs_human: 1 });
    db.prepare("UPDATE tickets SET needs_human = 0, merged_at = 'x' WHERE id = ?").run(id);
  });

  it('offers Resume in the card menu and the Inbox for a flagged running ticket whose agent is gone; Resume starts it again', async () => {
    const id = ticket('Died', { status: 'in_progress', needs_human: 1, retry: 2 });
    const waiting = ticket('Not started');
    db.prepare("INSERT INTO notes (ticket_id, role, kind, body) VALUES (?, 'worker', 'failure', 'agent exited without reporting')").run(id);
    try {
      // The id may be the one the previous test deleted, whose killed agents can still be closing under load.
      const sessions = async () => (await (await fetch(`${base}api/sessions`, { headers: { cookie: `k95=${srv.secret}` } })).json()) as { ticket_id: number }[];
      await until(async () => !(await sessions()).some((s) => s.ticket_id === id), 'the deleted ticket\'s agents to exit');
      await page.goto(base);
      await until(() => column(id), 'the card');
      await until(() => column(waiting), 'the backlog card');
      const item = (label: string) => `[...document.querySelectorAll('.k95-menu li')].find((li) => li.firstChild?.textContent === '${label}')`;
      await page.evaluate(`document.querySelector('.card[data-id="${id}"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 50 }))`);
      expect(await page.evaluate(`${item('Resume')}?.getAttribute('aria-disabled') ?? 'enabled'`)).toBe('enabled');
      expect(await page.evaluate(`${item('Launch')}?.getAttribute('aria-disabled') ?? 'enabled'`)).toBe('enabled');
      expect(await page.evaluate(`${item('Restart')}?.getAttribute('aria-disabled') ?? 'enabled'`)).toBe('enabled');
      await page.evaluate(`document.querySelector('.k95-menu').remove()`);
      await page.evaluate(`document.querySelector('.card[data-id="${waiting}"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 50 }))`);
      expect(await page.evaluate(`!!${item('Restart')}`)).toBe(false); // not on a Backlog card
      await page.evaluate(`document.querySelector('.k95-menu').remove()`);

      await click('#inbox-count');
      const box = `.k95-flag[data-ticket="${id}"]`;
      await until(() => page.evaluate(`!!document.querySelector('${box} button')`), 'the failure in the Inbox');
      expect(await page.evaluate(`document.querySelector('${box} pre').textContent`)).toBe('agent exited without reporting');
      expect(await page.evaluate(`[...document.querySelectorAll('${box} button')].map((b) => b.textContent)`)).toEqual(['Open ticket', 'Resume', 'Restart', 'Reset to Backlog']);
      await click(`${box} button:nth-child(3)`);
      await until(() => page.evaluate(`!!document.querySelector('dialog[open]')`), 'the Restart confirm');
      expect(await page.evaluate(`document.querySelector('dialog[open]').textContent`)).toContain(`End the running agent for #${id} and start a new one in the same phase?`);
      await page.evaluate(`[...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === 'Cancel').click()`);
      await click(`${box} button:nth-child(2)`);
      await until(() => !(db.prepare('SELECT needs_human FROM tickets WHERE id = ?').get(id) as { needs_human: number }).needs_human, 'the flag to clear', 5000);
      expect(db.prepare('SELECT status, retry FROM tickets WHERE id = ?').get(id)).toEqual({ status: 'in_progress', retry: 2 });
      expect((db.prepare("SELECT prompt_rendered FROM runs WHERE ticket_id = ? AND phase = 'execute'").get(id) as { prompt_rendered: string }).prompt_rendered)
        .toContain('agent exited without reporting');
    } finally {
      db.prepare("UPDATE tickets SET status = 'done', merged_at = 'x', needs_human = 0 WHERE id IN (?, ?)").run(id, waiting);
    }
  });

  it('asks for a mission on Ctrl+Shift+N and Start → New operator terminal, refuses an empty one, and opens the Operator terminal', async () => {
    const models = join(process.env.USERPROFILE!, '.kanban95', 'models.json');
    const before = readFileSync(models, 'utf8');
    writeFileSync(models, JSON.stringify({ ...JSON.parse(before), claude: { ...JSON.parse(before).claude, plan: { model: 'plan', effort: 'low' } } }));
    await page.goto(base);
    await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
    const dialogOpen = () => page.evaluate<boolean>(`document.querySelector('dialog[open] .title-bar-text')?.textContent === 'New operator terminal'`);
    const press = (button: string) => page.evaluate(`[...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === '${button}').click()`);

    for (const type of ['keyDown', 'keyUp']) {
      await page.send('Input.dispatchKeyEvent', { type, key: 'N', code: 'KeyN', windowsVirtualKeyCode: 78, modifiers: 2 | 8 });
    }
    await until(dialogOpen, 'the mission dialog');
    await press('Start');
    await until(async () => (await statusBar()) === 'mission must be a non-empty string', 'the refusal');
    expect(db.prepare("SELECT count(*) AS n FROM grants WHERE role = 'operator'").get()).toEqual({ n: 0 });

    await click('#start');
    await page.evaluate(`[...document.querySelectorAll('.k95-menu li')].find((li) => li.textContent === 'New operator terminal').click()`);
    await until(dialogOpen, 'the mission dialog from Start');
    const mission = 'Rename the janitor log & keep {{tools}} literal.';
    await page.evaluate(`document.querySelector('dialog[open] textarea').value = ${JSON.stringify(mission)}`);
    await press('Start');
    await until(() => page.evaluate(`[...document.querySelectorAll('[data-win^="term-"] .title-bar-text')].some((t) => t.textContent === 'Operator — plan')`), 'the Operator terminal');
    const g = db.prepare("SELECT id FROM grants WHERE role = 'operator' AND revoked_at IS NULL").get() as { id: number };
    expect(readFileSync(join(repo, '.kanban95', 'sessions', String(-g.id), 'prompt.md'), 'utf8')).toContain(`## Mission\n\n${mission}\n`);
    await fetch(`${base}api/grants/${g.id}`, { method: 'DELETE', headers: { cookie: `k95=${srv.secret}` } });
    await until(() => ![...sessions.values()].some((s) => s.role === 'operator'), 'the operator agent to exit');
    writeFileSync(models, before);
  });
});
