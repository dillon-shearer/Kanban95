// In headless Edge or Chrome against a running daemon (setup in ui.ts): which phases open a terminal on their own
// (Settings > Board), and reaching a hidden session from its card.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sessions } from '../src/launcher.ts';
import { until } from './cdp.ts';
import { srv, db, page, base, ticket, column, statusOf } from './ui.ts';

const launch = (id: number) => fetch(`${base}api/tickets/${id}/launch`, { method: 'POST', headers: { cookie: `k95=${srv.secret}` } });
const live = async () => (await (await fetch(`${base}api/sessions`, { headers: { cookie: `k95=${srv.secret}` } })).json()) as { id: number; ticket_id: number; phase: string; grant_id: number }[];
// Every terminal window the page ever opened, also one the board closed again after its agent reported.
const watch = () => page.evaluate(`(() => { window.opened = [];
  new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => n.dataset?.win?.startsWith('term-') && window.opened.push(n.dataset.win))))
    .observe(document.body, { childList: true, subtree: true }); })()`);
const opened = () => page.evaluate<string[]>('window.opened');

describe('ui-hidden-terminals', { timeout: 60_000 }, () => {
  it('with test unchecked, opens the execute terminal but not the tester\'s; card > Terminal opens the live test session', async () => {
    const settings = join(process.env.USERPROFILE!, '.kanban95', 'settings.json');
    writeFileSync(settings, JSON.stringify({ terminals: { auto: ['plan', 'execute'] } }));
    const models = join(process.env.USERPROFILE!, '.kanban95', 'models.json');
    const was = readFileSync(models, 'utf8');
    const cfg = JSON.parse(was);
    cfg.claude.test.model = 'hold'; // a tester that stays live until revoked
    writeFileSync(models, JSON.stringify(cfg));
    try {
      const id = ticket('Quiet tester', { model: 'submit' });
      await page.goto(base);
      await until(() => column(id), 'the card');
      await watch();
      expect((await launch(id)).status).toBe(200);
      const test = await until(async () => (await live()).find((s) => s.ticket_id === id && s.phase === 'test'), 'the test session');
      const all = await until(async () => (await opened()).length && opened(), 'the execute terminal');
      expect(all.length).toBe(1);
      expect(all[0]).not.toBe(`term-${test.id}`);
      // Give the board time to have opened the tester's had it wanted to.
      await new Promise((r) => setTimeout(r, 1000));
      expect(await page.evaluate(`!!document.querySelector('[data-win="term-${test.id}"]')`)).toBe(false);
      expect(statusOf(id)).toBe('testing');

      await page.evaluate(`document.querySelector('.card[data-id="${id}"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 50 }))`);
      const sub = `[...document.querySelectorAll('.k95-menu li.sub')].find((li) => li.firstChild?.textContent === 'Terminal').querySelectorAll('li')`;
      expect(await page.evaluate(`[...${sub}].map((li) => li.textContent)`)).toEqual(['test · hold']);
      await page.evaluate(`${sub}[0].click()`);
      await until(() => page.evaluate(`!!document.querySelector('[data-win="term-${test.id}"] .xterm')`), 'the tester\'s terminal');

      await fetch(`${base}api/grants/${test.grant_id}`, { method: 'DELETE', headers: { cookie: `k95=${srv.secret}` } });
      await until(() => sessions.size === 0, 'the tester to exit');
      db.prepare("UPDATE tickets SET status = 'done', merged_at = 'x', needs_human = 0 WHERE id = ?").run(id);
    } finally {
      writeFileSync(models, was);
      rmSync(settings, { force: true });
    }
  });

  it('with execute and test unchecked in Settings > Board, a launch opens no terminal and the tester still takes the ticket to Done', async () => {
    const settings = join(process.env.USERPROFILE!, '.kanban95', 'settings.json');
    rmSync(settings, { force: true }); // all defaults, also on a retry
    const id = ticket('No windows', { model: 'submit' });
    await page.goto(base);
    await until(() => column(id), 'the card');
    await page.evaluate(`document.querySelector('[data-icon="Settings"]').dispatchEvent(new MouseEvent('dblclick'))`);
    await page.evaluate(`[...document.querySelectorAll('[data-win="settings"] [role=tab] a')].find((t) => t.textContent === 'Board').click()`);
    await until(() => page.evaluate(`!!document.querySelector('#term-auto-execute')`), 'the Board tab');
    expect(await page.evaluate(`['plan', 'execute', 'test'].map((p) => document.querySelector('#term-auto-' + p).checked)`)).toEqual([true, true, true]);
    await page.evaluate(`document.querySelector('#term-auto-execute').click()`);
    await until(() => { try { return JSON.parse(readFileSync(settings, 'utf8')).terminals.auto.join() === 'plan,test'; } catch { return false; } }, 'settings.json');
    await page.evaluate(`document.querySelector('#term-auto-test').click()`);
    await until(() => { try { return JSON.parse(readFileSync(settings, 'utf8')).terminals.auto.join() === 'plan'; } catch { return false; } }, 'settings.json');

    await watch();
    expect((await launch(id)).status).toBe(200);
    await until(() => statusOf(id) === 'done', 'Done', 30_000);
    expect(await opened()).toEqual([]);
    db.prepare("UPDATE tickets SET merged_at = coalesce(merged_at, 'x') WHERE id = ?").run(id);
    await until(() => sessions.size === 0, 'the agents to exit');
    rmSync(settings);
  });
});
