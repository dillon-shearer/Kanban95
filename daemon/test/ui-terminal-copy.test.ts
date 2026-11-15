// In headless Edge or Chrome against a running daemon (setup in ui.ts): with mouse reporting on, Shift+drag makes an xterm
// selection at any UI zoom, Ctrl+Shift+C copies it and sends the agent nothing, Ctrl+C still sends 0x03, and a plain drag
// still goes to the agent as mouse reports.
import './home.ts';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { brainstorm } from '../src/lifecycle.ts';
import type { Session } from '../src/launcher.ts';
import { until } from './cdp.ts';
import { fakeCli } from './fake-cli.ts';
import { removeTemp } from './home.ts';
import { srv, page, base } from './ui.ts';

const bin = mkdtempSync(join(tmpdir(), 'k95-copy-'));
const log = join(bin, 'copy.log');
const PROGRAM = `
import { appendFileSync } from 'node:fs';
const LOG = ${JSON.stringify(log)};
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdout.write('\\x1b[?1000h\\x1b[?1002h\\x1b[?1006h\\x1b[2J\\x1b[3;5H\\x1b[7mHELLO WORLD\\x1b[0m\\x1b[H');
appendFileSync(LOG, 'ready\\n');
process.stdin.on('data', (d) => {
  for (const m of d.matchAll(/\\x1b\\[<(\\d+);(\\d+);(\\d+)([Mm])/g)) appendFileSync(LOG, 'mouse ' + m[1] + ' ' + m[2] + ' ' + m[3] + ' ' + m[4] + '\\n');
  const rest = d.replace(/\\x1b\\[<\\d+;\\d+;\\d+[Mm]/g, '');
  if (rest) appendFileSync(LOG, 'data ' + Buffer.from(rest).toString('hex') + '\\n');
});
`;
const PATH0 = process.env.PATH;
let s: Session;

beforeAll(() => {
  writeFileSync(join(bin, 'copy.mjs'), PROGRAM);
  writeFileSync(log, '');
  fakeCli(bin, 'claude', 'copy.mjs');
  process.env.PATH = bin + delimiter + PATH0;
});
afterAll(async () => {
  s?.pty.kill();
  await s?.done;
  process.env.PATH = PATH0;
  removeTemp(bin);
}, 30_000);

const lines = () => readFileSync(log, 'utf8').split('\n').filter(Boolean);
const win = () => `[data-win="term-${s.key}"]`;
type Span = { left: number; right: number; y: number; w: number };
const span = () => page.evaluate<Span | null>(`(() => {
  const e = [...document.querySelectorAll('${win()} .xterm-rows span')].find((e) => e.textContent === 'HELLO WORLD');
  if (!e) return null;
  const r = e.getBoundingClientRect();
  return { left: r.left, right: r.right, y: r.top + r.height / 2, w: r.width / 11 };
})()`);
const drag = async (x0: number, x1: number, y: number, modifiers: number) => {
  const m = (type: string, x: number) => page.send('Input.dispatchMouseEvent', { type, x, y, modifiers, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
  await m('mousePressed', x0);
  await m('mouseMoved', (x0 + x1) / 2);
  await m('mouseMoved', x1);
  await m('mouseReleased', x1);
};
const key = async (k: string, modifiers: number) => {
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code: 'KeyC', windowsVirtualKeyCode: 67, modifiers });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: 'KeyC', windowsVirtualKeyCode: 67, modifiers });
};
const copied = () => page.evaluate<string[]>('window.__copied');
/** Ctrl+Shift+C then Ctrl+C: everything the pty got for both, once the 0x03 has arrived. */
const copyThenCtrlC = async () => {
  await page.evaluate(`document.querySelector('${win()} .xterm-helper-textarea').focus()`);
  writeFileSync(log, '');
  await key('C', 2 | 8);
  await key('c', 2);
  await until(() => lines().includes('data 03'), 'the 0x03');
  return lines();
};
const zoomTo = async (z: number) => {
  await page.evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '0', ctrlKey: true, bubbles: true }))`);
  for (let i = 0; i < Math.round((z - 1) * 10); i++) await page.evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '=', ctrlKey: true, bubbles: true }))`);
  await until(async () => Math.abs((await page.evaluate<number>('Number(document.body.style.zoom || 1)')) - z) < 1e-6, `zoom ${z}`);
};

describe('ui-terminal-copy', { timeout: 120_000 }, () => {
  it('copies a Shift+drag selection with Ctrl+Shift+C and leaves Ctrl+C and plain drags to the agent', async () => {
    await page.goto(base);
    await zoomTo(1);
    await page.evaluate(`window.__copied = []; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (t) => { window.__copied.push(t); return Promise.resolve(); } } })`);
    s = brainstorm(srv.board!);
    await until(() => lines().includes('ready'), 'the program');
    await until(() => span(), 'the text');
    await page.evaluate(`document.querySelector('${win()} .title-bar-text').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
    let t = (await span())!;

    writeFileSync(log, '');
    await drag(t.left + 1, t.right - 1, t.y, 0);
    await until(() => lines().some((l) => / m$/.test(l)), 'the release report');
    expect(lines()[0]).toBe('mouse 0 5 3 M');
    expect(lines().at(-1)).toBe('mouse 0 15 3 m');
    let got = await copyThenCtrlC();
    expect(got).toEqual(['data 03']);
    expect(await copied()).toEqual([]);

    writeFileSync(log, '');
    await drag(t.left + 1, t.right - 1, t.y, 8);
    got = await copyThenCtrlC();
    expect(got).toEqual(['data 03']);
    expect(await copied()).toEqual(['HELLO WORLD']);

    await zoomTo(1.2);
    t = (await until(async () => {
      const n = await span();
      return n && Math.abs(n.w - t.w * 1.2) < t.w * 0.1 && n;
    }, 'the text at 120%'))!;
    writeFileSync(log, '');
    await drag(t.left + 6 * t.w + 1, t.right - 1, t.y, 8);
    got = await copyThenCtrlC();
    expect(got).toEqual(['data 03']);
    expect(await copied()).toEqual(['HELLO WORLD', 'WORLD']);

    await zoomTo(1);
  });
});
