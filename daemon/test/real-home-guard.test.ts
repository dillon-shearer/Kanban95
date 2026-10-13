import { rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import guard from './real-home-guard.ts';

// Inside a test worker the guard's "real home" is this file's throwaway home (home.ts), so it can be driven for real.
const state = join(homedir(), '.claude.json');
const trust = (dir: string) => writeFileSync(state, JSON.stringify({ projects: { [dir.replaceAll('\\', '/')]: { hasTrustDialogAccepted: true } } }));
const env0 = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
afterEach(() => {
  for (const [k, v] of Object.entries(env0)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(state, { force: true });
});

it('fails the run when one of its tests trusts a k95- repo in the real home', () => {
  const teardown = guard();
  trust(join(tmpdir(), 'k95-abc')); // tmpdir() is now the run's own temp dir, as in every worker of the run
  expect(teardown).toThrow(/trust entry .*\/k95-run-[^/]+\/k95-abc in /);
});

it('passes when a run in another worktree trusts its own k95- repo meanwhile', () => {
  const other = join(tmpdir(), 'k95-run-other', 'k95-abc');
  const teardown = guard();
  trust(other);
  expect(teardown).not.toThrow();
});
