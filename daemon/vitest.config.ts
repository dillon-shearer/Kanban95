import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// home.ts gives every test file a throwaway home; real-home-guard.ts fails the run if the real one was touched anyway.
// Absolute paths, so the repo-root vitest.config.ts, which re-exports this one, loads the same files.
const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
export default defineConfig({ test: { setupFiles: [here('test/home.ts')], globalSetup: [here('test/real-home-guard.ts')] } });
