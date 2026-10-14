CREATE TABLE deliverables (
  folder    TEXT PRIMARY KEY,
  ticket_id INTEGER NOT NULL,
  title     TEXT NOT NULL,
  merged_at TEXT NOT NULL
);
