-- Lifecycle: which template a ticket executes with, and when its branch landed on the base. Documented in docs/DATA.md.
ALTER TABLE tickets ADD COLUMN template TEXT NOT NULL DEFAULT 'execute' CHECK (template IN ('execute', 'housekeeping'));
ALTER TABLE tickets ADD COLUMN merged_at TEXT;
