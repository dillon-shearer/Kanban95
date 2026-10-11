// Drives a headless Edge or Chrome over the DevTools protocol for the UI tests, with Node's own WebSocket: no dependency.
// One browser serves a whole vitest run (browser-setup.ts starts it and puts its port in K95_CDP_PORT); each test file's
// `browser()` is a tab in its own browser context, so files share no cookies or storage.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = [
  process.env.KANBAN95_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

export async function until<T>(f: () => T | Promise<T>, what: string, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Starts a headless browser with a throwaway profile and home, 1280×720; `close` kills it and removes both. */
export async function launch() {
  const exe = CANDIDATES.find((p) => p && existsSync(p));
  if (!exe) throw new Error('the UI tests need Edge or Chrome; set KANBAN95_BROWSER to its executable');
  const dir = mkdtempSync(join(tmpdir(), 'k95-browser-'));
  const profile = join(dir, 'profile');
  const argv = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
    // Muted: a headless browser still plays sound, so every test merge and question rang the board's chimes on the operator's speakers.
    '--no-default-browser-check', '--window-size=1280,720', '--mute-audio', 'about:blank'];
  // A headed browser opens a window on the operator's desktop while they work; never allow one.
  if (!argv.some((a) => a.startsWith('--headless'))) throw new Error('cdp.ts must start the browser with --headless');
  // Its own home, not the operator's: vitest's globalSetup runs with the real one. Edge 155 (2026-10) never opens its DevTools
  // port when %USERPROFILE%\AppData\Local is missing; it then writes its Microsoft\ caches there.
  const home = join(dir, 'home');
  mkdirSync(join(home, 'AppData', 'Local'), { recursive: true });
  const proc = spawn(exe, argv, { stdio: 'ignore', env: { ...process.env, USERPROFILE: home, HOME: home } });
  const exited = new Promise((r) => proc.once('exit', r));
  const close = async () => {
    proc.kill();
    await exited;
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  const portFile = join(profile, 'DevToolsActivePort');
  try {
    const port = await until(() => existsSync(portFile) && readFileSync(portFile, 'utf8').split('\n')[0], 'the DevTools port', 60_000);
    return { port: Number(port), close };
  } catch (e) {
    await close();
    throw e;
  }
}

/** A DevTools WebSocket: `send` resolves with the command's result; every other message goes to `onEvent`. */
async function connect(url: string, onEvent: (msg: any) => void = () => {}) {
  const ws = new WebSocket(url);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
  let seq = 0;
  const pending = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
  ws.onmessage = (m) => {
    const msg = JSON.parse(String(m.data));
    const p = msg.id && pending.get(msg.id);
    if (!p) return onEvent(msg);
    pending.delete(msg.id);
    if (msg.error) p.fail(new Error(msg.error.message));
    else p.ok(msg.result);
  };
  const send = (method: string, params: object = {}): Promise<any> => new Promise((ok, fail) => {
    const id = ++seq;
    pending.set(id, { ok, fail });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { ws, send };
}

export type Page = Awaited<ReturnType<typeof browser>>;

/** A fresh tab, 1280×720, in its own browser context of the run's shared browser (K95_CDP_PORT); outside vitest, in a
 *  browser of its own. */
export async function browser() {
  const own = process.env.K95_CDP_PORT ? undefined : await launch();
  const port = own?.port ?? process.env.K95_CDP_PORT;
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as { webSocketDebuggerUrl: string };
  const root = await connect(version.webSocketDebuggerUrl);
  const { browserContextId } = await root.send('Target.createBrowserContext');
  const { targetId } = await root.send('Target.createTarget', { url: 'about:blank', browserContextId });

  const logs: string[] = [];
  const { ws, send } = await connect(`ws://127.0.0.1:${port}/devtools/page/${targetId}`, (msg) => {
    if (msg.method === 'Runtime.consoleAPICalled') logs.push(msg.params.args.map((a: { value?: unknown; description?: string }) => a.value ?? a.description).join(' '));
    if (msg.method === 'Runtime.exceptionThrown') logs.push(`exception: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`);
  });
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });

  /** Evaluates an expression in the page (promises awaited) and returns its JSON value; a page exception throws here. */
  const evaluate = async <T = any>(expression: string): Promise<T> => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const mouse = (type: 'mousePressed' | 'mouseMoved' | 'mouseReleased', x: number, y: number) =>
    send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });

  return {
    logs,
    send,
    evaluate,
    async goto(url: string) {
      await send('Page.navigate', { url });
      await until(() => evaluate<boolean>(`document.readyState === 'complete' && location.href === ${JSON.stringify(url)}`), `${url} to load`);
    },
    /** Center of the first element matching `selector`. */
    async center(selector: string) {
      const r = await evaluate<{ x: number; y: number } | null>(`(() => { const e = document.querySelector(${JSON.stringify(selector)});
        if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      if (!r) throw new Error(`no element ${selector}`);
      return r;
    },
    /** Presses at `from`, moves in steps, releases at `to`: real pointer events, as a person's drag makes them. */
    async drag(from: { x: number; y: number }, to: { x: number; y: number }) {
      await mouse('mousePressed', from.x, from.y);
      for (let i = 1; i <= 8; i++) await mouse('mouseMoved', from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8);
      await mouse('mouseReleased', to.x, to.y);
    },
    async screenshot(): Promise<Buffer> {
      return Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64');
    },
    /** Closes this tab and its context; the shared browser runs on for the other files. */
    async close() {
      ws.close();
      await root.send('Target.closeTarget', { targetId });
      await root.send('Target.disposeBrowserContext', { browserContextId });
      root.ws.close();
      await own?.close();
    },
  };
}
