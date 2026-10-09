// The operator's own settings in ~/.kanban95/, edited in the Settings window. No secrets live here.
// models.json: which CLI, and the model and effort per phase (docs/LIFECYCLE.md → Run settings). settings.json: CLI paths,
// sounds, voice, housekeeping, auto-opened terminals, idle minutes, UI zoom. projects.json: every repo with a board and its wallpaper colour. All are read on every use, so an edit applies to the next run without a restart.
import { execFile } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
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
    // A pre-split file has one boolean for both sounds; it carries over to each.
    sounds: z.preprocess((v) => (typeof v === 'boolean' ? { merge: v, attention: v } : v),
      z.object({ merge: z.boolean().default(true), attention: z.boolean().default(true) }).strict().default({ merge: true, attention: true })),
    voice: z.object({ backend: z.enum(['local']).default('local'), mode: z.enum(['push', 'toggle']).default('push') }).strict()
      .default({ backend: 'local', mode: 'push' }),
    // Off: no ticket is filed after merges; the Housekeeping button still works.
    housekeeping: z.object({ auto: z.boolean().default(true), every: z.number().int().min(1).default(10) }).strict()
      .default({ auto: true, every: 10 }),
    // Phases whose sessions open a terminal on their own; the rest run unseen until the operator opens one (card → Terminal).
    // Brainstorms and operator terminals always open: the operator started them.
    terminals: z.object({ auto: z.array(z.enum(['plan', 'execute', 'test'])).default(['plan', 'execute', 'test']) }).strict()
      .default({ auto: ['plan', 'execute', 'test'] }),
    // A running agent whose transcript gains no line for this long is flagged (docs/LIFECYCLE.md → Silent agents). Above the
    // 10 min tool timeout, so a long test run is not flagged.
    idle_minutes: z.number().int().min(1).default(20),
    // CSS zoom of the whole UI (Ctrl+= / Ctrl+- / Ctrl+0, Settings → General), here so it follows the operator across repos.
    zoom: z.number().min(0.8).max(2).default(1),
  }).strict(),
};
export type ConfigName = keyof typeof FILES;
type Config<N extends ConfigName> = z.output<(typeof FILES)[N]>;
export const CONFIGS = Object.keys(FILES) as ConfigName[];

/**
 * The board's own config directory: $KANBAN95_HOME, else ~/.kanban95. Every operator-level file (models.json, settings.json,
 * preferences.md, voice models) lives here and nowhere else. Under vitest the real one is refused, so no test can overwrite it.
 */
export function boardHome(): string {
  if (process.env.KANBAN95_HOME) return process.env.KANBAN95_HOME;
  if (process.env.VITEST) throw new Error('refusing the real ~/.kanban95 under vitest: set KANBAN95_HOME (test/home.ts does)');
  return join(homedir(), '.kanban95');
}

export const configPath = (name: ConfigName) => join(boardHome(), `${name}.json`);

/** A file that does not pass its schema. REST answers it with 400. */
export class BadConfig extends Error {}

function check<N extends ConfigName>(name: N, value: unknown, where: string): Config<N> {
  const r = FILES[name].safeParse(value);
  if (!r.success) throw new BadConfig(`${where}: ${z.prettifyError(r.error).replaceAll('\n', '; ')}`);
  return r.data as Config<N>;
}

/** models.json has no default (the operator picks the models); a missing settings.json is all defaults. */
export function readConfig<N extends ConfigName>(name: N): Config<N> {
  const file = configPath(name);
  if (!existsSync(file)) {
    if (name === 'models') throw new BadConfig(`no model catalog at ${file}`);
    return check(name, {}, file);
  }
  return check(name, JSON.parse(readFileSync(file, 'utf8')), file);
}

