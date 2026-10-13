import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export function fakeCli(bin: string, name: string, script: string) {
  writeFileSync(join(bin, `${name}.cmd`), `@if defined K95_PROBE (node --check "%~dp0${script}" & exit /b)\r\n@node "%~dp0${script}" %*\r\n`);
  writeFileSync(join(bin, name), `#!/bin/sh\n[ -n "$K95_PROBE" ] && exec node --check "$(dirname "$0")/${script}"\nexec node "$(dirname "$0")/${script}" "$@"\n`, { mode: 0o755 });
  checkCli(name, bin + delimiter + process.env.PATH);
}

export function checkCli(name: string, path: string) {
  const env = { ...process.env, PATH: path, K95_PROBE: '1' };
  const r = spawnSync(name, [], { env, encoding: 'utf8', timeout: 5_000, shell: process.platform === 'win32', windowsHide: true });
  const out = (r.stderr || r.stdout || '').split(/\r?\n/).filter((l) => l.trim());
  const why = r.error?.message ?? (r.status === 0 ? '' : `exit ${r.status ?? r.signal}: ${out.find((l) => /Error\b|not found|not recognized/.test(l)) ?? out.at(-1) ?? 'no output'}`);
  if (why) throw new Error(`stand-in CLI ${name} cannot start: ${why}`);
}
