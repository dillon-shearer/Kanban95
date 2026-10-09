// In headless Edge or Chrome against a running daemon (setup in ui.ts): the Ticket window's Tags field and the card's tag badges.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { describe, expect, it } from 'vitest';
import { until } from './cdp.ts';
import { db, page, base, ticket, column } from './ui.ts';

describe('ui-tags', { timeout: 60_000 }, () => {
  it('saving the Tags field stores the normalised tags and redraws the card badges after the CLI badge, without a reload', async () => {
    const id = ticket('Tag me', { tags: 'old' });
    await page.goto(base);
    await until(() => column(id), 'the card');
    const card = `document.querySelector('.card[data-id="${id}"]')`;
    const badges = `[...${card}.querySelectorAll('.badge')].map((b) => b.className + ':' + b.textContent)`;
    expect(await page.evaluate(badges)).toContain('badge tag:old');
    await page.evaluate(`${card}.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    const win = `[data-win="ticket-${id}"]`;
    const field = `[...document.querySelectorAll('${win} .field-row-stacked')].find((r) => r.textContent.startsWith('Tags')).querySelector('input')`;
    await until(() => page.evaluate(`!!(${field})`), 'the Tags field');
    expect(await page.evaluate(`${field}.value`)).toBe('old');
    await page.evaluate(`(() => { const f = ${field}; f.value = 'UI, Daemon'; [...document.querySelectorAll('${win} button')].find((b) => b.textContent === 'Save').click(); })()`);
    await until(() => (db.prepare('SELECT tags FROM tickets WHERE id = ?').get(id) as { tags: string }).tags === 'ui daemon', 'the tags stored');
    await until(() => page.evaluate(`JSON.stringify(${badges}.filter((b) => b.startsWith('badge tag:'))) === '["badge tag:ui","badge tag:daemon"]'`), 'the new tag badges');
    // After the model, effort and CLI badges.
    const all = (await page.evaluate(badges)) as string[];
    expect(all.indexOf('badge tag:ui')).toBe(3);
  });
});
