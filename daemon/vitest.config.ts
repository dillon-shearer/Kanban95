import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// home.ts gives every test file a throwaway home; real-home-guard.ts fails the run if the real one was touched anyway.
// Absolute paths, so the repo-root vitest.config.ts, which re-exports this one, loads the same files.
const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
// The ui-*.test.ts files each start a daemon and a browser; they run as a second group, after the rest, so their load
// does not time out the other files, and one at a time: parallel Chromes on Windows still lock their profile dirs at
// afterAll (rmSync EPERM).
const UI = 'test/ui-*.test.ts';
// restart.test.ts runs alone, last: next to the ConPTY tests in other workers it once crashed one of them with
// native heap corruption (0xC0000374) inside node-pty.
const isolated = 'test/restart.test.ts';
export default defineConfig({
  test: {
    setupFiles: [here('test/home.ts')],
    globalSetup: [here('test/real-home-guard.ts')],
    projects: [
      { extends: true, test: { name: 'unit', include: ['test/**/*.test.ts'], exclude: [UI, isolated] } },
      { extends: true, test: { name: 'ui', include: [UI], sequence: { groupOrder: 1 }, fileParallelism: false } },
      { extends: true, test: { name: 'restart', include: [isolated], sequence: { groupOrder: 2 } } },
    ],
  },
});
