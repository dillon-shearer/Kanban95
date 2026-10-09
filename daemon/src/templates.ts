// Prompt templates: markdown with {{var}} placeholders, read from <repo>/.kanban95/templates/ on every render.
import { constants, copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Role } from './grants.js';

export const DEFAULTS_DIR = resolve(import.meta.dirname, '../../templates');

/** Every template, the grant role its session runs on, and the `runs.phase` it records (brainstorm and operator have no ticket, so no run). */
export const TEMPLATES = {
  brainstorm: { role: 'planner', phase: null },
  operator: { role: 'operator', phase: null },
  plan: { role: 'worker', phase: 'plan' },
  execute: { role: 'worker', phase: 'execute' },
  housekeeping: { role: 'worker', phase: 'execute' },
  test: { role: 'tester', phase: 'test' },
} as const satisfies Record<string, { role: Role; phase: 'plan' | 'execute' | 'test' | null }>;
export type TemplateName = keyof typeof TEMPLATES;
/** The templates a ticket runs: each records a `runs` row. */
export type TicketTemplate = Exclude<TemplateName, 'brainstorm' | 'operator'>;

/** The only variables a template may use. Anything else is refused before a single value is substituted. */
export const VARS = ['ticket', 'criteria', 'brain', 'notes', 'retry', 'diff', 'tools', 'base', 'preferences', 'mission'] as const;
export type Ctx = Record<(typeof VARS)[number], string>;

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
const templatesDir = (repo: string) => join(repo, '.kanban95', 'templates');
export const templatePath = (repo: string, name: TemplateName) => join(templatesDir(repo), `${name}.md`);

/** The first variable in `text` outside VARS, or null when every placeholder is allowed. */
export function unknownVar(text: string): string | null {
  for (const [, v] of text.matchAll(PLACEHOLDER)) if (!(VARS as readonly string[]).includes(v)) return v;
  return null;
}

/** Copies each default template into the repo once. An existing file, edited or not, is never overwritten. */
export function initTemplates(repo: string) {
  mkdirSync(templatesDir(repo), { recursive: true });
  for (const name of Object.keys(TEMPLATES)) {
    try {
      copyFileSync(join(DEFAULTS_DIR, `${name}.md`), join(templatesDir(repo), `${name}.md`), constants.COPYFILE_EXCL);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
}

/** Reads the template and refuses it if it names a variable outside VARS. No ctx is involved, so a bad template fails the same way every time. */
export function loadTemplate(repo: string, name: TemplateName): string {
  if (!Object.hasOwn(TEMPLATES, name)) throw new Error(`unknown template ${name}`);
  const text = readFileSync(templatePath(repo, name), 'utf8');
  const v = unknownVar(text);
  if (v !== null) throw new Error(`template ${name}.md uses unknown variable {{${v}}}`);
  return text;
}

/** Replaces the repo's copy whole. The caller has checked `text` with unknownVar, so the next render cannot fail on it. */
export function writeTemplate(repo: string, name: TemplateName, text: string) {
  const file = templatePath(repo, name);
  mkdirSync(templatesDir(repo), { recursive: true });
  writeFileSync(`${file}.tmp`, text);
  renameSync(`${file}.tmp`, file);
}

/** Overwrites the repo's copy with the shipped default in templates/. */
export function resetTemplate(repo: string, name: TemplateName) {
  writeTemplate(repo, name, readFileSync(join(DEFAULTS_DIR, `${name}.md`), 'utf8'));
}

/** Single pass: a value that itself contains {{...}} (a brain note, a diff) is inserted literally, never expanded. A missing value is refused, never rendered as "undefined". */
export const fill = (text: string, ctx: Ctx) => text.replace(PLACEHOLDER, (_, v: keyof Ctx) => {
  if (typeof ctx[v] !== 'string') throw new Error(`no value for {{${v}}}`);
  return ctx[v];
});
export const render = (repo: string, name: TemplateName, ctx: Ctx) => fill(loadTemplate(repo, name), ctx);
