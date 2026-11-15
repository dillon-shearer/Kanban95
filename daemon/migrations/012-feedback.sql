CREATE TABLE feedback (
  id            INTEGER PRIMARY KEY,
  type          TEXT NOT NULL CHECK (type IN ('bug', 'idea', 'missing_capability')),
  title         TEXT NOT NULL,
  area          TEXT NOT NULL DEFAULT '',
  failure_mode  TEXT NOT NULL DEFAULT '',
  task_category TEXT NOT NULL DEFAULT '',
  details       TEXT NOT NULL,
  sources       TEXT NOT NULL,
  count         INTEGER NOT NULL DEFAULT 1,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'incorporated', 'dropped')),
  reason        TEXT,
  ticket_id     INTEGER,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX feedback_open ON feedback (status, title);
