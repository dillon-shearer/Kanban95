import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sources } from '../src/limits.ts';
import { boardHome } from '../src/settings.ts';

const FAKE = `import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], 'ran');
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\\n');
  if (m.id === 2) process.stdout.write(JSON.stringify({ id: 2, result: { rateLimits: { primary: { usedPercent: 7, windowDurationMins: 300, resetsAt: null } } } }) + '\\n');
});
`;

function shim(dir: string) {
  mkdirSync(dir, { recursive: true });
  const marker = join(dir, 'ran.txt');
  writeFileSync(join(dir, 'fake.mjs'), FAKE);
  writeFileSync(join(dir, 'codex.cmd'), `@"${process.execPath}" "${join(dir, 'fake.mjs')}" "${marker}"\r\n`);
  writeFileSync(join(boardHome(), 'settings.json'), JSON.stringify({ paths: { codex: join(dir, 'codex.cmd').replaceAll('\\', '/') } }));
  return marker;
}

describe.skipIf(process.platform !== 'win32')('limits: configured codex path through cmd.exe', () => {
  afterEach(() => rmSync(join(boardHome(), 'settings.json'), { force: true }));

  it.each(['A&B', 'A&B C'])('runs a .cmd shim under %s as one command', async (name) => {
    mkdirSync(boardHome(), { recursive: true });
    const marker = shim(join(boardHome(), 'tools', name));
    expect(await sources.codex()).toEqual({ rateLimits: { primary: { usedPercent: 7, windowDurationMins: 300, resetsAt: null } } });
    expect(existsSync(marker)).toBe(true);
  });

  it('refuses a path cmd.exe could expand before starting anything', async () => {
    mkdirSync(boardHome(), { recursive: true });
    const marker = shim(join(boardHome(), 'tools', '50%PATH%off'));
    await expect(sources.codex()).rejects.toThrow(/codex path from Settings cannot be run safely through cmd\.exe/);
    expect(existsSync(marker)).toBe(false);
  });
});
