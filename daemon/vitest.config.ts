import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// home.ts gives every test file a throwaway home; real-home-guard.ts fails the run if the real one was touched anyway.
// Absolute paths and `root`, so the repo-root vitest.config.mts, which re-exports this one, runs the same files the same way.
const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
// restart.test.ts runs alone, last: next to the ConPTY tests in other workers it once crashed one of them with
// native heap corruption (0xC0000374) inside node-pty.
const isolated = ['restart.test.ts'];
const files = readdirSync(here('test')).filter((f) => f.endsWith('.test.ts') && !isolated.includes(f));
const imports = (f: string, mod: string) => readFileSync(here(`test/${f}`), 'utf8').includes(`from '${mod}'`);
// Headless Edge (cdp.ts) is what times out under load, so only those files get a retry; a unit failure is always real.
const browser = files.filter((f) => imports(f, './cdp.ts'));
const pty = files.filter((f) => !browser.includes(f) && imports(f, '../src/launcher.ts'));
const unit = files.filter((f) => !browser.includes(f) && !pty.includes(f));
const project = (name: string, list: string[], o: object = {}) => ({ extends: true, test: { name, include: list.map((f) => `test/${f}`), ...o } });

export default defineConfig({
  root: here('.'),
  test: {
    setupFiles: [here('test/home.ts')],
    globalSetup: [here('test/real-home-guard.ts')],
    // Four workers: lifecycle.test.ts alone is the critical path (docs/ARCHITECTURE.md → Working on the board); more workers
    // only add ptys and browsers fighting for the CPU.
    maxWorkers: 4,
    // The default reporter leaves a test that passed on its retry out of its output; this line never does.
    reporters: ['default', {
      onTestCaseResult: (t) => { const n = t.diagnostic()?.retryCount; if (n) console.log(`RETRIED x${n}: ${t.module.moduleId} > ${t.fullName}`); },
    }],
    projects: [
      // A pty test measured up to 3 s alone against the 5 s default; launches and git under load need headroom.
      project('pty', pty, { testTimeout: 30_000, hookTimeout: 30_000 }),
      project('unit', unit),
      // The ui-*.test.ts files each start a daemon and a browser; they run as a second group, after the rest, so their load
      // does not time out the other files, and one at a time: parallel Chromes on Windows still lock their profile dirs at
      // afterAll (rmSync EPERM). They set their own 60 s per test (the slowest measured 13 s alone).
      project('browser', browser, { retry: 1, sequence: { groupOrder: 1 }, fileParallelism: false }),
      project('restart', isolated, { sequence: { groupOrder: 2 } }),
    ],
  },
});
