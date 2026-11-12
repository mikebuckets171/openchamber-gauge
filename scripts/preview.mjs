// Scratch harness (not part of the package): mount the real built status page
// in frames, answer like a host, and let a headless browser photograph it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = process.argv[2] || path.join(os.tmpdir(), 'gauge-preview.html');

const DARK = { mode: 'dark', tokens: { background: '#101114', elevated: '#1b1d21', foreground: '#f4f4f5', muted: '#9a9aa0', subtle: '#2a2c31', border: '#3a3d42', hover: '#3a3a3a', active: '#4a4a4a', selection: '#555', selectionForeground: '#fff', focus: '#6af', primary: '#6af', primaryForeground: '#08111a', primaryText: '#cfe3ff', successText: '#4ade80', warningText: '#eab308', errorText: '#f87171', infoText: '#60a5fa', success: '#4ade80', warning: '#eab308', error: '#f87171', info: '#60a5fa', font: 'system-ui', mono: 'ui-monospace', radius: '9px' } };
const LIGHT = { ...DARK, mode: 'light', tokens: { ...DARK.tokens, background: '#fbfbfc', elevated: '#f2f2f4', foreground: '#18181b', muted: '#6b7280', subtle: '#e5e7eb', border: '#d4d4d8', primary: '#b42318' } };

const NOW = Date.now();
const GB = 1024 ** 3;
const MODEL = { name: 'Qwen3.8-Flash-Next-GSQ-RCO', quant: 'IQ3_XXS', id: 'ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF:IQ3_XXS', at: NOW };
const CHAT = { id: 'ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF', name: 'Qwen3.8-Flash-Next-GSQ-RCO' };
const CLOUD = { id: 'MiniMax-M3.1-Flash', name: 'MiniMax-M3.1-Flash' };
const CACHE = {
  startedAt: NOW - 600_000, steps: 8, sessions: 2, hit: 192_000, miss: 38_000, hitRate: 83.5,
  write: 0, output: 110, reasoning: 0, cost: 0.4234,
  last: { at: NOW, sessionId: 'ses_preview', messageID: 'm', hit: 1600, miss: 100, hitRate: 94.1, delta: 1.2 },
  prevHitRate: 92.9,
};
const CURVE = [0, 0, 2, 18, 24, 21, 26, 22, 25, 23, 27, 24, 26, 22, 25, 24, 23, 26, 24, 25, 24, 23, 25, 24];
const base = (over) => ({
  connection: 'live', error: null, errorKind: null, sessionId: 'ses_preview', busy: false, waiting: null,
  toolActive: false, live: { tps: 0, spanMs: 0, chars: 0, textChars: 0, reasoningChars: 0, toolChars: 0 },
  running: null, curve: CURVE, curveStart: NOW - CURVE.length * 1250, curveStep: 1250, curveAt: NOW,
  turn: { active: false, ttftMs: null }, lastTurn: null, cache: CACHE, gauge: null, eventsSeen: 0, ...over,
});

const CASES = {
  idleLocal: base({
    gauge: { mac: { pressure: 'normal', usedBytes: 41.2 * GB, totalBytes: 48 * GB, swapUsedBytes: 0, at: NOW }, prompt: null, render: null, model: MODEL, chatModel: CHAT },
    curve: new Array(24).fill(0),
    lastTurn: { tokensPerSecond: 38.2, source: 'tokens', tokens: 1260, activeMs: 33000, wallMs: 48000, ttftMs: 6100, hasReasoning: true, endedAt: NOW - 90_000, split: { totalMs: 48000, readMs: 12000, waitMs: 6000, writeMs: 21000, toolMs: 9000 } },
  }),
  writing: base({
    busy: true, live: { tps: 41.6, spanMs: 1000, chars: 160, textChars: 90, reasoningChars: 70, toolChars: 0 },
    running: { tps: 38.6, source: 'estimate', tokens: 0, durationMs: 1000 },
    turn: { active: true, ttftMs: 2400 },
    gauge: { mac: { pressure: 'warning', usedBytes: 44.8 * GB, totalBytes: 48 * GB, swapUsedBytes: 1.5 * GB, at: NOW }, prompt: null, render: null, model: MODEL, chatModel: CHAT },
  }),
  empty: base({ curve: new Array(24).fill(0), cache: null, gauge: { mac: { pressure: 'normal', usedBytes: 30 * GB, totalBytes: 48 * GB, swapUsedBytes: 0, at: NOW }, prompt: null, render: null, model: null, chatModel: CLOUD } }),
  compacting: base({
    curve: new Array(24).fill(0), running: null,
    gauge: { mac: null, prompt: { kind: 'compaction', total: 24000, cache: 8000, processed: 9600, timeMs: 4000, observedAt: NOW }, render: null, model: MODEL, chatModel: CHAT },
  }),
  broken: base({
    connection: 'error', error: 'Allow the local service in Settings → Extensions', errorKind: 'http',
    curve: new Array(24).fill(0), cache: null, gauge: null, sessionId: null,
  }),
  cloudLongName: base({
    gauge: { mac: null, prompt: null, render: null, model: MODEL, chatModel: { id: 'claude-agent/opus', name: 'claude-agent/opus · subscription' } },
  }),
};

