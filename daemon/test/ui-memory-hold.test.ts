// In headless Edge or Chrome against a running daemon (setup in ui.ts): the runner's memory hold in the status bar.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { describe, expect, it } from 'vitest';
import { memory, tick } from '../src/lifecycle.ts';
import { until } from './cdp.ts';
import { srv, db, page, base, ticket, column } from './ui.ts';

describe('ui-memory-hold', { timeout: 60_000 }, () => {
  it('says the runner waits for memory while GET /api/runner reports the hold, and drops it once memory is back', async () => {
    const free = memory.free;
    const running = ticket('Running', { status: 'in_progress' }); // keeps the runner on without an agent
    const waiting = ticket('Waiting');
    const line = () => page.evaluate<string>(`document.querySelector('.k95-runner').textContent`);
    try {
      memory.free = () => 1.5 * 1024 ** 3;
      await fetch(`${base}api/runner`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie: `k95=${srv.secret}` }, body: '{"on":true}' });
      await page.goto(base);
      await until(() => column(waiting), 'the card');
      await until(async () => (await line()).endsWith('; waiting for memory (1.5 GB free)'), 'the waiting line');
      expect(await line()).toBe(`Running: #${running} (1 of 3; 1 of 1 candidates left); waiting for memory (1.5 GB free)`);

      db.prepare("UPDATE tickets SET status = 'done', merged_at = 'x' WHERE id = ?").run(waiting); // so the next tick launches nothing
      memory.free = () => Number.MAX_SAFE_INTEGER;
      tick(srv.board);
      await until(async () => !(await line()).includes('waiting for memory'), 'the waiting text gone');
    } finally {
      memory.free = free;
      await fetch(`${base}api/runner`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie: `k95=${srv.secret}` }, body: '{"on":false}' });
      db.prepare(`UPDATE tickets SET status = 'done', merged_at = 'x' WHERE id IN (${running}, ${waiting})`).run();
    }
  });
});
