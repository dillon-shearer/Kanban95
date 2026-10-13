import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { killTree } from './launcher.js';
import { childEnv, cmdSafe } from './pty.js';
import { CLIS, configPath, type Cli } from './settings.js';

export interface Found { found: boolean; version: string | null }
export type Requirements = Record<'git' | (typeof CLIS)[number], Found>;

export const TIMEOUT_MS = 4_000;
const MISSING: Found = { found: false, version: null };

function version(exe: string): Promise<Found> {
  const win = process.platform === 'win32';
  if (win && !cmdSafe(exe)) return Promise.resolve(MISSING);
  return new Promise((ok) => {
    let out = '';
    let child: ChildProcess;
    const o = { cwd: tmpdir(), env: childEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'] };
    try {
      child = win ? spawn(`"${exe}" --version`, { ...o, shell: true }) : spawn(exe, ['--version'], { ...o, detached: true });
    } catch {
      return ok(MISSING);
    }
    const timer = setTimeout(() => {
      void killTree(child);
      ok(MISSING);
    }, TIMEOUT_MS);
    child.stdout?.on('data', (c) => { if (out.length < 4096) out += c; });
    child.on('error', () => { clearTimeout(timer); ok(MISSING); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const line = out.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? null;
      ok(code === 0 ? { found: true, version: line } : MISSING);
    });
  });
}

function configured(cli: Cli, repo?: string): string {
  try {
    const p = JSON.parse(readFileSync(configPath('settings', repo), 'utf8'))?.paths?.[cli];
    return typeof p === 'string' && p.trim() ? p.trim() : cli;
  } catch {
    return cli;
  }
}

export async function requirements(repo?: string): Promise<Requirements> {
  const [git, claude, codex] = await Promise.all([version('git'), version(configured('claude', repo)), version(configured('codex', repo))]);
  return { git, claude, codex };
}
