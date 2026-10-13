// Importing this file stubs the runner's free-memory source above the launch floor for every test in the importing file, and
// restores it after each one, so a test that expects a launch does not depend on how much memory the machine has free.
import { afterEach, beforeEach } from 'vitest';
import { memory } from '../src/lifecycle.ts';

let free = memory.free;
beforeEach(() => {
  free = memory.free;
  memory.free = () => Number.MAX_SAFE_INTEGER;
});
afterEach(() => {
  memory.free = free;
});
