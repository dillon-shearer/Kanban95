// `npm run test:changed [-- <base>]`: vitest on only the test files the worktree's changes against <base> (default main) can
// affect. vitest's module graph picks the tests that import a changed TypeScript file; it cannot see ui/, templates, skills or
// docs, so `mapped` adds the tests that read those. Both go to one `vitest related` run, which takes them as its sources.
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

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
    // By import, as daemon/vitest.config.ts sorts its browser project, so a renamed or split ui test is still found.
    if (p.startsWith('ui/')) for (const f of tests) if (readFileSync(join(testDir, f), 'utf8').includes(`from './cdp.ts'`)) out.add(f);
    if (p.startsWith('templates/') || p.startsWith('skills/')) out.add('templates.test.ts');
    if (p === 'templates/operator.md' || p === 'templates/housekeeping.md') out.add('operator.test.ts');
    // SQL is read from disk at start, so no test imports it.
    if (p.startsWith('daemon/migrations/global/')) out.add('brain-global.test.ts');
    else if (p.startsWith('daemon/migrations/')) out.add('db.test.ts');
    if (DOC_TESTS[p]) out.add(DOC_TESTS[p]);
  }
  return [...out].filter((f) => tests.includes(f)).sort();
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
  const base = process.argv[2] || 'main';
  const daemon = resolve(import.meta.dirname, '..');
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: daemon, encoding: 'utf8' }).trim();
  const paths = changedPaths(root, base);
  const extra = mapped(paths, import.meta.dirname);
  const code = paths.filter((p) => p.startsWith('daemon/'));
  if (!code.length && !extra.length) {
    console.log(`test:changed: nothing maps to a test (changed against ${base}: ${paths.join(', ') || 'none'}); no tests run.`);
    process.exit(0);
  }
  if (extra.length) console.log(`test:changed: added by path mapping: ${extra.join(', ')}`);
  const sources = [...code.map((p) => join(root, p)), ...extra.map((f) => join(import.meta.dirname, f))];
  // vitest's bin under this node, not npx through cmd.exe, whose 8191-character line a big diff's paths would overflow.
  // passWithNoTests: a daemon change no test imports (a comment in a script) is not a failure.
  const vitest = join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');
  const r = spawnSync(process.execPath, [vitest, 'related', '--run', '--passWithNoTests', ...sources], { cwd: daemon, stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
