-- Kanban95 board schema, version 001. Documented in docs/DATA.md.

CREATE TABLE tickets (
  id              INTEGER PRIMARY KEY,
  title           TEXT NOT NULL CHECK (length(title) > 0),
  body            TEXT NOT NULL DEFAULT '',
  criteria        TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'backlog'
                  CHECK (status IN ('backlog', 'in_progress', 'testing', 'done')),
  needs_human     INTEGER NOT NULL DEFAULT 0 CHECK (needs_human IN (0, 1)),
  blocked_on_deps INTEGER NOT NULL DEFAULT 0 CHECK (blocked_on_deps IN (0, 1)),
  cli             TEXT,
  model           TEXT,
  effort          TEXT CHECK (effort IS NULL OR effort IN ('low', 'medium', 'high', 'max')),
  retry           INTEGER NOT NULL DEFAULT 0 CHECK (retry >= 0),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TRIGGER tickets_touch AFTER UPDATE ON tickets BEGIN
  UPDATE tickets SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- depends_on as a join table so the FK makes a dangling dependency impossible.
CREATE TABLE ticket_deps (
  ticket_id     INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  depends_on_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE RESTRICT,
  PRIMARY KEY (ticket_id, depends_on_id),
  CHECK (ticket_id <> depends_on_id)
);

CREATE TABLE notes (
  id         INTEGER PRIMARY KEY,
  ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('planner', 'worker', 'tester', 'operator')),
  kind       TEXT NOT NULL CHECK (kind IN ('plan', 'decision', 'failure', 'summary', 'question', 'answer')),
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX notes_ticket ON notes(ticket_id);

CREATE TABLE brain (
  id         INTEGER PRIMARY KEY,
  title      TEXT NOT NULL CHECK (length(title) > 0),
  body       TEXT NOT NULL,
  tags       TEXT NOT NULL DEFAULT '',
  ticket_id  INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE VIRTUAL TABLE brain_fts USING fts5(title, body, tags, content='brain', content_rowid='id');
CREATE TRIGGER brain_ai AFTER INSERT ON brain BEGIN
  INSERT INTO brain_fts(rowid, title, body, tags) VALUES (NEW.id, NEW.title, NEW.body, NEW.tags);
END;
CREATE TRIGGER brain_ad AFTER DELETE ON brain BEGIN
  INSERT INTO brain_fts(brain_fts, rowid, title, body, tags) VALUES ('delete', OLD.id, OLD.title, OLD.body, OLD.tags);
END;
CREATE TRIGGER brain_au AFTER UPDATE ON brain BEGIN
  INSERT INTO brain_fts(brain_fts, rowid, title, body, tags) VALUES ('delete', OLD.id, OLD.title, OLD.body, OLD.tags);
  INSERT INTO brain_fts(rowid, title, body, tags) VALUES (NEW.id, NEW.title, NEW.body, NEW.tags);
END;

CREATE TABLE runs (
  id              INTEGER PRIMARY KEY,
  ticket_id       INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  phase           TEXT NOT NULL CHECK (phase IN ('plan', 'execute', 'test')),
  cli             TEXT NOT NULL,
  model           TEXT NOT NULL,
  effort          TEXT NOT NULL CHECK (effort IN ('low', 'medium', 'high', 'max')),
  prompt_rendered TEXT NOT NULL,
  started_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ended_at        TEXT,
  outcome         TEXT
);
CREATE INDEX runs_ticket ON runs(ticket_id);

CREATE TABLE grants (
  id         INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  ticket_id  INTEGER REFERENCES tickets(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('planner', 'worker', 'tester')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((role = 'planner') = (ticket_id IS NULL))
);

CREATE TABLE audit (
  id           INTEGER PRIMARY KEY,
  grant_id     INTEGER REFERENCES grants(id) ON DELETE SET NULL,
  ticket_id    INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
  tool         TEXT NOT NULL,
  args_summary TEXT NOT NULL DEFAULT '',
  outcome      TEXT NOT NULL CHECK (outcome IN ('ok', 'denied', 'error')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX audit_ticket ON audit(ticket_id);
CREATE INDEX audit_grant ON audit(grant_id);
