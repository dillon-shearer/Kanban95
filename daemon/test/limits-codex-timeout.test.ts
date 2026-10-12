import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sources } from '../src/limits.ts';
import { boardHome } from '../src/settings.ts';

const HUNG = `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
process.stdin.on('data', () => {});
process.stdin.on('end', () => process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\\n'));
setInterval(() => {}, 1000);
writeFileSync(process.argv[2], JSON.stringify([process.pid, kid.pid]));
`;

const QUITS = `import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], JSON.stringify([process.pid]));
createInterface({ input: process.stdin }).on('line', () => {
  process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\\n', () => process.exit(0));
});
`;

const ANSWERS = `import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], JSON.stringify([process.pid]));
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\\n');
  if (m.id === 2) process.stdout.write(JSON.stringify({ id: 2, result: { rateLimits: { primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: null } } } }) + '\\n');
});
`;

const dir = () => join(boardHome(), 'tools', 'codex-timeout');
const pidsFile = () => join(dir(), 'pids.json');

function standIn(script: string) {
  mkdirSync(dir(), { recursive: true });
  rmSync(pidsFile(), { force: true });
  writeFileSync(join(dir(), 'fake.mjs'), script);
  writeFileSync(join(dir(), 'codex.cmd'), `@"${process.execPath}" "${join(dir(), 'fake.mjs')}" "${pidsFile()}"\r\n`);
  writeFileSync(join(boardHome(), 'settings.json'), JSON.stringify({ paths: { codex: join(dir(), 'codex.cmd').replaceAll('\\', '/') } }));
}

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

async function pids() {
  await vi.waitFor(() => expect(existsSync(pidsFile())).toBe(true), { timeout: 10_000, interval: 20 });
  await vi.waitFor(() => JSON.parse(readFileSync(pidsFile(), 'utf8')), { timeout: 2_000, interval: 20 });
  return JSON.parse(readFileSync(pidsFile(), 'utf8')) as number[];
}

describe.skipIf(process.platform !== 'win32')('limits: codex app-server lifetime', () => {
  afterEach(() => {
    vi.useRealTimers();
    rmSync(join(boardHome(), 'settings.json'), { force: true });
  });

  it('kills an app-server that ignores EOF, and its children, at the timeout, every poll', async () => {
    standIn(HUNG);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    for (let i = 0; i < 2; i++) {
      rmSync(pidsFile(), { force: true });
      const asked = sources.codex();
      const caught = asked.catch((e: Error) => e);
      const [root, kid] = await pids();
      expect([alive(root), alive(kid)]).toEqual([true, true]);
      vi.advanceTimersByTime(30_000);
      expect(((await caught) as Error).message).toBe('codex app-server timed out');
      await vi.waitFor(() => expect([alive(root), alive(kid)]).toEqual([false, false]), { timeout: 10_000, interval: 50 });
    }
  }, 40_000);

  it('rejects without crashing when the app-server exits before the next write', async () => {
    standIn(QUITS);
    await expect(sources.codex()).rejects.toThrow(/codex app-server (exited|closed its input)/);
  }, 20_000);

  it('returns a normal answer without waiting for the timeout', async () => {
    standIn(ANSWERS);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    expect(await sources.codex()).toEqual({ rateLimits: { primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: null } } });
  }, 20_000);
});
