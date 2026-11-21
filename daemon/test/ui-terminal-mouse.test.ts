// In headless Edge or Chrome against a running daemon (setup in ui.ts): a mouse press, drag or right-click in an agent terminal
// reaches the program as the cell under the pointer, at any UI zoom, after a resize or a re-tile and after a full scrollback.
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
import { srv, page, base, menuPick, rightClick } from './ui.ts';

const bin = mkdtempSync(join(tmpdir(), 'k95-mouse-'));
const log = join(bin, 'mouse.log');
// Turns on SGR mouse reporting, marks the middle cell M and the last cell E, and logs its size and every report.
// D redraws the marks, F prints 6000 lines first.
const PROGRAM = `
import { appendFileSync } from 'node:fs';
const LOG = ${JSON.stringify(log)};
const out = (s) => process.stdout.write(s);
const draw = () => {
  const [c, r] = process.stdout.getWindowSize();
  out('\\x1b[2J\\x1b[H\\x1b[' + Math.ceil(r / 2) + ';' + Math.ceil(c / 2) + 'H\\x1b[7mM\\x1b[0m\\x1b[' + r + ';' + c + 'H\\x1b[7mE\\x1b[0m\\x1b[H');
  appendFileSync(LOG, 'size ' + c + ' ' + r + '\\n');
};
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
out('\\x1b[?1000h\\x1b[?1002h\\x1b[?1006h');
draw();
process.stdin.on('data', (d) => {
  for (const m of d.matchAll(/\\x1b\\[<(\\d+);(\\d+);(\\d+)([Mm])/g)) appendFileSync(LOG, 'mouse ' + m[1] + ' ' + m[2] + ' ' + m[3] + ' ' + m[4] + '\\n');
  if (d.includes('F')) {
    out(Array.from({ length: 6000 }, (_, i) => 'line ' + i + '\\r\\n').join(''));
    draw();
  } else if (d.includes('D')) draw();
});
`;
const PATH0 = process.env.PATH;
const sessions: Session[] = [];
type Point = { x: number; y: number };
type Size = [number, number];

beforeAll(() => {
  writeFileSync(join(bin, 'mouse.mjs'), PROGRAM);
  fakeCli(bin, 'claude', 'mouse.mjs');
  process.env.PATH = bin + delimiter + PATH0;
});
afterAll(async () => {
  for (const s of sessions) s.pty.kill();
  await Promise.all(sessions.map((s) => s.done));
  process.env.PATH = PATH0;
  removeTemp(bin);
}, 30_000);

const lines = () => readFileSync(log, 'utf8').split('\n').filter(Boolean);
const win = (s: Session) => `[data-win="term-${s.key}"]`;
const open = async () => {
  const s = brainstorm(srv.board!);
  sessions.push(s);
  await until(() => page.evaluate(`!!document.querySelector('${win(s)} .xterm-rows')`), 'the terminal');
  return s;
};
/** The centre of the first cell of the span that shows `text`, and one cell's width, in screen px. */
const markAt = (s: Session, text: string) => page.evaluate<(Point & { w: number }) | null>(`(() => {
  const e = [...document.querySelectorAll('${win(s)} .xterm-rows span')].find((e) => e.textContent.trimEnd() === '${text}');
  if (!e) return null;
  const r = e.getBoundingClientRect();
  const w = r.width / e.textContent.length;
  return { x: r.left + w / 2, y: r.top + r.height / 2, w };
})()`);
/** xterm's cols and rows, from the DOM: the screen's width in cells and the row count. */
const xtermSize = async (s: Session): Promise<Size | null> => {
  const m = await markAt(s, 'M');
  if (!m) return null;
  return page.evaluate(`[Math.round(document.querySelector('${win(s)} .xterm-screen').getBoundingClientRect().width / ${m.w}), document.querySelector('${win(s)} .xterm-rows').children.length]`);
};
const resized = (s: Session, before: Size | null) =>
  until(async () => {
    const x = await xtermSize(s);
    if (!x) s.pty.write('D');
    return x && (x[0] !== before?.[0] || x[1] !== before?.[1]);
  }, 'the terminal to refit');
const mouse = (type: string, p: Point, button = 'left') =>
  page.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button, buttons: type === 'mouseReleased' ? 0 : button === 'right' ? 2 : 1, clickCount: 1 });

