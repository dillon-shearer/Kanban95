// Voice input. A mic button beside every text field and in every terminal title bar: hold to talk (or click to start and stop,
// Settings → Board → Voice), and the words land at the field's caret or are typed into the terminal without Enter.
// transcribe() runs a Whisper model inside this webview with transformers.js; the audio never leaves the machine. The model is
// downloaded by the daemon once, after the operator OKs the dialog that shows its source, size and hashes (docs/OPERATOR.md).
import { dialog, h } from './wm.js';

let settings = { backend: 'local', mode: 'push' };
export const configure = (voice) => { settings = { ...settings, ...voice }; };

const backends = { local: transcribeLocal };

/** Audio blob (anything the webview can decode) → text, with the backend chosen in Settings. */
export async function transcribe(blob) {
  const run = backends[settings.backend];
  if (!run) throw new Error(`unknown voice backend ${settings.backend}`);
  return run(blob);
}

let asr = null; // the loaded pipeline, shared by every mic
/** Which device the model runs on, for Settings and the log: 'webgpu' or 'wasm'. */
export let device = null;

async function load() {
  const info = await (await fetch('/api/voice')).json();
  const { pipeline, env } = await import('./vendor/transformers/transformers.min.js');
  env.allowRemoteModels = false; // everything comes from the daemon; the CSP would refuse anything else anyway
  env.allowLocalModels = true;
  env.localModelPath = '/voice-model/';
  env.useBrowserCache = false;
  env.useWasmCache = false; // its preload re-imports the runtime from a blob: URL, which the CSP (script-src 'self') refuses
  env.backends.onnx.wasm.wasmPaths = {
    mjs: '/vendor/transformers/ort-wasm-simd-threaded.asyncify.mjs',
    wasm: '/vendor/transformers/ort-wasm-simd-threaded.asyncify.wasm',
  };
  const gpu = await navigator.gpu?.requestAdapter().catch(() => null);
  for (const d of gpu ? ['webgpu', 'wasm'] : ['wasm']) {
    try {
      const p = await pipeline('automatic-speech-recognition', info.id, { device: d, dtype: 'q8' });
      device = d;
      return p;
    } catch (e) {
      if (d === 'wasm') throw e; // WebGPU can fail on a given adapter; WASM is the floor
    }
  }
}

async function transcribeLocal(blob) {
  asr ??= load().catch((e) => { asr = null; throw e; });
  const ctx = new AudioContext({ sampleRate: 16000 }); // Whisper wants 16 kHz mono; decodeAudioData resamples
  let samples;
  try {
    samples = (await ctx.decodeAudioData(await blob.arrayBuffer())).getChannelData(0);
  } finally {
    ctx.close();
  }
  const out = await (await asr)(samples);
  return out.text.trim();
}

const mb = (n) => (n < 1e6 ? `${Math.ceil(n / 1e3)} kB` : `${(n / 1e6).toFixed(1)} MB`);

/** True once the model is on disk. Otherwise asks first; nothing is fetched unless the operator presses Download. */
export async function ensureModel() {
  const s = await (await fetch('/api/voice')).json();
  if (s.downloaded) return true;
  const url = `${s.source}/tree/${s.revision}`;
  const ok = await dialog('Download speech model', h('div', { class: 'k95-download' },
    h('p', {}, 'Voice input runs a speech model on this computer. It is not installed yet. Download it once?'),
    h('table', {}, h('tbody', {},
      h('tr', {}, h('th', {}, 'Model'), h('td', {}, s.id)),
      h('tr', {}, h('th', {}, 'Source'), h('td', {}, url)),
      h('tr', {}, h('th', {}, 'Size'), h('td', {}, mb(s.size))),
      h('tr', {}, h('th', {}, 'License'), h('td', {}, s.license)))),
    h('p', {}, 'Each file is checked against its SHA-256 before it is used:'),
    h('ul', { class: 'tree-view k95-hashes' }, s.files.map((f) => h('li', {}, `${f.path}  ${mb(f.size)}  sha256 ${f.sha256}`)))),
  ['Download', 'Cancel']);
  if (ok !== 'Download') return false;

  const bar = h('span', { class: 'progress-indicator-bar', style: 'width: 0%' });
  const wait = dialog('Downloading speech model', h('div', {}, h('p', {}, `${s.id}, ${mb(s.size)}`), h('div', { class: 'progress-indicator' }, bar)), []);
  const poll = setInterval(async () => {
    const p = await (await fetch('/api/voice')).json();
    if (p.received !== null) bar.style.width = `${Math.round((100 * p.received) / p.size)}%`;
  }, 500);
  const r = await fetch('/api/voice/download', { method: 'POST' });
  clearInterval(poll);
  document.querySelector('dialog[open]')?.close();
  await wait;
  if (!r.ok) {
    await dialog('Download failed', (await r.json()).error);
    return false;
  }
  return true;
}

