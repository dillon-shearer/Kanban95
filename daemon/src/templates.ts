// Prompt templates: markdown with {{var}} placeholders, read from <repo>/.kanban95/templates/ on every render.
import { constants, copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Role } from './grants.js';

export const DEFAULTS_DIR = resolve(import.meta.dirname, '../../templates');

/** Every template, the grant role its session runs on, and the `runs.phase` it records (brainstorm has no ticket, so no run). */
export const TEMPLATES = {
  brainstorm: { role: 'planner', phase: null },
  plan: { role: 'worker', phase: 'plan' },
  execute: { role: 'worker', phase: 'execute' },
  housekeeping: { role: 'worker', phase: 'execute' },
  test: { role: 'tester', phase: 'test' },
} as const satisfies Record<string, { role: Role; phase: 'plan' | 'execute' | 'test' | null }>;
export type TemplateName = keyof typeof TEMPLATES;

/** The only variables a template may use. Anything else is refused before a single value is substituted. */
export const VARS = ['ticket', 'criteria', 'brain', 'notes', 'retry', 'diff', 'tools'] as const;
export type Ctx = Record<(typeof VARS)[number], string>;

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
const templatesDir = (repo: string) => join(repo, '.kanban95', 'templates');

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
  const text = readFileSync(join(templatesDir(repo), `${name}.md`), 'utf8');
  for (const [, v] of text.matchAll(PLACEHOLDER)) {
    if (!(VARS as readonly string[]).includes(v)) throw new Error(`template ${name}.md uses unknown variable {{${v}}}`);
  }
  return text;
}

/** Single pass: a value that itself contains {{...}} (a brain note, a diff) is inserted literally, never expanded. */
export const fill = (text: string, ctx: Ctx) => text.replace(PLACEHOLDER, (_, v: keyof Ctx) => ctx[v]);
export const render = (repo: string, name: TemplateName, ctx: Ctx) => fill(loadTemplate(repo, name), ctx);
