-- Free-form tags for grouping: a space-separated list of distinct lowercase tokens matching [a-z0-9-]+, '' for none.
-- Normalised by normaliseTags in daemon/src/api.ts. Documented in docs/DATA.md.
ALTER TABLE tickets ADD COLUMN tags TEXT NOT NULL DEFAULT '';
