import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { heavyTests, mapped } from './changed.ts';

// A fake test dir. The import line is built, not written out, so this file does not itself look like a browser test to
// vitest.config.ts or to `mapped`.
const cdp = `import { browser } from '.${'/cdp.ts'}';\n`;
const board = `import { up } from '.${'/board.ts'}';\n`;
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'k95-changed-'));
  const files: Record<string, string> = {
    'board-widgets.test.ts': `${cdp}import { x } from './helper.ts';\nimport { y } from '../src/lifecycle.ts';\n`,
    'ui-other.test.ts': `${cdp}import { z } from '../src/voice.ts';\n`,
    'helper.ts': `import { start } from '../src/server.ts';\nimport './deep.ts';\n`,
    'deep.ts': `import { sources } from '../src/limits.ts';\n`,
    'ui-mentions-cdp.test.ts': '// uses cdp.ts? no: it only names it\nimport { x } from \'./ui-helpers.ts\';\n',
    'lifecycle-fake.test.ts': `${board}import { w } from '../src/runner.ts';\n`,
    'restart.test.ts': `import { r } from '../src/update.ts';\n`,
    'ui.ts': cdp,                                          // imports cdp.ts but is not a test file
    'templates.test.ts': '', 'mcp.test.ts': '', 'lifecycle.test.ts': '', 'db.test.ts': '', 'operator.test.ts': '',
  };
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('test:changed path mapping', () => {
  it('a templates/ or skills/ change runs templates.test.ts', () => {
    expect(mapped(['templates/execute.md'], dir)).toEqual(['templates.test.ts']);
    expect(mapped(['skills/kanban95-ticket-start/SKILL.md'], dir)).toEqual(['templates.test.ts']);
    // operator.test.ts renders these two and checks the worktrees root they name.
    expect(mapped(['templates/operator.md', 'templates/housekeeping.md'], dir)).toEqual(['operator.test.ts', 'templates.test.ts']);
  });

  it('a drift-tested doc runs its drift test, and the cases union', () => {
    expect(mapped(['docs/MCP.md'], dir)).toEqual(['mcp.test.ts']);
    expect(mapped(['docs/LIFECYCLE.md'], dir)).toEqual(['lifecycle.test.ts']);
    expect(mapped(['docs/LIFECYCLE.md', 'templates/test.md', 'ui/app.js'], dir)).toEqual(['lifecycle.test.ts', 'templates.test.ts']);
  });

  it('an unmapped path, or one that only looks like a mapped one, maps to nothing', () => {
    expect(mapped(['README.md', 'docs/ARCHITECTURE.md', 'shell/src/main.rs'], dir)).toEqual([]);
    expect(mapped(['daemon/ui/x.ts', 'docs/templates/x.md', 'daemon/docs/MCP.md'], dir)).toEqual([]);
    // TypeScript under daemon/ is vitest's module graph's job, not the mapping's.
    expect(mapped(['daemon/src/db.ts'], dir)).toEqual([]);
  });
});

describe('test:changed pty, browser and restart files', () => {
  const browser = ['board-widgets.test.ts', 'ui-other.test.ts'];

  it('a daemon file no slow test imports runs none, however much else imports it', () => {
    expect(heavyTests(['daemon/src/db.ts'], dir)).toEqual([]);
    expect(heavyTests(['daemon/src/db.ts', 'README.md', 'templates/execute.md'], dir)).toEqual([]);
  });

  it('a daemon file runs only the slow tests that import it themselves, not through a shared test helper', () => {
    expect(heavyTests(['daemon/src/lifecycle.ts'], dir)).toEqual(['board-widgets.test.ts']);
    expect(heavyTests(['daemon/src/voice.ts', 'daemon/src/runner.ts'], dir)).toEqual(['lifecycle-fake.test.ts', 'ui-other.test.ts']);
    expect(heavyTests(['daemon/src/update.ts'], dir)).toEqual(['restart.test.ts']);
    expect(heavyTests(['daemon/src/server.ts'], dir)).toEqual([]);
    expect(heavyTests(['daemon/src/limits.ts'], dir)).toEqual([]);
  });

  it('a changed test file or test helper runs the slow tests that use it, through helpers of helpers', () => {
    expect(heavyTests(['daemon/test/ui-other.test.ts'], dir)).toEqual(['ui-other.test.ts']);
    expect(heavyTests(['daemon/test/deep.ts'], dir)).toEqual(['board-widgets.test.ts']);
    expect(heavyTests(['daemon/test/cdp.ts'], dir)).toEqual(browser);
    expect(heavyTests(['daemon/test/board.ts'], dir)).toEqual(['lifecycle-fake.test.ts']);
  });

  it('a ui/ change, browser-setup.ts or --browser runs every browser test, found by import and not by name; --pty every pty test', () => {
    expect(heavyTests(['ui/app.js'], dir)).toEqual(browser);
    expect(heavyTests(['daemon/test/browser-setup.ts'], dir)).toEqual(browser);
    expect(heavyTests([], dir, ['--browser'])).toEqual(browser);
    expect(heavyTests([], dir, ['--pty'])).toEqual(['lifecycle-fake.test.ts']);
    expect(heavyTests([], dir, ['--pty', '--browser'])).toEqual([...browser, 'lifecycle-fake.test.ts'].sort());
  });
});
