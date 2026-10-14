// `npm run test:changed [-- <base>] [--pty] [--browser]`: vitest on only the test files the worktree's changes against <base>
// (default main) can affect. vitest's module graph picks the unit tests that import a changed TypeScript file; it cannot see ui/,
// templates, skills or docs, so `mapped` adds the tests that read those. Pty, browser and restart files are slow, so they run
// only when they import a changed file themselves or through a changed test helper (`heavyTests`); a ui/ change runs every
// browser file.
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, posix, resolve } from 'node:path';
import { sortTests } from './projects.ts';

// Docs a test reads or is written from, so editing the doc can fail it. A new doc drift test adds its row here.
const DOC_TESTS: Record<string, string> = {
  'docs/MCP.md': 'mcp.test.ts',
  'docs/LIFECYCLE.md': 'lifecycle.test.ts',
};

/** Test files (names in `testDir`) that `paths` (repo-relative, forward slashes) affect but vitest's module graph cannot see. */
export function mapped(paths: string[], testDir: string): string[] {
  const tests = readdirSync(testDir).filter((f) => f.endsWith('.test.ts'));
  const out = new Set<string>();
  for (const p of paths) {
    if (p.startsWith('templates/') || p.startsWith('skills/')) out.add('templates.test.ts');
    if (p === 'templates/operator.md' || p === 'templates/housekeeping.md') out.add('operator.test.ts');
    if (p === 'templates/bootstrap.md') out.add('bootstrap.test.ts');
    // SQL is read from disk at start, so no test imports it.
    if (p.startsWith('daemon/migrations/global/')) out.add('brain-global.test.ts');
    else if (p.startsWith('daemon/migrations/')) out.add('db.test.ts');
    if (p === 'shell/stage.mjs') out.add('stage-node.test.ts');
    if (DOC_TESTS[p]) out.add(DOC_TESTS[p]);
  }
  return [...out].filter((f) => tests.includes(f)).sort();
}

export function heavyTests(paths: string[], testDir: string, flags: string[] = []): string[] {
  const { pty, browser, restart } = sortTests(testDir);
  const read = (f: string) => { try { return readFileSync(join(testDir, f), 'utf8'); } catch { return ''; } };
  const imports = (f: string) => [...read(f).matchAll(/(?:from|import) '(\.\.?\/[^']+)'/g)].map(([, spec]) => posix.join('daemon/test', spec));
  const helpers = (f: string, seen = new Set<string>()): Set<string> => {
    for (const p of imports(f)) if (p.startsWith('daemon/test/') && !seen.has(p)) { seen.add(p); helpers(p.slice('daemon/test/'.length), seen); }
    return seen;
  };
  const direct = (f: string) => { const d = new Set([`daemon/test/${f}`, ...imports(f), ...helpers(f)]); return paths.some((p) => d.has(p)); };
  const allBrowser = flags.includes('--browser') || paths.some((p) => p.startsWith('ui/') || p === 'daemon/test/browser-setup.ts');
  return [
    ...(flags.includes('--pty') ? pty : pty.filter(direct)),
    ...(allBrowser ? browser : browser.filter(direct)),
    ...restart.filter(direct),
  ].sort();
}

// The same three sets vitest's own `--changed <base>` reads: committed since the merge base, staged, and modified or untracked.
function changedPaths(root: string, base: string): string[] {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  return [...new Set([
    ...git('diff', '--name-only', `${base}...HEAD`),
    ...git('diff', '--cached', '--name-only'),
    ...git('ls-files', '--other', '--modified', '--exclude-standard'),
  ])];
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const base = args.find((a) => !a.startsWith('--')) || 'main';
  const daemon = resolve(import.meta.dirname, '..');
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: daemon, encoding: 'utf8' }).trim();
  const paths = changedPaths(root, base);
  const extra = mapped(paths, import.meta.dirname);
  const { unit } = sortTests(import.meta.dirname);
  const code = paths.filter((p) => p.startsWith('daemon/'));
  const heavy = [...new Set([...heavyTests(paths, import.meta.dirname, args), ...extra.filter((f) => !unit.includes(f))])].sort();
  const sources = [...code.map((p) => join(root, p)), ...extra.filter((f) => unit.includes(f)).map((f) => join(import.meta.dirname, f))];
  if (!sources.length && !heavy.length) {
    console.log(`test:changed: nothing maps to a test (changed against ${base}: ${paths.join(', ') || 'none'}); no tests run.`);
    process.exit(0);
  }
  if (extra.length) console.log(`test:changed: added by path mapping: ${extra.join(', ')}`);
  // vitest's bin under this node, not npx through cmd.exe, whose 8191-character line a big diff's paths would overflow.
  // passWithNoTests: a daemon change no test imports (a comment in a script) is not a failure.
  const vitest = join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');
  const run = (argv: string[]) => spawnSync(process.execPath, [vitest, ...argv], { cwd: daemon, stdio: 'inherit' }).status ?? 1;
  let status = 0;
  if (sources.length) status = run(['related', '--run', '--passWithNoTests', '--project', 'unit', ...sources]);
  console.log(`test:changed: pty, browser and restart files that import a changed file themselves: ${heavy.join(', ') || 'none'} (--pty or --browser runs all of one kind).`);
  if (heavy.length) status = run(['run', '--project', 'pty', '--project', 'browser', '--project', 'restart', ...heavy.map((f) => `test/${f}`)]) || status;
  process.exit(status);
}
