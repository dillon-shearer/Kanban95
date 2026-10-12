// The speech model behind the UI's mic button. Pinned by daemon/voice-model.json (source, revision, size and SHA-256 per file),
// downloaded only when the operator clicks OK in the UI's download dialog, checked file by file, stored under
// ~/.kanban95/models/ and served same-origin to transformers.js. This download is the only network call the board makes.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { boardHome } from './settings.js';
import { dirname, join, resolve } from 'node:path';

export interface Manifest {
  id: string;
  source: string;
  revision: string;
  license: string;
  files: { path: string; size: number; sha256: string }[];
}

export const MANIFEST: Manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '../voice-model.json'), 'utf8'));
export const modelDir = (m: Manifest) => join(boardHome(), 'models', m.id.split('/').pop()!);
const fileUrl = (m: Manifest, path: string) => `${m.source}/resolve/${m.revision}/${path}`;

let running: Promise<void> | null = null;
let received = 0;

async function sha256(file: string) {
  const h = createHash('sha256');
  for await (const c of createReadStream(file)) h.update(c);
  return h.digest('hex');
}

const checked = new Map<string, { stamp: string; ok: Promise<boolean> }>();

function stampOf(file: string, f: Manifest['files'][number]) {
  const st = statSync(file, { throwIfNoEntry: false, bigint: true });
  return st?.isFile() && st.size === BigInt(f.size) ? `${f.sha256}:${st.size}:${st.ino}:${st.mtimeNs}:${st.ctimeNs}` : null;
}

function verified(file: string, f: Manifest['files'][number]): Promise<boolean> {
  const stamp = stampOf(file, f);
  if (!stamp) {
    checked.delete(file);
    return Promise.resolve(false);
  }
  const hit = checked.get(file);
  if (hit?.stamp === stamp) return hit.ok;
  const ok = sha256(file).then((got) => got === f.sha256, () => false);
  checked.set(file, { stamp, ok });
  return ok;
}

const ready = async (m: Manifest) => (await Promise.all(m.files.map((f) => verified(join(modelDir(m), f.path), f)))).every(Boolean);

/** What the download dialog shows. `downloaded` means every file is on disk and matches its pinned hash. `received` is non-null while a download runs. */
export const status = async (m = MANIFEST) => ({
  id: m.id, source: m.source, revision: m.revision, license: m.license, files: m.files,
  size: m.files.reduce((n, f) => n + f.size, 0),
  downloaded: await ready(m),
  received: running ? received : null,
});

async function locked(m: Manifest, fn: () => Promise<void>) {
  const dir = modelDir(m);
  mkdirSync(dirname(dir), { recursive: true });
  const db = new DatabaseSync(`${dir}.lock`);
  try {
    db.exec('PRAGMA busy_timeout = 0');
    for (;;) {
      try {
        db.exec('BEGIN IMMEDIATE');
        break;
      } catch (e) {
        if ((e as { errcode?: number }).errcode !== 5) throw e;
        await sleep(200);
      }
    }
    try {
      await fn();
    } finally {
      db.exec('COMMIT');
    }
  } finally {
    db.close();
  }
}

/**
 * Fetches each file the manifest pins into its own `<file>.<pid>-<uuid>.part`, refusing more bytes than the manifest says,
 * then checks size and SHA-256 and renames it into place. A mismatch deletes that part file and fails the download, naming
 * the file and both hashes. A file already in place is kept only if its hash still matches, else it is deleted before the
 * fetch. Concurrent calls in one daemon share one download. Daemons sharing the home take turns on `<modelDir>.lock`, so a
 * part file found while holding it was left by a dead attempt and is deleted.
 */
export function download(m = MANIFEST): Promise<void> {
  running ??= locked(m, async () => {
    received = 0;
    const dir = modelDir(m);
    if (existsSync(dir)) for (const f of readdirSync(dir, { recursive: true, encoding: 'utf8' })) if (f.endsWith('.part')) rmSync(join(dir, f), { force: true });
    for (const f of m.files) {
      const dest = join(modelDir(m), f.path);
      if (existsSync(dest)) {
        if (await verified(dest, f)) {
          received += f.size;
          continue;
        }
        rmSync(dest, { force: true });
      }
      mkdirSync(dirname(dest), { recursive: true });
      const part = `${dest}.${process.pid}-${randomUUID()}.part`;
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
        const stamp = stampOf(dest, f);
        if (stamp) checked.set(dest, { stamp, ok: Promise.resolve(true) });
      } catch (e) {
        rmSync(part, { force: true });
        throw e;
      }
    }
  }).finally(() => (running = null));
  return running;
}

/**
 * `/voice-model/<id>/<path>` → the file on disk, only for a path the manifest lists and only while that file matches its
 * pinned hash. Anything else is null (404). A mismatch is not fetched again here; that waits for the operator's OK.
 */
export async function voiceFile(pathname: string, m = MANIFEST): Promise<string | null> {
  const prefix = `/voice-model/${m.id}/`;
  if (!pathname.startsWith(prefix)) return null;
  const f = m.files.find((x) => x.path === pathname.slice(prefix.length));
  if (!f) return null;
  const file = join(modelDir(m), f.path);
  return (await verified(file, f)) ? file : null;
}
