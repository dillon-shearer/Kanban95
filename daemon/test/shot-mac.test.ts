import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('npm run shot:mac prints one line and exits 2 off the Mac, before it compiles or starts anything', () => {
  const r = spawnSync(process.execPath, [
    '--import', 'data:text/javascript,Object.defineProperty(process,"platform",{value:"win32"})',
    join(import.meta.dirname, 'shot-mac.ts'), 'out.png',
  ], { encoding: 'utf8' });
  expect(r.status).toBe(2);
  expect(r.stdout).toBe('');
  expect(r.stderr).toBe('npm run shot:mac is Mac only; use npm run shot.\n');
});
