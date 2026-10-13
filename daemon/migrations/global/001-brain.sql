-- The global brain (~/.kanban95/brain.db): the project brain's tables from 001-init.sql. No tickets table here, so
-- ticket_id has no foreign key and is always null (tickets are per repo).
CREATE TABLE brain (
  id         INTEGER PRIMARY KEY,
  title      TEXT NOT NULL CHECK (length(title) > 0),
  body       TEXT NOT NULL,
  tags       TEXT NOT NULL DEFAULT '',
  ticket_id  INTEGER CHECK (ticket_id IS NULL),
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
