import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { availableParallelism, totalmem } from 'node:os';
import { join } from 'node:path';

export function workers(cpus = availableParallelism(), gb = totalmem() / 2 ** 30) {
  const unit = Math.max(1, Math.min(cpus - 1, Math.floor(gb / 4)));
  return { unit, heavy: Math.min(4, unit) };
}

// restart.test.ts runs alone, last: next to the ConPTY tests in other workers it once crashed one of them with
// native heap corruption (0xC0000374) inside node-pty.
export function sortTests(testDir: string) {
  const restart = ['restart.test.ts'].filter((f) => existsSync(join(testDir, f)));
  const files = readdirSync(testDir).filter((f) => f.endsWith('.test.ts') && !restart.includes(f)).sort();
  const imports = (f: string, mod: string) => readFileSync(join(testDir, f), 'utf8').includes(`from '${mod}'`);
  // Headless Edge (cdp.ts) and the ptys are what fail under load (a process Windows fails to start, docs/ARCHITECTURE.md →
  // Working on the board), so those files get one retry: no test runs more than twice. A unit failure is always real.
  const browser = files.filter((f) => imports(f, './cdp.ts'));
  const pty = files.filter((f) => !browser.includes(f) && (imports(f, '../src/launcher.ts') || imports(f, './board.ts')));
  const unit = files.filter((f) => !browser.includes(f) && !pty.includes(f));
  return { unit, pty, browser, restart };
}
