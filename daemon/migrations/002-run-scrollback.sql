-- Last 2000 lines of the agent's terminal, written when its pty exits. Documented in docs/DATA.md.
ALTER TABLE runs ADD COLUMN scrollback TEXT;
