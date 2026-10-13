// In headless Edge or Chrome against a running daemon (setup in ui.ts): the Switch board popup shows another board's
// count of flagged tickets, read from that board's running-registry entry, only when it is above zero.
import './home.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { entryPath, register } from '../src/boards.ts';
import { writeProjects } from '../src/settings.ts';
import { until } from './cdp.ts';
import { base, click, page, repo, srv } from './ui.ts';

const dir = (p: string) => mkdtempSync(join(tmpdir(), p));
let own: string, flagged: string, calm: string;
let ownEntry: { repo: string; port: number; shell: number | null };
const sleepers: ChildProcess[] = [];
const fake = (repo: string, attention: number) => {
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  sleepers.push(c);
  writeFileSync(entryPath(c.pid!), JSON.stringify({ pid: c.pid, repo, port: 1, started: '', shell: 123, agents: 1, attention }));
};

beforeAll(() => {
  own = realpathSync.native(repo);
  [flagged, calm] = [dir('k95-flagged-'), dir('k95-calm-')];
  writeProjects([{ path: own, colour: '#123456' }, { path: flagged, colour: 200 }, { path: calm, colour: 300 }], own);
  srv.board.shellId = 123;
  srv.board.shell = true;
  ownEntry = JSON.parse(readFileSync(entryPath(process.pid), 'utf8'));
  register(ownEntry.repo, ownEntry.port, 123);
});
afterAll(() => {
  register(ownEntry.repo, ownEntry.port, ownEntry.shell);
  for (const c of sleepers) {
    rmSync(entryPath(c.pid!), { force: true });
    c.kill();
  }
  srv.board.shellId = null;
  srv.board.shell = false;
  for (const d of [flagged, calm]) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

const counts = async () => {
  await page.goto(base);
  await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
  await click('#switch');
  await until(() => page.evaluate(`!!document.querySelector('.k95-switch')`), 'the popup');
  return page.evaluate<[string, string | null, string | null][]>(`[...document.querySelectorAll('.k95-switch-row')].map((r) =>
    [r.dataset.project, r.querySelector('.attn')?.textContent ?? null, r.querySelector('.attn') && getComputedStyle(r.querySelector('.attn')).color])`);
};

describe('ui-switch-attention', { timeout: 60_000 }, () => {
  it('shows no count when no other board has a flagged ticket', async () => {
    expect(await counts()).toEqual([[flagged, null, null], [calm, null, null]]);
  });

  it('shows the count in the alert colour on the row of a board with flagged tickets, and none on a board with zero', async () => {
    fake(flagged, 2);
    fake(calm, 0);
    expect(await counts()).toEqual([[flagged, '2', 'rgb(192, 0, 0)'], [calm, null, null]]);
  });
});
