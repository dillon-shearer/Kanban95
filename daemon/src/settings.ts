// The operator's own settings in ~/.kanban95/, edited in the Settings window. No secrets live here.
// models.json: which CLI, and the model and effort per phase (docs/LIFECYCLE.md → Run settings). settings.json: CLI paths,
// sounds, voice, housekeeping, auto-opened terminals, idle minutes, UI zoom, push after merge, sleep minutes,
// runner concurrency, the automatic update check. projects.json: every repo with a board and its wallpaper colour. All are read on every use, so an edit applies to the next run without a restart.
// models.json, settings.json and preferences.md may have a per-project copy in projects/<repo key>/, used whole instead of the global file.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as z from 'zod';
import type { Ticket } from './api.js';

export const CLIS = ['claude', 'codex'] as const;
export type Cli = (typeof CLIS)[number];
export const EFFORT = ['low', 'medium', 'high', 'max'] as const;
export type Effort = (typeof EFFORT)[number];

const phase = z.object({ model: z.string().trim().min(1), effort: z.enum(EFFORT).default('medium') }).strict();
const perCli = z.object({ models: z.array(z.string().trim().min(1)), plan: phase, execute: phase, test: phase, operator: phase }).partial().strict();
const exe = z.string().refine((p) => p === '' || (isAbsolute(p) && existsSync(p)), 'must be empty or an absolute path to an existing file');
const FILES = {
  models: z.object({ cli: z.enum(CLIS), claude: perCli.optional(), codex: perCli.optional() }).strict(),
  settings: z.object({
    paths: z.object({ claude: exe, codex: exe }).partial().strict().default({}),
    // A pre-split file has one boolean for every sound; it carries over to each.
    sounds: z.preprocess((v) => (typeof v === 'boolean' ? { merge: v, attention: v, done: v } : v),
      z.object({ merge: z.boolean().default(true), attention: z.boolean().default(true), done: z.boolean().default(true) }).strict()
        .default({ merge: true, attention: true, done: true })),
    voice: z.object({ backend: z.enum(['local']).default('local'), mode: z.enum(['push', 'toggle']).default('push') }).strict()
      .default({ backend: 'local', mode: 'push' }),
    // Off: no ticket is filed after merges; the Housekeeping button still works.
    housekeeping: z.object({ auto: z.boolean().default(true), every: z.number().int().min(1).default(10) }).strict()
      .default({ auto: true, every: 10 }),
    // Phases whose sessions open a terminal on their own; the rest run unseen until the operator opens one (card → Terminal).
    // Brainstorms and operator terminals always open: the operator started them. `tile` off: terminals take no slot (ui/wm.js).
    terminals: z.object({ auto: z.array(z.enum(['plan', 'execute', 'test'])).default(['plan', 'execute', 'test']), tile: z.boolean().default(true) }).strict()
      .default({ auto: ['plan', 'execute', 'test'], tile: true }),
    // A running agent whose transcript gains no line for this long is flagged (docs/LIFECYCLE.md → Silent agents). Above the
    // 10 min tool timeout, so a long test run is not flagged.
    idle_minutes: z.number().int().min(1).default(20),
    // CSS zoom of the whole UI (Ctrl+= / Ctrl+- / Ctrl+0, Settings → Board), here so it follows the operator across repos.
    zoom: z.number().min(0.8).max(2).default(1),
    // On: the merge queue pushes the base to its upstream after each merge, before the ticket counts as merged.
    push_after_merge: z.boolean().default(true),
    concurrency: z.number().int().min(1).max(10).default(3),
    sleepAfterMinutes: z.number().min(0).default(30),
    updateCheck: z.boolean().default(true),
  }).strict(),
};
type ConfigName = keyof typeof FILES;
type Config<N extends ConfigName> = z.output<(typeof FILES)[N]>;
const CONFIGS = Object.keys(FILES) as ConfigName[];

/**
 * This machine's own board directory: $KANBAN95_HOME, else ~/.kanban95. It holds the data folder pointer and the worktrees,
 * and is the data folder when there is no pointer. Under vitest the real one is refused, so no test can overwrite it.
 */
