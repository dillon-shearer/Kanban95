// Loaded before every test file (vitest.config.ts). Each file gets a throwaway home directory, so no test can write the
// operator's ~/.claude.json or read their ~/.kanban95/models.json. os.homedir() reads these variables on every call.
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterAll } from 'vitest';

const home = mkdtempSync(join(tmpdir(), 'k95-home-'));
process.env.USERPROFILE = home;
process.env.HOME = home;
process.env.KANBAN95_HOME = join(home, '.kanban95');
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;
if (homedir() !== home) throw new Error(`test home not in effect: os.homedir() is ${homedir()}; refusing to run against the operator's home`);
// A pty file's agents ran in worktrees under this home, and Windows can hold them for seconds after the ptys exit under load.
// Past that, a home under this run's `k95-run-*` dir is left to the run's teardown (real-home-guard.ts), which removes it once
// every worker has ended and reports any agent process still running from the run.
afterAll(() => {
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 });
  } catch (e) {
    if (!basename(dirname(home)).startsWith('k95-run-')) throw e;
  }
});
