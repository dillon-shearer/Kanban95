// gitNotRun tells a git that never ran (retry it) from git's verdict on the repo (a conflict, a refusal), on real child errors.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { gitNotRun } from '../src/git.ts';

const dir = mkdtempSync(join(tmpdir(), 'k95-notrun-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const thrown = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e;
  }
  throw new Error('did not throw');
};
// A process that exits the way one Windows failed to start does: status 0xC0000142, nothing printed.
const dllInitFailed = join(dir, 'dll-init-failed.mjs');
writeFileSync(dllInitFailed, 'process.exit(-1073741502);\n');

describe('gitNotRun', () => {
  it('a git that ran and refused (not a repo, a conflict) is a verdict, not a process that never ran', async () => {
    expect(gitNotRun(thrown(() => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, stdio: 'pipe' })))).toBe(false);
    const repo = join(dir, 'repo');
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, stdio: 'pipe', encoding: 'utf8' });
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    writeFileSync(join(repo, 'f'), 'a\n');
    git('add', 'f');
    git('commit', '-qm', 'a');
    git('checkout', '-qb', 'side');
    writeFileSync(join(repo, 'f'), 'side\n');
    git('commit', '-qam', 'side');
    git('checkout', '-q', 'main');
    writeFileSync(join(repo, 'f'), 'main\n');
    git('commit', '-qam', 'main');
    expect(gitNotRun(thrown(() => git('merge', '--no-edit', 'side')))).toBe(false);
    const async = await promisify(execFile)('git', ['merge', '--no-edit', 'side'], { cwd: repo }).catch((e) => e);
    expect(gitNotRun(async)).toBe(false);
  });

  it('a process Windows failed to start, sync or async, or that exited with no word, never ran', async () => {
    expect(gitNotRun(thrown(() => execFileSync(process.execPath, [dllInitFailed], { stdio: 'pipe' })))).toBe(true);
    expect(gitNotRun(await promisify(execFile)(process.execPath, [dllInitFailed]).catch((e) => e))).toBe(true);
    expect(gitNotRun(thrown(() => execFileSync(process.execPath, ['-e', 'process.exit(1)'], { stdio: 'pipe' })))).toBe(true);
    expect(gitNotRun(thrown(() => execFileSync(join(dir, 'no-such-git.exe'), [], { stdio: 'pipe' })))).toBe(true);
  });

  it('an error that is not a child process at all is not one that never ran', () => {
    expect(gitNotRun(new Error('database is locked'))).toBe(false);
  });
});