export function localHome(): string {
  if (process.env.KANBAN95_HOME) return process.env.KANBAN95_HOME;
  if (process.env.VITEST) throw new Error('refusing the real ~/.kanban95 under vitest: set KANBAN95_HOME (test/home.ts does)');
  return join(homedir(), '.kanban95');
}

export const pointerPath = () => join(localHome(), 'home');

/**
 * The data folder: the path the pointer names, else the local home. Every operator-level file (models.json, settings.json,
 * preferences.md, projects.json, the global brain, voice models) lives here and nowhere else.
 */
export function boardHome(): string {
  try {
    const dir = readFileSync(pointerPath(), 'utf8').trim();
    if (isAbsolute(dir)) return dir;
  } catch {}
  return localHome();
}

export function setBoardHome(dir: string) {
  if (!isAbsolute(dir)) throw new BadConfig(`data folder ${dir} is not an absolute path`);
  mkdirSync(dir, { recursive: true });
  if (same(normal(dir), normal(localHome()))) return rmSync(pointerPath(), { force: true });
  mkdirSync(localHome(), { recursive: true });
  writeFileSync(pointerPath(), normal(dir) + '\n');
}

/** FNV-1a, 32 bit, as hex: stable across Node releases, like the shell's per-repo WebView2 profile name. */
const fnv1a = (s: string) => {
  let h = 0x811c9dc5;
  for (const b of Buffer.from(s, 'utf8')) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
};

/**
 * A repo's key under the board home: `<basename>-<hash of the canonical path>`. The hash keeps two repos with the same folder
 * name apart; Windows paths are hashed lower-cased, as one folder has one key whatever case it is typed in.
 */
export function repoKey(repo: string): string {
  const path = normal(repo);
  return `${basename(path)}-${fnv1a(process.platform === 'win32' ? path.toLowerCase() : path)}`;
}

/** A file that may have a per-project copy. */
export type OverridableName = ConfigName | 'preferences';
const fileName = (name: OverridableName) => (name === 'preferences' ? 'preferences.md' : `${name}.json`);
export const isOverridable = (s: string): s is OverridableName => s === 'preferences' || (CONFIGS as string[]).includes(s);

/** <board home>/projects/<repo key>/<file>: the repo's own copy, whether or not it exists. */
export const projectPath = (name: OverridableName, repo: string) => join(boardHome(), 'projects', repoKey(repo), fileName(name));
export const globalPath = (name: OverridableName) => join(boardHome(), fileName(name));

/** The file a run on `repo` reads: its project copy when one exists, else the global file. No repo: the global file. */
export function configPath(name: OverridableName, repo?: string): string {
  if (repo) {
    const own = projectPath(name, repo);
    if (existsSync(own)) return own;
  }
  return globalPath(name);
}

/**
 * Starts a project copy as a copy of the global file (settings: `{}`, preferences: empty when there is none). False when
 * the copy exists already. No global models.json is BadConfig: there is nothing to start from.
 */
export function addOverride(name: OverridableName, repo: string): boolean {
  const own = projectPath(name, repo);
  if (existsSync(own)) return false;
  const global = globalPath(name);
  if (!existsSync(global) && name === 'models') throw new BadConfig(`no model catalog at ${global} to copy`);
  mkdirSync(dirname(own), { recursive: true });
  if (existsSync(global)) copyFileSync(global, own);
  else writeFileSync(own, name === 'settings' ? '{}\n' : '');
  return true;
}

/** Removes a project copy, and its project dir once empty. False when there is no copy. */
export function dropOverride(name: OverridableName, repo: string): boolean {
  const own = projectPath(name, repo);
  if (!existsSync(own)) return false;
  unlinkSync(own);
  try { rmdirSync(dirname(own)); } catch { /* another copy is still there */ }
  return true;
}

const LOCK_MS = 10_000;

