// Prompt templates: markdown with {{var}} placeholders, read from <repo>/.kanban95/templates/ on every render.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
export const VARS = ['ticket', 'criteria', 'brain', 'notes', 'retry', 'diff', 'tools', 'base', 'preferences', 'mission', 'worktrees', 'ready'] as const;
export type Ctx = Record<(typeof VARS)[number], string>;

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
const templatesDir = (repo: string) => join(repo, '.kanban95', 'templates');
export const templatePath = (repo: string, name: TemplateName) => join(templatesDir(repo), `${name}.md`);
/** `{name: sha256}` of the shipped default each copy was last copied or reset from. */
export const shippedPath = (repo: string) => join(templatesDir(repo), '.shipped.json');
/** The text an unrecorded copy had before a start replaced it, kept until the next start (git-ignored). */
export const replacedPath = (repo: string, name: TemplateName) => join(templatesDir(repo), `${name}.replaced.md`);
const shipped = (name: string) => readFileSync(join(DEFAULTS_DIR, `${name}.md`), 'utf8');
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

function readShipped(repo: string): Record<string, string> {
  try {
    const v = JSON.parse(readFileSync(shippedPath(repo), 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' || e instanceof SyntaxError) return {}; // a broken record counts as none: every differing copy is replaced, its old text kept once
    throw e;
  }
}

function writeAtomic(file: string, text: string) {
  writeFileSync(`${file}.tmp`, text);
  renameSync(`${file}.tmp`, file);
}

const recordShipped = (repo: string, rec: Record<string, string>) => writeAtomic(shippedPath(repo), `${JSON.stringify(rec, null, 2)}\n`);

/** True when `text`, a repo copy, differs from the current shipped default (edited, or copied from an older default). */
export const isStale = (name: TemplateName, text: string) => text !== shipped(name);

/** The first variable in `text` outside VARS, or null when every placeholder is allowed. */
export function unknownVar(text: string): string | null {
  for (const [, v] of text.matchAll(PLACEHOLDER)) if (!(VARS as readonly string[]).includes(v)) return v;
  return null;
}

/**
 * Brings the repo's copies in step with the shipped defaults, on daemon start. A missing copy is copied. A copy whose
 * sha256 still equals the one recorded in `.shipped.json` is unedited, so a changed default replaces it. A copy with no
 * record was written by a daemon from before the record (Settings → Prompts → Save leaves the record alone, so an edit
 * made there keeps it), so it is replaced too: its old text goes to `<name>.replaced.md` until the next start and a log
 * line names it. A recorded copy whose hash differs from its record is edited and never overwritten.
 */
export function initTemplates(repo: string) {
  mkdirSync(templatesDir(repo), { recursive: true });
  const rec = readShipped(repo);
  const before = JSON.stringify(rec);
  for (const name of Object.keys(TEMPLATES) as TemplateName[]) {
    rmSync(replacedPath(repo, name), { force: true }); // shown once: the start after a replacement removes it
    const text = shipped(name);
    const hash = sha256(text);
    const file = join(templatesDir(repo), `${name}.md`);
    if (!existsSync(file)) {
      writeAtomic(file, text);
      rec[name] = hash;
      continue;
    }
    const old = readFileSync(file, 'utf8');
    const copy = sha256(old);
    if (copy === hash) rec[name] = hash;
    else if (rec[name] === copy) {
      writeAtomic(file, text);
      rec[name] = hash;
    } else if (rec[name] === undefined) {
      writeAtomic(replacedPath(repo, name), old);
      writeAtomic(file, text);
      rec[name] = hash;
      console.error(`[templates] ${name}.md had no .shipped.json record and differed from the default: replaced it; its old text is in ${name}.replaced.md until the next start`);
    }
  }
  if (JSON.stringify(rec) !== before) recordShipped(repo, rec);
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
  writeAtomic(file, text);
}

/** Overwrites the repo's copy with the shipped default in templates/ and records its hash, so later defaults reach it. */
export function resetTemplate(repo: string, name: TemplateName) {
  const text = shipped(name);
  writeTemplate(repo, name, text);
  recordShipped(repo, { ...readShipped(repo), [name]: sha256(text) });
}

/** Single pass: a value that itself contains {{...}} (a brain note, a diff) is inserted literally, never expanded. A missing value is refused, never rendered as "undefined". */
export const fill = (text: string, ctx: Ctx) => text.replace(PLACEHOLDER, (_, v: keyof Ctx) => {
  if (typeof ctx[v] !== 'string') throw new Error(`no value for {{${v}}}`);
  return ctx[v];
});
export const render = (repo: string, name: TemplateName, ctx: Ctx) => fill(loadTemplate(repo, name), ctx);
