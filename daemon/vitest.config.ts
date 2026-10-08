import { defineConfig } from 'vitest/config';

// home.ts gives every test file a throwaway home; real-home-guard.ts fails the run if the real one was touched anyway.
export default defineConfig({ test: { setupFiles: ['test/home.ts'], globalSetup: ['test/real-home-guard.ts'] } });
