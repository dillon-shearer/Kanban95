import { dirtyMessage, git, worktreesRoot } from './git.js';
import { runner, type Board } from './lifecycle.js';
import { requirements } from './requirements.js';
import { CLIS, runSettings, type Cli } from './settings.js';
import { claudeTrusts } from './trust.js';

export type Item = { id: string; ok: boolean; fix: string };
export type Readiness = { ready: boolean; items: Item[] };

const firstLine = (e: unknown) => (e as Error).message.split(/\r?\n/)[0].trim();
const has = (repo: string, ...args: string[]) => {
  try {
    return git(repo, ...args) !== '';
  } catch {
    return false;
  }
};

export async function readiness(b: Board): Promise<Readiness> {
  const found = await requirements(b.repo);
  const items: Item[] = [];
  const add = (id: string, ok: boolean, fix: string) => items.push({ id, ok, fix: ok ? '' : fix });

  add('git', found.git.found, 'Install git and put it on PATH, then restart the board.');
  add('identity', has(b.repo, 'config', 'user.name') && has(b.repo, 'config', 'user.email'),
    'Set your git identity: git config --global user.name "Your Name" and git config --global user.email you@example.com');
  add('commit', !b.gitError && has(b.repo, 'rev-parse', '--verify', '-q', 'HEAD'), b.gitError ? b.gitError.split(/\r?\n/)[0] : 'Make a first commit on the base branch.');
  let dirty: string;
  try {
    const d = dirtyMessage(b.repo);
    dirty = d && `The base branch has uncommitted changes${d.split('\n')[0].replace(/:$/, '')}.`;
  } catch (e) {
    dirty = `git status failed in the repo: ${firstLine(e)}`;
  }
  add('clean', !dirty, dirty);

  let clis: Cli[] = [];
  let models = '';
  try {
    clis = [...new Set([runSettings(null, 'execute', b.repo).cli, runSettings(null, 'test', b.repo).cli])];
  } catch (e) {
    models = `Pick the models in Start -> Settings -> Agents, then Save (${firstLine(e)}).`;
  }
  add('models', !models, models);
  const missing = clis.filter((c) => CLIS.includes(c) && !found[c].found);
  add('cli', clis.length > 0 && !missing.length,
    clis.length ? `Install ${missing.join(' and ')} or set its path in Start -> Settings -> Agents.` : 'Pick a CLI in Start -> Settings -> Agents first.');
  const root = worktreesRoot(b.repo);
  add('trust', !clis.includes('claude') || claudeTrusts(b.repo),
    `Claude Code does not trust ${root} yet: the board writes it on the first Claude launch; if the trust prompt still shows, run claude in ${root} and accept it.`);
  add('runner', runner(b).on, 'Turn the runner on with Run on the Board toolbar (Ctrl+L).');
  return { ready: items.every((i) => i.ok), items };
}

export const readyText = (r: Readiness) => (r.ready ? 'ready' : r.items.filter((i) => !i.ok).map((i) => `- ${i.id}: ${i.fix}`).join('\n'));