function locked<T>(fn: () => T): T {
  const home = boardHome();
  mkdirSync(home, { recursive: true });
  const db = new DatabaseSync(join(home, 'settings.lock'));
  try {
    db.exec(`PRAGMA busy_timeout = ${LOCK_MS}`);
    db.exec('BEGIN IMMEDIATE');
    try {
      return fn();
    } finally {
      db.exec('COMMIT');
    }
  } finally {
    db.close();
  }
}

function replace(file: string, data: string) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}-${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** A file that does not pass its schema. REST answers it with 400. */
export class BadConfig extends Error {}

function check<N extends ConfigName>(name: N, value: unknown, where: string): Config<N> {
  const r = FILES[name].safeParse(value);
  if (!r.success) throw new BadConfig(`${where}: ${z.prettifyError(r.error).replaceAll('\n', '; ')}`);
  return r.data as Config<N>;
}

/** models.json has no default (the operator picks the models); a missing settings.json is all defaults. A project copy is read whole. */
export function readConfig<N extends ConfigName>(name: N, repo?: string): Config<N> {
  const file = configPath(name, repo);
  if (!existsSync(file)) {
    if (name === 'models') throw new BadConfig(`no model catalog at ${file}`);
    return check(name, {}, file);
  }
  return check(name, JSON.parse(readFileSync(file, 'utf8')), file);
}

/**
 * Checked first, then written whole through a temp file, so a bad edit never reaches the file and a crash never half-writes it.
 * With a repo it writes that repo's project copy, creating it; else the global file.
 */
export function writeConfig<N extends ConfigName>(name: N, value: unknown, repo?: string): Config<N> {
  const file = repo ? projectPath(name, repo) : globalPath(name);
  const data = check(name, value, `${name}.json`);
  locked(() => replace(file, JSON.stringify(data, null, 2) + '\n'));
  return data;
}

/**
 * Every model each installed CLI knows, for the Settings dropdowns; free text stays allowed. Nothing is named here.
 * Codex: every entry of ~/.codex/models_cache.json (its own picker hides some), in its order. Claude Code has no list command:
 * its "latest model" aliases from `claude --help` come first, then every full id compiled into its executable, newest first.
 * Any failure is an empty list.
 */
export async function knownModels(repo?: string): Promise<Record<Cli, string[]>> {
  const codex = (() => {
    try {
      const { models } = JSON.parse(readFileSync(join(homedir(), '.codex', 'models_cache.json'), 'utf8'));
      return models.sort((a: { priority: number }, b: { priority: number }) => a.priority - b.priority).map((m: { slug: string }) => m.slug);
    } catch {
      return [];
    }
  })();
  const exe = (() => { try { return readConfig('settings', repo).paths.claude; } catch { return ''; } })()
    || process.env.PATH?.split(delimiter).map((d) => join(d, process.platform === 'win32' ? 'claude.exe' : 'claude')).find((p) => existsSync(p));
  if (!exe) return { claude: [], codex };
  const [aliases, ids] = await Promise.all([
    new Promise<string[]>((done) => execFile(exe, ['--help'], { timeout: 10_000, windowsHide: true }, (err, out) => {
      // ponytail: parses the --model help line; when Claude Code rewords it the aliases are missing and the full ids remain.
      const line = /alias for the latest model \(e\.g\.([^)]*)\)/.exec(String(out).replace(/\s+/g, ' '))?.[1] ?? '';
      done(err ? [] : [...line.matchAll(/'([\w.-]+)'/g)].map((m) => m[1]));
    })).catch(() => []), // execFile throws instead of calling back when the file is not an executable at all
    claudeIds(exe).catch(() => []),
  ]);
  return { claude: [...aliases, ...ids], codex };
}

const scanned = new Map<string, { mtime: number; ids: string[] }>();
const version = (id: string) => id.replace(/^claude-[a-z]+-/, '').replace(/-\d{8}$/, ''); // a release date does not make it newer

/**
 * Model ids compiled into the Claude Code executable, newest version first. Read in chunks (it is ~250 MB) and cached per
 * file and mtime, so it is scanned again only after Claude Code updates itself.
 * ponytail: string scan of the native build. An npm-installed Claude Code (a .cmd shim) gives none; scan its cli.js if needed.
 */
