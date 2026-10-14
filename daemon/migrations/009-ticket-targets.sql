-- Tickets a ticket's worker and tester may read beyond their own and its dependencies; edit = 1 also lets the worker update their body and criteria.
-- Not a dependency: a target never blocks or orders anything. Documented in docs/DATA.md.
CREATE TABLE ticket_targets (
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  target_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  edit      INTEGER NOT NULL DEFAULT 0 CHECK (edit IN (0, 1)),
  PRIMARY KEY (ticket_id, target_id),
  CHECK (ticket_id <> target_id)
);
