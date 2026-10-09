-- The Claude Code session id a run was launched with (--session-id), so Resume and restart recovery can --resume it. Documented in docs/DATA.md.
ALTER TABLE runs ADD COLUMN session_id TEXT;
