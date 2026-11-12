// Scratch harness (development only, never shipped): mount the real built page
// in frames of a fake host, so a headless browser photographs what the section
// really paints. The copied page and this page share one directory, which is
// what lets the frames answer each other and paint.
//
//   node scripts/mount-preview.mjs [outDir]
//
// Writes `index.html` (every state, for checking a change by eye) and
// `photo.html` (the states the README shows, in one row, each sized by the
// section's own height report).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT_DIR = process.argv[2] || path.join(os.tmpdir(), 'gauge-mount');

const NOW = Date.now();
const GB = 1024 ** 3;
const MODEL = { name: 'Qwen3.8-Flash-Next-GSQ-RCO', quant: 'IQ3_XXS', id: 'ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF:IQ3_XXS', at: NOW };
const CHAT = { id: 'ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF', name: 'Qwen3.8-Flash-Next-GSQ-RCO' };
const CLOUD = { id: 'minimax-coding-plan/MiniMax-M3.1-Flash', name: 'MiniMax-M3.1-Flash' };
const CURVE = [0, 0, 2, 18, 24, 21, 26, 22, 25, 23, 27, 24, 26, 22, 25, 24, 23, 26, 24, 25, 24, 23, 25, 24];
const ZEROS = new Array(24).fill(0);
const LAST_TURN = {
  tokensPerSecond: 38.2, source: 'tokens', tokens: 4780, activeMs: 92_000,
  ttftMs: 6_100, hasReasoning: true, endedAt: NOW - 90_000,
  split: { totalMs: 125_000, readMs: 18_000, waitMs: 6_000, writeMs: 92_000, toolMs: 9_000 },
};
// A cloud reply has no `reading` slice: that time is inside `waiting`.
const CLOUD_TURN = {
  tokensPerSecond: 38.2, source: 'tokens', tokens: 1830, activeMs: 39_000,
  ttftMs: 6_100, hasReasoning: true, endedAt: NOW - 90_000,
  split: { totalMs: 48_000, readMs: 0, waitMs: 6_000, writeMs: 33_000, toolMs: 9_000 },
};
const CACHE = {
  startedAt: NOW - 600_000, steps: 8, sessions: 2, hit: 192_000, miss: 38_000, hitRate: 83.5,
  write: 0, output: 110, reasoning: 0, cost: 0.4234,
  last: { at: NOW, sessionId: 'ses_mount', messageID: 'm', hit: 1600, miss: 100, hitRate: 94.1, delta: 1.2 },
  prevHitRate: 92.9,
};
// A local engine bills nothing, so its chat has no cost to show.
const LOCAL_CACHE = { ...CACHE, cost: 0 };
const mac = (pressure, used, swap = 0) => ({ pressure, usedBytes: used * GB, totalBytes: 48 * GB, swapUsedBytes: swap * GB, at: NOW });
const base = (over) => ({
  connection: 'live', error: null, errorKind: null, sessionId: 'ses_mount', busy: false, waiting: null,
  toolActive: false, live: { tps: 0 },
  running: null, curve: ZEROS, curveStart: NOW - 30_000, curveStep: 1250, curveAt: NOW,
  turn: { active: false, ttftMs: null }, lastTurn: LAST_TURN, cache: CACHE,
  gauge: { mac: mac('normal', 41.2), prompt: null, render: null, model: MODEL, chatModel: CHAT },
  ...over,
});

const CASES = {
  // Exactly what the service answers when a watched chat has gone quiet.
  // The local engine holds its model while the chat is on a cloud one.
  idle: base({
    lastTurn: CLOUD_TURN,
    gauge: { mac: mac('normal', 41.2), prompt: null, render: null, model: MODEL, chatModel: CLOUD },
  }),
  writing: base({
    busy: true, live: { tps: 41.6 },
    running: { tps: 38.6, source: 'estimate', tokens: 0, durationMs: 1000 },
    turn: { active: true, ttftMs: 2400 }, lastTurn: null, curve: CURVE, cache: LOCAL_CACHE,
    gauge: { mac: mac('warning', 44.8, 1.5), prompt: null, render: null, model: MODEL, chatModel: CHAT },
  }),
  // A llama.cpp engine's own prefill counters, mid-prompt.
  reading: base({
    cache: LOCAL_CACHE,
    gauge: { mac: mac('normal', 41.2), render: null, model: MODEL, chatModel: CHAT, prompt: { kind: 'primary', total: 22056, cache: 8192, processed: 12000, timeMs: 5200, observedAt: NOW } },
  }),
  compacting: base({
    gauge: { mac: null, render: null, model: MODEL, chatModel: CHAT, prompt: { kind: 'compaction', total: 24000, cache: 8000, processed: 9600, timeMs: 4000, observedAt: NOW } },
  }),
  empty: base({
    lastTurn: null, cache: null,
    gauge: { mac: mac('normal', 30), prompt: null, render: null, model: null, chatModel: CLOUD },
  }),
  // Any machine that is not a Mac: there is no memory reading, so no line.
  offmac: base({
    gauge: { macSupported: false, mac: null, prompt: null, render: null, model: null, chatModel: CLOUD },
  }),
  denied: { rejected: { code: 'NO_SERVICE', error: 'The local service is not allowed for this extension' } },
  unreachable: base({ connection: 'error', error: null, errorKind: 'network', curve: CURVE }),
  // The approval that lets Gauge read sessions is missing: its own wording.
  noaccess: base({ connection: 'error', error: null, errorKind: 'access', curve: ZEROS }),
};

