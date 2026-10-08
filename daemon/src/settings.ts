// The operator's own settings in ~/.kanban95/, edited in the Settings window. No secrets live here.
// models.json: which CLI, and the model and effort per phase (docs/LIFECYCLE.md → Run settings). settings.json: CLI paths,
// sounds, voice. Both are read on every use, so an edit applies to the next run without a restart.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import * as z from 'zod';
import type { Ticket } from './api.js';

export const CLIS = ['claude', 'codex'] as const;
export type Cli = (typeof CLIS)[number];
export const EFFORT = ['low', 'medium', 'high', 'max'] as const;
export type Effort = (typeof EFFORT)[number];

const phase = z.object({ model: z.string().trim().min(1), effort: z.enum(EFFORT).default('medium') }).strict();
const perCli = z.object({ plan: phase, execute: phase, test: phase }).partial().strict();
const exe = z.string().refine((p) => p === '' || (isAbsolute(p) && existsSync(p)), 'must be empty or an absolute path to an existing file');
const FILES = {
  models: z.object({ cli: z.enum(CLIS), claude: perCli.optional(), codex: perCli.optional() }).strict(),
  settings: z.object({
    paths: z.object({ claude: exe, codex: exe }).partial().strict().default({}),
    sounds: z.boolean().default(true),
    voice: z.object({ backend: z.enum(['local']).default('local'), mode: z.enum(['push', 'toggle']).default('push') }).strict()
      .default({ backend: 'local', mode: 'push' }),
  }).strict(),
};
export type ConfigName = keyof typeof FILES;
type Config<N extends ConfigName> = z.output<(typeof FILES)[N]>;
export const CONFIGS = Object.keys(FILES) as ConfigName[];

export const configPath = (name: ConfigName) => join(homedir(), '.kanban95', `${name}.json`);

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
 * cli, model, effort and executable for a run. The ticket's cli wins; its model and effort override the execute phase only.
 * A brainstorm (no ticket) runs the plan phase.
 */
export function runSettings(t: Ticket | null, phase: 'plan' | 'execute' | 'test'): { cli: Cli; model: string; effort: Effort; path?: string } {
  const file = configPath('models');
  if (!existsSync(file)) throw new Error(`no model catalog at ${file}`);
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  const cli = t?.cli ?? cfg.cli;
  if (!CLIS.includes(cli)) throw new Error(`unknown cli ${cli} in ${file}; expected ${CLIS.join(' or ')}`);
  const d = cfg[cli]?.[phase] ?? {};
  const own = phase === 'execute';
  const model = (own && t?.model) || d.model;
  const effort = (own && t?.effort) || d.effort || 'medium';
  if (!model) throw new Error(`no ${phase} model for ${cli} in ${file}`);
  if (!EFFORT.includes(effort)) throw new Error(`bad effort ${effort} for ${cli} ${phase} in ${file}`);
  return { cli, model, effort, path: readConfig('settings').paths[cli as Cli] || undefined };
}
