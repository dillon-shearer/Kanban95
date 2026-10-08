import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// home.ts gives every test file a throwaway home; real-home-guard.ts fails the run if the real one was touched anyway.
// Absolute paths, so the repo-root vitest.config.ts, which re-exports this one, loads the same files.
const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
const shared = { setupFiles: [here('test/home.ts')], globalSetup: [here('test/real-home-guard.ts')] };
// restart.test.ts runs alone, after the rest: next to the ConPTY tests in other workers it once crashed one of them with
// native heap corruption (0xC0000374) inside node-pty.
const isolated = ['test/restart.test.ts'];
export default defineConfig({
  test: {
    projects: [
      { test: { ...shared, name: 'daemon', root: here('.'), exclude: ['**/node_modules/**', ...isolated] } },
      { test: { ...shared, name: 'restart', root: here('.'), include: isolated, sequence: { groupOrder: 1 } } },
    ],
  },
});
