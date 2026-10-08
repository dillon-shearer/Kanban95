// Stages what the installer ships next to the shell exe: the built daemon, its runtime dependencies (locked versions,
// no dev dependencies), the UI and the default templates, in the same layout as the repo so the daemon's relative
// paths (../../ui, ../migrations) still hold. `npm run installer` runs this after `npm run build`.
import { cpSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const app = resolve(root, 'shell/target/app');
rmSync(app, { recursive: true, force: true });
for (const p of ['package.json', 'package-lock.json', '.npmrc', 'ui', 'templates', 'daemon/package.json',
  'daemon/dist', 'daemon/migrations', 'daemon/voice-model.json']) {
  cpSync(resolve(root, p), resolve(app, p), { recursive: true });
}
execSync('npm ci --omit=dev --ignore-scripts --no-audit --no-fund', { cwd: app, stdio: 'inherit' });
// The workspace link points back at daemon/: a junction the bundler would follow in a loop, and nothing imports it.
rmSync(resolve(app, 'node_modules/@kanban95'), { recursive: true, force: true });
