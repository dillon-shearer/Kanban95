import './home.ts';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it.runIf(process.platform === 'win32')('PowerShell under the test home resolves LocalApplicationData inside it, not to the cwd', () => {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Environment]::GetFolderPath("LocalApplicationData")'],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  expect(out.trim()).toBe(join(homedir(), 'AppData', 'Local'));
});
