import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shotArgs, withBoard } from './shot-board.ts';

if (process.platform !== 'darwin') {
  console.error('npm run shot:mac is Mac only; use npm run shot.');
  process.exit(2);
}
const { out, zoom, open } = shotArgs('shot:mac');
const source = join(import.meta.dirname, 'shot-mac.swift');
const bin = join(tmpdir(), `k95-shot-mac-${createHash('sha256').update(readFileSync(source)).digest('hex').slice(0, 12)}`);
if (!existsSync(bin)) {
  for (const f of readdirSync(tmpdir())) if (f.startsWith('k95-shot-mac-')) rmSync(join(tmpdir(), f), { force: true });
  execFileSync('swiftc', ['-O', '-o', `${bin}.${process.pid}`, source], { stdio: 'inherit' });
  renameSync(`${bin}.${process.pid}`, bin);
}
const code = await withBoard(zoom, async (login) => {
  const swift = spawn(bin, ['1280', '800', String(zoom), open, out], { stdio: ['pipe', 'inherit', 'inherit'], timeout: 90_000 });
  swift.stdin.end(`${login}\n`);
  const [exit, signal] = await new Promise<[number | null, string | null]>((done, fail) => swift.on('error', fail).on('close', (c, s) => done([c, s])));
  if (exit !== 0) throw new Error(`shot-mac.swift failed (${signal ?? `exit ${exit}`})`);
  console.log(out);
});
process.exit(code);