/** A mic button. `onText` gets the words; the button shows idle, recording, transcribing or error. */
export function micButton(onText) {
  let rec = null;
  const b = h('button', { class: 'k95-mic', type: 'button', 'data-state': 'idle', title: 'Voice input', 'aria-label': 'Voice input' });
  const state = (s, title = 'Voice input') => { b.dataset.state = s; b.title = title; };

  async function start() {
    if (rec || b.dataset.state === 'transcribing') return;
    if (!(await ensureModel())) return;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      state('error', e.message);
      await dialog('Microphone unavailable', h('div', {},
        h('p', {}, e.name === 'NotAllowedError' ? 'Kanban95 is not allowed to use the microphone.' : `No microphone could be opened (${e.name}).`),
        h('p', {}, 'Windows: open Privacy & security → Microphone in the Windows Settings app. Turn on "Microphone access" and "Let desktop apps access your microphone", then try again.'),
        h('p', {}, 'Windows dictation (Win+H) also works in any field.')));
      return;
    }
    const chunks = [];
    rec = new MediaRecorder(stream);
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      rec = null;
      state('transcribing', 'Transcribing…');
      try {
        const text = await transcribe(new Blob(chunks, { type: chunks[0]?.type }));
        state('idle');
        if (text) onText(text);
      } catch (e) {
        state('error', `Voice input failed: ${e.message}`);
      }
    };
    rec.start();
    state('recording', settings.mode === 'push' ? 'Recording… release to stop' : 'Recording… click to stop');
  }
  const stop = () => rec?.state === 'recording' && rec.stop();

  b.addEventListener('mousedown', (e) => e.preventDefault()); // keep the caret in the field
  b.addEventListener('pointerdown', () => settings.mode === 'push' && start());
  b.addEventListener('pointerup', () => settings.mode === 'push' && stop());
  b.addEventListener('pointerleave', () => settings.mode === 'push' && stop());
  b.addEventListener('click', () => settings.mode === 'toggle' && (rec ? stop() : start()));
  return b;
}

/** Inserts text at the field's caret, with a space before it when it would run into a word. */
function insert(field, text) {
  const at = field.selectionStart ?? field.value.length;
  const pad = at > 0 && !/\s/.test(field.value[at - 1]) ? ' ' : '';
  field.focus();
  field.setRangeText(pad + text, at, field.selectionEnd ?? at, 'end');
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Every text field gets a mic, now and whenever one is added to the page. */
export function micEverywhere(root = document.body) {
  const SEL = 'textarea, input[type=text], input[type=search]';
  const add = (f) => {
    if (f.dataset.mic || f.closest('.xterm')) return; // a terminal's mic sits in its title bar, not on xterm's hidden textarea
    f.dataset.mic = '1';
    f.after(micButton((t) => insert(f, t)));
  };
  root.querySelectorAll(SEL).forEach(add);
  new MutationObserver((ms) => {
    for (const m of ms) for (const n of m.addedNodes) {
      if (n.nodeType !== 1) continue;
      if (n.matches(SEL)) add(n);
      n.querySelectorAll(SEL).forEach(add);
    }
  }).observe(root, { childList: true, subtree: true });
}
