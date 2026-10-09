import { afterEach, describe, expect, it } from 'vitest';
import { limits, parseClaude, parseCodex, sources } from '../src/limits.ts';

// `claude -p "/usage"` as Claude Code 2.1.294 prints it, breakdown included (its indented % lines must not become rows).
const CLAUDE = `You are currently using your subscription to power your Claude Code usage

Current session: 84% used · resets Oct 8, 7:59pm (America/New_York)
Current week (all models): 18% used · resets Oct 14, 11:59pm (America/New_York)
Current week (Fable): 9% used · resets Oct 14, 11:59pm (America/New_York)

What's contributing to your limits usage?
  76% of your usage was while 4+ sessions ran in parallel
  Top MCP servers: kanban95 6%
`;
// The result of codex-cli 0.154.0's account/rateLimits/read (ids redacted).
const CODEX = {
  ordinaryUsageAllowed: true,
  rateLimits: {
    limitId: 'codex', planType: 'plus',
    primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1791504257 },
    secondary: { usedPercent: 41, windowDurationMins: 10080, resetsAt: 1791995516 },
    credits: { hasCredits: false, unlimited: false, balance: '0' }, spendControlReached: false, rateLimitReachedType: null,
  },
  accountId: '<redacted>',
};

const real = { ...sources };
afterEach(() => Object.assign(sources, real));

describe('limits', () => {
  it('reads the three Claude windows and skips the breakdown', () => {
    expect(parseClaude(CLAUDE.replaceAll('\n', '\r\n'))).toEqual([
      { cli: 'claude', window: 'Current session', used: 84, limit: 100, resets_at: 'Oct 8, 7:59pm (America/New_York)' },
      { cli: 'claude', window: 'Current week (all models)', used: 18, limit: 100, resets_at: 'Oct 14, 11:59pm (America/New_York)' },
      { cli: 'claude', window: 'Current week (Fable)', used: 9, limit: 100, resets_at: 'Oct 14, 11:59pm (America/New_York)' },
    ]);
  });

  it('reads both Codex windows, reset as ISO time, and tolerates a missing one', () => {
    expect(parseCodex(CODEX)).toEqual([
      { cli: 'codex', window: '5 hour', used: 0, limit: 100, resets_at: '2026-10-09T00:04:17.000Z' },
      { cli: 'codex', window: '7 day', used: 41, limit: 100, resets_at: '2026-10-14T16:31:56.000Z' },
    ]);
    expect(parseCodex({ rateLimits: { primary: null, secondary: CODEX.rateLimits.secondary } })).toHaveLength(1);
    expect(parseCodex({})).toEqual([]);
  });

  it('names why a CLI has no rows, keeps the other, caches, and asks again on refresh', async () => {
    let calls = 0;
    sources.claude = async () => (calls++, 'Not logged in');
    sources.codex = async () => { throw new Error('codex app-server could not start: ENOENT'); };
    const a = await limits(true);
    expect(a.rows).toEqual([]);
    expect(a.errors.claude).toMatch(/no limits could be read/);
    expect(a.errors.codex).toBe('codex app-server could not start: ENOENT');

    sources.claude = async () => (calls++, CLAUDE);
    sources.codex = async () => CODEX;
    expect(await limits()).toBe(a); // still fresh: no CLI start
    expect(calls).toBe(1);
    const [b, c] = await Promise.all([limits(true), limits(true)]); // a refresh while one runs shares it
    expect(b).toBe(c);
    expect(calls).toBe(2);
    expect(b.rows.map((r) => `${r.cli} ${r.used}`)).toEqual(['claude 84', 'claude 18', 'claude 9', 'codex 0', 'codex 41']);
    expect(b.errors).toEqual({});
  });
});
