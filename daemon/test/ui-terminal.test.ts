// In headless Edge or Chrome against a running daemon (setup in ui.ts): terminal windows: their lifetime, ending and resuming agents, the Operator terminal.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sessions } from '../src/launcher.ts';
import { until } from './cdp.ts';
import { repo, srv, db, page, base, ticket, column, statusBar, click, rightClick, menuItems, menuPick } from './ui.ts';

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
    await rightClick(`[data-task="${second}"]`);
    expect(await menuItems()).toEqual(['Restore', 'Minimize', 'Maximize', 'Open ticket', 'Close']);
    await menuPick('Open ticket');
    await until(() => win(`ticket-${id}`), 'the Ticket window');
    expect(await tasks()).toBe(3);

    expect((await fetch(`${base}api/tickets/${id}`, { method: 'DELETE', headers: { cookie: `k95=${srv.secret}` } })).status).toBe(204);
    await until(async () => !(await win(`ticket-${id}`)) && !(await win(first)) && !(await win(second)), 'the windows to close', 5000);
    expect(await tasks()).toBe(0);
    // The next test's ticket reuses this id; it must not see these agents still exiting as its own.
    await until(() => sessions.size === 0, 'the agents to exit');
  });

  it("opens a ticket's next session's terminal where the operator left the last one, after a reload too", async () => {
    const id = ticket('Stay put');
    await page.goto(base);
    await until(() => column(id), 'the card');
    const cookie = { cookie: `k95=${srv.secret}` };
    const launchAgent = async () => {
      // A session id never repeats, so each launch is a new terminal window with a new id.
      await until(() => sessions.size === 0, 'the earlier agents to exit');
      db.prepare("UPDATE tickets SET status = 'backlog' WHERE id = ?").run(id);
      expect((await fetch(`${base}api/tickets/${id}/launch`, { method: 'POST', headers: cookie })).status).toBe(200);
      const key = await until(async () => (await (await fetch(`${base}api/sessions`, { headers: cookie })).json()).find((x: { ticket_id: number }) => x.ticket_id === id)?.id, 'the session');
      await until(() => page.evaluate(`!!document.querySelector('[data-win="term-${key}"] .xterm')`), 'the terminal');
      return `term-${key}`;
    };
    const box = (wid: string) => page.evaluate<number[]>(`(() => { const e = document.querySelector('[data-win="${wid}"]'); return [e.offsetLeft, e.offsetTop, e.offsetWidth, e.offsetHeight]; })()`);
    const end = async (wid: string) => {
      const grant = (db.prepare('SELECT id FROM grants WHERE ticket_id = ? AND revoked_at IS NULL').get(id) as { id: number }).id;
      await fetch(`${base}api/grants/${grant}`, { method: 'DELETE', headers: cookie });
      await until(() => page.evaluate(`document.querySelector('[data-win="${wid}"]').classList.contains('ended')`), 'the ended terminal');
      await page.evaluate(`document.querySelector('[data-win="${wid}"] [aria-label="Close"]').click()`);
      await until(() => page.evaluate(`!document.querySelector('[data-win="${wid}"]')`), 'the window to close');
    };

    const first = await launchAgent();
    const cascaded = await box(first);
    // Resize as the CSS corner does (it only sets the inline size), then drag the title bar: letting go saves both.
    await page.evaluate(`Object.assign(document.querySelector('[data-win="${first}"]').style, { width: '612px', height: '345px' })`);
    await click(`[data-task="${first}"]`); // the board opens it behind the Board window
    const { x, y } = await page.center(`[data-win="${first}"] .title-bar-text`);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + 137, y: y + 71, button: 'left', buttons: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + 137, y: y + 71, button: 'left', buttons: 0, clickCount: 1 });
    const placed = await box(first);
    expect(placed).toEqual([cascaded[0] + 137, cascaded[1] + 71, 612, 345]);
    await end(first);

    // Board closed and reopened: only ui.json carries the place over.
    await page.goto(base);
    await until(() => column(id), 'the card after the reload');
    const second = await launchAgent();
    expect(second).not.toBe(first);
    expect(await box(second)).toEqual(placed);
    await end(second);
    db.prepare("UPDATE tickets SET status = 'done', merged_at = 'x' WHERE id = ?").run(id);
  });

  it("colours a terminal's title bar by its state, focused or not, and recolours it in place when its ticket is flagged", async () => {
    const id = ticket('Colour me');
    await page.goto(base);
    await until(() => column(id), 'the card');
    const cookie = { cookie: `k95=${srv.secret}` };
    expect((await fetch(`${base}api/tickets/${id}/launch`, { method: 'POST', headers: cookie })).status).toBe(200);
    const key = await until(async () => (await (await fetch(`${base}api/sessions`, { headers: cookie })).json()).find((x: { ticket_id: number }) => x.ticket_id === id)?.id, 'the session');
    const wid = `term-${key}`;
    await until(() => page.evaluate(`!!document.querySelector('[data-win="${wid}"] .xterm')`), 'the terminal');
    const state = () => page.evaluate<string | null>(`document.querySelector('[data-win="${wid}"]').dataset.state ?? null`);
    const bar = (w: string) => page.evaluate<string>(`getComputedStyle(document.querySelector('[data-win="${w}"] .title-bar')).backgroundImage`);
    const flag = (on: boolean) => fetch(`${base}api/tickets/${id}`, { method: 'PATCH', headers: { ...cookie, 'content-type': 'application/json' }, body: JSON.stringify({ needs_human: on }) });
    const GREY = 'linear-gradient(90deg, rgb(128, 128, 128), rgb(181, 181, 181))'; // 98.css's inactive bar
    const BLUE = 'linear-gradient(90deg, rgb(0, 0, 128), rgb(16, 132, 208))'; // and its active one

    // Opened behind the Board: unfocused, yet a dimmed blue rather than 98.css's grey.
    expect(await state()).toBe('execute');
    const dimmed = await bar(wid);
    expect(dimmed).not.toBe(GREY);
    expect(dimmed).not.toBe(BLUE);
    await click(`[data-task="${wid}"]`);
    expect(await bar(wid)).toBe(BLUE);
    expect(await bar('board')).toBe(GREY); // other windows keep the 98.css look

    expect((await flag(true)).status).toBe(200);
    await until(async () => (await state()) === 'human', 'the orange bar');
    const orange = await bar(wid);
    expect(orange).not.toBe(BLUE);
    expect((await flag(false)).status).toBe(200);
    await until(async () => (await state()) === 'execute', 'the blue bar again');

    // Ended beats a flag.
    await flag(true);
    await until(async () => (await state()) === 'human', 'the orange bar');
    const grant = (db.prepare('SELECT id FROM grants WHERE ticket_id = ? AND revoked_at IS NULL').get(id) as { id: number }).id;
    await fetch(`${base}api/grants/${grant}`, { method: 'DELETE', headers: cookie });
    await until(async () => (await state()) === 'ended', 'the grey bar');
    expect(await bar(wid)).not.toBe(orange);
    db.prepare("UPDATE tickets SET needs_human = 0, status = 'done', merged_at = 'x' WHERE id = ?").run(id);
    await until(() => sessions.size === 0, 'the agent to exit');
  });

  it("dragging a running card to Backlog stops its agent and closes its terminals, the live one and an already ended one", async () => {
    const id = ticket('Reset me');
    await page.goto(base);
    await until(() => column(id), 'the card');
    const sessionsOf = async () => ((await (await fetch(`${base}api/sessions`, { headers: { cookie: `k95=${srv.secret}` } })).json()) as { id: number; ticket_id: number; grant_id: number }[]).filter((x) => x.ticket_id === id);
    const launchAgent = async () => {
      expect((await fetch(`${base}api/tickets/${id}/launch`, { method: 'POST', headers: { cookie: `k95=${srv.secret}` } })).status).toBe(200);
      const s = await until(async () => (await sessionsOf())[0], 'the session');
      await until(() => page.evaluate(`!!document.querySelector('[data-win="term-${s.id}"] .xterm')`), 'the terminal');
      await until(() => [...sessions.values()].find((x) => x.key === s.id)?.scrollback().includes('FAKE'), 'the fake agent');
      return s;
    };
    const win = (wid: string) => page.evaluate<boolean>(`!!document.querySelector('[data-win="${wid}"]')`);
    const tasks = () => page.evaluate<number>(`document.querySelectorAll('#tasks [data-task^="term-"]').length`);

    // The first agent dies with the ticket still In Progress: its terminal stays, "(ended)".
    const first = await launchAgent();
    await fetch(`${base}api/grants/${first.grant_id}`, { method: 'DELETE', headers: { cookie: `k95=${srv.secret}` } });
    await until(() => page.evaluate(`document.querySelector('[data-win="term-${first.id}"]').classList.contains('ended')`), 'the ended terminal');
    const second = await launchAgent();
    expect(await tasks()).toBe(2);

    await page.drag(await page.center(`.card[data-id="${id}"]`), await page.center('[data-status="backlog"] .cards'));
    await until(() => page.evaluate('!!document.querySelector("dialog[open]")'), 'the confirm');
    await page.evaluate(`[...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === 'Reset').click()`);
    const t0 = Date.now();
    await until(async () => !(await win(`term-${first.id}`)) && !(await win(`term-${second.id}`)) && (await tasks()) === 0, 'the terminals to close', 5000);
    expect(Date.now() - t0).toBeLessThan(2000);
    await until(async () => (await sessionsOf()).length === 0, 'the agent to exit', 2000);
    expect(db.prepare('SELECT status, needs_human FROM tickets WHERE id = ?').get(id)).toEqual({ status: 'backlog', needs_human: 0 });
    db.prepare("UPDATE tickets SET status = 'done', merged_at = 'x' WHERE id = ?").run(id);
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
    await until(() => page.evaluate(`[...document.querySelectorAll('[data-win^="term-"] .title-bar-text')].some((t) => t.textContent === 'Operator — CLI default')`), 'the Operator terminal');
    const g = db.prepare("SELECT id FROM grants WHERE role = 'operator' AND revoked_at IS NULL").get() as { id: number };
    expect(readFileSync(join(repo, '.kanban95', 'sessions', String(-g.id), 'prompt.md'), 'utf8')).toContain(`## Mission\n\n${mission}\n`);
    await fetch(`${base}api/grants/${g.id}`, { method: 'DELETE', headers: { cookie: `k95=${srv.secret}` } });
    await until(() => ![...sessions.values()].some((s) => s.role === 'operator'), 'the operator agent to exit');
    writeFileSync(models, before);
  });
});
