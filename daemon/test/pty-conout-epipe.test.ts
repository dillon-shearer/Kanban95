import { afterEach, describe, expect, it } from 'vitest';
import { spawnPty } from '../src/pty.ts';

type Agent = {
  _outSocket: { pause(): void; destroy(): void };
  _conoutSocketWorker: { _worker: { once(e: 'exit', f: (code: number) => void): void } };
};

const uncaught: Error[] = [];
const onUncaught = (e: Error) => uncaught.push(e);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
afterEach(() => {
  process.off('uncaughtException', onUncaught);
});

describe.skipIf(process.platform !== 'win32')('a pty whose output reader closes mid-write', { timeout: 30_000 }, () => {
  it('does not raise an uncaught EPIPE from the conout worker', async () => {
    process.on('uncaughtException', onUncaught);
    const flood = 'setInterval(()=>process.stdout.write(Math.random().toString(36).repeat(2000)),1)';
    const { pty, scrollback } = spawnPty(process.execPath, ['-e', flood], { cwd: process.cwd(), env: { ...process.env } as Record<string, string>, cols: 200, rows: 60 });
    const end = Date.now() + 20_000;
    while (scrollback().length < 10_000) {
      if (Date.now() > end) throw new Error('no output from the pty');
      await sleep(25);
    }
    const agent = (pty as unknown as { _agent: Agent })._agent;
    const exited = new Promise<number>((r) => agent._conoutSocketWorker._worker.once('exit', r));
    agent._outSocket.pause();
    await sleep(1000);
    agent._outSocket.destroy();
    expect(await exited).toBe(1);
    await sleep(200);
    pty.kill();
    expect(uncaught.map((e) => e.message)).toEqual([]);
  });
});