async function claudeIds(exe: string): Promise<string[]> {
  const mtime = statSync(exe).mtimeMs;
  const hit = scanned.get(exe);
  if (hit?.mtime === mtime) return hit.ids;
  const found = new Set<string>();
  let tail = '';
  const scan = (text: string, upTo: number) => {
    for (const m of text.matchAll(/claude-[a-z]+-\d+(?:-\d+)*/g)) if (m.index < upTo) found.add(m[0]);
  };
  // A match starting in the last 64 characters may be cut off; it is counted with the next chunk, which starts with them.
  for await (const chunk of createReadStream(exe, { encoding: 'latin1', highWaterMark: 4 << 20 })) {
    const text = tail + chunk;
    scan(text, text.length - 64);
    tail = text.slice(-64);
  }
  scan(tail, Infinity);
  // Model families are the ones with a minor version (opus-4-5); that drops beta headers and the like (code-20250219, eval-9).
  const families = new Set([...found].filter((id) => /^claude-[a-z]+-\d-\d+$/.test(id)).map((id) => id.replace(/-\d.*$/, '')));
  const ids = [...found].filter((id) => families.has(id.replace(/-\d.*$/, ''))).sort((a, b) => version(b).localeCompare(version(a), 'en', { numeric: true }) || a.localeCompare(b));
  scanned.set(exe, { mtime, ids });
  return ids;
}

/**
 * cli, model, effort and executable for a run. The ticket's cli wins; its model and effort override the execute phase only.
 * A brainstorm (no ticket) runs the plan phase; an operator terminal the operator phase, whose model may be unset (''): the CLI's own default.
 */
export function runSettings(t: Ticket | null, phase: 'plan' | 'execute' | 'test' | 'operator', repo?: string): { cli: Cli; model: string; effort: Effort; path?: string } {
  const file = configPath('models', repo);
  if (!existsSync(file)) throw new Error(`no model catalog at ${file}`);
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  const cli = t?.cli ?? cfg.cli;
  if (!CLIS.includes(cli)) throw new Error(`unknown cli ${cli} in ${file}; expected ${CLIS.join(' or ')}`);
  const d = cfg[cli]?.[phase] ?? {};
  const own = phase === 'execute';
  const model = (own && t?.model) || d.model || '';
  const effort = (own && t?.effort) || d.effort || 'medium';
  if (!model && phase !== 'operator') throw new Error(`no ${phase} model for ${cli} in ${file}`);
  const bad = model && uncatalogued(model, cli, repo);
  if (bad) throw new Error(bad);
  // Only a model id outside the list is caught before launch; an agent stuck at its prompt for another reason is flagged by the
  // silence watch (lifecycle.ts) after idle_minutes.
  if (!EFFORT.includes(effort)) throw new Error(`bad effort ${effort} for ${cli} ${phase} in ${file}`);
  return { cli, model, effort, path: readConfig('settings', repo).paths[cli as Cli] || undefined };
}

/**
 * Why a model id may not run on a CLI: it is not in that CLI's `models` list in models.json. No list (or no file) means
 * no check, so a catalog written before the list existed keeps launching. Null when the model is fine.
 */
export function uncatalogued(model: string, cli?: string | null, repo?: string): string | null {
  const file = configPath('models', repo);
  if (!existsSync(file)) return null;
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  const c = cli ?? cfg.cli;
  const list = cfg[c]?.models;
  if (!Array.isArray(list) || list.includes(model)) return null;
  return `model ${model} is not in the ${c} model list in ${file}`;
}

/** The operator's configured executable for a CLI, else its bare name for PATH. A broken settings.json reads as unset. */
export function cliPath(cli: Cli, repo?: string): string {
  try {
    return readConfig('settings', repo).paths[cli] || cli;
  } catch {
    return cli;
  }
}

/** ~/.kanban95/preferences.md (or the repo's project copy): the operator's standing instructions, injected into every prompt as {{preferences}}. */
export const preferencesPath = (repo?: string) => configPath('preferences', repo);
const PREFERENCES_MAX = 16 * 1024;

