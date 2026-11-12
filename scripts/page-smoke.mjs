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
  addEventListener(type, fn) { (this.listeners ??= []).push([type, fn]); }
  removeEventListener() {}
  click() { for (const [type, fn] of this.listeners ?? []) if (type === 'click') fn({ type: 'click' }); }
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
  // Tall enough to tell an open line from a closed one: the page reports its
  // height from this, so a line that opens must make the frame taller.
  get scrollHeight() {
    let open = 0;
    const walk = (el) => {
      for (const child of el.children) {
        if (!(child instanceof El)) continue;
        if (String(child.className).split(/\s+/).includes('open')) open += 1;
        walk(child);
      }
    };
    walk(this);
    return 150 + open * 80;
  }
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
const GAUGE_TPS = 42.5;
const RATE = {
  connection: 'live',
  error: null,
  errorKind: null,
  sessionId: SESSION,
  busy: false,
  waiting: null,
  toolActive: false,
  live: { tps: GAUGE_TPS, spanMs: 1000, chars: 12, textChars: 12, reasoningChars: 0, toolChars: 0 },
  running: { tps: GAUGE_TPS, tokens: 12, durationMs: 1000 },
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
    cost: 0.4234,
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
const runGuest = (bundle, href, { session = { id: SESSION, title: 'page smoke', busy: false }, rate = RATE, locale = 'zh' } = {}) => {
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
      locale,
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

/** The line whose label is `text`: the line's root, with what is behind it. */
const findLine = (node, text) => {
  if (String(node.className ?? '').split(/\s+/).includes('row')) {
    const label = findByClass(node, 'k');
    if (label && label.textContent === text) return node;
  }
  for (const child of node.children) {
    if (!(child instanceof El)) continue;
    const hit = findLine(child, text);
    if (hit) return hit;
  }
  return null;
};

const collectByClass = (node, className, out = []) => {
  if (String(node.className ?? '').split(/\s+/).includes(className)) out.push(node);
  for (const child of node.children) if (child instanceof El) collectByClass(child, className, out);
  return out;
};

const isOpen = (line) => String(line.className ?? '').split(/\s+/).includes('open');

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
  check(`${surface.name}: an http page still shows the live number`, direct.root().includes(String(GAUGE_TPS)), JSON.stringify(direct.root()));
  check(`${surface.name}: an http page never says it cannot reach the server`, !NO_ORIGIN_COPY.some((copy) => direct.root().includes(copy)), JSON.stringify(direct.root()));
  const settledValue = findByText(direct.rootEl, String(GAUGE_TPS));
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
  check(`${surface.name}: a relay srcDoc shows the live number`, relay.root().includes(String(GAUGE_TPS)), JSON.stringify(relay.root()));
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
  // The cache rates live behind the model line, as two meters under their value.
  const modelLineZh = findLine(direct.rootEl, '模型');
  const cacheMeters = collectByClass(modelLineZh ?? direct.rootEl, 'meter');
  check(
    `${surface.name}: both hit rates carry a progress bar`,
    modelLineZh !== null && cacheMeters.length === 2,
    `bars=${cacheMeters.length}`,
  );
  const widths = cacheMeters.map((bar) => widthOf(findByClass(bar, 'fill')));
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

  const relayValue = findByText(relay.rootEl, String(GAUGE_TPS));
  check(
    `${surface.name}: a relay srcDoc keeps the stale styling`,
    relayValue !== null && relayValue.className.includes('stale'),
    JSON.stringify(relayValue && relayValue.className),
  );

  // A provider that has not reported any cache yet: empty tracks and a dash.
  const noCache = runGuest(surface.bundle, surface.url, { rate: { ...RATE, cache: null } });
  await settle();
  const emptyMeters = collectByClass(findLine(noCache.rootEl, '模型') ?? noCache.rootEl, 'meter');
  check(
    `${surface.name}: no cache data leaves the cache meters empty`,
    emptyMeters.length === 2 && emptyMeters.every((bar) => widthOf(findByClass(bar, 'fill')) === '0%'),
    `meters=${emptyMeters.length} widths=${JSON.stringify(emptyMeters.map((bar) => widthOf(findByClass(bar, 'fill'))))}`,
  );
  check(
    `${surface.name}: no cache data writes no percentage`,
    !noCache.root().includes('94.1') && !noCache.root().includes('83.5'),
    JSON.stringify(noCache.root()),
  );

  // The glance layout: three lines, always drawn, a dash for a missing reading.
  const plain = runGuest(surface.bundle, surface.url, { rate: { ...RATE, gauge: null, cache: null, lastTurn: null }, locale: 'en' });
  await settle();
  const plainLines = collectByClass(plain.rootEl, 'row');
  check(`${surface.name}: three lines are always drawn`, plainLines.length === 3, `lines=${plainLines.length}`);
  check(
    `${surface.name}: a missing reading is a dash on its line`,
    plainLines.length === 3 && plainLines.every((line) => findByClass(line, 'v').textContent === '—'),
    JSON.stringify(plainLines.map((line) => findByClass(line, 'v').textContent)),
  );
  check(
    `${surface.name}: no line is open until it is tapped`,
    plainLines.every((line) => !isOpen(line)),
    JSON.stringify(plainLines.map((line) => line.className)),
  );
  check(
    `${surface.name}: an idle section has an empty divider`,
    widthOf(findByClass(findByClass(plain.rootEl, 'rule'), 'fill')) === '0%',
  );

  // Tapping: a line opens, a second tap on another closes the first, and a tap
  // on the open one closes it. One line is open at a time.
  {
    const [reply, model, memory] = plainLines;
    findByClass(reply, 'line').click();
    check(`${surface.name}: a tap opens a line`, isOpen(reply) && !isOpen(model) && !isOpen(memory), reply.className);
    check(
      `${surface.name}: the open line says so to assistive tech`,
      findByClass(reply, 'line').getAttribute('aria-expanded') === 'true'
        && findByClass(model, 'line').getAttribute('aria-expanded') === 'false',
    );
    findByClass(memory, 'line').click();
    check(
      `${surface.name}: opening another line closes the first`,
      !isOpen(reply) && !isOpen(model) && isOpen(memory),
      JSON.stringify(plainLines.map((line) => line.className)),
    );
    findByClass(memory, 'line').click();
    check(`${surface.name}: a tap on the open line closes it`, plainLines.every((line) => !isOpen(line)));
    const heights = plain.posted.filter((message) => message && message.type === 'resize').map((message) => message.payload.height);
    check(
      `${surface.name}: the frame grows for an open line and shrinks back when it closes`,
      heights.length >= 3 && Math.max(...heights) > heights[0] && heights.at(-1) === heights[0],
      JSON.stringify(heights),
    );
  }

  // The receipt: a finished reply says how long it took and what most of that
  // was; behind the line, the slices add up to the whole bar.
  const SPLIT = { totalMs: 48_000, readMs: 0, waitMs: 6_000, writeMs: 33_000, toolMs: 9_000 };
  const LAST_TURN = {
    tokensPerSecond: 38.2, source: 'tokens', tokens: 1260, activeMs: 33_000, wallMs: 47_000,
    ttftMs: 6_100, hasReasoning: true, endedAt: Date.now() - 5_000, split: SPLIT,
  };
  const receipt = runGuest(surface.bundle, surface.url, { locale: 'en', rate: { ...RATE, running: null, lastTurn: LAST_TURN } });
  await settle();
  const replyLine = findLine(receipt.rootEl, 'Last reply');
  check(
    `${surface.name}: the reply line says how long and what most of it was`,
    replyLine !== null && findByClass(replyLine, 'v').textContent === '48s · mostly writing',
    JSON.stringify(replyLine && findByClass(replyLine, 'v').textContent),
  );
  check(
    `${surface.name}: the receipt names each slice that took time, and no reading for a cloud reply`,
    replyLine !== null && findByClass(replyLine, 'sub').textContent === '6.0s waiting · 33s writing · 9.0s tools',
    JSON.stringify(replyLine && findByClass(replyLine, 'sub').textContent),
  );
  const segWidths = collectByClass(replyLine ?? receipt.rootEl, 'seg').map(widthOf);
  check(
    `${surface.name}: the receipt bar's slices add up to the whole bar`,
    segWidths.length === 4 && Math.abs(segWidths.reduce((sum, w) => sum + Number.parseFloat(w), 0) - 100) < 0.01
      && segWidths[0] === '0%' && segWidths[2] === '68.75%',
    JSON.stringify(segWidths),
  );
  check(
    `${surface.name}: speed and first word sit behind the reply line`,
    replyLine !== null && replyLine.textContent.includes('38.2 tok/s · measured') && replyLine.textContent.includes('First word6.1s'),
    JSON.stringify(replyLine && replyLine.textContent),
  );
  check(`${surface.name}: the headline keeps the last reply's speed`, receipt.root().includes('38.2'), JSON.stringify(receipt.root()));

  const localReceipt = runGuest(surface.bundle, surface.url, {
    locale: 'en',
    rate: { ...RATE, running: null, lastTurn: { ...LAST_TURN, split: { totalMs: 48_000, readMs: 20_000, waitMs: 6_000, writeMs: 13_000, toolMs: 9_000 } } },
  });
  await settle();
  const localReply = findLine(localReceipt.rootEl, 'Last reply');
  check(
    `${surface.name}: a local reply has a reading slice`,
    localReply !== null && findByClass(localReply, 'v').textContent === '48s · mostly reading'
      && findByClass(localReply, 'sub').textContent.startsWith('20s reading'),
    JSON.stringify(localReply && localReply.textContent),
  );

  // A turn recorded by an older service has no receipt: its speed stands in,
  // and a split that does not add up is not drawn.
  for (const [name, split] of [['absent', undefined], ['broken', { ...SPLIT, waitMs: 60_000 }]]) {
    const old = runGuest(surface.bundle, surface.url, { locale: 'en', rate: { ...RATE, running: null, lastTurn: { ...LAST_TURN, split } } });
    await settle();
    const oldLine = findLine(old.rootEl, 'Last reply');
    check(
      `${surface.name}: an ${name} receipt falls back to the speed`,
      oldLine !== null && findByClass(oldLine, 'v').textContent === '38.2 tok/s'
        && collectByClass(oldLine, 'seg').every((seg) => widthOf(seg) === '0%'),
      JSON.stringify(oldLine && oldLine.textContent),
    );
  }

  const busy = runGuest(surface.bundle, surface.url, {
    locale: 'en',
    rate: {
      ...RATE,
      gauge: {
        mac: { pressure: 'warning', usedBytes: 34 * 1024 ** 3, totalBytes: 48 * 1024 ** 3, swapUsedBytes: 5 * 1024 ** 3, at: Date.now() },
        prompt: { kind: 'primary', total: 1000, cache: 100, processed: 400, timeMs: 4000, observedAt: Date.now() },
        render: { state: 'running', startedAt: Date.now() - 30_000, queued: 0, step: { value: 8, max: 20, at: Date.now() } },
        model: { name: 'Qwen3.8-Flash-Next-GSQ-RCO', quant: 'IQ3_XXS', id: 'ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF:IQ3_XXS', at: Date.now() },
      },
    },
  });
  await settle();
  check(
    `${surface.name}: a prompt being read is said in the headline, ahead of a render`,
    findByClass(busy.rootEl, 'state').textContent === 'reading prompt 40% · 6.0s left',
    JSON.stringify(findByClass(busy.rootEl, 'state').textContent),
  );
  check(
    `${surface.name}: the divider fills to the prompt's percentage`,
    widthOf(findByClass(findByClass(busy.rootEl, 'rule'), 'fill')) === '40%',
    widthOf(findByClass(findByClass(busy.rootEl, 'rule'), 'fill')),
  );
  check(`${surface.name}: a job adds no line`, collectByClass(busy.rootEl, 'row').length === 3);
  const memoryLine = findLine(busy.rootEl, 'Memory');
  check(
    `${surface.name}: the memory line shows the Mac's memory`,
    memoryLine !== null && findByClass(memoryLine, 'v').textContent === '34.0 / 48.0 GB',
    JSON.stringify(memoryLine && memoryLine.textContent),
  );
  check(
    `${surface.name}: a kernel warning shows on the closed memory line`,
    memoryLine !== null && memoryLine.className.split(/\s+/).includes('warning'),
    JSON.stringify(memoryLine && memoryLine.className),
  );
  check(
    `${surface.name}: swap and pressure sit behind the memory line`,
    memoryLine !== null && memoryLine.textContent.includes('Swap5.0 GB') && memoryLine.textContent.includes('Pressurewarning'),
    JSON.stringify(memoryLine && memoryLine.textContent),
  );
  {
    findByClass(memoryLine, 'line').click();
    check(
      `${surface.name}: an open line keeps its warning`,
      isOpen(memoryLine) && memoryLine.className.split(/\s+/).includes('warning'),
      memoryLine.className,
    );
  }
  const modelLine = findLine(busy.rootEl, 'Model');
  check(
    `${surface.name}: the model line names the model the engine holds`,
    modelLine !== null && findByClass(modelLine, 'v').textContent === 'Qwen3.8-Flash-Next-GSQ-RCO · IQ3_XXS · $0.42',
    JSON.stringify(modelLine && findByClass(modelLine, 'v').textContent),
  );
  check(
    `${surface.name}: the full model identifier is behind the line, and on the hover`,
    modelLine !== null && findByClass(modelLine, 'id').textContent === 'ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF:IQ3_XXS'
      && modelLine.getAttribute('title') === 'ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF:IQ3_XXS',
    JSON.stringify(modelLine && modelLine.getAttribute('title')),
  );

  // A cloud chat: the model in play is the cloud one, with what it has cost,
  // and the local engine's reading waits behind the line. The line itself
  // must never name the local model as the one the chat is on.
  const cloud = runGuest(surface.bundle, surface.url, {
    locale: 'en',
    rate: {
      ...RATE,
      gauge: {
        mac: null,
        prompt: null,
        render: null,
        model: { name: 'Qwen3.8-Flash-Next-GSQ-RCO', quant: 'IQ3_XXS', id: 'ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF:IQ3_XXS', at: Date.now() },
        chatModel: { id: 'MiniMax-M3.1-Flash', name: 'MiniMax-M3.1-Flash' },
      },
    },
  });
  await settle();
  const cloudLine = findLine(cloud.rootEl, 'Model');
  check(
    `${surface.name}: a cloud chat names the cloud model and its cost`,
    cloudLine !== null && findByClass(cloudLine, 'v').textContent === 'MiniMax-M3.1-Flash · $0.42',
    JSON.stringify(cloudLine && findByClass(cloudLine, 'v').textContent),
  );
  check(
    `${surface.name}: the cost has its own entry behind the line`,
    cloudLine !== null && cloudLine.textContent.includes('Cost this chat$0.42'),
    JSON.stringify(cloudLine && cloudLine.textContent),
  );
  check(
    `${surface.name}: the local engine's reading is behind the line, a tap away`,
    cloudLine !== null && cloudLine.textContent.includes('Engine holdsQwen3.8-Flash-Next-GSQ-RCO · IQ3_XXS')
      && String(cloudLine.getAttribute('title') ?? '').includes('Engine holds Qwen3.8-Flash-Next-GSQ-RCO · IQ3_XXS'),
    JSON.stringify(cloudLine && cloudLine.textContent),
  );
  check(
    `${surface.name}: a cloud chat's identifier is its own, not the engine's`,
    cloudLine !== null && findByClass(cloudLine, 'id').textContent === 'MiniMax-M3.1-Flash',
    JSON.stringify(cloudLine && findByClass(cloudLine, 'id').textContent),
  );

  // A local chat: the model in play is the one the engine holds, so its
  // quantization belongs to the name. A chat that cost nothing shows no cost.
  const local = runGuest(surface.bundle, surface.url, {
    locale: 'en',
    rate: {
      ...RATE,
      cache: { ...RATE.cache, cost: 0 },
      gauge: {
        mac: null,
        prompt: null,
        render: null,
        model: { name: 'Qwen3.8-Flash-Next-GSQ-RCO', quant: 'IQ3_XXS', id: 'ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF:IQ3_XXS', at: Date.now() },
        chatModel: { id: 'ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF', name: 'Qwen3.8-Flash-Next-GSQ-RCO' },
      },
    },
  });
  await settle();
  const localLine = findLine(local.rootEl, 'Model');
  check(
    `${surface.name}: a local chat names the model with its quantization and no cost`,
    localLine !== null && findByClass(localLine, 'v').textContent === 'Qwen3.8-Flash-Next-GSQ-RCO · IQ3_XXS'
      && localLine.textContent.includes('Cost this chat—')
      && localLine.textContent.includes('Engine holdsthis model · IQ3_XXS'),
    JSON.stringify(localLine && localLine.textContent),
  );

  // The page tells the service which model the chat is on. The service needs
  // it to say which model is in play, which is not the model the engine holds.
  const withModel = runGuest(surface.bundle, surface.url, {
    locale: 'en',
    session: { id: SESSION, title: 'page smoke', busy: false, model: 'MiniMax-M3.1-Flash' },
  });
  await settle();
  const watchBody = withModel.posted
    .filter((message) => message && message.type === 'service-request' && message.payload?.path === '/watch')
    .map((message) => {
      try {
        return JSON.parse(message.payload.body);
      } catch {
        return null;
      }
    })
    .find(Boolean);
  check(
    `${surface.name}: the watch carries the chat's model`,
    watchBody && watchBody.model === 'MiniMax-M3.1-Flash',
    JSON.stringify(watchBody),
  );

  const rendering = runGuest(surface.bundle, surface.url, {
    locale: 'en',
    rate: {
      ...RATE,
      gauge: {
        mac: null,
        prompt: null,
        render: { state: 'running', startedAt: Date.now() - 30_000, queued: 1, step: { value: 8, max: 20, at: Date.now() } },
      },
    },
  });
  await settle();
  const renderingState = findByClass(rendering.rootEl, 'state').textContent;
  check(
    `${surface.name}: a render says its step and the queue in the headline`,
    renderingState.startsWith('render 8 / 20 · ') && renderingState.endsWith(' · 1 queued'),
    JSON.stringify(renderingState),
  );
  check(
    `${surface.name}: the divider fills to the render's step`,
    widthOf(findByClass(findByClass(rendering.rootEl, 'rule'), 'fill')) === '40%',
  );
  const toolAndRender = runGuest(surface.bundle, surface.url, {
    locale: 'en',
    rate: {
      ...RATE,
      busy: true,
      toolActive: true,
      gauge: { mac: null, prompt: null, render: { state: 'running', startedAt: null, queued: 0, step: null } },
    },
  });
  await settle();
  check(
    `${surface.name}: the chat's own state outranks a render`,
    findByClass(toolAndRender.rootEl, 'state').textContent === 'running tool',
    JSON.stringify(findByClass(toolAndRender.rootEl, 'state').textContent),
  );

  // A page with no chat of its own must never show the prompt a *watched* chat
  // is reading. When the service answers for a session some other page watched,
  // the gauge readings belong to that session and are blanked with the rest.
  const noSession = runGuest(surface.bundle, surface.url, {
    session: null,
    locale: 'en',
    rate: {
      ...RATE,
      lastTurn: LAST_TURN,
      gauge: {
        mac: { pressure: 'normal', usedBytes: 34 * 1024 ** 3, totalBytes: 48 * 1024 ** 3, swapUsedBytes: 0, at: Date.now() },
        prompt: { kind: 'primary', total: 1000, cache: 100, processed: 400, timeMs: 4000, observedAt: Date.now() },
        render: null,
      },
    },
  });
  await settle();
  const noSessionText = noSession.root();
  check(
    `${surface.name}: a page with no session never shows another chat's readings`,
    !noSessionText.includes('40%') && !noSessionText.includes('reading prompt')
      && !noSessionText.includes('48s') && !noSessionText.includes('$0.42'),
    JSON.stringify(noSessionText),
  );
  check(
    `${surface.name}: a page with no session leaves the divider empty`,
    widthOf(findByClass(findByClass(noSession.rootEl, 'rule'), 'fill')) === '0%',
  );

  // English is the page's own language until the host says otherwise.
  check(
    `${surface.name}: the page markup declares English and no leftover font`,
    /<html lang="en">/.test(fs.readFileSync(path.join(ROOT, 'status/index.html'), 'utf8'))
      && !fs.readFileSync(path.join(ROOT, 'status/index.html'), 'utf8').includes('YaHei'),
  );
  check(
    `${surface.name}: motion is switched off for a reader who asked for less`,
    /prefers-reduced-motion: reduce/.test(fs.readFileSync(path.join(ROOT, 'status/index.html'), 'utf8')),
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
