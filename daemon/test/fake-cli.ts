import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function fakeCli(bin: string, name: string, script: string) {
  writeFileSync(join(bin, `${name}.cmd`), `@node "%~dp0${script}" %*\r\n`);
  writeFileSync(join(bin, name), `#!/bin/sh\nexec node "$(dirname "$0")/${script}" "$@"\n`, { mode: 0o755 });
}
