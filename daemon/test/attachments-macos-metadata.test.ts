import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { attachmentDir, attachments } from '../src/attachments.ts';

let repo = '';
afterEach(() => rmSync(repo, { recursive: true, force: true }));

test('attachments() leaves out macOS ._ and .DS_Store files', () => {
  repo = mkdtempSync(join(tmpdir(), 'k95-attach-'));
  const dir = attachmentDir(repo, 7);
  mkdirSync(dir, { recursive: true });
  for (const name of ['shot.png', '._shot.png', '.DS_Store']) writeFileSync(join(dir, name), 'x');
  expect(attachments(repo, 7).map((a) => a.name)).toEqual(['shot.png']);
});
