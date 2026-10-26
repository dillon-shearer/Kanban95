import { describe, expect, it } from 'vitest';
import { summary } from './changed.ts';

describe('test:changed final block', () => {
  it('names a unit-pass failure after the second pass passed', () => {
    const out = summary([
      { name: 'unit', status: 1, report: { failed: ['test/a.test.ts > suite > breaks'], errors: [] } },
      { name: 'pty/browser/restart', status: 0, report: { failed: [], errors: [] } },
    ]);
    expect(out).toEqual([
      'test:changed: summary of every vitest pass that ran:',
      '  unit: failed, 1 failed test',
      '    FAIL test/a.test.ts > suite > breaks',
      '  pty/browser/restart: passed',
      'test:changed: FAILED',
    ]);
  });

  it('a pass that failed with every test passing gives the error and its file', () => {
    const out = summary([{ name: 'pty/browser/restart', status: 1, report: { failed: [], errors: [{ message: 'write EPIPE\n    at Socket', file: 'test/lifecycle-flow.test.ts' }] } }]);
    expect(out.slice(1)).toEqual([
      '  pty/browser/restart: failed with every test passing, 1 error',
      '    ERROR write EPIPE (test/lifecycle-flow.test.ts)',
      'test:changed: FAILED',
    ]);
  });

  it('a failed pass with no report still says failed', () => {
    expect(summary([{ name: 'unit', status: 1 }])[1]).toMatch(/^ {2}unit: failed \(exit 1\)/);
    expect(summary([{ name: 'unit', status: 0 }]).at(-1)).toBe('test:changed: passed');
  });
});
