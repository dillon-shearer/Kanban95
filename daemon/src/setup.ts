import type { IncomingMessage, ServerResponse } from 'node:http';
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { requirements } from './requirements.js';
import { addProject, BadConfig, boardHome, gone, normal, readProjects, setBoardHome } from './settings.js';

export function firstProject(): string | undefined {
  return readProjects().find((p) => !gone(p.path))?.path;
}

function json(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const c of req) {
    raw += c;
    if (raw.length > 1 << 16) throw new BadConfig('body too large');
  }
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object') return v;
  } catch {}
  throw new BadConfig('body is not a JSON object');
}

export async function handleSetup(req: IncomingMessage, res: ServerResponse, url: URL, done: (repo: string) => void) {
  if (url.pathname === '/api/requirements' && req.method === 'GET') return json(res, 200, await requirements());
  if (url.pathname !== '/api/setup') return json(res, 404, { error: 'not found' });
  if (req.method === 'GET') return json(res, 200, { data: boardHome() });
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
  try {
    const { data, project } = await body(req);
    if (typeof data !== 'string' || !data.trim()) throw new BadConfig('Data folder is empty');
    if (typeof project !== 'string' || !project.trim()) throw new BadConfig('Project folder is empty');
    if (!isAbsolute(data.trim())) throw new BadConfig(`Data folder ${data.trim()} is not a full path`);
    if (!isAbsolute(project.trim()) || !statSync(project.trim(), { throwIfNoEntry: false })?.isDirectory()) {
      throw new BadConfig(`Project folder ${project.trim()} does not exist`);
    }
    const repo = normal(project.trim());
    setBoardHome(data.trim());
    addProject(repo);
    res.once('finish', () => done(repo));
    json(res, 200, { repo });
  } catch (e) {
    json(res, e instanceof BadConfig ? 400 : 500, { error: (e as Error).message });
  }
}
