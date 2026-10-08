// The speech model behind the UI's mic button. Pinned by daemon/voice-model.json (source, revision, size and SHA-256 per file),
// downloaded only when the operator clicks OK in the UI's download dialog, checked file by file, stored under
// ~/.kanban95/models/ and served same-origin to transformers.js. This download is the only network call the board makes.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { once } from 'node:events';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export interface Manifest {
  id: string;
  source: string;
  revision: string;
  license: string;
  files: { path: string; size: number; sha256: string }[];
}

export const MANIFEST: Manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '../voice-model.json'), 'utf8'));
export const modelDir = (m: Manifest) => join(homedir(), '.kanban95', 'models', m.id.split('/').pop()!);
const fileUrl = (m: Manifest, path: string) => `${m.source}/resolve/${m.revision}/${path}`;

const present = (m: Manifest) => m.files.every((f) => statSync(join(modelDir(m), f.path), { throwIfNoEntry: false })?.size === f.size);
let running: Promise<void> | null = null;
let received = 0;

/** What the download dialog shows. `received` is non-null while a download runs. */
export const status = (m = MANIFEST) => ({
  id: m.id, source: m.source, revision: m.revision, license: m.license, files: m.files,
  size: m.files.reduce((n, f) => n + f.size, 0),
  downloaded: present(m),
  received: running ? received : null,
});

async function sha256(file: string) {
  const h = createHash('sha256');
  for await (const c of createReadStream(file)) h.update(c);
  return h.digest('hex');
}

/**
 * Fetches each file the manifest pins into `<file>.part`, refusing more bytes than the manifest says, then checks size and
 * SHA-256 and renames it into place. A mismatch deletes the file and fails the download, naming the file and both hashes.
 * A file already in place is kept only if its hash still matches. Concurrent calls share one download.
 */
export function download(m = MANIFEST): Promise<void> {
  running ??= (async () => {
    received = 0;
    for (const f of m.files) {
      const dest = join(modelDir(m), f.path);
      if (existsSync(dest) && (await sha256(dest)) === f.sha256) {
        received += f.size;
        continue;
      }
      mkdirSync(dirname(dest), { recursive: true });
      const part = `${dest}.part`;
      try {
        const res = await fetch(fileUrl(m, f.path), { redirect: 'follow' });
        if (!res.ok || !res.body) throw new Error(`${f.path}: HTTP ${res.status}`);
        const h = createHash('sha256');
        const out = createWriteStream(part);
        let n = 0;
        try {
          for await (const c of res.body) {
            n += c.length;
            if (n > f.size) throw new Error(`${f.path}: larger than the pinned ${f.size} bytes`);
            h.update(c);
            received += c.length;
            if (!out.write(c)) await once(out, 'drain');
          }
        } finally {
          out.end();
          await once(out, 'close');
        }
        const got = h.digest('hex');
        if (n !== f.size || got !== f.sha256) throw new Error(`${f.path}: expected sha256 ${f.sha256} (${f.size} bytes), got ${got} (${n} bytes)`);
        renameSync(part, dest);
      } catch (e) {
        rmSync(part, { force: true });
        rmSync(dest, { force: true });
        throw e;
      }
    }
  })().finally(() => (running = null));
  return running;
}

/** `/voice-model/<id>/<path>` → the file on disk, only for a path the manifest lists. Anything else is null (404). */
export function voiceFile(pathname: string, m = MANIFEST): string | null {
  const prefix = `/voice-model/${m.id}/`;
  if (!pathname.startsWith(prefix)) return null;
  const f = m.files.find((x) => x.path === pathname.slice(prefix.length));
  return f ? join(modelDir(m), f.path) : null;
}
