// The silence watch raising Claude Code's own yes/no menu as an Inbox question, clearing it once the menu is gone, and typing an
// Inbox answer into the menu as the option's number. A fake session stands in for the agent: its scrollback and transcript are
// set by hand, its pty records what is written to it.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readTicket } from '../src/api.ts';
import { openDb, openGlobalBrain } from '../src/db.ts';
import { sessions, type Session } from '../src/launcher.ts';
import { apply, claudePrompt, PROMPT_ASK, PROMPT_GONE, SILENCE, watchSilence, type Board } from '../src/lifecycle.ts';

// As Claude Code 2.1.296 draws it: rows placed with cursor moves, the spaces between words as cursor-forward, colours.
const e = '\x1b[';
const MENU = `${e}14;2H│ Dangerous${e}1Crm${e}1Coperation${e}1Con${e}1Cpossibly-empty${e}1Cvariable${e}1Cpath:${e}1C"$SHOTS"/*${e}1Cin${e}1C\`rm${e}1C-f${e}1C"$SHOTS"/*\`` +
  `${e}15;2H│${e}1C(rewrite${e}1Cit${e}1Cas${e}1C"\${SHOTS:?}"/*${e}1Cor${e}1Cuse${e}1Ca${e}1Cliteral${e}1Cpath)` +
  `${e}38;2;255;193;7m${e}18;2H⚠ Claude Code will automatically deny this request in 1:59, to avoid blocking progress on an ${e}19;2Hunattended session${e}m` +
  `${e}22;2HDo${e}1Cyou${e}1Cwant${e}1Cto${e}1Cproceed?${e}23;2H❯${e}1C1. Yes${e}24;4H2. ${e}mNo${e}26;2HEsc to cancel · Tab to amend${e}m`;
// The countdown redraws only its changed digit; a dot blinks.
const TICKING = `${e}10;1H●${e}21;59H8${e}10;1H ${e}21;59H7`;
const BEFORE = `${e}2;1H● Bash(rm -f "$SHOTS"/*)${e}4;1H────────────${e}6;1HBash command${e}8;1H╌╌╌╌╌╌╌╌╌╌╌╌`;

describe('claudePrompt', () => {
  it('finds the menu at the end of the terminal, with what it asks above it, while only the countdown redraws after it', () => {
    expect(claudePrompt(BEFORE + MENU + TICKING)).toBe([
      '│ Dangerous rm operation on possibly-empty variable path: "$SHOTS"/* in `rm -f "$SHOTS"/*`',
      '│ (rewrite it as "${SHOTS:?}"/* or use a literal path)',
      '⚠ Claude Code will automatically deny this request in 1:59, to avoid blocking progress on an',
      'unattended session',
      'Do you want to proceed?',
      '❯ 1. Yes',
      '2. No',
      'Esc to cancel · Tab to amend',
    ].join('\n'));
  });

  it('is gone once the terminal shows anything past the menu, and absent from an ordinary terminal', () => {
    expect(claudePrompt(BEFORE + MENU + TICKING + `${e}2;1H● Bash(rm -f "$SHOTS"/*)\r\n⎿ Permission denied`)).toBeUndefined();
    expect(claudePrompt(BEFORE)).toBeUndefined();
    expect(claudePrompt('')).toBeUndefined();
  });
});

