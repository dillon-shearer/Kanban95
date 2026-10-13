import './home.ts';
import { describe, expect, it } from 'vitest';
import { until } from './cdp.ts';
import { events } from '../src/lifecycle.ts';
import { page, base, ticket, column } from './ui.ts';

type Counts = { fetches: Record<string, number>; rebuilds: number };

const watch = async (holdRunner: boolean) => {
  await page.evaluate(`(() => {
    window.counts = { fetches: {}, rebuilds: 0 };
    window.hold = false;
    window.release = null;
    const f = window.__fetch ??= window.fetch;
    window.fetch = (u, o) => {
      const path = String(u).split('?')[0];
      window.counts.fetches[path] = (window.counts.fetches[path] ?? 0) + 1;
      if (window.hold && path === '/api/runner') {
        window.hold = false;
        return new Promise((ok) => { window.release = () => ok(f(u, o)); });
      }
      return f(u, o);
    };
    window.observer?.disconnect();
    window.observer = new MutationObserver((rs) => { window.counts.rebuilds += rs.filter((r) => r.removedNodes.length).length; });
    window.observer.observe(document.querySelector('.k95-columns'), { childList: true });
  })()`);
  await new Promise((ok) => setTimeout(ok, 500));
  await page.evaluate(`window.counts = { fetches: {}, rebuilds: 0 }; window.hold = ${holdRunner};`);
};
const counts = () => page.evaluate<Counts>('window.counts');
const settled = async (rebuilds: number) => {
  await until(async () => (await counts()).rebuilds >= rebuilds, `${rebuilds} rebuilds`);
  await new Promise((ok) => setTimeout(ok, 300));
  return counts();
};

describe('ui-event-burst', { timeout: 60_000 }, () => {
  it('five ticket events in one tick fetch each shared list once and rebuild the Board once', async () => {
    const ids = Array.from({ length: 5 }, (_, i) => ticket(`Burst ${i}`));
    await page.goto(base);
    await until(() => column(ids[4]), 'the cards');
    await watch(false);

    for (const id of ids) events.emit('event', { ticket: id });
    const c = await settled(1);
    expect(c.rebuilds).toBe(1);
    expect(c.fetches['/api/runner']).toBe(1);
    expect(c.fetches['/api/sessions']).toBe(1);
    expect(c.fetches['/api/inbox']).toBe(1);
    for (const id of ids) expect(c.fetches[`/api/tickets/${id}`]).toBe(1);
  });

  it('events during an in-flight pass cause exactly one trailing pass', async () => {
    const ids = Array.from({ length: 3 }, (_, i) => ticket(`Trail ${i}`));
    await page.goto(base);
    await until(() => column(ids[2]), 'the cards');
    await watch(true);

    events.emit('event', { ticket: ids[0] });
    await until(() => page.evaluate<boolean>('!!window.release'), 'the first pass waiting on /api/runner');
    events.emit('event', { ticket: ids[1] });
    events.emit('event', { ticket: ids[2] });
    events.emit('event', { ticket: ids[1] });
    await new Promise((ok) => setTimeout(ok, 200));
    expect((await counts()).rebuilds).toBe(0);
    await page.evaluate('window.release()');

    const c = await settled(2);
    expect(c.rebuilds).toBe(2);
    expect(c.fetches['/api/runner']).toBe(2);
    expect(c.fetches[`/api/tickets/${ids[0]}`]).toBe(1);
    expect(c.fetches[`/api/tickets/${ids[1]}`]).toBe(1);
    expect(c.fetches[`/api/tickets/${ids[2]}`]).toBe(1);
  });
});
