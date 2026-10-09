// In headless Edge or Chrome against a running daemon (setup in ui.ts): the Board window: drag and drop, redraws, launch refusals, the runner button and Push.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { countUnpushed } from '../src/lifecycle.ts';
import { until } from './cdp.ts';
import { repo, srv, db, page, base, git, ticket, statusOf, column, statusBar, click, setUi } from './ui.ts';

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

  it('selects cards with Ctrl, Shift and Ctrl+A, and sets effort on the whole selection, naming a refusal', async () => {
    const ids = ['One', 'Two', 'Three'].map((title) => ticket(title));
    const [a, b, c] = ids;
    const chosen = () => page.evaluate<number[]>(`[...document.querySelectorAll('.card.selected')].map((el) => Number(el.dataset.id))`);
    const effort = (id: number) => (db.prepare('SELECT effort FROM tickets WHERE id = ?').get(id) as { effort: string | null }).effort;
    try {
      await page.goto(base);
      await until(() => column(c), 'the cards');
      await click(`.card[data-id="${a}"]`);
      await click(`.card[data-id="${c}"]`, 2);
      expect(await chosen()).toEqual([a, c]);
      await click(`.card[data-id="${c}"]`, 2);
      expect(await chosen()).toEqual([a]);
      await click(`.card[data-id="${a}"]`);
      await click(`.card[data-id="${c}"]`, 8);
      expect(await chosen()).toEqual([a, b, c]);

      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
      expect((await chosen()).length).toBe(await page.evaluate<number>(`document.querySelectorAll('.card').length`));
      await click(`[data-status="backlog"] .cards`);
      expect(await chosen()).toEqual([]);

      await click(`.card[data-id="${a}"]`);
      await click(`.card[data-id="${b}"]`, 2);
      await click(`.card[data-id="${c}"]`, 2);
      // The daemon refuses #c once; the others still change and the status bar names it.
      await page.evaluate(`(() => { const f = window.fetch; window.fetch = (u, o) => {
        if (!(u.endsWith('/tickets/${c}') && o?.method === 'PATCH')) return f(u, o);
        window.fetch = f;
        return Promise.resolve(new Response(JSON.stringify({ error: 'nope' }), { status: 409 }));
      }; })()`);
      const high = async () => {
        await page.evaluate(`document.querySelector('.card[data-id="${b}"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 50 }))`);
        await page.evaluate(`[...document.querySelectorAll('.k95-menu li')].find((li) => li.firstChild?.textContent === 'Effort').querySelector('li:nth-child(4)').click()`);
      };
      await high();
      await until(async () => (await statusBar()).startsWith('Effort'), 'the outcome');
      expect(await statusBar()).toBe(`Effort set to high on 2 tickets. #${c} refused: nope`);
      expect(ids.map(effort)).toEqual(['high', 'high', null]);
      await high();
      await until(async () => (await statusBar()) === 'Effort set to high on 3 tickets.', 'the second outcome');
      expect(ids.map(effort)).toEqual(['high', 'high', 'high']);
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
    await until(async () => (await line()) === `Running: #${id} (1 of 3; 0 of 0 candidates left)`, 'the running line');
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
  it('names the held tickets in the status bar; Stop clears every hold and nothing else, and says how many', async () => {
    db.prepare("UPDATE tickets SET status = 'done', merged_at = coalesce(merged_at, 'x'), needs_human = 0").run(); // earlier tests' leftovers
    const dep = ticket('Not merged yet', { status: 'in_progress' }); // running for the runner: it waits instead of stopping itself
    const held = [ticket('Held one'), ticket('Held two')];
    for (const id of held) db.prepare('INSERT INTO ticket_deps VALUES (?, ?)').run(id, dep);
    db.prepare(`UPDATE tickets SET blocked_on_deps = 1, retry = 2 WHERE id IN (${held.join(',')})`).run();
    await fetch(`${base}api/runner`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie: `k95=${srv.secret}` }, body: '{"on":true}' });
    const field = () => page.evaluate<string | null>(`(() => { const f = document.querySelector('.k95-held'); return f.hidden ? null : f.textContent; })()`);
    await page.goto(base);
    await until(() => column(held[1]), 'the cards');
    expect(await field()).toBe('2 waiting to launch by themselves');
    expect(await page.evaluate<string[]>(`[...document.querySelectorAll('.k95-toolbar button')].map((b) => b.textContent)`))
      .toEqual(['Launch', 'Stop', 'New brainstorm', 'Housekeeping']);

    await page.evaluate(`[...document.querySelectorAll('.k95-toolbar button')].find((b) => b.textContent === 'Stop').click()`);
    await until(async () => (await statusBar()) === 'Runner stopped, 2 holds cleared.', 'the cleared count');
    await until(async () => (await field()) === null, 'the held line gone');
    for (const id of held) expect(db.prepare('SELECT status, blocked_on_deps, retry FROM tickets WHERE id = ?').get(id)).toEqual({ status: 'backlog', blocked_on_deps: 0, retry: 2 });
    expect(db.prepare('SELECT status FROM tickets WHERE id = ?').get(dep)).toEqual({ status: 'in_progress' });
    db.prepare(`UPDATE tickets SET status = 'done', merged_at = 'x' WHERE id IN (${[dep, ...held].join(',')})`).run();
  });

  it('collapses a column to a strip that survives a reload, takes drops, and shows a flag in its count', async () => {
    const id = ticket('Fold me', { status: 'testing' });
    const flagged = ticket('Flagged', { needs_human: 1 });
    const width = (s: string) => page.evaluate<number>(`document.querySelector('[data-status="${s}"]').getBoundingClientRect().width`);
    try {
      await page.goto(base);
      await until(() => column(id), 'the card');
      await setUi('k95.collapsed', []); // Done starts folded when nothing is saved
      await page.goto(base);
      await until(() => column(id), 'the card');
      const before = await width('testing');
      await click('[data-status="done"] > legend');
      await until(async () => (await width('done')) <= 24, 'the Done strip');
      expect(await width('testing')).toBeGreaterThan(before);

      await click('[data-status="backlog"] > legend');
      expect(await page.evaluate<boolean>(`!document.querySelector('[data-status="backlog"] .card')`)).toBe(true);
      expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('[data-status="backlog"] > legend')).color`)).toBe('rgb(192, 0, 0)');
      expect(await page.evaluate<string>(`getComputedStyle(document.querySelector('[data-status="testing"] > legend')).color`)).not.toBe('rgb(192, 0, 0)');

      await page.drag(await page.center(`.card[data-id="${id}"]`), await page.center('[data-status="backlog"]'));
      await until(() => statusOf(id) === 'backlog', 'the reset');
      await until(async () => (await statusBar()) === `#${id} reset to Backlog.`, 'the status-bar message');

      await page.goto(base);
      await until(() => page.evaluate<boolean>(`!!document.querySelector('[data-status="done"].collapsed')`), 'Done still collapsed');
      await click('[data-status="done"] > legend');
      await until(async () => (await width('done')) > 24, 'Done expanded');
    } finally {
      await setUi('k95.collapsed', undefined);
      for (const t of [id, flagged]) db.prepare("UPDATE tickets SET status = 'done', merged_at = 'x', needs_human = 0 WHERE id = ?").run(t);
    }
  });
  it('a base ahead of its upstream at start shows "N commits not pushed"; Push pushes it and the field goes', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'k95-remote-'));
    const remote = (...a: string[]) => execFileSync('git', a, { cwd: bare, encoding: 'utf8' }).trim();
    const field = () => page.evaluate<string | null>(`(() => { const f = document.querySelector('.k95-unpushed'); return f.hidden ? null : f.querySelector('span').textContent; })()`);
    try {
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: bare });
      git('remote', 'add', 'origin', bare);
      git('push', '-q', '-u', 'origin', 'HEAD:main');
      for (const f of ['p1', 'p2']) {
        writeFileSync(join(repo, `${f}.txt`), 'x\n');
        git('add', `${f}.txt`);
        git('commit', '-qm', `Add ${f}`);
      }
      await countUnpushed(srv.board); // what daemon start runs
      await page.goto(base);
      await until(async () => (await field()) === '2 commits not pushed', 'the unpushed field');
      await page.evaluate(`document.querySelector('.k95-unpushed button').click()`);
      await until(async () => (await field()) === null, 'the field gone');
      expect(await statusBar()).toBe('Pushed.');
      expect(remote('rev-parse', 'main')).toBe(git('rev-parse', 'HEAD'));
    } finally {
      git('remote', 'remove', 'origin');
      rmSync(bare, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
