import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { removeTemp } from './home.ts';
import { checkCli, fakeCli } from './fake-cli.ts';

const bin = mkdtempSync(join(tmpdir(), 'k95-bin-'));
afterAll(() => removeTemp(bin));

describe('a stand-in CLI that cannot start fails its file at once, naming why', () => {
  it('a missing script', () => {
    const t0 = Date.now();
    expect(() => fakeCli(bin, 'gone', 'gone.mjs')).toThrow(/stand-in CLI gone cannot start: exit 1: .*gone\.mjs/);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it('a script that does not parse', () => {
    writeFileSync(join(bin, 'bad.mjs'), 'export const = 1;\n');
    expect(() => fakeCli(bin, 'bad', 'bad.mjs')).toThrow(/stand-in CLI bad cannot start: exit 1: SyntaxError/);
  });

  it('a name not on PATH', () => {
    const t0 = Date.now();
    expect(() => checkCli('k95-nowhere', bin)).toThrow(/stand-in CLI k95-nowhere cannot start: /);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it.skipIf(process.platform === 'win32')('a shim that is not executable', () => {
    writeFileSync(join(bin, 'ok.mjs'), '');
    fakeCli(bin, 'ok', 'ok.mjs');
    chmodSync(join(bin, 'ok'), 0o644);
    expect(() => checkCli('ok', bin + delimiter + process.env.PATH)).toThrow(/stand-in CLI ok cannot start: .*EACCES/);
  });

  it('a working one passes', () => {
    writeFileSync(join(bin, 'fine.mjs'), 'console.log(1);\n');
    expect(() => fakeCli(bin, 'fine', 'fine.mjs')).not.toThrow();
  });
});
