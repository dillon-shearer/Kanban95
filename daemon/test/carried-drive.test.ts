import './home.ts';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorktree, guardFileMode, worktreePath } from '../src/git.ts';
import { childEnv } from '../src/pty.ts';

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
let repo: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'k95-carried-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'T');
  git('config', 'user.email', 't@t');
  for (const f of ['a.txt', 'b.txt', 'c.txt', 'my file.txt']) writeFileSync(join(repo, f), `${f}\n`);
  git('add', '-A');
  git('commit', '-qm', 'init');
  git('config', '--unset', 'core.fileMode');
});
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  vi.restoreAllMocks();
  rmSync(repo, { recursive: true, force: true });
});

describe('launch from a base branch with tracked changes', () => {
  it('names the count and kind of change and the command to restore them', () => {
    unlinkSync(join(repo, 'a.txt'));
    unlinkSync(join(repo, 'my file.txt'));
    writeFileSync(join(repo, 'b.txt'), 'changed\n');
    let message = '';
    try {
      createWorktree(repo, 3);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message.split('\n')[0]).toBe('base branch main has uncommitted changes (2 deleted, 1 modified); '
      + 'restore with git checkout -- "a.txt" "b.txt" "my file.txt" in the repo, or commit or stash them before launching:');
    expect(existsSync(worktreePath(repo, 3))).toBe(false);
    git('checkout', '--', 'a.txt', 'b.txt', 'my file.txt');
    expect(git('status', '--porcelain')).toBe('');
  });

  it('offers no checkout for a change that is only staged', () => {
    git('rm', '-q', 'c.txt');
    expect(() => createWorktree(repo, 3)).toThrow(/^base branch main has uncommitted changes \(1 deleted\); commit or stash them before launching:\nD {2}c\.txt$/);
  });
});

describe('core.fileMode on a carried drive', () => {
  const on = (p: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value: p });
  const fileMode = () => git('config', '--local', '--default', '', 'core.fileMode');

  it('is set to false on macOS when the volume is not APFS or HFS, once', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    on('darwin');
    expect(guardFileMode(repo, () => 'exfat')).toBe(true);
    expect(fileMode()).toBe('false');
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(guardFileMode(repo, () => 'exfat')).toBe(false);
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it('is left alone on APFS, HFS, an unknown volume, or when already set', () => {
    on('darwin');
    for (const type of ['apfs', 'hfs', undefined]) expect(guardFileMode(repo, () => type)).toBe(false);
    expect(fileMode()).toBe('');
    git('config', 'core.fileMode', 'true');
    expect(guardFileMode(repo, () => 'exfat')).toBe(false);
    expect(fileMode()).toBe('true');
  });

  it('never runs on Windows or Linux, not even the volume check', () => {
    for (const p of ['win32', 'linux'] as const) {
      on(p);
      const fsType = vi.fn(() => 'exfat');
      expect(guardFileMode(repo, fsType)).toBe(false);
      expect(fsType).not.toHaveBeenCalled();
    }
    expect(fileMode()).toBe('');
  });
});

describe('git trust on a volume that records no owner', () => {
  afterEach(() => {
    for (const k of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_DIR']) delete process.env[k];
  });

  it('reaches an agent terminal, while other git variables do not', () => {
    Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*', GIT_DIR: repo });
    const env = childEnv();
    expect([env.GIT_CONFIG_COUNT, env.GIT_CONFIG_KEY_0, env.GIT_CONFIG_VALUE_0]).toEqual(['1', 'safe.directory', '*']);
    expect(env.GIT_DIR).toBeUndefined();
  });
});
