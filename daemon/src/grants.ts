// Scoped, revocable bearer grants. The raw token leaves mint() once; only its SHA-256 is stored.
import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type Role = 'planner' | 'worker' | 'tester' | 'operator';
export interface Grant {
  id: number;
  ticket_id: number | null;
  role: Role;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
}

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export function mint(db: DatabaseSync, g: { ticket: number | null; role: Role; ttlMs: number }): { id: number; token: string } {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + g.ttlMs).toISOString();
  const { lastInsertRowid } = db
    .prepare('INSERT INTO grants (token_hash, ticket_id, role, expires_at) VALUES (?, ?, ?, ?)')
    .run(hash(token), g.ticket, g.role, expires);
  return { id: Number(lastInsertRowid), token };
}

/** Null for unknown, expired or revoked tokens. Callers never learn which. */
export function verify(db: DatabaseSync, token: string): Grant | null {
  const g = db
    .prepare('SELECT id, ticket_id, role, expires_at, revoked_at, created_at FROM grants WHERE token_hash = ?')
    .get(hash(token)) as Grant | undefined;
  if (!g || g.revoked_at !== null || g.expires_at <= new Date().toISOString()) return null;
  return g;
}

export function revoke(db: DatabaseSync, id: number): boolean {
  const r = db.prepare('UPDATE grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(new Date().toISOString(), id);
  return r.changes > 0;
}

export function audit(
  db: DatabaseSync,
  a: { grant_id: number | null; ticket_id: number | null; tool: string; args?: unknown; outcome: 'ok' | 'denied' | 'error' },
): void {
  const summary = a.args === undefined ? '' : JSON.stringify(a.args).slice(0, 200);
  db.prepare('INSERT INTO audit (grant_id, ticket_id, tool, args_summary, outcome) VALUES (?, ?, ?, ?, ?)').run(
    a.grant_id, a.ticket_id, a.tool, summary, a.outcome,
  );
}
