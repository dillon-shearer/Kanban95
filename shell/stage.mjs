// Stages what the installer ships next to the shell exe: the built daemon, its runtime dependencies (locked versions,
// no dev dependencies), the UI and the default templates, in the same layout as the repo so the daemon's relative
// paths (../../ui, ../migrations) still hold, and the Node binary the shell runs it on (bundle.externalBin).
// `npm run installer` runs this after `npm run build`. `node shell/stage.mjs [--target] <triple>` stages the Node for
// that target; the default is this machine's, and on macOS both Mac targets, so tauri build finds either one.
import { chmodSync, cpSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

export const NODE_VERSION = '24.21.0';

const TARGETS = {
  'x86_64-pc-windows-msvc': { dist: 'win-x64', ext: 'zip', member: 'node.exe', npm: ['npm', 'npm.cmd', 'npx', 'npx.cmd', 'node_modules/npm'] },
  'aarch64-apple-darwin': { dist: 'darwin-arm64', ext: 'tar.gz', member: 'bin/node' },
  'x86_64-apple-darwin': { dist: 'darwin-x64', ext: 'tar.gz', member: 'bin/node' },
};

function defaultTargets() {
  if (process.platform === 'win32' && process.arch === 'x64') return ['x86_64-pc-windows-msvc'];
  if (process.platform === 'darwin') return ['aarch64-apple-darwin', 'x86_64-apple-darwin'];
  throw new Error(`no Node sidecar for ${process.platform}-${process.arch}; pass --target <triple>`);
}

export const sidecarName = (target) => `node-${target}${target.includes('windows') ? '.exe' : ''}`;

async function download(url, file) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  writeFileSync(`${file}.part`, Buffer.from(await res.arrayBuffer()));
  renameSync(`${file}.part`, file);
}

const sha256 = (file) => new Promise((ok, fail) => {
  const h = createHash('sha256');
  createReadStream(file).on('data', (d) => h.update(d)).on('end', () => ok(h.digest('hex'))).on('error', fail);
});

const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

export async function stageNode(target, { cache, out, npmOut, base = 'https://nodejs.org/dist' }) {
  const t = TARGETS[target];
  if (!t) throw new Error(`unknown target ${target}; one of ${Object.keys(TARGETS).join(', ')}`);
  const dest = join(out, sidecarName(target));
  rmSync(dest, { force: true });
  mkdirSync(cache, { recursive: true });
  const dir = `node-v${NODE_VERSION}-${t.dist}`;
  const name = `${dir}.${t.ext}`;
  const sums = join(cache, `SHASUMS256-v${NODE_VERSION}.txt`);
  const archive = join(cache, name);
  if (!existsSync(sums)) await download(`${base}/v${NODE_VERSION}/SHASUMS256.txt`, sums);
  const expected = readFileSync(sums, 'utf8').split('\n').map((l) => l.trim().split(/\s+/)).find(([, f]) => f === name)?.[0];
  if (!expected) throw new Error(`${name} is not listed in SHASUMS256.txt for v${NODE_VERSION}`);
  if (!existsSync(archive)) await download(`${base}/v${NODE_VERSION}/${name}`, archive);
  const actual = await sha256(archive);
  if (actual !== expected) {
    rmSync(archive, { force: true });
    throw new Error(`${name}: SHA-256 ${actual} does not match the published ${expected}; deleted the download`);
  }
  const tmp = mkdtempSync(join(cache, 'extract-'));
  try {
    const npm = npmOut && t.npm ? t.npm : [];
    execFileSync(tar, ['-xf', archive, '-C', tmp, ...[t.member, ...npm].map((m) => `${dir}/${m}`)], { stdio: 'inherit' });
    mkdirSync(out, { recursive: true });
    renameSync(join(tmp, dir, t.member), dest);
    chmodSync(dest, 0o755);
    for (const m of npm) {
      mkdirSync(dirname(join(npmOut, m)), { recursive: true });
      renameSync(join(tmp, dir, m), join(npmOut, m));
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return dest;
}

function stageApp(root) {
  const app = resolve(root, 'shell/target/app');
  rmSync(app, { recursive: true, force: true });
  for (const p of ['package.json', 'package-lock.json', '.npmrc', 'ui', 'templates', 'daemon/package.json',
    'daemon/dist', 'daemon/migrations', 'daemon/voice-model.json']) {
    cpSync(resolve(root, p), resolve(app, p), { recursive: true });
  }
  execSync('npm ci --omit=dev --ignore-scripts --no-audit --no-fund', { cwd: app, stdio: 'inherit' });
  // The workspace link points back at daemon/: a junction the bundler would follow in a loop, and nothing imports it.
  rmSync(resolve(app, 'node_modules/@kanban95'), { recursive: true, force: true });
  if (process.platform !== 'win32') {
    const prebuilds = resolve(app, 'node_modules/node-pty/prebuilds');
    for (const dir of readdirSync(prebuilds)) {
      const helper = resolve(prebuilds, dir, 'spawn-helper');
      if (existsSync(helper)) chmodSync(helper, 0o755);
    }
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2).filter((a) => a !== '--target');
  const targets = args.length ? args : defaultTargets();
  const root = resolve(import.meta.dirname, '..');
  stageApp(root);
  const shell = resolve(root, 'shell/target');
  const npmOut = join(shell, 'npm');
  rmSync(npmOut, { recursive: true, force: true });
  mkdirSync(npmOut);
  for (const t of targets) console.log(`staged ${await stageNode(t, { cache: join(shell, 'node-download'), out: join(shell, 'sidecar'), npmOut })}`);
}
