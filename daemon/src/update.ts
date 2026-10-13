import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as z from 'zod';
import { running, tellShell } from './boards.js';
import { events, holding, type Board } from './lifecycle.js';
import { readConfig } from './settings.js';

export const VERSION: string = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../package.json'), 'utf8')).version;

const version = z.string().min(1).max(64);
export const REPORT = z.discriminatedUnion('state', [
  z.object({ state: z.literal('available'), version, current: version }).strict(),
  z.object({ state: z.literal('current'), current: version }).strict(),
  z.object({ state: z.literal('failed'), error: z.string().max(2000) }).strict(),
  z.object({ state: z.literal('downloading'), done: z.number().min(0), total: z.number().min(0).nullable() }).strict(),
  z.object({ state: z.literal('installing') }).strict(),
]);
type Report = z.output<typeof REPORT>;

export function askForCheck(board: Board) {
  if (!board.shell) return;
  let on = true;
  try {
    on = readConfig('settings', board.repo).updateCheck;
  } catch {}
  if (on) tellShell('check', board.repo);
}

export function relay(board: Board, r: Report) {
  if (r.state === 'available') board.update = { version: r.version, current: r.current };
  if (r.state === 'current') board.update = undefined;
  events.emit('event', { update: r });
}

function agentsRunning(board: Board): number {
  const others = running().filter((e) => e.pid !== process.pid && board.shellId != null && e.shell === board.shellId);
  return holding(board) + others.reduce((n, e) => n + (Number.isInteger(e.agents) ? e.agents : 0), 0);
}

export function busy(board: Board, done: string, again: string): string | null {
  const n = agentsRunning(board);
  return n ? `${done}: ${n} agent${n === 1 ? ' is' : 's are'} running. ${again} when ${n === 1 ? 'it finishes' : 'they finish'}.` : null;
}

export function installNow(board: Board): string | null {
  if (!board.update) return 'No update is waiting. Check for updates first.';
  const refused = busy(board, 'Not updated', 'Update');
  if (refused) return refused;
  tellShell('update', board.repo);
  return null;
}

export const checkNow = (board: Board) => tellShell('checknow', board.repo);
