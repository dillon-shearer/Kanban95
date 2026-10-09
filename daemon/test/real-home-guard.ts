// vitest globalSetup: runs in the main process, where the operator's real home is still in effect (test/home.ts redirects it
// only inside test workers). Fails the run if any test left a trace there: a trust entry for one of this run's test repos,
// a board backup of ~/.claude.json, or a ~/.kanban95 that did not exist before.
// Every temp dir of this run lives under one fresh `k95-run-*` dir (TEMP/TMP point there before the workers start), so a
// `k95-*` trust entry another worktree's run writes at the same time is not this run's and does not fail it.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const state = join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), '.claude.json');
const keys = () => {
  try {
    return Object.keys(JSON.parse(readFileSync(state, 'utf8')).projects ?? {});
  } catch {
    return []; // no file, or Claude mid-write: nothing to compare
  }
};
const traces = () => ({ bak: existsSync(`${state}.kanban95.bak`), board: existsSync(join(homedir(), '.kanban95')) });

export default function setup() {
  const run = mkdtempSync(join(tmpdir(), 'k95-run-'));
  process.env.TEMP = process.env.TMP = process.env.TMPDIR = run;
  const mine = resolve(run).replaceAll('\\', '/') + '/'; // Claude Code's key form (trust.ts)
  const before = traces();
  return () => {
    const after = traces();
    const found = [
      ...keys().filter((k) => k.startsWith(mine)).map((k) => `trust entry ${k} in ${state}`),
      ...(after.bak && !before.bak ? [`${state}.kanban95.bak`] : []),
      ...(after.board && !before.board ? [join(homedir(), '.kanban95')] : []),
    ];
    try {
      rmSync(run, { recursive: true, force: true, maxRetries: 5 });
    } catch {} // ponytail: a file still held open stays in %TEMP%; the OS temp cleanup takes it
    if (found.length) throw new Error(`tests wrote to the operator's real home; remove by hand:\n- ${found.join('\n- ')}`);
  };
}
