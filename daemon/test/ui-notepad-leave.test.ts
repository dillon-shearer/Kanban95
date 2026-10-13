// In headless Edge or Chrome against a running daemon (setup in ui.ts): a Notepad edit still waiting out its 500 ms pause
// is saved before a board switch is asked for, and sent on pagehide when under 64 KB.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { entryPath, register } from '../src/boards.ts';
import { writeProjects } from '../src/settings.ts';
import { until } from './cdp.ts';
import { base, click, page, repo, srv } from './ui.ts';

let own: string, other: string;
let ownEntry: { repo: string; port: number; shell: number | null };
let sleeper: ChildProcess;
const write = process.stdout.write.bind(process.stdout);
const file = () => join(repo, '.kanban95', 'notepad.md');
const area = '[data-win="notepad"] textarea';

beforeAll(() => {
  own = realpathSync.native(repo);
  other = mkdtempSync(join(tmpdir(), 'k95-other-'));
  writeProjects([{ path: own, colour: 100 }, { path: other, colour: 200 }], own);
  srv.board.shellId = 123;
  srv.board.shell = true;
  ownEntry = JSON.parse(readFileSync(entryPath(process.pid), 'utf8'));
  register(ownEntry.repo, ownEntry.port, 123);
  sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  writeFileSync(entryPath(sleeper.pid!), JSON.stringify({ pid: sleeper.pid, repo: other, port: 1, started: '', shell: 123, agents: 0 }));
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...rest) => (String(chunk).startsWith('KANBAN95 ') ? true : write(chunk, ...(rest as []))));
});
afterAll(() => {
  vi.restoreAllMocks();
  register(ownEntry.repo, ownEntry.port, ownEntry.shell);
  rmSync(entryPath(sleeper.pid!), { force: true });
  sleeper.kill();
  srv.board.shellId = null;
  srv.board.shell = false;
  rmSync(other, { recursive: true, force: true, maxRetries: 5 });
  rmSync(file(), { force: true });
});

const openNotepad = async () => {
  await page.goto(base);
  await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
  await page.evaluate(`document.querySelector('[data-icon="Notepad"]').dispatchEvent(new MouseEvent('dblclick'))`);
  await until(() => page.evaluate(`document.querySelector('${area}')?.readOnly === false`), 'the loaded Notepad');
};
const type = (value: string) => page.evaluate(`(() => { const t = document.querySelector('${area}'); t.value = ${JSON.stringify(value)}; t.dispatchEvent(new Event('input')); })()`);

describe('ui-notepad-leave', { timeout: 60_000 }, () => {
  it('saves the pending edit before asking the shell to switch, so switching back shows it', async () => {
    rmSync(file(), { force: true });
    await openNotepad();
    await page.evaluate(`(() => { window.order = []; const f = window.fetch;
      window.fetch = (u, o) => {
        if (u === '/api/notepad' && o?.method === 'PUT') { window.order.push('put'); return f(u, o).then((r) => { window.order.push('saved'); return r; }); }
        if (u.startsWith('/api/projects/switch')) window.order.push('switch');
        return f(u, o); }; })()`);
    await type('typed just before the switch');
    await click('#switch');
    await until(() => page.evaluate(`!!document.querySelector('.k95-switch-row')`), 'the switch popup');
    await page.evaluate(`document.querySelector('.k95-switch-row').click()`);
    await until(() => page.evaluate(`window.order.includes('switch')`), 'the switch request');
    expect(await page.evaluate('window.order')).toEqual(['put', 'saved', 'switch']);
    expect(readFileSync(file(), 'utf8')).toBe('typed just before the switch');

    await openNotepad();
    expect(await page.evaluate(`document.querySelector('${area}').value`)).toBe('typed just before the switch');
  });

  it('sends a pending edit under 64 KB on pagehide and leaves a larger one to the pre-switch save', async () => {
    rmSync(file(), { force: true });
    await openNotepad();
    await type('typed just before leaving');
    await page.goto('about:blank');
    await until(() => existsSync(file()) && readFileSync(file(), 'utf8') === 'typed just before leaving', 'notepad.md after pagehide');

    await openNotepad();
    await type('x'.repeat(64 * 1024));
    await page.goto('about:blank');
    await new Promise((r) => setTimeout(r, 1000));
    expect(readFileSync(file(), 'utf8')).toBe('typed just before leaving');
  });
});