const THEME = JSON.stringify({ mode: 'dark', tokens: { background: '#101114', elevated: '#1b1d21', foreground: '#f4f4f5', muted: '#9a9aa0', subtle: '#2a2c31', border: '#3a3d42', hover: '#3a3a3a', active: '#4a4a4a', selection: '#555', selectionForeground: '#fff', focus: '#6af', primary: '#6af', primaryForeground: '#08111a', primaryText: '#cfe3ff', successText: '#4ade80', warningText: '#eab308', errorText: '#f87171', infoText: '#60a5fa', success: '#4ade80', warning: '#eab308', error: '#f87171', info: '#60a5fa', font: 'system-ui', mono: 'ui-monospace', radius: '9px' } });

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'status/main.js'), path.join(OUT_DIR, 'main.js'));
const sectionHtml = fs.readFileSync(path.join(ROOT, 'status/index.html'), 'utf8');
fs.writeFileSync(path.join(OUT_DIR, 'section.html'), sectionHtml);

/**
 * A copy of the page with a tap in it, for a photograph that has to show what
 * sits behind a line. The shipped page is not touched: this is the harness's
 * own copy, and the tap is one a person would make.
 */
const tappedPage = (label) => {
  const file = `section-${label.replace(/[^a-z]/gi, '').toLowerCase()}.html`;
  const tap = `<script>/* harness only: open "${label}" the way a tap does */
addEventListener('load', () => setTimeout(() => {
  const button = [...document.querySelectorAll('.row .line')]
    .find((line) => line.querySelector('.k')?.textContent === ${JSON.stringify(label)});
  button?.click();
}, 600));</script>`;
  fs.writeFileSync(path.join(OUT_DIR, file), sectionHtml.replace('</body>', `${tap}</body>`));
  return file;
};

/** One mounted section: `open` names a line to tap, so its detail shows. */
const panel = (name, title, { width, open } = {}) => `
  <figure class="shot"><figcaption>${title}</figcaption>
  <iframe style="width:${width}px" src="${open ? tappedPage(open) : 'section.html'}" data-case="${name}" loading="eager"></iframe></figure>`;

// What a host does: answer hello, answer the service's routes, and take the
// section's height report and size the frame to it.
const HOST_SCRIPT = `
const CASES = ${JSON.stringify(CASES)};
const THEME = ${THEME};
window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.channel !== 'openchamber.sdk') return;
  const frame = [...document.querySelectorAll('iframe')].find((f) => f.contentWindow === event.source);
  if (!frame) return;
  const fixture = CASES[frame.dataset.case];
  const send = (payload) => event.source.postMessage({ channel: 'openchamber.sdk', v: 1, ...payload }, '*');
  if (data.type === 'hello') {
    send({ type: 'ready', payload: { session: { id: 'ses_mount', title: 'mount', busy: false, model: 'x' }, surface: 'status', connection: { connected: true, account: null }, settings: {}, locale: 'en', theme: THEME } });
    return;
  }
  if (data.type === 'resize') {
    frame.style.height = \`\${data.payload.height}px\`;
    send({ type: 'result', id: data.id, ok: true });
    return;
  }
  if (data.type !== 'service-request') return;
  if (fixture.rejected) {
    send({ type: 'result', id: data.id, ok: false, code: fixture.rejected.code, error: fixture.rejected.error });
    return;
  }
  const body = data.payload?.path === '/watch' ? { ok: true, connection: 'live', sessionId: 'ses_mount', push: true } : fixture;
  send({ type: 'result', id: data.id, ok: true, payload: { status: 200, body: JSON.stringify(body) } });
});
`;

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>
body{margin:0;padding:14px;background:#0b0c0e;color:#f4f4f5;font-family:system-ui}
h2{font:500 .78rem/1.3 system-ui;color:#9a9aa0;margin:14px 0 6px}
.grid{display:flex;gap:14px;flex-wrap:wrap;align-items:flex-start}
.shot{margin:0;display:flex;flex-direction:column;gap:6px}
.shot figcaption{font:500 .72rem/1.3 system-ui;color:#9a9aa0}
.shot iframe{height:150px;border:0;border-radius:10px;background:#101114}
</style></head><body>
${body}
<script>${HOST_SCRIPT}</script></body></html>`;

const checks = page('Gauge mounted', `
<h2>300 px wide</h2>
<div class="grid">${panel('idle', 'idle: the band closes, the number is named', { width: 300 })}${panel('writing', 'writing: band open', { width: 300 })}${panel('empty', 'a chat with no reply yet', { width: 300 })}</div>
<h2>470 px wide</h2>
<div class="grid">${panel('reading', 'a llama.cpp engine reading the prompt', { width: 470 })}${panel('compacting', 'a prompt being compacted', { width: 470 })}${panel('offmac', 'a machine with no memory reading', { width: 470 })}</div>
<h2>the refusals</h2>
<div class="grid">${panel('denied', 'the service was never allowed', { width: 470 })}${panel('unreachable', 'the stream cannot be reached', { width: 470 })}${panel('noaccess', 'reading sessions was not allowed', { width: 470 })}</div>
`);

// The README's picture: three real states, each as tall as the section says it is.
const photo = page('Gauge', `
<div class="grid">${panel('idle', 'Cloud chat, idle', { width: 470, open: 'Last reply' })}${panel('writing', 'Local chat, writing', { width: 470 })}${panel('reading', 'Reading the prompt', { width: 470 })}</div>
`);

const written = ['index.html', 'photo.html'].map((name) => {
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, name === 'photo.html' ? photo : checks);
  return file;
});
console.log(written.join('\n'));
