import { chmodSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { sortTests, workers } from './test/projects.ts';

// home.ts gives every test file a throwaway home; real-home-guard.ts fails the run if the real one was touched anyway.
// Absolute paths and `root`, so the repo-root vitest.config.mts, which re-exports this one, runs the same files the same way.
const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
if (process.platform === 'darwin') {
  const prebuilds = join(dirname(createRequire(import.meta.url).resolve('node-pty/package.json')), 'prebuilds');
  for (const a of ['arm64', 'x64']) try { chmodSync(join(prebuilds, `darwin-${a}`, 'spawn-helper'), 0o755); } catch {}
}
const { unit: unitFiles, pty, browser, restart } = sortTests(here('test'));
const { unit, heavy } = workers();
const project = (name: string, list: string[], o: object = {}) => ({ extends: true, test: { name, include: list.map((f) => `test/${f}`), ...o } });

export default defineConfig({
  root: here('.'),
  test: {
    setupFiles: [here('test/home.ts')],
    globalSetup: [here('test/real-home-guard.ts')],
    // Worker counts come from the machine (test/projects.ts, docs/ARCHITECTURE.md → Working on the board).
    maxWorkers: unit,
    // The default reporter leaves a test that passed on its retry out of its output; this line never does.
    reporters: ['default', {
      onTestCaseResult: (t) => { const n = t.diagnostic()?.retryCount; if (n) console.log(`RETRIED x${n}: ${t.module.moduleId} > ${t.fullName}`); },
    }],
    projects: [
      project('unit', unitFiles),
      // A pty test measured up to 3 s alone against the 5 s default; launches and git under load need headroom.
      project('pty', pty, { testTimeout: 30_000, hookTimeout: 30_000, retry: 1, maxWorkers: heavy, sequence: { groupOrder: 1 } }),
      // The ui-*.test.ts files each start a daemon and open a tab in one headless browser, which browser-setup.ts starts once
      // per run. They run after the unit and pty groups, so their load does not time out the other files, and in
      // parallel like the rest. They set their own 60 s per test (the slowest measured 13 s alone).
      project('browser', browser, { retry: 1, maxWorkers: heavy, sequence: { groupOrder: 2 }, globalSetup: [here('test/browser-setup.ts')] }),
      project('restart', restart, { sequence: { groupOrder: 3 } }),
    ],
  },
});
