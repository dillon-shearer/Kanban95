import { describe, expect, it, vi } from 'vitest';

const handlers: Array<(d: string) => void> = [];
vi.mock('node-pty', () => ({
  spawn: () => ({
    onData: (f: (d: string) => void) => handlers.push(f),
    onExit: () => {},
    write: () => {},
    resize: () => {},
    kill: () => {},
  }),
}));

const { spawnPty } = await import('../src/pty.ts');
const MiB = 1024 * 1024;

describe('pty scrollback', () => {
  it('stays under 2 MiB when the output has no newlines', () => {
    const { scrollback } = spawnPty('fake', [], { cwd: process.cwd(), env: {} });
    const emit = handlers.at(-1)!;
    const chunk = '\r\x1b[2Kx'.repeat(16 * 1024);
    let sent = 0;
    while (sent <= 5 * MiB) { emit(chunk); sent += chunk.length; }
    const out = scrollback();
    expect(out.length).toBeLessThanOrEqual(2 * MiB);
    expect(out.length).toBeGreaterThan(MiB);
  });

  it('cuts at a newline when one is inside the last 2 MiB', () => {
    const { scrollback } = spawnPty('fake', [], { cwd: process.cwd(), env: {} });
    const emit = handlers.at(-1)!;
    emit('a'.repeat(3 * MiB) + '\nTAIL' + 'b'.repeat(MiB));
    expect(scrollback()).toBe('TAIL' + 'b'.repeat(MiB));
  });
});