/** Checked first, then written whole through a temp file, so a bad edit never reaches the file and a crash never half-writes it. */
export function writeConfig<N extends ConfigName>(name: N, value: unknown): Config<N> {
  const file = configPath(name);
  const data = check(name, value, `${name}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2) + '\n');
  renameSync(`${file}.tmp`, file);
  return data;
}

/**
 * Every model each installed CLI knows, for the Settings dropdowns; free text stays allowed. Nothing is named here.
 * Codex: every entry of ~/.codex/models_cache.json (its own picker hides some), in its order. Claude Code has no list command:
 * its "latest model" aliases from `claude --help` come first, then every full id compiled into its executable, newest first.
 * Any failure is an empty list.
 */
export async function knownModels(): Promise<Record<Cli, string[]>> {
  const codex = (() => {
    try {
      const { models } = JSON.parse(readFileSync(join(homedir(), '.codex', 'models_cache.json'), 'utf8'));
      return models.sort((a: { priority: number }, b: { priority: number }) => a.priority - b.priority).map((m: { slug: string }) => m.slug);
    } catch {
      return [];
    }
  })();
  const exe = (() => { try { return readConfig('settings').paths.claude; } catch { return ''; } })()
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
export function runSettings(t: Ticket | null, phase: 'plan' | 'execute' | 'test' | 'operator'): { cli: Cli; model: string; effort: Effort; path?: string } {
  const file = configPath('models');
  if (!existsSync(file)) throw new Error(`no model catalog at ${file}`);
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  const cli = t?.cli ?? cfg.cli;
  if (!CLIS.includes(cli)) throw new Error(`unknown cli ${cli} in ${file}; expected ${CLIS.join(' or ')}`);
  const d = cfg[cli]?.[phase] ?? {};
  const own = phase === 'execute';
  const model = (own && t?.model) || d.model || '';
  const effort = (own && t?.effort) || d.effort || 'medium';
  if (!model && phase !== 'operator') throw new Error(`no ${phase} model for ${cli} in ${file}`);
  const bad = model && uncatalogued(model, cli);
  if (bad) throw new Error(bad);
  // Only a model id outside the list is caught before launch; an agent stuck at its prompt for another reason is flagged by the
  // silence watch (lifecycle.ts) after idle_minutes.
  if (!EFFORT.includes(effort)) throw new Error(`bad effort ${effort} for ${cli} ${phase} in ${file}`);
  return { cli, model, effort, path: readConfig('settings').paths[cli as Cli] || undefined };
}

/**
 * Why a model id may not run on a CLI: it is not in that CLI's `models` list in models.json. No list (or no file) means
 * no check, so a catalog written before the list existed keeps launching. Null when the model is fine.
 */
export function uncatalogued(model: string, cli?: string | null): string | null {
  const file = configPath('models');
  if (!existsSync(file)) return null;
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  const c = cli ?? cfg.cli;
  const list = cfg[c]?.models;
  if (!Array.isArray(list) || list.includes(model)) return null;
  return `model ${model} is not in the ${c} model list in ${file}`;
}

/** The operator's configured executable for a CLI, else its bare name for PATH. A broken settings.json reads as unset. */
export function cliPath(cli: Cli): string {
  try {
    return readConfig('settings').paths[cli] || cli;
  } catch {
    return cli;
  }
}

/** ~/.kanban95/preferences.md: the operator's standing instructions, injected into every prompt as {{preferences}}. */
export const preferencesPath = () => join(boardHome(), 'preferences.md');
const PREFERENCES_MAX = 16 * 1024;

/** A missing file is an empty string. */
export function readPreferences(): string {
  try {
    return readFileSync(preferencesPath(), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw e;
  }
}

/** Refused over 16 KB (UTF-8 bytes); written through a temp file like the config files. */
export function writePreferences(value: unknown): string {
  if (typeof value !== 'string') throw new BadConfig('preferences.md: value must be a string');
  if (Buffer.byteLength(value) > PREFERENCES_MAX) throw new BadConfig(`preferences.md: over ${PREFERENCES_MAX / 1024} KB`);
  const file = preferencesPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, value);
  renameSync(`${file}.tmp`, file);
  return value;
}

/**
 * ~/.kanban95/projects.json: `[{ path, colour }]`, one entry per repo the operator runs a board on (Settings → Projects).
 * `colour` is the wallpaper's base: a hex colour, or a hue (0 to 360) painted at the teal's saturation and lightness.
 * The display name is the folder's basename, never stored.
 */
export const projectsPath = () => join(boardHome(), 'projects.json');
export const DEFAULT_COLOUR = '#008080';
const projectList = z.array(z.object({
  path: z.string().refine(isAbsolute, 'must be an absolute path'),
  colour: z.union([z.string().regex(/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i, 'must be #rgb or #rrggbb'), z.number().min(0).max(360)]),
}).strict());
export type Project = z.output<typeof projectList>[number];

/** Absolute, resolved and in the file system's own spelling (case, 8.3 names), so one repo is one entry. */
const normal = (p: string) => {
  try {
    return realpathSync.native(resolve(p));
  } catch {
    return resolve(p);
  }
};
const same = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/** A missing file is an empty list. Only the shape is checked on read: a repo deleted since does not break every board. */
export function readProjects(): Project[] {
  const file = projectsPath();
  if (!existsSync(file)) return [];
  const r = projectList.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!r.success) throw new BadConfig(`${file}: ${z.prettifyError(r.error).replaceAll('\n', '; ')}`);
  return r.data;
}

function saveProjects(list: Project[]) {
  const file = projectsPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(list, null, 2) + '\n');
  renameSync(`${file}.tmp`, file);
}

/** The whole list, checked before anything is written: every path an existing git repo, listed once, `keep` among them. */
export function writeProjects(value: unknown, keep: string): Project[] {
  const r = projectList.safeParse(value);
  if (!r.success) throw new BadConfig(`projects.json: ${z.prettifyError(r.error).replaceAll('\n', '; ')}`);
  const list = r.data.map((p) => ({ ...p, path: normal(p.path) }));
  for (const [i, p] of list.entries()) {
    if (!existsSync(join(p.path, '.git'))) throw new BadConfig(`projects.json: ${p.path} is not a git repo`);
    if (list.findIndex((q) => same(q.path, p.path)) !== i) throw new BadConfig(`projects.json: ${p.path} is listed twice`);
  }
  if (!list.some((p) => same(p.path, normal(keep)))) throw new BadConfig(`projects.json: this board's own project ${normal(keep)} cannot be removed`);
  saveProjects(list);
  return list;
}

/** On daemon start: list the repo it serves, with the default colour, unless it is listed already. */
export function addProject(repo: string) {
  const list = readProjects();
  if (!list.some((p) => same(p.path, normal(repo)))) saveProjects([...list, { path: normal(repo), colour: DEFAULT_COLOUR }]);
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
