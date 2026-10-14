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
  it('every agent brief tells it how to ask for reach and where to file a board gap', () => {
    for (const name of ['execute', 'test', 'operator', 'brainstorm'] as TemplateName[]) {
      const out = render(repo, name, ctx);
      expect(out, name).toContain('request_permission');
      expect(out, name).toMatch(/Never retry the refused call before the answer/);
      expect(out, name).toMatch(/- 4: [\s\S]*- read_all:/);
      expect(out, name).toContain('file_on_board');
    }
  });
});
