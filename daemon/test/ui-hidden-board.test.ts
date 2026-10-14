// In headless Edge or Chrome: a board page in a hidden tab, as a board window the shell hides on a switch, keeps its
// /events client, so its board stays awake; once the page is gone the board sleeps.
import './home.ts';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { changed } from '../src/lifecycle.ts';
import { sources } from '../src/limits.ts';
import { start } from '../src/server.ts';
import { writeConfig } from '../src/settings.ts';
import { browser, until, type Page } from './cdp.ts';
import { removeTemp } from './home.ts';

const lines: string[] = [];
const closes = () => lines.filter((l) => l.startsWith('KANBAN95 close='));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const repo = mkdtempSync(join(tmpdir(), 'k95-hidden-'));
let srv: Awaited<ReturnType<typeof start>>;
let page: Page | undefined;

async function cover(p: Page) {
  const { targetInfo } = await p.send('Target.getTargetInfo');
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${process.env.K95_CDP_PORT}/json/version`)).json() as { webSocketDebuggerUrl: string };
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
  let seq = 0;
  const call = (method: string, params: object) => new Promise<any>((ok) => {
    const id = ++seq;
    ws.addEventListener('message', function reply(m) {
      const msg = JSON.parse(String(m.data));
      if (msg.id !== id) return;
      ws.removeEventListener('message', reply);
      ok(msg.result);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const { targetId } = await call('Target.createTarget', { url: 'about:blank', browserContextId: targetInfo.browserContextId });
  await call('Target.activateTarget', { targetId });
  return async () => {
    await call('Target.closeTarget', { targetId });
    ws.close();
  };
}

beforeAll(async () => {
  execFileSync('git', ['init', '-q'], { cwd: repo });
  sources.claude = async () => 'Current session: 1% used · resets Oct 8, 7:59pm (America/New_York)';
  sources.codex = async () => { throw new Error('codex app-server could not start: ENOENT'); };
  writeConfig('settings', { sleepAfterMinutes: 0 }, repo);
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => (lines.push(String(chunk)), true));
  srv = await start({ repo, shell: true });
  page = await browser();
  const base = `http://127.0.0.1:${srv.port}/`;
  await page.send('Page.navigate', { url: `${base}?k95=${srv.secret}` });
  await until(() => page!.evaluate<boolean>(`location.href === ${JSON.stringify(base)} && !!document.querySelector('.k95-board .status-bar-field')`), 'the board', 60_000);
}, 90_000);
afterAll(async () => {
  vi.restoreAllMocks();
  await page?.close();
  await srv?.close();
  removeTemp(repo);
}, 60_000);

describe('ui-hidden-board', { timeout: 60_000 }, () => {
  it('a hidden board page keeps its /events client and its board awake; closing the page lets the board sleep', async () => {
    const uncover = await cover(page!);
    try {
      await until(async () => (await page!.evaluate<string>('document.visibilityState')) === 'hidden', 'the tab to be hidden');
      writeConfig('settings', { sleepAfterMinutes: 0.01 }, repo);
      changed(null);
      await wait(1500);
      expect(await page!.evaluate<string>('document.visibilityState')).toBe('hidden');
      expect(closes()).toEqual([]);
    } finally {
      await uncover();
    }
    await page!.close();
    page = undefined;
    await until(() => closes().length > 0, 'the board to sleep once its page is gone');
    expect(closes()).toEqual([`KANBAN95 close=${repo}\n`]);
  });
});