const icon = fs.readFileSync(path.join(ROOT, 'icon.svg'), 'utf8');
const pageCss = fs.readFileSync(path.join(ROOT, 'status/index.html'), 'utf8').match(/<style>([\s\S]*?)<\/style>/)[1];

/**
 * The layout check: the page's real CSS around markup shaped exactly like the
 * page builds, so the collapsed band, the named number, the notice and the
 * model parts can be looked at without a host handshake.
 */
const piece = (text, keep) => `<span class="part${keep ? ' keep' : ''}">${text}</span>`;
const join = '<span class="join"> · </span>';
const row = (tone, label, value, open = false) => `<div class="row${tone ? ` ${tone}` : ''}${open ? ' open' : ''}"><button type="button" class="line"><span class="k">${label}</span>${value}<span class="chev" aria-hidden="true">›</span></button><div class="det"><div class="in"><div class="sub">6.0s waiting · 33s writing · 9.0s tools</div></div></div></div>`;
const modelValue = (parts) => `<span class="v pieces">${parts.map((p, i) => (i ? join : '') + piece(p, i > 0)).join('')}</span>`;
const lineValue = (text) => `<span class="v">${text}</span>`;
const sparkOpen = `<div class="sparkrow"><svg viewBox="0 0 120 18" preserveAspectRatio="none"><path d="M1 16L10 15L20 6L40 4L60 5L80 4L100 5L119 5V18H1Z" fill="currentColor" opacity=".16"/><path d="M1 16L10 15L20 6L40 4L60 5L80 4L100 5L119 5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></div>`;
const gauge = ({ dot, value, unit = true, stale, cap, state, spark, notice, rows, rule = 0 }) => `<div class="gauge"><div class="hero"><span class="dot ${dot}"></span><span class="value${stale ? ' stale' : ''}">${value}</span>${unit ? '<span class="unit">tok/s</span>' : ''}${cap ? `<span class="cap">${cap}</span>` : ''}${state ? `<span class="state">${state}</span>` : ''}</div>${spark}${notice ? `<div class="notice">${notice}</div>` : ''}<div class="rule"><i class="fill" style="width:${rule}%"></i></div><div class="rows">${rows}</div></div>`;
const rowsIdle = row('', 'Last reply', lineValue('2m 5s · mostly writing'))
  + row('', 'Model', modelValue(['Qwen3.8-Flash-Next-GSQ-RCO', 'IQ3_XXS', '$0.42']))
  + row('warning', 'Memory', lineValue('44.8 / 48.0 GB'));
