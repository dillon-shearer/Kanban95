import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.ts';
import { audit, mint, revoke, verify } from '../src/grants.ts';

let repo: string;
let db: DatabaseSync;
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'k95-'));
  db = openDb(repo);
  db.prepare("INSERT INTO tickets (title) VALUES ('t1')").run();
});
afterAll(() => {
  db.close();
  rmSync(repo, { recursive: true, force: true });
});

describe('grants', () => {
  it('verifies a live token and returns its scope', () => {
    const { id, token } = mint(db, { ticket: 1, role: 'worker', ttlMs: 60_000 });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(verify(db, token)).toMatchObject({ id, ticket_id: 1, role: 'worker', revoked_at: null });
  });

  it('stores only a hash: the raw token appears nowhere in the database', () => {
    const { id, token } = mint(db, { ticket: 1, role: 'tester', ttlMs: 60_000 });
    const row = db.prepare('SELECT token_hash FROM grants WHERE id = ?').get(id) as { token_hash: string };
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.token_hash).not.toContain(token);
  });

  it('rejects an expired token', () => {
    const { token } = mint(db, { ticket: 1, role: 'worker', ttlMs: -1 });
    expect(verify(db, token)).toBeNull();
  });

  it('rejects a revoked token, and revoke is idempotent', () => {
    const { id, token } = mint(db, { ticket: 1, role: 'worker', ttlMs: 60_000 });
    expect(revoke(db, id)).toBe(true);
    expect(verify(db, token)).toBeNull();
    expect(revoke(db, id)).toBe(false);
  });

  it('rejects a token with one byte changed, and an unknown token', () => {
    const { token } = mint(db, { ticket: 1, role: 'worker', ttlMs: 60_000 });
    const flipped = (token[0] === 'A' ? 'B' : 'A') + token.slice(1);
    expect(verify(db, flipped)).toBeNull();
    expect(verify(db, '')).toBeNull();
    expect(verify(db, 'not-a-token')).toBeNull();
  });

  it('a planner grant carries no ticket', () => {
    const { token } = mint(db, { ticket: null, role: 'planner', ttlMs: 60_000 });
    expect(verify(db, token)).toMatchObject({ ticket_id: null, role: 'planner' });
    expect(() => mint(db, { ticket: 1, role: 'planner', ttlMs: 60_000 })).toThrow(/CHECK constraint/);
  });

  it('audit truncates args to 200 chars and keeps the grant id', () => {
    audit(db, { grant_id: 1, ticket_id: 1, tool: 'add_note', args: { body: 'x'.repeat(1000) }, outcome: 'ok' });
    const row = db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 1').get() as Record<string, unknown>;
    expect(row).toMatchObject({ grant_id: 1, ticket_id: 1, tool: 'add_note', outcome: 'ok' });
    expect((row.args_summary as string).length).toBe(200);
  });
});