/** Waits until the pty and xterm agree on the size and the marks are drawn for it, then presses, drags and right-clicks them. */
async function check(s: Session) {
  await page.evaluate(`document.querySelector('${win(s)} .title-bar-text').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
  let last = '';
  const size = await until(async () => {
    const x = await xtermSize(s);
    const now = JSON.stringify([x, s.pty.cols, s.pty.rows]);
    const same = now === last;
    last = now;
    if (!same) await new Promise((r) => setTimeout(r, 300));
    return same && x && x[0] === s.pty.cols && x[1] === s.pty.rows && x;
  }, 'the pty to take the terminal size, unchanged for 300 ms');
  writeFileSync(log, '');
  s.pty.write('D');
  await until(() => lines().includes(`size ${size[0]} ${size[1]}`), 'the marks');
  const [c, r] = size;
  const mid = `${Math.ceil(c / 2)} ${Math.ceil(r / 2)}`;
  const end = `${c} ${r}`;
  const at = (text: string, col: number, row: number) =>
    until(async () => {
      const p = await markAt(s, text);
      const box = p && await page.evaluate<{ x: number; y: number; w: number; h: number }>(`(() => {
        const r = document.querySelector('${win(s)} .xterm-screen').getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height };
      })()`);
      return p && box && Math.abs(p.x - (box.x + (col - 0.5) * (box.w / c))) < p.w / 4 && Math.abs(p.y - (box.y + (row - 0.5) * (box.h / r))) < box.h / r / 4 && p;
    }, `the ${text} mark at ${col} ${row}`);
  const m = await at('M', Math.ceil(c / 2), Math.ceil(r / 2));
  const e = await at('E', c, r);
  writeFileSync(log, '');
  await mouse('mousePressed', m);
  await mouse('mouseMoved', { x: (m.x + e.x) / 2, y: (m.y + e.y) / 2 });
  await mouse('mouseMoved', e);
  await mouse('mouseReleased', e);
  await mouse('mousePressed', m, 'right');
  await mouse('mouseReleased', m, 'right');
  await until(() => lines().at(-1)?.startsWith('mouse 2 ') && lines().at(-1)?.endsWith(' m'), 'the reports');
  const got = lines();
  expect(got[0]).toBe(`mouse 0 ${mid} M`);
  expect(got.filter((l) => l.startsWith('mouse 32 ')).at(-1)).toBe(`mouse 32 ${end} M`);
  expect(got.slice(-3)).toEqual([`mouse 0 ${end} m`, `mouse 2 ${mid} M`, `mouse 2 ${mid} m`]);
}

/** Ctrl+0, then Ctrl+= or Ctrl+- in 10% steps to `f`, pressed outside the terminals. */
const zoomTo = async (f: number) => {
  const zoom = () => page.evaluate<number>('Number(document.body.style.zoom || 1)');
  const press = async (key: string, want: number) => {
    await page.evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', ctrlKey: true, bubbles: true }))`);
    await until(async () => Math.abs((await zoom()) - want) < 1e-6, `zoom ${want}`);
  };
  await press('0', 1);
  for (let z = 1; Math.abs(z - f) > 1e-6; z = Math.round((z + (f > 1 ? 0.1 : -0.1)) * 10) / 10) await press(f > 1 ? '=' : '-', Math.round((z + (f > 1 ? 0.1 : -0.1)) * 10) / 10);
};

describe('ui-terminal-mouse', { timeout: 120_000 }, () => {
  it('reports the cell under the pointer at every zoom, after a resize, a re-tile and a full scrollback', async () => {
    await page.goto(base);
    await zoomTo(1);
    const s = await open();
    await check(s);
    for (const f of [0.8, 1.2, 1.5]) {
      await zoomTo(f);
      await check(s);
    }

    let before = await xtermSize(s);
    await rightClick(`[data-task="term-${s.key}"]`);
    await menuPick('Maximize');
    await resized(s, before);
    await check(s);
    before = await xtermSize(s);
    await rightClick(`[data-task="term-${s.key}"]`);
    await menuPick('Restore');
    await resized(s, before);
    await check(s);

    before = await xtermSize(s);
    await open();
    await resized(s, before);
    await check(s);

    writeFileSync(log, '');
    s.pty.write('F');
    await until(() => lines().some((l) => l.startsWith('size')), 'the 6000 lines', 60_000);
    await check(s);

    await zoomTo(1);
  });
});
