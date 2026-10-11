// The harness itself: a browser that fails to start must fail the test fast and leave nothing behind.
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect, test } from 'vitest';

const profiles = () => readdirSync(tmpdir()).filter((f) => f.startsWith('k95-browser-'));

test('a browser that quits before its DevTools port fails at once and its profile is removed', async () => {
  // Node stands in for a broken browser: it rejects --headless=new and exits. cdp.ts reads KANBAN95_BROWSER on import.
  process.env.KANBAN95_BROWSER = process.execPath;
  const { launch } = await import('./cdp.ts');
  const before = profiles();
  const t0 = Date.now();
  await expect(launch()).rejects.toThrow(/quit before opening its DevTools port/);
  expect(Date.now() - t0).toBeLessThan(15_000);
  expect(profiles()).toEqual(before);
});
