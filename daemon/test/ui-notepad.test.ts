// In headless Edge or Chrome against a running daemon (setup in ui.ts): the Notepad window.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sessions } from '../src/launcher.ts';
import { until } from './cdp.ts';
import { repo, page, base, ticket, click } from './ui.ts';

describe('ui-notepad', { timeout: 60_000 }, () => {
  it('autosaves the Notepad, brings the text back after a reload, and starts a brainstorm from the selection', async () => {
    const file = join(repo, '.kanban95', 'notepad.md');
    const area = '[data-win="notepad"] textarea';
    const TEXT = 'draft one\nfix the login bug';
    await page.goto(base);
    await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
    await page.evaluate(`document.querySelector('[data-icon="Notepad"]').dispatchEvent(new MouseEvent('dblclick'))`);
    await until(() => page.evaluate(`document.querySelector('${area}')?.readOnly === false`), 'the loaded Notepad');
    expect(await page.evaluate(`document.querySelector('${area}').nextElementSibling?.classList.contains('k95-mic')`)).toBe(true);
    await click(area);
    await page.send('Input.insertText', { text: TEXT });
    await until(() => existsSync(file) && readFileSync(file, 'utf8') === TEXT, 'notepad.md after the pause');

    await page.goto(base + '?notepad');
    await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board after reload');
    await page.evaluate(`document.querySelector('#start').click()`);
    await page.evaluate(`[...document.querySelectorAll('.k95-menu *')].find((e) => e.textContent === 'Notepad').click()`);
    await until(() => page.evaluate(`document.querySelector('${area}')?.value === ${JSON.stringify(TEXT)}`), 'the text after reload');

    await page.evaluate(`document.querySelector('${area}').setSelectionRange(10, 28)`);
    await page.evaluate(`[...document.querySelectorAll('[data-win="notepad"] button')].find((b) => b.textContent === 'New brainstorm from selection').click()`);
    await until(() => [...sessions.values()].some((s) => s.ticketId === null && readFileSync(join(s.dir, 'prompt.md'), 'utf8').includes('## Starting notes\n\nfix the login bug\n')), 'the seeded brainstorm');
    for (const s of sessions.values()) s.pty.kill();

    // Over 256 KB: the daemon answers 413 and the window says so; the file keeps the last good text.
    await page.evaluate(`(() => { const t = document.querySelector('${area}'); t.value = 'x'.repeat(256 * 1024 + 1); t.dispatchEvent(new Event('input')); })()`);
    await until(() => page.evaluate(`document.querySelector('[data-win="notepad"] .status-bar-field').textContent.includes('256 KB')`), 'the refusal in the Notepad');
    expect(readFileSync(file, 'utf8')).toBe(TEXT);
    rmSync(file);
  });
});
