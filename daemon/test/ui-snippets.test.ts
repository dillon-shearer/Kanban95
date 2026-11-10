import './home.ts';
import { readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { globalPath, projectPath } from '../src/settings.ts';
import { until } from './cdp.ts';
import { base, page, repo, srv } from './ui.ts';

afterAll(() => {
  rmSync(globalPath('snippets'), { force: true });
  rmSync(dirname(projectPath('snippets', repo)), { recursive: true, force: true });
});

const stored = async (scope = 'global') =>
  (await (await fetch(`http://127.0.0.1:${srv.port}/api/config/snippets?scope=${scope}`, { headers: { cookie: `k95=${srv.secret}` } })).json()).value;
const q = <T>(js: string) => page.evaluate<T>(js);
const box = `document.querySelector('[data-win="settings"] #snippets')`;
const rowNames = () => q<string[]>(`[...${box}.querySelectorAll('.k95-snippets label')].map((l) => l.textContent)`);
const button = (row: number, label: string) => `[...${box}.querySelectorAll('.k95-snippets .field-row')[${row}].querySelectorAll('button')].find((b) => b.textContent === '${label}')`;
const dialogButton = (label: string) => `[...document.querySelector('dialog[open]').querySelectorAll('button')].find((b) => b.textContent === '${label}').click()`;
const status = () => q<string>(`document.querySelector('.k95-board .status-bar-field').textContent`);

async function fill(name: string, text: string) {
  await until(() => q(`!!document.querySelector('dialog[open] #snippet-name')`), 'the snippet form');
  await q(`document.querySelector('#snippet-name').value = ${JSON.stringify(name)}; document.querySelector('#snippet-text').value = ${JSON.stringify(text)}`);
  await q(dialogButton('Save'));
}
async function openPrompts() {
  await q(`[...document.querySelectorAll('[data-win="settings"] [role=tab] a')].find((t) => t.textContent === 'Prompts').click()`);
  await until(() => q(`!!${box}`), 'the Snippets box');
}

describe('ui-snippets', { timeout: 60_000 }, () => {
  it('sits between Preferences and Templates with an Add button and the file path', async () => {
    await page.goto(base);
    await until(() => q(`!!document.querySelector('[data-win="board"]')`), 'the board');
    await q(`document.querySelector('[data-icon="Settings"]').dispatchEvent(new MouseEvent('dblclick'))`);
    await until(() => q(`!!document.querySelector('[data-win="settings"] [role=tab]')`), 'the Settings tabs');
    await openPrompts();
    const legends = await q<string[]>(`[...document.querySelectorAll('[data-win="settings"] legend')].map((l) => l.textContent)`);
    expect(legends).toEqual(['Preferences', 'Snippets', 'Templates']);
    expect(await q(`${box}.textContent`)).toContain(globalPath('snippets'));
    expect(await q(`!!${box}.querySelector('#snippet-add')`)).toBe(true);
  });

  it('Add with a name and text stores the snippet off', async () => {
    await q(`${box}.querySelector('#snippet-add').click()`);
    await fill('greet', 'Say hello.');
    await until(async () => (await stored()).length === 1, 'the snippet on disk');
    expect(await stored()).toEqual([{ name: 'greet', text: 'Say hello.', on: false }]);
    await until(async () => (await rowNames()).length === 1, 'the new row');
    expect(await q(`${box}.querySelector('#snippet-0').checked`)).toBe(false);
    expect(await q(`!!${button(0, 'Edit')} && !!${button(0, 'Delete')}`)).toBe(true);
  });

  it('ticking the checkbox stores it on with no Save click, by mouse and by keyboard', async () => {
    await q(`${box}.querySelector('label[for="snippet-0"]').click()`);
    await until(async () => (await stored())[0].on === true, 'on true on disk');
    await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await q(`${box}.querySelector('#snippet-0').focus()`);
    expect(await q(`document.activeElement?.id`)).toBe('snippet-0');
    for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: type === 'keyDown' ? ' ' : undefined });
    await until(async () => (await stored())[0].on === false, 'on false on disk after Space');
  });

  it('Edit to a name another snippet has is refused with the daemon message and the stored list is unchanged', async () => {
    await q(`${box}.querySelector('#snippet-add').click()`);
    await fill('bye', 'Say goodbye.');
    await until(async () => (await stored()).length === 2, 'two snippets on disk');
    const before = await stored();
    await q(`${button(1, 'Edit')}.click()`);
    await fill('greet', 'Say goodbye.');
    await until(async () => (await status()).includes('listed twice'), 'the refusal in the status bar');
    expect(await stored()).toEqual(before);
    expect(await rowNames()).toEqual(['greet', 'bye']);
  });

  it('Delete asks first; Cancel keeps it, Delete removes it', async () => {
    await q(`${button(1, 'Delete')}.click()`);
    await until(() => q(`!!document.querySelector('dialog[open]')`), 'the confirm dialog');
    await q(dialogButton('Cancel'));
    expect((await stored()).map((s: { name: string }) => s.name)).toEqual(['greet', 'bye']);
    await q(`${button(1, 'Delete')}.click()`);
    await until(() => q(`!!document.querySelector('dialog[open]')`), 'the confirm dialog');
    await q(dialogButton('Delete'));
    await until(async () => (await stored()).length === 1, 'one snippet on disk');
    expect((await stored())[0].name).toBe('greet');
  });

  it('on This project with no copy the box is disabled; after Customize a change goes to the project copy only', async () => {
    const global = readFileSync(globalPath('snippets'), 'utf8');
    await q(`document.querySelector('#scope-project').click()`);
    await until(() => q(`!!document.querySelector('[data-win="settings"] .k95-scope-bar[data-file="snippets"]')`), 'the snippets scope bar');
    expect(await q(`document.querySelector('fieldset.k95-scoped[data-file="snippets"]').disabled`)).toBe(true);
    const bar = `document.querySelector('.k95-scope-bar[data-file="snippets"] button')`;
    expect(await q(`${bar}.textContent`)).toBe('Customize for this project');
    await q(`${bar}.click()`);
    await until(() => q(`document.querySelector('fieldset.k95-scoped[data-file="snippets"]')?.disabled === false`), 'the box enabled');
    await q(`${box}.querySelector('label[for="snippet-0"]').click()`);
    await until(async () => (await stored('project'))[0].on === true, 'project copy on true');
    expect(readFileSync(globalPath('snippets'), 'utf8')).toBe(global);
    expect(readFileSync(projectPath('snippets', repo), 'utf8')).not.toBe(global);
  });
});
