// Drives a headless Edge or Chrome over the DevTools protocol for the UI tests, with Node's own WebSocket: no dependency.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

export type Page = Awaited<ReturnType<typeof browser>>;

/** A fresh headless browser with a throwaway profile, 1280×720. `args` are extra command-line switches. */
export async function browser(args: string[] = []) {
  const exe = CANDIDATES.find((p) => p && existsSync(p));
  if (!exe) throw new Error('the UI tests need Edge or Chrome; set KANBAN95_BROWSER to its executable');
  const profile = mkdtempSync(join(tmpdir(), 'k95-browser-'));
  const argv = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
    '--no-default-browser-check', '--window-size=1280,720', ...args, 'about:blank'];
  // A headed browser opens a window on the operator's desktop while they work; never allow one.
  if (!argv.some((a) => a.startsWith('--headless'))) throw new Error('cdp.ts must start the browser with --headless');
  const proc = spawn(exe, argv, { stdio: 'ignore' });
  const portFile = join(profile, 'DevToolsActivePort');
  const port = await until(() => existsSync(portFile) && readFileSync(portFile, 'utf8').split('\n')[0], 'the DevTools port');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { type: string; webSocketDebuggerUrl: string }[];
  const ws = new WebSocket(targets.find((t) => t.type === 'page')!.webSocketDebuggerUrl);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });

  let seq = 0;
  const pending = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
  const logs: string[] = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(String(m.data));
    if (msg.method === 'Runtime.consoleAPICalled') logs.push(msg.params.args.map((a: { value?: unknown; description?: string }) => a.value ?? a.description).join(' '));
    if (msg.method === 'Runtime.exceptionThrown') logs.push(`exception: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`);
    const p = msg.id && pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.fail(new Error(msg.error.message));
    else p.ok(msg.result);
  };
  const send = (method: string, params: object = {}): Promise<any> => new Promise((ok, fail) => {
    const id = ++seq;
    pending.set(id, { ok, fail });
    ws.send(JSON.stringify({ id, method, params }));
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
    async close() {
      ws.close();
      proc.kill();
      await new Promise((r) => proc.once('exit', r));
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}
