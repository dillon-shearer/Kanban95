import './home.ts';
import { describe, expect, it } from 'vitest';
import { until } from './cdp.ts';
import { db, page, base, ticket, column } from './ui.ts';

const open = async (id: number) => {
  await page.goto(base);
  await until(() => column(id), 'the card');
  await page.evaluate(`document.querySelector('.card[data-id="${id}"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await until(() => page.evaluate(`!!document.querySelector('[data-win="ticket-${id}"] [role=tab]')`), 'the Ticket window');
};
const tab = (id: number, name: string) =>
  page.evaluate(`[...document.querySelectorAll('[data-win="ticket-${id}"] [role=tab] a')].find((a) => a.textContent === '${name}').click()`);

describe('ui-ticket-notes-runs', { timeout: 60_000 }, () => {
  it('opens the Notes tab scrolled so the last note is in view', async () => {
    const id = ticket('Many notes');
    const long = Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n');
    for (const body of [`first\n${long}`, `second\n${long}`, 'the latest note']) {
      db.prepare("INSERT INTO notes (ticket_id, role, kind, body) VALUES (?, 'worker', 'decision', ?)").run(id, body);
    }
    await open(id);
    await tab(id, 'Notes');
    const panel = `document.querySelector('[data-win="ticket-${id}"] .k95-panel > .window-body')`;
    await until(() => page.evaluate(`${panel}.querySelectorAll('.note').length === 3`), 'three notes');
    expect(await page.evaluate(`${panel}.scrollHeight > ${panel}.clientHeight + 100`)).toBe(true);
    await until(() => page.evaluate(`(() => {
      const p = ${panel}.getBoundingClientRect(), n = [...${panel}.querySelectorAll('.note')].at(-1).getBoundingClientRect();
      return n.top >= p.top && n.bottom <= p.bottom + 1;
    })()`), 'the last note in view');
  });

  it('loads a run prompt when its row is clicked', async () => {
    const id = ticket('With a run');
    db.prepare("INSERT INTO runs (ticket_id, phase, cli, model, effort, prompt_rendered, ended_at, outcome, scrollback) VALUES (?, 'execute', 'claude', 'm', 'medium', 'THE RENDERED PROMPT', 'x', 'exit', 'THE OUTPUT')").run(id);
    await open(id);
    await tab(id, 'Runs');
    const win = `[data-win="ticket-${id}"]`;
    await until(() => page.evaluate(`!!document.querySelector('${win} tbody tr')`), 'the run row');
    await page.evaluate(`document.querySelector('${win} tbody tr').click()`);
    await until(() => page.evaluate(`document.querySelector('${win} .k95-pre').textContent === 'THE RENDERED PROMPT'`), 'the prompt text');
    await page.evaluate(`[...document.querySelectorAll('${win} tbody button')].find((b) => b.textContent === 'Output').click()`);
    await until(() => page.evaluate(`document.querySelector('${win} .k95-pre').textContent === 'THE OUTPUT'`), 'the output text');
  });
});
