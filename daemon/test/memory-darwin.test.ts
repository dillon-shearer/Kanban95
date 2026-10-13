import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const os = vi.hoisted(() => ({ freemem: vi.fn(() => 42) }));
const cp = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock('node:os', async (orig) => ({ ...(await orig<typeof import('node:os')>()), freemem: os.freemem }));
vi.mock('node:child_process', async (orig) => ({ ...(await orig<typeof import('node:child_process')>()), execFileSync: cp.execFileSync }));

const { freeMemory, parseVmStat } = await import('../src/memlog.ts');

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                5093.
Pages active:                             88880.
Pages inactive:                           87491.
Pages speculative:                          750.
Pages throttled:                              0.
Pages wired down:                        161006.
Pages purgeable:                           4053.
`;
const BYTES = (5093 + 87491 + 4053 + 750) * 16384;

const platform = process.platform;
const setPlatform = (p: string) => Object.defineProperty(process, 'platform', { value: p });
let clock = 0;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime((clock += 60_000));
  os.freemem.mockClear();
  cp.execFileSync.mockReset();
});
afterEach(() => {
  setPlatform(platform);
  vi.useRealTimers();
});

describe('free memory on macOS', () => {
  it('parses vm_stat into free + inactive + purgeable + speculative pages times the page size', () => {
    expect(parseVmStat(VM_STAT)).toBe(BYTES);
  });

  it('rejects output without a page size or a counted field', () => {
    expect(() => parseVmStat(VM_STAT.replace(/\(page size.*\)/, ''))).toThrow(/page size/);
    expect(() => parseVmStat(VM_STAT.replace(/Pages purgeable.*\n/, ''))).toThrow(/purgeable/);
  });

  it('reads vm_stat on darwin and never os.freemem, and caches it for a few seconds', () => {
    setPlatform('darwin');
    cp.execFileSync.mockReturnValue(VM_STAT);
    expect(freeMemory()).toBe(BYTES);
    expect(freeMemory()).toBe(BYTES);
    expect(cp.execFileSync).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    freeMemory();
    expect(cp.execFileSync).toHaveBeenCalledTimes(2);
    expect(os.freemem).not.toHaveBeenCalled();
  });

  it('reads os.freemem on win32 and never runs vm_stat', () => {
    setPlatform('win32');
    expect(freeMemory()).toBe(42);
    expect(os.freemem).toHaveBeenCalledTimes(1);
    expect(cp.execFileSync).not.toHaveBeenCalled();
  });

  it('falls back to os.freemem when vm_stat fails', () => {
    setPlatform('darwin');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    cp.execFileSync.mockImplementation(() => {
      throw new Error('spawn vm_stat ENOENT');
    });
    expect(freeMemory()).toBe(42);
    expect(freeMemory()).toBe(42);
    expect(os.freemem).toHaveBeenCalledTimes(2);
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
});
