-- Who made a ticket: the grant whose create_ticket call inserted it; null for the UI. Documented in docs/DATA.md.
-- A worker may edit and delete only Backlog tickets its own grant created (docs/SECURITY.md).
ALTER TABLE tickets ADD COLUMN created_by_grant INTEGER REFERENCES grants(id) ON DELETE SET NULL;