/** A missing file is an empty string. */
export function readPreferences(repo?: string): string {
  try {
    return readFileSync(preferencesPath(repo), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw e;
  }
}

/** Refused over 16 KB (UTF-8 bytes); written through a temp file like the config files. With a repo, to its project copy. */
export function writePreferences(value: unknown, repo?: string): string {
  if (typeof value !== 'string') throw new BadConfig('preferences.md: value must be a string');
  if (Buffer.byteLength(value) > PREFERENCES_MAX) throw new BadConfig(`preferences.md: over ${PREFERENCES_MAX / 1024} KB`);
  const file = repo ? projectPath('preferences', repo) : globalPath('preferences');
  locked(() => replace(file, value));
  return value;
}

/**
 * ~/.kanban95/projects.json: `[{ path, colour }]`, one entry per repo the operator runs a board on (Settings → Projects).
 * `colour` is the wallpaper's base: a hex colour, or a hue (0 to 360) painted at the teal's saturation and lightness.
 * The display name is the folder's basename, never stored.
 */
export const projectsPath = () => join(boardHome(), 'projects.json');
const DEFAULT_COLOUR = '#008080';
const projectList = z.array(z.object({
  path: z.string().refine(isAbsolute, 'must be an absolute path'),
  colour: z.union([z.string().regex(/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i, 'must be #rgb or #rrggbb'), z.number().min(0).max(360)]),
}).strict());
export type Project = z.output<typeof projectList>[number];

/** Absolute, resolved and in the file system's own spelling (case, 8.3 names), so one repo is one entry. */
export const normal = (p: string) => {
  try {
    return realpathSync.native(resolve(p));
  } catch {
    return resolve(p);
  }
};
export const same = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/** A missing file is an empty list. Only the shape is checked on read: a repo deleted since does not break every board. */
export function readProjects(): Project[] {
  const file = projectsPath();
  if (!existsSync(file)) return [];
  const r = projectList.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!r.success) throw new BadConfig(`${file}: ${z.prettifyError(r.error).replaceAll('\n', '; ')}`);
  return r.data;
}

function saveProjects(list: Project[]) {
  replace(projectsPath(), JSON.stringify(list, null, 2) + '\n');
}

/**
 * The whole list, checked before anything is written: every path an existing folder, listed once, `keep` among them. A plain
 * folder becomes a git repo when a board first starts on it (git.ts `initRepo`).
 */
export function writeProjects(value: unknown, keep: string): Project[] {
  const r = projectList.safeParse(value);
  if (!r.success) throw new BadConfig(`projects.json: ${z.prettifyError(r.error).replaceAll('\n', '; ')}`);
  const list = r.data.map((p) => ({ ...p, path: normal(p.path) }));
  for (const [i, p] of list.entries()) {
    if (!statSync(p.path, { throwIfNoEntry: false })?.isDirectory()) throw new BadConfig(`projects.json: ${p.path} is not a folder`);
    if (list.findIndex((q) => same(q.path, p.path)) !== i) throw new BadConfig(`projects.json: ${p.path} is listed twice`);
  }
  if (!list.some((p) => same(p.path, normal(keep)))) throw new BadConfig(`projects.json: this board's own project ${normal(keep)} cannot be removed`);
  locked(() => saveProjects(list));
  return list;
}

/** On daemon start: list the repo it serves, with the default colour, unless it is listed already. */
export function addProject(repo: string) {
  locked(() => {
    const list = readProjects();
    if (!list.some((p) => same(p.path, normal(repo)))) saveProjects([...list, { path: normal(repo), colour: DEFAULT_COLOUR }]);
  });
}

/** This board's project. Unlisted (a broken file) reads as the default colour. */
export function project(repo: string): Project & { name: string } {
  const path = normal(repo);
  let colour: Project['colour'] = DEFAULT_COLOUR;
  try {
    colour = readProjects().find((p) => same(p.path, path))?.colour ?? colour;
  } catch { /* the default */ }
  return { path, name: basename(path), colour };
}
