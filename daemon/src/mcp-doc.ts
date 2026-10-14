// Renders docs/MCP.md from the tool table in mcp.ts. `node daemon/dist/mcp-doc.js` writes it; mcp.test.ts fails if the file drifts.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as z from 'zod';
import type { Role } from './grants.js';
import { TOOLS } from './mcp.js';

export const MCP_DOC = resolve(import.meta.dirname, '../../docs/MCP.md');
const ROLES: Role[] = ['planner', 'worker', 'tester', 'operator'];

type Schema = { type?: string; anyOf?: Schema[]; enum?: unknown[]; items?: Schema; properties?: Record<string, Schema>; description?: string; default?: unknown };
function typeOf(s: Schema): string {
  if (s.anyOf) return s.anyOf.map(typeOf).join(' \\| ');
  if (s.enum) return s.enum.map(String).join(' \\| ');
  if (s.type === 'array') return `${typeOf(s.items ?? {})}[]`;
  if (s.type === 'object' && s.properties) return `{ ${Object.entries(s.properties).map(([k, v]) => `${k}: ${typeOf(v)}`).join(', ')} }`;
  return s.type ?? 'any';
}

export function renderMcpDoc(): string {
  const out: string[] = [
    '# MCP tool reference',
    '',
    'Generated from `daemon/src/mcp.ts` by `npm run docs:mcp`. Do not edit by hand; the test suite fails if this file drifts from the code.',
    '',
    '## Connecting',
    '',
    'Endpoint: `POST http://127.0.0.1:<port>/mcp`, Streamable HTTP, stateless (no session id, JSON responses). The host must be `127.0.0.1`, never `localhost`.',
    'Every request carries `Authorization: Bearer <token>` where the token is the grant minted for this agent session. A missing, malformed, unknown, expired or revoked token',
    'gets `401` before any tool runs and leaves no audit row. A live token resolves to a grant `{ role, ticket }` that scopes every tool below.',
    'Each tool call rechecks the grant when it runs: one revoked or expired after the headers arrived returns a tool error and does nothing.',
    '',
    'Every tool call, allowed or not, writes one `audit` row with the grant id, tool name, a 200-character argument summary and `ok | denied | error`.',
    'A refused call returns a tool error whose text says why and, for `move_ticket`, which targets the role may use. Results are JSON text.',
    '',
    '## Role matrix',
    '',
    `| tool | ${ROLES.join(' | ')} |`,
    `|------|${ROLES.map(() => '---').join('|')}|`,
    ...Object.entries(TOOLS).map(([name, t]) => `| ${name} | ${ROLES.map((r) => t.access[r] ?? 'no').join(' | ')} |`),
    '',
    '"own" means the ticket the grant was minted for; a worker or tester may omit `ticket_id` and may not name another ticket. A planner or operator grant has no ticket and must pass `ticket_id`.',
    'The operator role is an operator terminal: an agent the operator starts from the UI with a typed mission, holding the operator\'s own reach on the board. It never gets `report_test`; only a tester proves a ticket.',
    '',
    '### Levels',
    '',
    'A worker or tester grant reaches further when the operator raises its ticket\'s `agent_level` (0 to 4, in the Ticket window). The level holds for every run of that ticket, retries and testers alike, and is read on every call. Each level holds the ones below it:',
    '',
    '- 0: the role\'s cells above.',
    '- 1: `move_ticket` any ticket to backlog (a reset) or in_progress (a launch, or a failed test from testing), with the operator\'s lifecycle guards.',
    '- 2: also `move_ticket` any running ticket to done without a tester pass; its sessions end and no merge is queued (docs/LIFECYCLE.md → Agent moves under a level).',
    `- 3: also the operator's cell for ${Object.entries(TOOLS).filter(([, t]) => t.level === 3).map(([n]) => `\`${n}\``).join(', ')}.`,
    '- 4: the operator\'s cell for every tool, `move_ticket` to testing included. A worker still never gets `report_test`; `ask_operator`, and a tester\'s `report_test`, stay on its own ticket.',
    '',
    '`read_all` on the ticket, or `workers_read: "all"` in settings.json, lets its worker and tester `get_ticket` and `list_tickets` every ticket. `targets` on the ticket (`ticket_targets`, set by the planner or operator, never by its own worker) name tickets its worker and tester may `get_ticket` and `list_tickets` without depending on them; a target with `edit` also lets the worker `update_ticket` that ticket\'s body and criteria. A refusal that a higher level would lift ends with "ask for level N with request_permission". Only the operator sets a level or `read_all` (docs/SECURITY.md → MCP).',
    '',
    '## Tools',
  ];
  for (const [name, t] of Object.entries(TOOLS)) {
    const schema = z.toJSONSchema(z.object(t.input), { io: 'input' }) as Schema & { required?: string[] };
    out.push('', `### ${name}`, '', t.description, '');
    const props = Object.entries(schema.properties ?? {});
    if (props.length === 0) { out.push('No arguments.'); continue; }
    out.push('| argument | type | required | description |', '|---|---|---|---|');
    for (const [k, s] of props) {
      const req = schema.required?.includes(k) ? 'yes' : s.default !== undefined ? `default \`${JSON.stringify(s.default)}\`` : 'no';
      out.push(`| ${k} | ${typeOf(s)} | ${req} | ${s.description ?? ''} |`);
    }
  }
  return out.join('\n') + '\n';
}

if (import.meta.main) {
  writeFileSync(MCP_DOC, renderMcpDoc());
  console.error(`wrote ${MCP_DOC}`);
}
