import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { webkit } from 'playwright';

const OPEN = ['board', 'start', 'switch', 'taskmenu'];
const { values, positionals } = parseArgs({ allowPositionals: true, options: { zoom: { type: 'string', default: '100' }, open: { type: 'string', default: 'board' } } });
const zoom = Number(values.zoom) / 100;
if (positionals.length !== 1 || !OPEN.includes(values.open!) || !(zoom >= 0.8 && zoom <= 2)) {
  console.error(`usage: npm run shot -- <out.png> [--zoom 80..200] [--open ${OPEN.join('|')}]`);
  process.exit(2);
}
const out = resolve(process.env.INIT_CWD ?? process.cwd(), positionals[0]);

const browser = await webkit.launch({ headless: true });
const scratch = mkdtempSync(join(tmpdir(), 'k95-shot-'));
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

let srv: Awaited<ReturnType<typeof start>> | undefined;
let code = 0;
try {
  srv = await start({ repo });
  const add = srv.db.prepare('INSERT INTO tickets (title, status, body) VALUES (?, ?, ?)');
  for (const [title, status] of [
    ['Add a dark title bar option', 'backlog'],
    ['Show merge time on cards', 'backlog'],
    ['Fix thin font in WebKit', 'in_progress'],
    ['Keep menus inside the desktop', 'testing'],
    ['Sort the inbox by age', 'done'],
  ]) add.run(title, status, 'Seeded by npm run shot.');
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const base = `http://127.0.0.1:${srv.port}/`;
  await page.goto(`${base}?k95=${srv.secret}`);
  await page.waitForURL(base);
  await page.locator('.k95-board .card').first().waitFor();
  await page.locator('#tasks .task').nth(2).waitFor();
  if (values.open === 'start') await page.locator('#start').click();
  if (values.open === 'switch') await page.locator('#switch').click();
  if (values.open === 'taskmenu') await page.locator('[data-task="board"]').click({ button: 'right' });
  if (values.open === 'start' || values.open === 'taskmenu') await page.locator('.k95-menu').first().waitFor();
  if (values.open === 'switch') await page.locator('.k95-switch').waitFor();
  await page.screenshot({ path: out, fullPage: true });
  console.log(out);
} catch (e) {
  console.error(e);
  code = 1;
} finally {
  await browser.close();
  await srv?.close();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
}
process.exit(code);
