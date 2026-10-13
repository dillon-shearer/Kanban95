// In headless Edge or Chrome against a running daemon (setup in ui.ts): a terminal the operator opened from a card closes
// when the ticket is moved by hand, and stays "(ended)" when its agent died.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { killSession, sessions } from '../src/launcher.ts';
import { until } from './cdp.ts';
import { srv, db, page, base, ticket, column } from './ui.ts';

const auth = () => ({ cookie: `k95=${srv.secret}` });
const settings = join(process.env.USERPROFILE!, '.kanban95', 'settings.json');
const win = (wid: string) => page.evaluate<boolean>(`!!document.querySelector('[data-win="${wid}"]')`);

async function openFromCard(id: number) {
  expect((await fetch(`${base}api/tickets/${id}/launch`, { method: 'POST', headers: auth() })).status).toBe(200);
  const s = await until(async () => ((await (await fetch(`${base}api/sessions`, { headers: auth() })).json()) as { id: number; ticket_id: number }[]).find((x) => x.ticket_id === id), 'the session');
  await until(() => [...sessions.values()].find((x) => x.key === s.id)?.scrollback().includes('FAKE'), 'the fake agent');
  await until(() => page.evaluate(`!!document.querySelector('.card[data-id="${id}"]')`), 'the card');
  await page.evaluate(`document.querySelector('.card[data-id="${id}"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 50 }))`);
  const sub = `[...document.querySelectorAll('.k95-menu li.sub')].find((li) => li.firstChild?.textContent === 'Terminal').querySelectorAll('li')`;
  await until(() => page.evaluate(`!!document.querySelector('.k95-menu li.sub')`), 'the Terminal menu');
  await page.evaluate(`${sub}[0].click()`);
  await until(() => page.evaluate(`!!document.querySelector('[data-win="term-${s.id}"] .xterm')`), 'the terminal');
  return s;
}

describe('ui-moved-terminal', { timeout: 60_000 }, () => {
  beforeAll(() => writeFileSync(settings, JSON.stringify({ terminals: { auto: [] } })));
  afterAll(() => rmSync(settings, { force: true }));

  it('closes a terminal opened from the card when the ticket is moved to Testing', async () => {
    const id = ticket('Move me');
    await page.goto(base);
    await until(() => column(id), 'the card');
    const s = await openFromCard(id);
    expect((await fetch(`${base}api/tickets/${id}`, { method: 'PATCH', headers: { ...auth(), 'content-type': 'application/json' }, body: JSON.stringify({ status: 'testing' }) })).status).toBe(200);
    await until(async () => !(await win(`term-${s.id}`)), 'the terminal to close', 5000);
    await until(() => sessions.size === 0, 'the agent to exit');
    db.prepare("UPDATE tickets SET status = 'done', merged_at = 'x', needs_human = 0 WHERE id = ?").run(id);
  });

  it('keeps a terminal whose agent died open, marked (ended)', async () => {
    const id = ticket('Die');
    await page.goto(base);
    await until(() => column(id), 'the card');
    const s = await openFromCard(id);
    killSession([...sessions.values()].find((x) => x.key === s.id)!);
    await until(() => page.evaluate(`document.querySelector('[data-win="term-${s.id}"]').classList.contains('ended')`), 'the ended terminal');
    await until(() => (db.prepare('SELECT outcome FROM runs WHERE ticket_id = ?').get(id) as { outcome: string | null }).outcome === 'exit', 'outcome exit');
    await new Promise((r) => setTimeout(r, 2500));
    expect(await win(`term-${s.id}`)).toBe(true);
    expect(await page.evaluate<string>(`document.querySelector('[data-win="term-${s.id}"] .title-bar-text').textContent`)).toMatch(/\(ended\)$/);
    await until(() => sessions.size === 0, 'the agent to exit');
    db.prepare("UPDATE tickets SET status = 'done', merged_at = 'x', needs_human = 0 WHERE id = ?").run(id);
  });
});
