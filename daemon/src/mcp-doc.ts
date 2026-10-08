// Renders docs/MCP.md from the tool table in mcp.ts. `node daemon/dist/mcp-doc.js` writes it; mcp.test.ts fails if the file drifts.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as z from 'zod';
import type { Role } from './grants.js';
import { TOOLS } from './mcp.js';

export const MCP_DOC = resolve(import.meta.dirname, '../../docs/MCP.md');
const ROLES: Role[] = ['planner', 'worker', 'tester'];

type Schema = { type?: string; enum?: unknown[]; items?: Schema; properties?: Record<string, Schema>; description?: string; default?: unknown };
function typeOf(s: Schema): string {
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
    '"own" means the ticket the grant was minted for; a worker or tester may omit `ticket_id` and may not name another ticket. A planner grant has no ticket and must pass `ticket_id`.',
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
  console.log(`wrote ${MCP_DOC}`);
}
