import { describe, expect, it } from 'vitest';
import { workers } from './projects.ts';

describe('test worker count from the machine', () => {
  it('gives one worker per 2 GB, at most six', () => {
    expect(workers(8, 8)).toBe(4);
    expect(workers(8, 11.9)).toBe(5);
    expect(workers(16, 64)).toBe(6);
  });

  it('never goes below one worker or uses every core', () => {
    expect(workers(1, 64)).toBe(1);
    expect(workers(8, 3.9)).toBe(1);
    expect(workers(4, 32)).toBe(3);
  });
});
