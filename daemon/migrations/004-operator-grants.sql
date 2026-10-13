-- The operator role (an operator terminal): a grant with no ticket, like a planner's. Documented in docs/DATA.md.
-- SQLite cannot alter a CHECK, so grants is rebuilt. Dropping it would SET NULL every audit.grant_id (foreign keys are on
-- and the migration runs in a transaction, where the pragma cannot change), so those links are saved and put back.
CREATE TABLE grants_new (
  id         INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  ticket_id  INTEGER REFERENCES tickets(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('planner', 'worker', 'tester', 'operator')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((role IN ('planner', 'operator')) = (ticket_id IS NULL))
);
INSERT INTO grants_new SELECT id, token_hash, ticket_id, role, expires_at, revoked_at, created_at FROM grants;
CREATE TEMP TABLE audit_grant AS SELECT id, grant_id FROM audit WHERE grant_id IS NOT NULL;
DROP TABLE grants;
ALTER TABLE grants_new RENAME TO grants;
UPDATE audit SET grant_id = (SELECT grant_id FROM audit_grant g WHERE g.id = audit.id) WHERE id IN (SELECT id FROM audit_grant);
DROP TABLE audit_grant;
