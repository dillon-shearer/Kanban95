// In headless Edge or Chrome against a running daemon (setup in ui.ts): the mic button with fake model status, media and recorder.
// A start still waiting on the model or the microphone is cancelled by release, pointer cancel, a second click or removal.
import './home.ts';
import { describe, expect, it } from 'vitest';
import { until } from './cdp.ts';
import { page, base } from './ui.ts';

type Counts = { media: number; recorders: number; recording: number; tracks: number; live: number; transcribed: number; state: string };

const SETUP = `(async () => {
  const gate = () => { let open; const p = new Promise((ok) => { open = ok; }); return { p, open }; };
  const m = window.__mic = { model: gate(), media: [], recorders: [], tracks: [], transcribed: 0 };
  const real = window.fetch;
  window.fetch = async (url, opts) => {
    if (url !== '/api/voice') return real(url, opts);
    if (m.b?.dataset.state === 'transcribing') return new Promise(() => {});
    await m.model.p;
    return new Response(JSON.stringify({ downloaded: true }), { headers: { 'content-type': 'application/json' } });
  };
  navigator.mediaDevices.getUserMedia = () => {
    const g = gate();
    const t = { live: true, stop() { this.live = false; } };
    m.tracks.push(t);
    m.media.push(g);
    return g.p.then(() => ({ getTracks: () => [t] }));
  };
  window.MediaRecorder = class {
    constructor(s) { this.s = s; this.state = 'inactive'; m.recorders.push(this); }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      setTimeout(() => { this.ondataavailable?.({ data: new Blob(['x'], { type: 'audio/webm' }) }); this.onstop?.(); }, 0);
    }
  };
  window.AudioContext = class { constructor() { m.transcribed++; throw new Error('fake audio'); } };
  const v = await import('/voice.js');
  m.v = v;
  m.mount = (mode) => {
    v.configure({ mode });
    m.b = v.micButton(() => {});
    document.body.append(m.b);
  };
  m.ev = (type) => m.b.dispatchEvent(type === 'click' ? new MouseEvent('click') : new PointerEvent(type));
  m.tick = () => new Promise((ok) => setTimeout(ok, 30));
  m.counts = () => ({
    media: m.media.length,
    recorders: m.recorders.length,
    recording: m.recorders.filter((r) => r.state === 'recording').length,
    tracks: m.tracks.length,
    live: m.tracks.filter((t) => t.live).length,
    transcribed: m.transcribed,
    state: m.b.dataset.state,
  });
})()`;

async function run(body: string): Promise<Counts> {
  await page.goto(base);
  await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
  await page.evaluate(SETUP);
  return page.evaluate<Counts>(`(async () => { const m = window.__mic; ${body}; await m.tick(); return m.counts(); })()`);
}

describe('ui-mic-gesture', { timeout: 60_000 }, () => {
  it('records nothing when the hold ends before the model is ready', async () => {
    const r = await run(`m.mount('push'); m.ev('pointerdown'); await m.tick(); m.ev('pointerup'); m.model.open(); await m.tick();`);
    expect(r).toEqual({ media: 0, recorders: 0, recording: 0, tracks: 0, live: 0, transcribed: 0, state: 'idle' });
  });

  it('stops the late microphone stream when the hold is released or cancelled during the permission wait', async () => {
    for (const end of ['pointerup', 'pointercancel', 'pointerleave']) {
      const r = await run(`m.model.open(); m.mount('push'); m.ev('pointerdown'); await m.tick(); m.ev('${end}'); m.media[0].open(); await m.tick();`);
      expect(r, end).toEqual({ media: 1, recorders: 0, recording: 0, tracks: 1, live: 0, transcribed: 0, state: 'idle' });
    }
  });

  it('opens one stream for repeated presses while permission is pending', async () => {
    const r = await run(`m.model.open(); m.mount('push');
      m.ev('pointerdown'); await m.tick(); m.ev('pointerdown'); m.ev('pointerdown'); await m.tick();
      m.media.forEach((g) => g.open()); await m.tick();
      if (m.counts().recording !== 1) throw new Error('not recording: ' + JSON.stringify(m.counts()));
      m.ev('pointerup');`);
    expect(r).toEqual({ media: 1, recorders: 1, recording: 0, tracks: 1, live: 0, transcribed: 1, state: 'error' });
  });

  it('in toggle mode a second click while pending cancels and further clicks open no second stream', async () => {
    const r = await run(`m.model.open(); m.mount('toggle');
      m.ev('click'); await m.tick(); m.ev('click'); m.ev('click'); m.ev('click'); await m.tick();
      m.media.forEach((g) => g.open()); await m.tick();`);
    expect(r).toEqual({ media: 1, recorders: 0, recording: 0, tracks: 1, live: 0, transcribed: 0, state: 'idle' });
  });

  it('stops every track when the control is removed while recording or while starting', async () => {
    const recording = await run(`m.model.open(); m.mount('push'); m.ev('pointerdown'); await m.tick(); m.media[0].open(); await m.tick();
      if (m.counts().recording !== 1) throw new Error('not recording');
      m.b.remove(); await m.tick(); m.ev('pointerup');`);
    expect(recording).toEqual({ media: 1, recorders: 1, recording: 0, tracks: 1, live: 0, transcribed: 0, state: 'idle' });
    const starting = await run(`m.model.open(); m.mount('toggle'); m.ev('click'); await m.tick();
      m.b.remove(); await m.tick(); m.media[0].open(); await m.tick();`);
    expect(starting).toEqual({ media: 1, recorders: 0, recording: 0, tracks: 1, live: 0, transcribed: 0, state: 'idle' });
  });

  it('a normal hold and a normal toggle each transcribe once', async () => {
    const hold = await run(`m.model.open(); m.mount('push'); m.ev('pointerdown'); await m.tick(); m.media[0].open(); await m.tick();
      m.ev('pointerup'); m.ev('pointerleave'); await m.tick();`);
    expect(hold).toEqual({ media: 1, recorders: 1, recording: 0, tracks: 1, live: 0, transcribed: 1, state: 'error' });
    const toggle = await run(`m.model.open(); m.mount('toggle'); m.ev('click'); await m.tick(); m.media[0].open(); await m.tick();
      if (m.counts().recording !== 1) throw new Error('not recording');
      m.ev('click'); await m.tick();`);
    expect(toggle).toEqual({ media: 1, recorders: 1, recording: 0, tracks: 1, live: 0, transcribed: 1, state: 'error' });
  });
});
