// In headless Edge or Chrome against a running daemon (setup in ui.ts): voice input: the model download dialog and local transcription.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MANIFEST, modelDir, status } from '../src/voice.ts';
import { until } from './cdp.ts';
import { srv, db, page, base, click, CACHE, WAV } from './ui.ts';

describe('ui-voice', { timeout: 60_000 }, () => {
  it('shows the download dialog on the first mic press and fetches nothing until OK', async () => {
    rmSync(modelDir(MANIFEST), { recursive: true, force: true });
    await page.goto(base);
    await click('#start'); // Start → New ticket: a window with text fields, so with mics
    await page.evaluate(`[...document.querySelectorAll('.k95-menu li')].find((li) => li.textContent === 'New ticket').click()`);
    await until(() => page.evaluate(`!!document.querySelector('[data-win="ticket-new"] .k95-mic')`), 'a mic button');
    await click('[data-win="ticket-new"] .k95-mic');
    const dlg = await until(() => page.evaluate<string>(`document.querySelector('dialog[open]')?.textContent ?? ''`), 'the download dialog');
    expect(dlg).toContain(MANIFEST.id);
    expect(dlg).toContain(`${MANIFEST.source}/tree/${MANIFEST.revision}`);
    expect(dlg).toContain(MANIFEST.files.find((f) => f.path.includes('decoder'))!.sha256);
    await page.evaluate(`[...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === 'Cancel').click()`);
    await until(() => page.evaluate('!document.querySelector("dialog[open]")'), 'the dialog to close');
    expect(db.prepare("SELECT count(*) AS n FROM audit WHERE tool = 'voice.download'").get()).toEqual({ n: 0 });
    expect(existsSync(modelDir(MANIFEST))).toBe(false);
  });

  it('transcribes the bundled WAV with the local model', { timeout: 600_000 }, async () => {
    if (existsSync(CACHE)) cpSync(CACHE, modelDir(MANIFEST), { recursive: true });
    // The daemon verifies every file's SHA-256, cached or not; a missing or tampered file is fetched again.
    const r = await fetch(`${base}api/voice/download`, { method: 'POST', headers: { cookie: `k95=${srv.secret}` } });
    expect(r.status, await r.clone().text()).toBe(200);
    expect(status().downloaded).toBe(true);
    if (!existsSync(CACHE)) cpSync(modelDir(MANIFEST), CACHE, { recursive: true });

    await page.goto(base);
    const wav = readFileSync(WAV).toString('base64');
    const text = await page.evaluate<string>(`(async () => {
      const { transcribe } = await import('/voice.js');
      const bytes = Uint8Array.from(atob('${wav}'), (c) => c.charCodeAt(0));
      return transcribe(new Blob([bytes], { type: 'audio/wav' }));
    })()`);
    // The fixture is Windows TTS saying "Please add a test for the merge queue."
    expect(text.toLowerCase()).toMatch(/add a test for the merge queue/);
  });
});
