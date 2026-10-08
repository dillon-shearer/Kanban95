import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// home.ts gives every test file a throwaway home; real-home-guard.ts fails the run if the real one was touched anyway.
// Absolute paths and `root`, so the repo-root vitest.config.mts, which re-exports this one, runs the same files the same way.
const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
const files = readdirSync(here('test')).filter((f) => f.endsWith('.test.ts'));
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
    // The default reporter can leave a test that passed on its retry out of its output; this line never does.
    reporters: ['default', {
      onTestCaseResult: (t) => { const n = t.diagnostic()?.retryCount; if (n) console.log(`RETRIED x${n}: ${t.module.moduleId} > ${t.fullName}`); },
    }],
    projects: [
      // The browser files set their own 60 s per test (the slowest measured ~16 s).
      project('browser', browser, { retry: 1 }),
      // A pty test measured up to 4.5 s against the 5 s default; launches and git under load need headroom.
      project('pty', pty, { testTimeout: 30_000, hookTimeout: 30_000 }),
      project('unit', unit),
    ],
  },
});
