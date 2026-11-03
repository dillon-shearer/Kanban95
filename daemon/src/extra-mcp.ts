import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BadConfig } from './settings.js';
import { claudeKey, claudeState } from './trust.js';

type Servers = Record<string, unknown>;

const read = (file: string) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {});
const same = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

function ancestors(path: string): string[] {
  const out = [];
  for (let p = claudeKey(path); ; p = dirname(p)) {
    out.push(p);
    if (dirname(p) === p) return out;
  }
}

export function operatorMcpServers(names: string[], cwd: string, repo: string): Servers {
  if (!names.length) return {};
  const state = read(claudeState());
  const projects: Record<string, { mcpServers?: Servers; enabledMcpjsonServers?: string[] }> = state.projects ?? {};
  const project = (k: string) => Object.entries(projects).find(([p]) => same(p, k))?.[1];
  const keys = [...new Set([...ancestors(cwd), ...ancestors(repo)])];
  const approved = new Set([claudeKey(cwd), claudeKey(repo)].flatMap((k) => project(k)?.enabledMcpjsonServers ?? []));
  const mcpjson: Servers = read(join(cwd, '.mcp.json')).mcpServers ?? {};
  const layers: Servers[] = [
    ...keys.map((k) => project(k)?.mcpServers ?? {}),
    state.mcpServers ?? {},
    Object.fromEntries(Object.entries(mcpjson).filter(([n]) => approved.has(n))),
  ];
  const out: Servers = {};
  for (const name of names) {
    const found = layers.find((l) => Object.hasOwn(l, name));
    if (!found) throw new BadConfig(`MCP server "${name}" (settings.json mcp_servers) is not in ${claudeState()} or ${join(cwd, '.mcp.json')}: add it with claude mcp add (a .mcp.json server must be approved in Claude Code first), or remove it from Settings → Agents → Extra MCP servers`);
    out[name] = found[name];
  }
  return out;
}
