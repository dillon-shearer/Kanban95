CREATE TABLE deliverables_new (
  folder    TEXT PRIMARY KEY,
  ticket_id INTEGER,
  title     TEXT NOT NULL,
  merged_at TEXT NOT NULL
);
INSERT INTO deliverables_new (folder, ticket_id, title, merged_at) SELECT folder, ticket_id, title, merged_at FROM deliverables;
DROP TABLE deliverables;
ALTER TABLE deliverables_new RENAME TO deliverables;
