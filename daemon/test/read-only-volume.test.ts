import './home.ts';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb, openGlobalBrain } from '../src/db.ts';
import { start } from '../src/server.ts';
import { localHome, pointerPath } from '../src/settings.ts';
import { removeTemp } from './home.ts';

describe.skipIf(process.platform !== 'darwin')('a board on a volume mounted read-only on macOS', { timeout: 60_000 }, () => {
  const tmp = mkdtempSync(join(tmpdir(), 'k95-ro-'));
  const image = join(tmp, 'ro.dmg');
  const mount = join(tmp, 'mnt');
  const repo = join(mount, 'repo');
  const data = join(mount, 'data');
  const hdiutil = (...args: string[]) => execFileSync('hdiutil', args, { stdio: 'ignore' });
  const attach = (...flags: string[]) => hdiutil('attach', image, '-nobrowse', '-mountpoint', mount, ...flags);

  beforeAll(() => {
    mkdirSync(mount);
    hdiutil('create', '-size', '40m', '-fs', 'ExFAT', '-volname', 'RO', image);
    attach();
    mkdirSync(repo);
    mkdirSync(data);
    openDb(repo).close();
    openGlobalBrain(data).close();
    hdiutil('detach', mount);
    attach('-readonly');
  });
  afterAll(() => {
    try { hdiutil('detach', mount, '-force'); } catch { /* not attached */ }
    removeTemp(tmp);
  });

  it('names the project folder and says the drive is read-only', async () => {
    const e = await Promise.resolve().then(() => start({ repo })).then(() => null, (x: Error) => x);
    expect(e?.message).toBe(`Project folder ${repo} is on a drive mounted read-only. macOS mounts NTFS drives read-only: reformat the drive as exFAT, which works on both Windows and macOS`);
  });

  it('names the data folder and says the drive is read-only', async () => {
    const own = mkdtempSync(join(tmp, 'own-'));
    mkdirSync(localHome(), { recursive: true });
    writeFileSync(pointerPath(), data + '\n');
    const e = await Promise.resolve().then(() => start({ repo: own })).then(() => null, (x: Error) => x);
    expect(e?.message).toBe(`Data folder ${data} is on a drive mounted read-only. macOS mounts NTFS drives read-only: reformat the drive as exFAT, which works on both Windows and macOS`);
  });
});
