import './home.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { until } from './cdp.ts';
import { page, base } from './ui.ts';
import { removeTemp } from './home.ts';

const win = process.platform === 'win32';
const PATH = process.env.PATH;
const bin = mkdtempSync(join(tmpdir(), 'k95-bin-'));
const git = join(bin, win ? 'git.cmd' : 'git');
afterAll(() => {
  process.env.PATH = PATH;
  removeTemp(bin);
});

const rows = () => page.evaluate<string[]>(`[...document.querySelectorAll('[data-win="settings"] #requirements .k95-requirement')].map((r) => r.textContent)`);

describe('ui-settings-requirements', { timeout: 60_000 }, () => {
  it('Settings > Agents lists the requirements, and Check again asks the daemon again', async () => {
    writeFileSync(git, win ? '@echo git version 9.9.9.fake\r\n' : '#!/bin/sh\necho git version 9.9.9.fake\n', { mode: 0o755 });
    process.env.PATH = [bin, win ? join(process.env.SystemRoot ?? 'C:\Windows', 'System32') : '/bin'].join(delimiter);
    await page.goto(base);
    await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
    await page.evaluate(`document.querySelector('[data-icon="Settings"]').dispatchEvent(new MouseEvent('dblclick'))`);
    await until(async () => (await rows()).length === 3, 'the requirements');
    const first = await rows();
    expect(first[0]).toBe('git: found (git version 9.9.9.fake)');
    expect(first[1]).toMatch(/^Claude Code: missingInstall it with .*then run claude once and log in\.$/);
    expect(first[2]).toMatch(/^Codex: missingInstall it with npm install -g @openai\/codex/);

    rmSync(git);
    await page.evaluate(`document.querySelector('[data-win="settings"] #requirements .k95-requirements-check').click()`);
    await until(async () => (await rows())[0]?.startsWith('git: missing'), 'git missing after Check again');
    process.env.PATH = PATH;
  });
});
