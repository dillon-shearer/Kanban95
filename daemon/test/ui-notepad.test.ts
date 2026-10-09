// In headless Edge or Chrome against a running daemon (setup in ui.ts): the Notepad window.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sessions } from '../src/launcher.ts';
import { until } from './cdp.ts';
import { repo, page, base, ticket, click } from './ui.ts';

describe('ui-notepad', { timeout: 60_000 }, () => {
  it('autosaves the Notepad, brings the text back after a reload, and starts a brainstorm from the notes, resetting a template that predates them on request', async () => {
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

    const button = `[...document.querySelectorAll('[data-win="notepad"] button')].find((b) => b.textContent === 'New brainstorm from notes')`;
    expect(await page.evaluate(`${button}.title`)).toBe('The selection, or the whole page when nothing is selected');
    const seeded = (notes: string) => [...sessions.values()].some((s) => s.ticketId === null && readFileSync(join(s.dir, 'prompt.md'), 'utf8').includes(`## Starting notes\n\n${notes}\n\n`));
    // An up-to-date template: only the selection goes, with no dialog.
    await page.evaluate(`document.querySelector('${area}').setSelectionRange(10, 28)`);
    await page.evaluate(`${button}.click()`);
    await until(() => seeded('fix the login bug'), 'the seeded brainstorm');
    expect(await page.evaluate(`!!document.querySelector('dialog')`)).toBe(false);
    for (const s of sessions.values()) s.pty.kill();
    await until(() => sessions.size === 0, 'the brainstorm ended');

    // A repo copy from before {{mission}}: the board asks; Reset and start puts the shipped default back and sends the whole page.
    const tpl = join(repo, '.kanban95', 'templates', 'brainstorm.md');
    const OLD = '# Brainstorm\n\n{{tools}}\n';
    writeFileSync(tpl, OLD);
    await page.evaluate(`document.querySelector('${area}').setSelectionRange(0, 0)`);
    await page.evaluate(`${button}.click()`);
    await until(() => page.evaluate(`document.querySelector('dialog')?.textContent.includes('predates starting notes') ?? false`), 'the reset dialog');
    expect(readFileSync(tpl, 'utf8')).toBe(OLD); // nothing is overwritten before the click
    await page.evaluate(`[...document.querySelectorAll('dialog button')].find((b) => b.textContent === 'Reset and start').click()`);
    await until(() => seeded(TEXT), 'the brainstorm with the whole page');
    expect(readFileSync(tpl, 'utf8')).toBe(readFileSync(resolve(import.meta.dirname, '..', '..', 'templates', 'brainstorm.md'), 'utf8'));
    const listed = await page.evaluate<{ ticket_id: number | null; role: string }[]>(`fetch('/api/sessions').then((r) => r.json())`);
    expect(listed.some((s) => s.ticket_id === null && s.role === 'planner')).toBe(true);
    for (const s of sessions.values()) s.pty.kill();

    // Over 256 KB: the daemon answers 413 and the window says so; the file keeps the last good text.
    await page.evaluate(`(() => { const t = document.querySelector('${area}'); t.value = 'x'.repeat(256 * 1024 + 1); t.dispatchEvent(new Event('input')); })()`);
    await until(() => page.evaluate(`document.querySelector('[data-win="notepad"] .status-bar-field').textContent.includes('256 KB')`), 'the refusal in the Notepad');
    expect(readFileSync(file, 'utf8')).toBe(TEXT);
    rmSync(file);
  });
});
