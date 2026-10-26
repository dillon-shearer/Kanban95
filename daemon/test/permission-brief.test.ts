import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initTemplates, render, VARS, type Ctx, type TemplateName } from '../src/templates.ts';

let repo: string;
const ctx = Object.fromEntries(VARS.map((v) => [v, `<${v}>`])) as Ctx;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'k95-'));
  initTemplates(repo);
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('permission brief', () => {
  it('every ticket agent brief tells it how to ask for reach and where to file a board gap', () => {
    for (const name of ['execute', 'test'] as TemplateName[]) {
      const out = render(repo, name, ctx);
      expect(out, name).toContain('request_permission');
      expect(out, name).toMatch(/Never retry the refused call before the answer/);
      expect(out, name).toMatch(/- 4: [\s\S]*- read_all:/);
      expect(out, name).toContain('file_on_board');
    }
  });

  it('the planner brief never offers request_permission and leaves closing tickets to the operator', () => {
    const out = render(repo, 'brainstorm', ctx);
    expect(out).not.toContain('request_permission');
    expect(out).toMatch(/drag the card to Done/);
    expect(out).toContain('file_on_board');
  });

  it('the operator terminal brief never offers request_permission and reports board gaps in the terminal', () => {
    const out = render(repo, 'operator', ctx);
    expect(out).not.toContain('request_permission');
    expect(out).toMatch(/there is no level to raise/);
    expect(out).toMatch(/file_on_board[\s\S]*tell the operator the filed id in this terminal/);
  });
});
