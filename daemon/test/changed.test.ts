import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mapped } from './changed.ts';

// A fake test dir. The import line is built, not written out, so this file does not itself look like a browser test to
// vitest.config.ts or to `mapped`.
const cdp = `import { browser } from '.${'/cdp.ts'}';\n`;
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'k95-changed-'));
  const files: Record<string, string> = {
    'board-widgets.test.ts': cdp,                          // a browser test whose name says nothing about ui
    'ui-mentions-cdp.test.ts': '// uses cdp.ts? no: it only names it\nimport { x } from \'./ui-helpers.ts\';\n',
    'ui.ts': cdp,                                          // imports cdp.ts but is not a test file
    'templates.test.ts': '', 'mcp.test.ts': '', 'lifecycle.test.ts': '', 'db.test.ts': '', 'operator.test.ts': '',
  };
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('test:changed path mapping', () => {
  it('a ui/ change runs the tests that import ./cdp.ts, found by import and not by name', () => {
    expect(mapped(['ui/app.js'], dir)).toEqual(['board-widgets.test.ts']);
    expect(mapped(['ui/css/win.css', 'ui/index.html'], dir)).toEqual(['board-widgets.test.ts']);
  });

  it('a templates/ or skills/ change runs templates.test.ts', () => {
    expect(mapped(['templates/execute.md'], dir)).toEqual(['templates.test.ts']);
    expect(mapped(['skills/kanban95-ticket-start/SKILL.md'], dir)).toEqual(['templates.test.ts']);
    // operator.test.ts renders these two and checks the worktrees root they name.
    expect(mapped(['templates/operator.md', 'templates/housekeeping.md'], dir)).toEqual(['operator.test.ts', 'templates.test.ts']);
  });

  it('a drift-tested doc runs its drift test, and the cases union', () => {
    expect(mapped(['docs/MCP.md'], dir)).toEqual(['mcp.test.ts']);
    expect(mapped(['docs/LIFECYCLE.md'], dir)).toEqual(['lifecycle.test.ts']);
    expect(mapped(['docs/LIFECYCLE.md', 'templates/test.md', 'ui/app.js'], dir)).toEqual(['board-widgets.test.ts', 'lifecycle.test.ts', 'templates.test.ts']);
  });

  it('an unmapped path, or one that only looks like a mapped one, maps to nothing', () => {
    expect(mapped(['README.md', 'docs/ARCHITECTURE.md', 'shell/src/main.rs'], dir)).toEqual([]);
    expect(mapped(['daemon/ui/x.ts', 'docs/templates/x.md', 'daemon/docs/MCP.md'], dir)).toEqual([]);
    // TypeScript under daemon/ is vitest's module graph's job, not the mapping's.
    expect(mapped(['daemon/src/db.ts'], dir)).toEqual([]);
  });
});
