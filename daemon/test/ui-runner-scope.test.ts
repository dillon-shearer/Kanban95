import './home.ts';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { until } from './cdp.ts';
import { start } from '../src/server.ts';
import { globalPath, projectPath } from '../src/settings.ts';
import { removeTemp } from './home.ts';
import { page, base, repo, srv } from './ui.ts';

const W = '[data-win="settings"]';
const field = () => page.evaluate<{ value: string; disabled: boolean; label: string } | null>(`(() => {
  const f = document.querySelector('#concurrency');
  return f && { value: f.value, disabled: f.matches(':disabled'), label: document.querySelector('label[for=concurrency]').textContent };
})()`);
const runnerOf = (port: number, secret: string) => fetch(`http://127.0.0.1:${port}/api/runner`, { headers: { cookie: `k95=${secret}` } }).then((r) => r.json());

async function openAgents(url: string) {
  await page.goto(url);
  await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
  await page.evaluate(`document.querySelector('[data-icon="Settings"]').dispatchEvent(new MouseEvent('dblclick'))`);
  await page.evaluate(`[...document.querySelectorAll('${W} [role=tab] a')].find((t) => t.textContent === 'Agents').click()`);
  await until(async () => !!(await field()), 'the Agents tab');
}
const scope = (id: string) => page.evaluate(`(() => { const r = document.querySelector('#${id}'); r.checked = true; r.dispatchEvent(new Event('change')); })()`);

let other: string | undefined;
let second: Awaited<ReturnType<typeof start>> | undefined;
afterAll(async () => {
  await second?.close();
  if (other) removeTemp(other);
  rmSync(projectPath('settings', repo), { force: true });
  rmSync(globalPath('settings'), { force: true });
}, 60_000);

describe('ui-runner-scope', { timeout: 60_000 }, () => {
  it('Tickets running at once follows the scope switch: greyed under This project until Customize, saved globally for a second board', async () => {
    await openAgents(base);
    expect(await field()).toEqual({ value: '3', disabled: false, label: 'Tickets running at once' });

    await scope('scope-project');
    await until(async () => (await field())?.disabled === true, 'the greyed field');
    await page.evaluate(`document.querySelector('${W} .k95-scope-bar[data-file=settings] button').click()`);
    await until(async () => (await field())?.disabled === false, 'the field after Customize');
    rmSync(projectPath('settings', repo));

    await openAgents(base);
    await page.evaluate(`(() => { const f = document.querySelector('#concurrency'); f.value = '2'; f.closest('fieldset').querySelector('button').click(); })()`);
    await until(() => { try { return JSON.parse(readFileSync(globalPath('settings'), 'utf8')).concurrency === 2; } catch { return false; } }, 'the global settings.json');
    expect((await runnerOf(srv.port, srv.secret)).concurrency).toBe(2);

    other = mkdtempSync(join(tmpdir(), 'k95-'));
    const git = (...a: string[]) => execFileSync('git', a, { cwd: other });
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Op Erator');
    git('config', 'user.email', 'op@example.com');
    writeFileSync(join(other, 'a.txt'), 'a\n');
    git('add', 'a.txt');
    git('commit', '-qm', 'init');
    second = await start({ repo: other });
    const url = `http://127.0.0.1:${second.port}/`;
    await page.send('Page.navigate', { url: `${url}?k95=${second.secret}` });
    await until(() => page.evaluate(`document.readyState === 'complete' && location.href === ${JSON.stringify(url)}`), 'the second board');
    await openAgents(url);
    expect((await field())?.value).toBe('2');
    expect((await runnerOf(second.port, second.secret)).concurrency).toBe(2);
  });
});
