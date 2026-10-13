// In headless Edge or Chrome against a running daemon (setup in ui.ts): the Board window: drag and drop, redraws, launch refusals, the runner button and Push.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { countUnpushed } from '../src/lifecycle.ts';
import { until } from './cdp.ts';
import { repo, srv, db, page, base, git, ticket, statusOf, column, statusBar, click } from './ui.ts';

describe('ui-board', { timeout: 60_000 }, () => {
  it('a drop on any column moves the card there without a reload', async () => {
    const id = ticket('Drag me');
    await page.goto(base);
    await until(() => column(id), 'the card');
    await page.evaluate('window.__noReload = true');

    await page.drag(await page.center(`.card[data-id="${id}"]`), await page.center('[data-status="testing"] .cards'));
    await until(async () => (await column(id)) === 'testing', 'the card in Testing');
    expect(statusOf(id)).toBe('testing');

    await page.drag(await page.center(`.card[data-id="${id}"]`), await page.center('[data-status="in_progress"] .cards'));
    await until(async () => (await column(id)) === 'in_progress', 'the card in In Progress');
    expect(statusOf(id)).toBe('in_progress');
    expect(await page.evaluate('window.__noReload')).toBe(true);
    db.prepare("UPDATE tickets SET status = 'done', merged_at = 'x' WHERE id = ?").run(id); // out of the way of the next tests
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
      await until(() => page.evaluate(`!!document.querySelector('.k95-unpushed')`), 'the status bar');
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
