import { describe, expect, it } from 'vitest';
import { workers } from './projects.ts';

describe('test worker count from the machine', () => {
  it('gives one worker per 4 GB, and pty and browser files at most four', () => {
    expect(workers(8, 8)).toEqual({ unit: 2, heavy: 2 });
    expect(workers(8, 15.9)).toEqual({ unit: 3, heavy: 3 });
    expect(workers(8, 16)).toEqual({ unit: 4, heavy: 4 });
    expect(workers(16, 64)).toEqual({ unit: 15, heavy: 4 });
  });

  it('never goes below one worker or uses every core', () => {
    expect(workers(1, 64)).toEqual({ unit: 1, heavy: 1 });
    expect(workers(8, 7.9)).toEqual({ unit: 1, heavy: 1 });
    expect(workers(4, 32)).toEqual({ unit: 3, heavy: 3 });
  });
});
