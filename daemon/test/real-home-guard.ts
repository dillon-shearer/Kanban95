// vitest globalSetup: runs in the main process, where the operator's real home is still in effect (test/home.ts redirects it
// only inside test workers). Fails the run if any test left a trace there: a trust entry for a test repo (`k95-` temp dirs),
// a board backup of ~/.claude.json, or a ~/.kanban95 that did not exist before.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const state = join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), '.claude.json');
const testKeys = () => {
  try {
    return Object.keys(JSON.parse(readFileSync(state, 'utf8')).projects ?? {}).filter((k) => /\/k95-[^/]*$/.test(k));
  } catch {
    return []; // no file, or Claude mid-write: nothing to compare
  }
};
const traces = () => ({ keys: testKeys(), bak: existsSync(`${state}.kanban95.bak`), board: existsSync(join(homedir(), '.kanban95')) });

export default function setup() {
  const before = traces();
  return () => {
    const after = traces();
    const found = [
      ...after.keys.filter((k) => !before.keys.includes(k)).map((k) => `trust entry ${k} in ${state}`),
      ...(after.bak && !before.bak ? [`${state}.kanban95.bak`] : []),
      ...(after.board && !before.board ? [join(homedir(), '.kanban95')] : []),
    ];
    if (found.length) throw new Error(`tests wrote to the operator's real home; remove by hand:\n- ${found.join('\n- ')}`);
  };
}