describe('a session sitting on the menu', { timeout: 20_000 }, () => {
  const silence0 = { ...SILENCE };
  let repo: string;
  let db: DatabaseSync;
  let brain: DatabaseSync;
  let b: Board;
  let stop: () => void;
  let id: number;
  let screen: string;
  let written: string[];
  let transcript: string;

  beforeAll(() => Object.assign(SILENCE, { every: 20, minute: 60_000 }));
  afterAll(() => Object.assign(SILENCE, silence0));
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'k95-prompt-'));
    process.env.CLAUDE_CONFIG_DIR = join(repo, 'claude');
    mkdirSync(join(repo, 'claude', 'projects', 'wt'), { recursive: true });
    transcript = join(repo, 'claude', 'projects', 'wt', 'sid.jsonl');
    writeFileSync(transcript, '{}\n');
    db = openDb(repo);
    brain = openGlobalBrain();
    b = { db, brain, repo, port: 0 };
    id = Number(db.prepare("INSERT INTO tickets (title, status) VALUES ('Clean up shots', 'in_progress')").run().lastInsertRowid);
    screen = BEFORE;
    written = [];
    // Choosing an option closes the menu, as in Claude Code.
    const pty = { write: (d: string) => void (written.push(d), /^\d$/.test(d) && (screen += '\r\n● Ran it')), kill() {} };
    sessions.set(1, {
      key: 1, runId: null, grantId: 1, ticketId: id, role: 'worker', phase: 'execute', model: 'm', cli: 'claude', cwd: repo,
      sessionId: 'sid', started: Date.now(), dir: repo, pty, scrollback: () => screen, done: Promise.resolve(),
    } as unknown as Session);
    stop = watchSilence(b);
  });
  afterEach(() => {
    stop();
    sessions.delete(1);
    delete process.env.CLAUDE_CONFIG_DIR;
    db.close();
    brain.close();
    rmSync(repo, { recursive: true, force: true });
  });

  const flagged = () => readTicket(db, id).flags.needs_human;
  const notes = (kind: string) => (db.prepare('SELECT body FROM notes WHERE ticket_id = ? AND kind = ? ORDER BY id').all(id, kind) as { body: string }[]).map((n) => n.body);
  const until = async (ok: () => boolean, what: string) => {
    for (const end = Date.now() + 5000; !ok(); await new Promise((r) => setTimeout(r, 10))) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
  };
  const tick = () => new Promise((r) => setTimeout(r, 200)); // ten watch ticks

  it('flags the ticket with the menu as an Inbox question, once', async () => {
    await tick();
    expect(flagged()).toBe(false); // an ordinary terminal raises nothing
    screen += MENU + TICKING;
    await until(flagged, 'the flag');
    const [q] = notes('question');
    expect(q.startsWith(`${PROMPT_ASK}\n\`\`\`\n│ Dangerous rm operation on possibly-empty variable path`)).toBe(true);
    expect(q).toContain('Do you want to proceed?\n❯ 1. Yes\n2. No\nEsc to cancel · Tab to amend\n```');
    screen += TICKING;
    await tick();
    expect(notes('question')).toHaveLength(1);
  });

  it('clears the flag once the menu is gone and the transcript grows, and closes the question', async () => {
    screen += MENU + TICKING;
    await until(flagged, 'the flag');
    appendFileSync(transcript, '{}\n'); // grows while the menu is still up: stays flagged
    await tick();
    expect(flagged()).toBe(true);
    screen += `${e}2;1H● Bash(rm -f "$SHOTS"/*)\r\n⎿ Permission denied`; // Claude Code denied it by itself
    await tick();
    expect(flagged()).toBe(true); // no new transcript line yet
    appendFileSync(transcript, '{}\n');
    await until(() => !flagged(), 'the flag cleared');
    expect(notes('answer')).toEqual([PROMPT_GONE]);
    expect(notes('question')).toHaveLength(1);
  });

  it('types an Inbox answer into the menu as the option number, then Enter', async () => {
    screen += MENU + TICKING;
    await until(flagged, 'the flag');
    apply(b, id, 'answer', { note: { role: 'operator', kind: 'answer', body: 'Yes' }, answer: 'Yes' });
    await until(() => written.length === 2, 'Enter');
    expect(written).toEqual(['1', '\r']);
    expect(flagged()).toBe(false);

    screen += MENU; // asked again; "2" and "no" both choose No
    appendFileSync(transcript, '{}\n');
    await until(flagged, 'the second flag');
    apply(b, id, 'answer', { note: { role: 'operator', kind: 'answer', body: 'no' }, answer: 'no' });
    await until(() => written.length === 4, 'Enter');
    expect(written.slice(2)).toEqual(['2', '\r']);
  });
});
