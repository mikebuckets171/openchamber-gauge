// Page smoke: run the built guest pages against a fake host frame, without a
// browser. The case that matters is the relay client: it mounts a guest as a
// self-contained `srcDoc`, so `window.location` is `about:srcdoc` and there is
// no http(s) origin to hand the service. The page must still ask for numbers
// instead of painting "cannot reach the server".
//
// Run: node scripts/page-smoke.mjs  (from the package root, after `bun run build`)
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SESSION = 'ses_page';
const NO_ORIGIN_COPY = [
  '当前页面连不上 OpenChamber 服务',
  'Cannot reach the OpenChamber server from this surface',
];

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`ok   ${name}`);
  else {
    failures += 1;
    console.log(`FAIL ${name} ${extra}`);
  }
};

// --- a DOM small enough for these two pages ----------------------------------
class Style {
  constructor() { this.props = {}; }
  setProperty(name, value) { this.props[name] = String(value); }
  removeProperty(name) { delete this.props[name]; }
  getPropertyValue(name) { return this.props[name] ?? ''; }
}

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.style = new Style();
    this.dataset = {};
    this.className = '';
    this._text = '';
    this.hidden = false;
    this.attrs = {};
  }
  append(...nodes) { for (const node of nodes) this.children.push(node); }
  appendChild(node) { this.children.push(node); return node; }
  insertBefore(node) { this.children.push(node); return node; }
  removeChild(node) { this.children = this.children.filter((c) => c !== node); return node; }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  getAttribute(key) { return this.attrs[key] ?? null; }
  hasAttribute(key) { return Object.hasOwn(this.attrs, key); }
  removeAttribute(key) { delete this.attrs[key]; }
  addEventListener() {}
  removeEventListener() {}
  querySelectorAll(selector) {
    const found = [];
    const walk = (el) => {
      for (const child of el.children) {
        if (!(child instanceof El)) continue;
        if (selector === 'dt' && child.tagName === 'DT') found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
  get scrollHeight() { return 0; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
}

class MessageEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.data = init.data;
    this.source = init.source;
    this.origin = init.origin ?? '';
  }
}

const TOKENS = {
  background: '#111', elevated: '#222', foreground: '#eee', muted: '#999',
  subtle: '#333', border: '#444', hover: '#3a3a3a', active: '#4a4a4a',
  selection: '#555', selectionForeground: '#fff', focus: '#6af',
  primary: '#6af', primaryForeground: '#000', primaryText: '#6af',
  successText: '#3c3', warningText: '#cc3', errorText: '#f66', infoText: '#6af',
  success: '#3c3', warning: '#cc3', error: '#f66', info: '#6af',
  font: 'system-ui', mono: 'monospace', radius: '9px',
};

/** The number a fixed page must paint once the fake host answers `/rate`. */
const LIVE_TPS = 42.5;
const RATE = {
  connection: 'live',
  error: null,
  errorKind: null,
  sessionId: SESSION,
  busy: false,
  waiting: null,
  toolActive: false,
  live: { tps: LIVE_TPS, spanMs: 1000, chars: 12, textChars: 12, reasoningChars: 0, toolChars: 0 },
  running: { tps: LIVE_TPS, tokens: 12, durationMs: 1000 },
  curve: [],
  curveStart: Date.now(),
  curveStep: 1250,
  curveAt: Date.now(),
  turn: { active: false, ttftMs: null },
  lastTurn: null,
  cache: {
    startedAt: Date.now() - 60_000,
    steps: 8,
    sessions: 2,
    hit: 19_200,
    miss: 3_800,
    hitRate: 83.5,
    write: 0,
    output: 110,
    reasoning: 0,
    cost: 0,
    last: {
      at: Date.now(),
      sessionId: SESSION,
      messageID: 'msg_page',
      hit: 1_600,
      miss: 100,
      hitRate: 94.1,
      delta: 1.2,
    },
    prevHitRate: 92.9,
  },
  eventsSeen: 0,
};

/** Run one built bundle in a fake frame and collect what it posts to its host. */
const runGuest = (bundle, href, { session = { id: SESSION, title: 'page smoke', busy: false }, rate = RATE } = {}) => {
  const source = fs.readFileSync(path.join(ROOT, bundle), 'utf8');
  const posted = [];
  const listeners = [];
  const root = new El('div');
  const documentElement = new El('html');
  const document = {
    documentElement,
    hidden: false,
    querySelector: (selector) => (selector === '#root' ? root : null),
    createElement: (tag) => new El(tag),
    createElementNS: (_ns, tag) => new El(tag),
    addEventListener: (type, fn) => { listeners.push([type, fn]); },
    removeEventListener: () => {},
  };
  const location = new URL(href);
  const win = {
    location,
    document,
    parent: { postMessage: (message) => posted.push(message) },
    addEventListener: (type, fn) => { listeners.push([type, fn]); },
    removeEventListener: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    performance: { now: () => Date.now() },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    navigator: { userAgent: 'node' },
  };
  win.window = win;
  win.self = win;

  const sandbox = {
    window: win,
    self: win,
    document,
    location,
    parent: win.parent,
    MessageEvent,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    URL,
    TextEncoder,
    TextDecoder,
    performance: win.performance,
    navigator: win.navigator,
    requestAnimationFrame: win.requestAnimationFrame,
    cancelAnimationFrame: win.cancelAnimationFrame,
    setTimeout: win.setTimeout,
    clearTimeout: win.clearTimeout,
    setInterval: win.setInterval,
    clearInterval: win.clearInterval,
    queueMicrotask,
    console,
    globalThis: win,
  };
  vm.createContext(sandbox);

  let channel = null;
  let version = null;
  const dispatch = (data) => {
    const event = new MessageEvent('message', { data, source: win.parent });
    for (const [type, fn] of listeners.slice()) {
      if (type === 'message') fn(event);
    }
  };
  const reply = (request, payload) => {
    dispatch({ channel, v: version, type: 'result', id: request.id, ok: true, payload });
  };

  vm.runInContext(source, sandbox, { filename: bundle });
  const hello = posted.find((message) => message && message.type === 'hello');
  if (!hello) throw new Error(`${bundle} never posted hello`);
  channel = hello.channel;
  version = hello.v;

  dispatch({
    channel,
    v: version,
    type: 'ready',
    payload: {
      session,
      surface: 'status',
      connection: { connected: true, account: null },
      settings: {},
      locale: 'zh',
      theme: { mode: 'dark', tokens: TOKENS },
    },
  });

  // Answer the page the way the host proxy would. `/watch` is accepted without
  // an origin: that is what a relay surface has to send.
  const requests = posted.filter((message) => message && message.type === 'service-request');
  for (const request of requests) {
    if (request.payload?.path === '/watch') {
      reply(request, { status: 200, body: JSON.stringify({ ok: true, changed: true, connection: 'live', sessionId: SESSION }) });
    } else if (request.payload?.path?.startsWith('/rate')) {
      reply(request, { status: 200, body: JSON.stringify(rate) });
    }
  }

  return { posted, rootEl: root, root: () => root.textContent };
};

const settle = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const findByClass = (node, className) => {
  if (String(node.className ?? '').split(/\s+/).includes(className)) return node;
  for (const child of node.children) {
    if (!(child instanceof El)) continue;
    const hit = findByClass(child, className);
    if (hit) return hit;
  }
  return null;
};

const widthOf = (node) => String(node?.style?.props?.width ?? node?.style?.width ?? '');

const findByText = (node, text) => {
  if (node.textContent === text) return node;
  for (const child of node.children) {
    if (!(child instanceof El)) continue;
    const hit = findByText(child, text);
    if (hit) return hit;
  }
  return null;
};

const SURFACES = [
  { name: 'status', bundle: 'status/main.js', url: 'http://127.0.0.1:28888/status/index.html' },
  { name: 'panel', bundle: 'panel/main.js', url: 'http://127.0.0.1:28888/panel/index.html' },
];

for (const surface of SURFACES) {
  // A normal browser surface knows its origin and keeps working as before.
  const direct = runGuest(surface.bundle, surface.url);
  await settle();
  const directWatch = direct.posted.find(
    (message) => message.type === 'service-request' && message.payload?.path === '/watch',
  );
  const directBody = directWatch ? JSON.parse(directWatch.payload.body) : null;
  check(`${surface.name}: an http page names its origin`, directBody?.origin === 'http://127.0.0.1:28888', JSON.stringify(directBody));
  check(`${surface.name}: an http page still shows the live number`, direct.root().includes(String(LIVE_TPS)), JSON.stringify(direct.root()));
  check(`${surface.name}: an http page never says it cannot reach the server`, !NO_ORIGIN_COPY.some((copy) => direct.root().includes(copy)), JSON.stringify(direct.root()));
  const settledValue = findByText(direct.rootEl, String(LIVE_TPS));
  check(
    `${surface.name}: an idle kept number is drawn stale, not live`,
    settledValue !== null && settledValue.className.includes('stale'),
    JSON.stringify(settledValue && settledValue.className),
  );

  // A relay surface: the host hands the page over as a srcDoc, so there is no
  // http(s) origin at all. This is the regression: the page used to stop here.
  const relay = runGuest(surface.bundle, 'about:srcdoc');
  await settle();
  const relayWatch = relay.posted.find(
    (message) => message.type === 'service-request' && message.payload?.path === '/watch',
  );
  const relayBody = relayWatch ? JSON.parse(relayWatch.payload.body) : null;
  check(`${surface.name}: a relay srcDoc still asks the service to watch`, relayWatch !== undefined);
  check(
    `${surface.name}: the origin-less watch carries no bogus origin`,
    relayBody !== null && relayBody.origin === undefined,
    JSON.stringify(relayBody),
  );
  check(`${surface.name}: the origin-less watch still names its session`, relayBody?.sessionId === SESSION, JSON.stringify(relayBody));
  check(
    `${surface.name}: a relay srcDoc still polls /rate`,
    relay.posted.some((message) => message.type === 'service-request' && message.payload?.path?.startsWith('/rate')),
  );
  check(`${surface.name}: a relay srcDoc shows the live number`, relay.root().includes(String(LIVE_TPS)), JSON.stringify(relay.root()));
  check(
    `${surface.name}: a relay srcDoc no longer says it cannot reach the server`,
    !NO_ORIGIN_COPY.some((copy) => relay.root().includes(copy)),
    JSON.stringify(relay.root()),
  );
  // The two cache hit rates: last settled step and the conversation total,
  // each drawn with a progress bar.
  check(
    `${surface.name}: the last-step hit rate is drawn`,
    direct.root().includes('94.1'),
    JSON.stringify(direct.root()),
  );
  check(
    `${surface.name}: the conversation hit rate is drawn`,
    direct.root().includes('83.5'),
    JSON.stringify(direct.root()),
  );
  const lastBar = findByClass(direct.rootEl, 'hitbar');
  const totalBars = [];
  const collectBars = (node) => {
    if (String(node.className ?? '').includes('hitbar')) totalBars.push(node);
    for (const child of node.children) if (child instanceof El) collectBars(child);
  };
  collectBars(direct.rootEl);
  check(
    `${surface.name}: both hit rates carry a progress bar`,
    lastBar !== null && totalBars.length === 2,
    `bars=${totalBars.length}`,
  );
  const widths = totalBars.map((bar) => widthOf(findByClass(bar, 'fill')));
  check(
    `${surface.name}: the bars fill to their percentages`,
    widths.some((w) => w.startsWith('94.1')) && widths.some((w) => w.startsWith('83.5')),
    JSON.stringify(widths),
  );
  check(
    `${surface.name}: the per-step rate says which step it is`,
    direct.root().includes('单步') && direct.root().includes('累计'),
    JSON.stringify(direct.root()),
  );

  const relayValue = findByText(relay.rootEl, String(LIVE_TPS));
  check(
    `${surface.name}: a relay srcDoc keeps the stale styling`,
    relayValue !== null && relayValue.className.includes('stale'),
    JSON.stringify(relayValue && relayValue.className),
  );

  // A provider that has not reported any cache yet: no bars, just dashes.
  // The empty tracks used to render as stray ``— [bar] —`` rows.
  const noCache = runGuest(surface.bundle, surface.url, { rate: { ...RATE, cache: null } });
  await settle();
  const barHidden = [];
  const collect = (node, hidden) => {
    const nextHidden = hidden || node.hidden === true;
    if (String(node.className ?? '').split(/\s+/).includes('hitbar')) barHidden.push(nextHidden);
    for (const child of node.children) if (child instanceof El) collect(child, nextHidden);
  };
  collect(noCache.rootEl, false);
  check(
    `${surface.name}: no cache data draws no bars`,
    barHidden.length > 0 && barHidden.every(Boolean),
    `bars=${barHidden.length} hidden=${JSON.stringify(barHidden)}`,
  );
  check(
    `${surface.name}: no cache data writes no percentage`,
    !noCache.root().includes('94.1') && !noCache.root().includes('83.5'),
    JSON.stringify(noCache.root()),
  );

  // The section is also mounted with no chat open: the watch must still go out,
  // naming no session, instead of being suppressed along with the origin.
  const bare = runGuest(surface.bundle, 'about:srcdoc', { session: null });
  await settle();
  const bareWatch = bare.posted.find(
    (message) => message.type === 'service-request' && message.payload?.path === '/watch',
  );
  check(
    `${surface.name}: a relay srcDoc with no session still watches`,
    bareWatch !== undefined && JSON.parse(bareWatch.payload.body).sessionId === null,
    bareWatch ? bareWatch.payload.body : '(no watch)',
  );
}

console.log(failures === 0 ? '\nALL PAGE SMOKE TESTS PASSED' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
