import type { IncomingMessage, ServerResponse } from 'node:http';
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { finishPick, readPick, startPick } from './pick.js';
import { requirements } from './requirements.js';
import { addProject, BadConfig, boardHome, gone, missingHome, normal, readConfig, readLastBoard, readProjects, same, setBoardHome } from './settings.js';

export function firstProject(): string | undefined {
  return readProjects().find((p) => !gone(p.path))?.path;
}

export function startupProject(): string | undefined {
  const startup = (() => {
    try {
      return readConfig('settings').startup;
    } catch {
      return 'last';
    }
  })();
  if (startup !== 'last' && !gone(startup)) return startup;
  const last = readLastBoard();
  if (last && !gone(last) && readProjects().some((p) => same(p.path, last))) return last;
  return firstProject();
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

function answer(res: ServerResponse, r: { status: number; body?: unknown }) {
  if (r.body === undefined) res.writeHead(r.status).end();
  else json(res, r.status, r.body);
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

export async function handleSetup(req: IncomingMessage, res: ServerResponse, url: URL, setup: { done: (repo?: string) => void; shell?: boolean }) {
  const { done } = setup;
  if (url.pathname === '/api/requirements' && req.method === 'GET') return json(res, 200, await requirements());
  const token = /^\/api\/pick\/([0-9a-f]{32})$/.exec(url.pathname)?.[1];
  if (url.pathname === '/api/pick' || token) {
    if (token && req.method === 'GET') return answer(res, readPick(token));
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    try {
      const b = await body(req);
      return answer(res, token ? finishPick(token, req.headers.origin, b) : startPick(setup.shell === true, '', b.kind));
    } catch (e) {
      return json(res, 400, { error: (e as Error).message });
    }
  }
  if (url.pathname === '/api/setup/retry') {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    const lost = missingHome();
    if (lost) return json(res, 400, { error: notFound(lost) });
    const repo = firstProject();
    res.once('finish', () => done(repo));
    return json(res, 200, { repo });
  }
  if (url.pathname !== '/api/setup') return json(res, 404, { error: 'not found' });
  if (req.method === 'GET') return json(res, 200, { data: boardHome(), shell: setup.shell === true });
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
