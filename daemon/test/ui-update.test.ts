import './home.ts';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { until } from './cdp.ts';
import { VERSION } from '../src/update.ts';
import { base, db, menuItems, page, srv } from './ui.ts';

const report = (body: unknown) => fetch(`${base}api/update/shell`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: `k95=${srv.secret}` },
  body: JSON.stringify(body),
});
const offer = { state: 'available', version: '9.0.0', current: VERSION };
const q = <T>(js: string) => page.evaluate<T>(js);
const dialog = () => q<{ text: string; note: string; buttons: string[]; disabled: boolean[]; bar: string } | null>(`(() => {
  const d = document.querySelector('#update-dialog[open]');
  if (!d) return null;
  const buttons = [...d.querySelectorAll('button')];
  return { text: d.querySelector('#update-text').textContent, note: d.querySelector('#update-note').textContent,
    buttons: buttons.map((b) => b.textContent), disabled: buttons.map((b) => b.disabled), bar: d.querySelector('.progress-indicator-bar').style.width };
})()`);
const press = (label: string) => q(`[...document.querySelectorAll('#update-dialog button')].find((b) => b.textContent === ${JSON.stringify(label)}).click()`);
const open = async () => {
  await page.goto(base);
  await until(() => q(`!!document.querySelector('[data-win="board"]')`), 'the board');
};
const shellLines = () => {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => (lines.push(String(s)), true));
  return { lines, restore: () => spy.mockRestore() };
};
const settingsFile = () => join(process.env.KANBAN95_HOME!, 'settings.json');

describe('ui-update', { timeout: 60_000 }, () => {
  beforeAll(() => { srv.board.shell = true; });
  afterEach(() => {
    srv.board.update = undefined;
    db.exec('DELETE FROM tickets');
    rmSync(settingsFile(), { force: true });
  });

  it('a newer release opens the dialog with both versions; Later closes it and it stays closed until the next check', async () => {
    await open();
    expect((await report(offer)).status).toBe(204);
    await until(async () => (await dialog()) !== null, 'the update dialog');
    expect(await dialog()).toMatchObject({ text: `Kanban95 v9.0.0 is available (you have v${VERSION}).`, buttons: ['Update now', 'Later'], disabled: [false, false] });

    await press('Later');
    await until(async () => (await dialog()) === null && srv.board.update === undefined, 'the dialog to close');
    await open();
    await q(`document.getElementById('start').click()`);
    await until(async () => (await menuItems()).includes(`Kanban95 v${VERSION}`), 'the version in the Start menu');
    expect(await dialog()).toBeNull();

    await report(offer);
    await until(async () => (await dialog()) !== null, 'the dialog on the next check');
  });

  it('Update now is refused while agents run, naming the count; once they are done it downloads in the same dialog', async () => {
    await open();
    db.exec("INSERT INTO tickets (title, status) VALUES ('a', 'in_progress'), ('b', 'testing')");
    await report(offer);
    await until(async () => (await dialog()) !== null, 'the update dialog');
    await press('Update now');
    await until(async () => (await dialog())?.note === 'Not updated: 2 agents are running. Update when they finish.', 'the refusal');
    expect(await dialog()).toMatchObject({ disabled: [false, false] });

    db.exec("UPDATE tickets SET status = 'backlog'");
    const shell = shellLines();
    try {
      await press('Update now');
      await until(() => shell.lines.some((l) => l.startsWith('KANBAN95 update=')), 'the shell to be told');
    } finally {
      shell.restore();
    }
    await until(async () => (await dialog())?.text === 'Downloading Kanban95 v9.0.0...', 'the download');
    await report({ state: 'downloading', done: 50, total: 200 });
    await until(async () => (await dialog())?.bar === '25%', 'the progress');
    expect((await dialog())?.disabled).toEqual([true, true]);
    await report({ state: 'failed', error: 'The download failed: reset' });
    await until(async () => (await dialog())?.note === 'The download failed: reset', 'the failure');
    expect((await dialog())?.disabled).toEqual([false, false]);
  });

  it('Settings -> Board saves the automatic check and Check for updates reports up to date', async () => {
    await open();
    await q(`document.querySelector('[data-icon="Settings"]').dispatchEvent(new MouseEvent('dblclick'))`);
    await until(() => q(`!!document.querySelector('[data-win="settings"] [role=tab]')`), 'Settings');
    await q(`[...document.querySelectorAll('[data-win="settings"] [role=tab] a')].find((t) => t.textContent === 'Board').click()`);
    await until(() => q(`!!document.querySelector('#update-check')`), 'the Updates box');
    expect(await q(`document.querySelector('#update-check').checked`)).toBe(true);
    await q(`document.querySelector('#update-check').click()`);
    await until(() => { try { return JSON.parse(readFileSync(settingsFile(), 'utf8')).updateCheck === false; } catch { return false; } }, 'the setting');

    const shell = shellLines();
    try {
      await q(`document.querySelector('#update-now').click()`);
      await until(() => shell.lines.some((l) => l.startsWith('KANBAN95 checknow=')), 'the shell to be asked');
    } finally {
      shell.restore();
    }
    await report({ state: 'current', current: VERSION });
    await until(async () => (await q<string>(`document.querySelector('#update-status').textContent`)) === `Kanban95 v${VERSION} is up to date.`, 'up to date');
    expect(await dialog()).toBeNull();
  });
});
