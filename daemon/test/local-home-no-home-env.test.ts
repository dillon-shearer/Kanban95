import { userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { localHome } from '../src/settings.ts';

const KEYS = ['HOME', 'USERPROFILE', 'KANBAN95_HOME', 'VITEST'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const expected = join(userInfo().homedir, '.kanban95');

it.each([
  ['unset', undefined],
  ['empty', ''],
  ['relative', 'Kanban95.app'],
])('localHome is .kanban95 in the account home when HOME is %s', (_, value) => {
  for (const k of KEYS) delete process.env[k];
  if (value !== undefined) process.env.HOME = process.env.USERPROFILE = value;
  expect(localHome()).toBe(expected);
});
