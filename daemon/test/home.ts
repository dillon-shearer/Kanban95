// Loaded before every test file (vitest.config.ts). Each file gets a throwaway home directory, so no test can write the
// operator's ~/.claude.json or read their ~/.kanban95/models.json. os.homedir() reads these variables on every call.
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

/**
 * Removes a test's temp dir after its tests. Under load a killed agent or Edge can hold a file in it past the retries
 * (about 7 s, inside the 10 s default hook limit): that is a leftover, not a failed test, so it warns. The run's
 * `k95-run-*` dir (real-home-guard.ts) holds every temp dir, and the OS temp cleanup takes what is left.
 */
export function removeTemp(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'ENOTEMPTY') throw e;
    console.warn(`left ${dir}: ${code}`);
  }
}

const home = mkdtempSync(join(tmpdir(), 'k95-home-'));
process.env.USERPROFILE = home;
process.env.HOME = home;
process.env.KANBAN95_HOME = join(home, '.kanban95');
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;
if (homedir() !== home) throw new Error(`test home not in effect: os.homedir() is ${homedir()}; refusing to run against the operator's home`);
afterAll(() => removeTemp(home));
