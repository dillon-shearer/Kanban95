import { randomBytes } from 'node:crypto';
import * as z from 'zod';
import { tellShell } from './boards.js';

export const PICK_MS = 5 * 60_000;

const RESULT = z.union([z.object({ path: z.string().min(1).max(4096) }).strict(), z.object({ cancelled: z.literal(true) }).strict()]);
type Picked = z.output<typeof RESULT>;
export type PickFrame = { type: 'pick'; token: string } & Picked;
type Reply = { status: number; body?: unknown };

let open: { token: string; timer: NodeJS.Timeout; deliver?: (f: PickFrame) => void; result?: Picked } | null = null;

const refuse = (status: number, error: string): Reply => ({ status, body: { error } });

export function startPick(shell: boolean, path: string, kind: unknown, deliver?: (f: PickFrame) => void): Reply {
  if (kind !== 'folder' && kind !== 'file') return refuse(400, 'kind must be folder or file');
  if (!shell) return refuse(409, 'Browse needs the Kanban95 app; this board was started without it.');
  if (open) return refuse(409, 'A file or folder dialog is already open.');
  const token = randomBytes(16).toString('hex');
  const timer = setTimeout(() => {
    if (open?.token !== token) return;
    open = null;
    deliver?.({ type: 'pick', token, cancelled: true });
  }, PICK_MS).unref();
  open = { token, timer, deliver };
  tellShell('pick', path, `${kind} ${token}`);
  return { status: 202, body: { token } };
}

export function finishPick(token: string, origin: string | undefined, body: unknown): Reply {
  if (origin !== undefined) return refuse(403, 'only the shell answers a file or folder dialog');
  if (!open || open.token !== token || open.result) return refuse(404, 'no such dialog is open');
  const r = RESULT.safeParse(body);
  if (!r.success) return refuse(400, `bad dialog result: ${r.error.issues[0]?.message}`);
  if (!open.deliver) {
    open.result = r.data;
    return { status: 204 };
  }
  const { deliver, timer } = open;
  clearTimeout(timer);
  open = null;
  deliver({ type: 'pick', token, ...r.data });
  return { status: 204 };
}

export function readPick(token: string): Reply {
  if (!open || open.token !== token) return refuse(404, 'no such dialog is open');
  if (!open.result) return { status: 200, body: { pending: true } };
  const { result, timer } = open;
  clearTimeout(timer);
  open = null;
  return { status: 200, body: result };
}
