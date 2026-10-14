import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

export const OPEN = ['board', 'start', 'switch', 'taskmenu'];

export function shotArgs(cmd: string) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { zoom: { type: 'string', default: '100' }, open: { type: 'string', default: 'board' } } });
  const zoom = Number(values.zoom) / 100;
  if (positionals.length !== 1 || !OPEN.includes(values.open!) || !(zoom >= 0.8 && zoom <= 2)) {
    console.error(`usage: npm run ${cmd} -- <out.png> [--zoom 80..200] [--open ${OPEN.join('|')}]`);
    process.exit(2);
  }
  return { out: resolve(process.env.INIT_CWD ?? process.cwd(), positionals[0]), zoom, open: values.open! };
}

export async function withBoard(zoom: number, shoot: (login: string, base: string) => Promise<void>): Promise<number> {
  const scratch = mkdtempSync(join(tmpdir(), 'k95-shot-'));
  let srv: { port: number; secret: string; close(): Promise<void> } | undefined;
  try {
    const home = join(scratch, 'home');
    const repo = join(scratch, 'repo');
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.KANBAN95_HOME = join(home, '.kanban95');
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CODEX_HOME;
    mkdirSync(process.env.KANBAN95_HOME, { recursive: true });
    writeFileSync(join(process.env.KANBAN95_HOME, 'models.json'), JSON.stringify({
      cli: 'claude', claude: { plan: { model: 'plan', effort: 'low' }, execute: { model: 'work', effort: 'low' }, test: { model: 'pass', effort: 'low' } },
    }));
    writeFileSync(join(process.env.KANBAN95_HOME, 'settings.json'), JSON.stringify({ zoom, updateCheck: false }));
    mkdirSync(repo);
    const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Op Erator');
    git('config', 'user.email', 'op@example.com');
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    git('add', 'a.txt');
    git('commit', '-qm', 'init');

    const { sources } = await import('../dist/limits.js');
    const { start } = await import('../dist/server.js');
    sources.claude = async () => 'Current session: 62% used · resets Oct 8, 7:59pm (America/New_York)';
    sources.codex = async () => { throw new Error('codex app-server could not start: ENOENT'); };

    const s = await start({ repo });
    srv = s;
    const add = s.db.prepare('INSERT INTO tickets (title, status, body) VALUES (?, ?, ?)');
    for (const [title, status] of [
      ['Add a dark title bar option', 'backlog'],
      ['Show merge time on cards', 'backlog'],
    ['Wrap long legends in the Settings window', 'backlog'],
    ['Remember the Notepad caret', 'backlog'],
    ['Group the Inbox by ticket', 'backlog'],
    ['Show the brain row count in the title', 'backlog'],
    ['Let the filter match ticket ids', 'backlog'],
    ['Collapse empty columns', 'backlog'],
      ['Fix thin font in WebKit', 'in_progress'],
      ['Keep menus inside the desktop', 'testing'],
      ['Sort the inbox by age', 'done'],
    ]) add.run(title, status, 'Seeded by npm run shot.');
    const base = `http://127.0.0.1:${s.port}/`;
    await shoot(`${base}?k95=${s.secret}`, base);
    return 0;
  } catch (e) {
    console.error(e);
    return 1;
  } finally {
    await srv?.close();
    rmSync(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  }
}
