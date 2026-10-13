// vitest globalSetup of the browser project: one headless browser for the whole run, instead of one per ui-*.test.ts file.
// The port goes in the environment before the workers start; each file's `browser()` (cdp.ts) opens a tab in it.
import { launch } from './cdp.ts';

export default async function setup() {
  const b = await launch();
  process.env.K95_CDP_PORT = String(b.port);
  return b.close;
}