const LAYOUT = [
  { title: 'idle, 300 px', width: 300, html: gauge({ dot: 'idle', value: '38.2', stale: true, cap: 'Last reply', spark: '<div class="sparkrow tight"></div>', rows: rowsIdle }) },
  { title: 'writing, band open', width: 300, html: gauge({ dot: 'live', value: '38.6', spark: sparkOpen, rows: rowsIdle, rule: 40 }) },
  { title: 'service not allowed', width: 300, html: gauge({ dot: 'wait', value: '—', unit: false, state: 'reconnecting', spark: '<div class="sparkrow tight"></div>', notice: 'Allow the local service in Settings → Extensions', rows: rowsIdle }) },
  { title: 'a line opened', width: 300, html: gauge({ dot: 'idle', value: '38.2', stale: true, cap: 'Last reply', spark: '<div class="sparkrow tight"></div>', rows: row('', 'Last reply', lineValue('2m 5s · mostly writing'), true) + row('', 'Model', modelValue(['MiniMax-M3.1-Flash', '$0.42'])) + row('warning', 'Memory', lineValue('44.8 / 48.0 GB')) }) },
];
const layoutHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>:root{--oc-fg:#f4f4f5;--oc-muted:#9a9aa0;--oc-primary:#6af;--oc-subtle:#2a2c31;--oc-warning:#eab308;--oc-error:#f66;--oc-focus:#6af;--oc-font:system-ui}${pageCss}</style></head>
<body style="margin:0;padding:18px;background:#101114;color:#f4f4f5;font-family:system-ui"><div class="shots">${LAYOUT.map((s) => `<figure class="shot"><figcaption>${s.title}</figcaption><div style="width:${s.width}px">${s.html}</div></figure>`).join('')}</div>
<style>.shots{display:flex;gap:20px;flex-wrap:wrap;align-items:flex-start}.shot{margin:0;display:flex;flex-direction:column;gap:8px}.shot figcaption{font:500 .78rem/1.3 system-ui;color:#9a9aa0}</style></body></html>`;
fs.writeFileSync(OUT.replace(/\.html$/, '-layout.html'), layoutHtml);
console.log(OUT.replace(/\.html$/, '-layout.html'));

const panel = (title, mode, rate) => `
  <figure class="shot ${mode}">
    <figcaption>${title}</figcaption>
    <iframe data-mode="${mode}" data-rate="${encodeURIComponent(JSON.stringify(rate))}" src="file://${ROOT}/status/index.html" loading="eager"></iframe>
  </figure>`;

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Gauge preview</title>
<style>
:root{color-scheme:light dark}
body{margin:0;padding:20px;font-family:system-ui;background:#0b0c0e;color:#f4f4f5}
h2{font:600 .8rem/1.2 system-ui;color:#9a9aa0;margin:0 0 8px;text-transform:none}
h1{font:600 1.1rem/1.3 system-ui;margin:0 0 18px}
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin-bottom:26px}
.shot{margin:0;display:flex;flex-direction:column;gap:8px}
.shot figcaption{font:500 .78rem/1.3 system-ui;color:#9a9aa0}
.shot.dark{background:#101114;border-radius:10px;padding:12px}
.shot.light{background:#fbfbfc;color:#18181b;border-radius:10px;padding:12px}
iframe{width:100%;height:210px;border:0;display:block}
.icons{display:flex;gap:22px;align-items:center;margin-bottom:26px}
.chip{display:flex;align-items:center;gap:8px;padding:10px 14px;border-radius:10px;font-weight:600}
.chip.dark{background:#101114;color:#f4f4f5}
.chip.light{background:#fbfbfc;color:#18181b}
.chip svg{fill:currentColor}
.narrow .grid{grid-template-columns:minmax(0,1fr)}
.narrow iframe{height:230px}
</style></head><body>
<h1>Gauge 0.5.0 — built page, fake host</h1>
<div class="icons">
  <span class="chip dark">${icon}<span style="font-size:1.05rem">Gauge</span></span>
  <span class="chip light">${icon}<span style="font-size:1.05rem">Gauge</span></span>
  <span class="chip dark">${icon.replace('viewBox="0 0 24 24"', 'viewBox="0 0 24 24" width="14" height="14"')}<span style="font-size:.8rem">14px</span></span>
</div>
<h2>Desktop width</h2>
<div class="grid">
  ${panel('idle, local chat, last reply kept', 'dark', CASES.idleLocal)}
  ${panel('writing now', 'dark', CASES.writing)}
  ${panel('memory warning while writing', 'dark', CASES.compacting)}
  ${panel('new chat, nothing yet', 'dark', CASES.empty)}
  ${panel('service not allowed', 'dark', CASES.broken)}
  ${panel('light theme, cloud chat', 'light', CASES.cloudLongName)}
</div>
<h2>Narrow (phone-width relay)</h2>
<div class="grid narrow">
  ${panel('local model name, narrow', 'dark', CASES.idleLocal)}
  ${panel('service not allowed, narrow', 'dark', CASES.broken)}
</div>
<script>
const TOKENS = ${JSON.stringify({ dark: DARK, light: LIGHT })};
window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'hello') return;
  const frame = [...document.querySelectorAll('iframe')].find((f) => f.contentWindow === event.source);
  if (!frame) return;
  const mode = frame.dataset.mode;
  const rate = JSON.parse(decodeURIComponent(frame.dataset.rate));
  const send = (payload) => event.source.postMessage({ channel: data.channel, v: data.v, ...payload }, event.origin || '*');
  send({ type: 'ready', payload: { session: { id: 'ses_preview', title: 'preview', busy: false, model: 'x' }, surface: 'status', connection: { connected: true, account: null }, settings: {}, locale: 'en', theme: TOKENS[mode] } });
  const answer = (request) => {
    if (request.type !== 'service-request') return;
    const body = request.payload?.path === '/watch' ? { ok: true, changed: true, connection: 'live', sessionId: 'ses_preview' } : rate;
    send({ type: 'result', id: request.id, ok: true, payload: { status: 200, body: JSON.stringify(body) } });
  };
  frame.__answer = answer;
  window.addEventListener('message', (next) => { if (next.source === event.source) answer(next.data); });
});
</script>
</body></html>`;

fs.writeFileSync(OUT, html);
console.log(OUT);
