import type { IncomingMessage, ServerResponse } from 'node:http';
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { requirements } from './requirements.js';
import { addProject, BadConfig, boardHome, gone, missingHome, normal, readProjects, setBoardHome } from './settings.js';

export function firstProject(): string | undefined {
  return readProjects().find((p) => !gone(p.path))?.path;
}

export const notFound = (dir: string) => `Data folder ${dir} was not found. Connect it or choose another folder.`;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** setup.html as served: first run as it is, or the not-found page when the pointer's folder is missing. */
export function setupPage(html: string): string {
  const lost = missingHome();
  if (!lost) return html;
  return html
    .replace(/<p id="intro">[^<]*<\/p>/, `<p id="intro">${esc(notFound(lost))}</p>`)
    .replace('<input id="data" type="text" required>', `<input id="data" type="text" required value="${esc(lost)}">`)
    .replace('<div id="project-row" class="field-row-stacked">', '<div id="project-row" class="field-row-stacked" hidden>')
    .replace('<input id="project" type="text" required>', '<input id="project" type="text">')
    .replace('<button id="retry" type="button" hidden>', '<button id="retry" type="button">');
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

export async function handleSetup(req: IncomingMessage, res: ServerResponse, url: URL, done: (repo?: string) => void) {
  if (url.pathname === '/api/requirements' && req.method === 'GET') return json(res, 200, await requirements());
  if (url.pathname === '/api/setup/retry') {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    const lost = missingHome();
    if (lost) return json(res, 400, { error: notFound(lost) });
    const repo = firstProject();
    res.once('finish', () => done(repo));
    return json(res, 200, { repo });
  }
  if (url.pathname !== '/api/setup') return json(res, 404, { error: 'not found' });
  if (req.method === 'GET') return json(res, 200, { data: boardHome() });
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
  try {
    const { data, project } = await body(req);
    if (typeof data !== 'string' || !data.trim()) throw new BadConfig('Data folder is empty');
    if (!isAbsolute(data.trim())) throw new BadConfig(`Data folder ${data.trim()} is not a full path`);
    if (missingHome()) {
      setBoardHome(data.trim());
      const repo = firstProject();
      res.once('finish', () => done(repo));
      return json(res, 200, { repo });
    }
    if (typeof project !== 'string' || !project.trim()) throw new BadConfig('Project folder is empty');
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
