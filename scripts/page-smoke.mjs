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
    // The width the headline's state slot has, when the harness gives it one.
    this._slotWidth = 0;
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
  /**
   * A layout small enough for the page's own fit check: the headline's state
   * slot has the width the harness gives it, and a text wants about as much
   * room as it has characters (a full-width one counts double).
   */
  get clientWidth() {
    return String(this.className).split(/\s+/).includes('state') ? this._slotWidth : 0;
  }
  get scrollWidth() {
    const units = [...this._text].reduce(
      (n, ch) => n + (/[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1),
      0,
    );
    return units * 7;
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
  live: { tps: GAUGE_TPS },
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
};

/** Run one built bundle in a fake frame and collect what it posts to its host. */
const runGuest = (bundle, href, { session = { id: SESSION, title: 'page smoke', busy: false, model: 'page-model' }, rate = RATE, locale = 'zh', serviceDenied = false, slotWidth = 0, pushAnswer = true } = {}) => {
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
  const timers = [];
  const answered = new Set();
  const win = {
    location,
    document,
    parent: {
      postMessage: (message) => {
        posted.push(message);
        // A host answers a request when it arrives, not only in one pass after
        // the handshake: a page that asks on its own tick has to be answered too.
        // Answered on the next turn of the event loop: the request has to finish
        // being posted before its answer can be delivered.
        if (message && message.type === 'service-request') setImmediate(() => answerRequest(message));
      },
    },
    addEventListener: (type, fn) => { listeners.push([type, fn]); },
    removeEventListener: () => {},
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
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
  const answerRequest = (request) => {
    if (!channel || answered.has(request.id)) return;
    answered.add(request.id);
    // A service the user has not allowed: the host answers the way its proxy
    // does, with a code rather than a body.
    if (serviceDenied) {
      dispatch({
        channel,
        v: version,
        type: 'result',
        id: request.id,
        ok: false,
        code: 'NO_SERVICE',
        error: 'The local service is not allowed for this extension',
      });
      return;
    }
    if (request.payload?.path === '/watch') {
      // `push` is what the service says about this host: whether it takes the
      // readings the service posts.
      reply(request, { status: 200, body: JSON.stringify({ ok: true, connection: 'live', sessionId: SESSION, push: pushAnswer }) });
    } else if (request.payload?.path?.startsWith('/rate')) {
      reply(request, { status: 200, body: JSON.stringify(rate) });
    }
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

  // The headline's state slot is as wide as the harness says it is: the page
  // measures it to decide whether a wording fits there or is read in full
  // below. Zero means the frame has no layout, and the page falls back to the
  // count of characters.
  if (slotWidth > 0) {
    const state = findByClass(root, 'state');
    if (state) state._slotWidth = slotWidth;
  }

  // `/watch` is accepted without an origin: that is what a relay surface has to
  // send. Anything posted before this point is answered here.
  for (const request of posted.filter((message) => message && message.type === 'service-request')) {
    answerRequest(request);
  }

  return {
    posted,
    rootEl: root,
    root: () => root.textContent,
    /** What the host does when the service posts a reading to the open frames. */
    push: (topic, data) => dispatch({ channel, v: version, type: 'service-event', payload: { topic, data } }),
    /** Take the page through the ticks its own timer loop would take. */
    tick: async (rounds = 1) => {
      for (let round = 0; round < rounds; round += 1) {
        const batch = timers.splice(0, timers.length);
        if (batch.length === 0) return;
        for (const fn of batch) fn();
        await settle();
      }
    },
  };
};

const settle = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** How many readings this page has asked the service for. */
const polls = (guest) => guest.posted.filter(
  (message) => message.type === 'service-request' && String(message.payload?.path ?? '').startsWith('/rate'),
).length;

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
  check(`${surface.name}: the watch names the session and the model it is on`,
    directBody?.sessionId === SESSION && directBody?.model === 'page-model', JSON.stringify(directBody));
  check(`${surface.name}: a watch carries no origin any more`, directBody !== null && !('origin' in directBody), JSON.stringify(directBody));
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
    `${surface.name}: a relay watch carries no origin either`,
    relayBody !== null && !('origin' in relayBody),
    JSON.stringify(relayBody),
  );
  check(`${surface.name}: the relay watch still names its session`, relayBody?.sessionId === SESSION, JSON.stringify(relayBody));
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
    tokensPerSecond: 38.2, source: 'tokens', tokens: 1260, activeMs: 33_000,
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

  // The section adjusts itself to what there is to show: the curve's band
  // closes when there is nothing to draw, a notice too long for the headline is
  // read in full there, and an idle number is named.
  {
    const idle = runGuest(surface.bundle, surface.url, {
      locale: 'en',
      rate: { ...RATE, gauge: null, cache: null, running: null, curve: [], lastTurn: null },
    });
    await settle();
    const idleDot = findByClass(idle.rootEl, 'dot');
    check(
      `${surface.name}: an idle section closes the curve's band`,
      String(findByClass(idle.rootEl, 'sparkrow').className).split(/\s+/).includes('tight'),
      idleDot && idleDot.className,
    );
    check(
      `${surface.name}: an idle dot is quiet, not lit`,
      String(idleDot.className).split(/\s+/).includes('idle'),
      idleDot.className,
    );
    check(
      `${surface.name}: a watched chat with no reply says so once`,
      findByClass(idle.rootEl, 'state').textContent === 'no reply yet',
      JSON.stringify(findByClass(idle.rootEl, 'state').textContent),
    );
    check(
      `${surface.name}: a chat that is reading a prompt is not called empty`,
      findByClass(busy.rootEl, 'state').textContent.includes('reading prompt')
        && !findByClass(busy.rootEl, 'state').textContent.includes('no reply yet'),
      JSON.stringify(findByClass(busy.rootEl, 'state').textContent),
    );

    const written = runGuest(surface.bundle, surface.url, {
      locale: 'en',
      rate: { ...RATE, gauge: null, cache: null, running: null, curve: [12, 14, 11], lastTurn: LAST_TURN },
    });
    await settle();
    check(
      `${surface.name}: a curve older than the window still keeps its band open`,
      !String(findByClass(written.rootEl, 'sparkrow').className).split(/\s+/).includes('tight'),
      findByClass(written.rootEl, 'sparkrow').className,
    );
    const writtenValue = findByClass(written.rootEl, 'value');
    check(
      `${surface.name}: a kept number is grey and named as the last reply's`,
      writtenValue.className.includes('stale')
        && findByClass(written.rootEl, 'cap').textContent === 'Last reply',
      `${writtenValue.className} / ${findByClass(written.rootEl, 'cap').textContent}`,
    );
    check(
      `${surface.name}: a running rate carries no such label`,
      String(findByClass(direct.rootEl, 'cap').hidden) === 'true',
      JSON.stringify(findByClass(direct.rootEl, 'cap').textContent),
    );

    const longError = runGuest(surface.bundle, surface.url, {
      locale: 'en',
      rate: { connection: 'error', error: 'Allow the local service in Settings → Extensions', errorKind: 'http', sessionId: null, busy: false, waiting: null, toolActive: false, live: { tps: 0 }, running: null, curve: [], turn: { active: false, ttftMs: null }, lastTurn: null, cache: null },
    });
    await settle();
    check(
      `${surface.name}: a long notice is read in full in the curve's spot`,
      findByClass(longError.rootEl, 'notice').textContent === 'Allow the local service in Settings → Extensions'
        && String(findByClass(longError.rootEl, 'notice').hidden) === 'false',
      JSON.stringify(findByClass(longError.rootEl, 'notice').textContent),
    );
    const longState = findByClass(longError.rootEl, 'state');
    check(
      `${surface.name}: the headline keeps a short state beside the number`,
      String(longState.hidden) === 'true' || longState.textContent.length <= 28,
      JSON.stringify(longState.textContent),
    );

    // What the service actually answers when a chat is quiet: all 24 buckets
    // present and zero, not an empty list. The band must still close.
    const quiet = runGuest(surface.bundle, surface.url, {
      locale: 'en',
      rate: { ...RATE, running: null, curve: new Array(24).fill(0), lastTurn: LAST_TURN },
    });
    await settle();
    check(
      `${surface.name}: a window of zero buckets closes the band`,
      String(findByClass(quiet.rootEl, 'sparkrow').className).split(/\s+/).includes('tight'),
      findByClass(quiet.rootEl, 'sparkrow').className,
    );

    // A notice read in the curve's spot and the band cannot both have it.
    const quietWithError = runGuest(surface.bundle, surface.url, {
      locale: 'en',
      rate: { ...RATE, connection: 'error', error: 'cannot reach the server stream', errorKind: 'http', running: null, curve: [12, 14, 11] },
    });
    await settle();
    check(
      `${surface.name}: a notice in the curve's spot closes the band`,
      String(findByClass(quietWithError.rootEl, 'sparkrow').className).split(/\s+/).includes('tight'),
      findByClass(quietWithError.rootEl, 'sparkrow').className,
    );

    // The common real failure: the user never allowed the local service, so
    // every request is refused. Its whole sentence has to be readable.
    const denied = runGuest(surface.bundle, surface.url, { locale: 'en', serviceDenied: true });
    await settle();
    const deniedNotice = findByClass(denied.rootEl, 'notice');
    const deniedState = findByClass(denied.rootEl, 'state');
    check(
      `${surface.name}: a refused service is said in full, not cut off`,
      deniedNotice !== null && deniedNotice.textContent === 'Allow the local service in Settings → Extensions'
        && String(deniedNotice.hidden) === 'false',
      JSON.stringify(deniedNotice && deniedNotice.textContent),
    );
    check(
      `${surface.name}: the long copy leaves the headline clear`,
      String(deniedState.hidden) === 'true' || deniedState.textContent.length <= 28,
      JSON.stringify(deniedState && deniedState.textContent),
    );
    check(
      `${surface.name}: a refused service also closes the band`,
      String(findByClass(denied.rootEl, 'sparkrow').className).split(/\s+/).includes('tight'),
      findByClass(denied.rootEl, 'sparkrow').className,
    );

    const compact = runGuest(surface.bundle, surface.url, {
      locale: 'en',
      rate: { ...RATE, gauge: { prompt: { kind: 'compaction', total: 1000, cache: 100, processed: 400, timeMs: 4000, observedAt: Date.now() } } },
    });
    await settle();
    check(
      `${surface.name}: a compaction read is named in the headline`,
      findByClass(compact.rootEl, 'state').textContent.startsWith('compacting 40%')
        && String(findByClass(compact.rootEl, 'sparkrow').className).split(/\s+/).includes('tight'),
      JSON.stringify(findByClass(compact.rootEl, 'state').textContent),
    );

    // A turn of several minutes is read as minutes, in the line and in the receipt.
    const longTurn = runGuest(surface.bundle, surface.url, {
      locale: 'en',
      rate: {
        ...RATE,
        running: null,
        turn: { active: false, ttftMs: null },
        lastTurn: { ...LAST_TURN, ttftMs: 61_000, split: { totalMs: 125_000, readMs: 0, waitMs: 5_000, writeMs: 120_000, toolMs: 0 } },
      },
    });
    await settle();
    const longLine = findLine(longTurn.rootEl, 'Last reply');
    check(
      `${surface.name}: a long reply reads as minutes`,
      longLine !== null && findByClass(longLine, 'v').textContent === '2m 5s · mostly writing'
        && findByClass(longLine, 'sub').textContent === '5.0s waiting · 2m writing'
        && longLine.textContent.includes('First word1m 1s'),
      JSON.stringify(longLine && longLine.textContent),
    );

    // The number names itself only when it is really the last reply's. A turn
    // that is running shows its own average, so it is not called the last
    // reply's.
    const pausedTurn = runGuest(surface.bundle, surface.url, {
      locale: 'en',
      rate: {
        ...RATE,
        busy: true,
        live: { ...RATE.live, tps: 0 },
        running: { tps: 38.6, source: 'estimate', tokens: 100, durationMs: 1000 },
        lastTurn: LAST_TURN,
      },
    });
    await settle();
    check(
      `${surface.name}: a running turn's number is not named as the last reply's`,
      String(findByClass(pausedTurn.rootEl, 'cap').hidden) === 'true'
        && findByClass(pausedTurn.rootEl, 'value').className.includes('stale'),
      `${findByClass(pausedTurn.rootEl, 'value').className} / ${findByClass(pausedTurn.rootEl, 'cap').textContent}`,
    );

    // The headline's slot is narrow: a wording that does not fit there whole
    // is read in full in the curve's spot instead of being cut off.
    const promptState = {
      ...RATE,
      busy: true,
      running: { tps: 38.6, source: 'estimate', tokens: 100, durationMs: 1000 },
      gauge: {
        mac: { pressure: 'normal', usedBytes: 34 * 1024 ** 3, totalBytes: 48 * 1024 ** 3, swapUsedBytes: 0, at: Date.now() },
        prompt: { kind: 'primary', total: 1000, cache: 100, processed: 400, timeMs: 4000, observedAt: Date.now() },
        render: null,
      },
    };
    const narrow = runGuest(surface.bundle, surface.url, { locale: 'en', slotWidth: 100, rate: promptState });
    await settle();
    check(
      `${surface.name}: a state that does not fit the headline is read in full below`,
      findByClass(narrow.rootEl, 'notice').textContent === 'reading prompt 40% · 6.0s left'
        && String(findByClass(narrow.rootEl, 'notice').hidden) === 'false'
        && findByClass(narrow.rootEl, 'state').textContent === '',
      JSON.stringify(findByClass(narrow.rootEl, 'notice').textContent),
    );
    const wide = runGuest(surface.bundle, surface.url, { locale: 'en', slotWidth: 300, rate: promptState });
    await settle();
    check(
      `${surface.name}: a state that fits the headline stays in the headline`,
      findByClass(wide.rootEl, 'state').textContent === 'reading prompt 40% · 6.0s left'
        && String(findByClass(wide.rootEl, 'notice').hidden) === 'true',
      JSON.stringify(findByClass(wide.rootEl, 'state').textContent),
    );
  }

  // The service sends readings; the page takes its own session's and ignores
  // another session's.
  //
  // What is read here is what the page writes verbatim — the cost, the cache
  // line, the dot — not the headline: that number glides from one reading to
  // the next through the frame loop, and this harness runs no frames.
  {
    const pushed = runGuest(surface.bundle, surface.url, { locale: 'en' });
    await settle();
    const asked = polls(pushed);
    const dot = findByClass(pushed.rootEl, 'dot');
    check(`${surface.name}: the page shows what it read first`, pushed.root().includes('42.5'), JSON.stringify(pushed.root()));
    check(`${surface.name}: an idle reading leaves the dot dark`, dot.className.includes('idle'), dot.className);
    pushed.push('rate', {
      session: SESSION,
      rate: {
        ...RATE,
        busy: true,
        live: { tps: 77.5 },
        running: { tps: 77.5, tokens: 10, durationMs: 1000 },
        cache: { ...RATE.cache, hitRate: 66.6, cost: 0.99 },
      },
    });
    await settle();
    check(
      `${surface.name}: a pushed reading is painted`,
      pushed.root().includes('$0.99') && pushed.root().includes('66.6') && dot.className.includes('live'),
      `${dot.className} ${JSON.stringify(pushed.root())}`,
    );
    check(`${surface.name}: and the page asked for nothing to get it`, polls(pushed) === asked, `polls=${polls(pushed)} after ${asked}`);
    pushed.push('rate', {
      session: 'ses_someother_chat',
      rate: { ...RATE, busy: false, live: { tps: 99.9 }, cache: { ...RATE.cache, hitRate: 11.1, cost: 5.55 } },
    });
    await settle();
    check(
      `${surface.name}: another session's push is not shown here`,
      !pushed.root().includes('$5.55') && !pushed.root().includes('11.1') && pushed.root().includes('$0.99'),
      JSON.stringify(pushed.root()),
    );
    pushed.push('something-else', { whatever: true });
    await settle();
    check(
      `${surface.name}: an unrelated topic leaves the reading alone`,
      pushed.root().includes('$0.99') && !pushed.root().includes('Cannot reach'),
      JSON.stringify(pushed.root()),
    );
  }

  // A reply of hours reads in hours, and one that mostly sat on a question or a
  // permission says whose time that was.
  {
    const turn = { tokensPerSecond: 40, source: 'tokens', tokens: 900, ttftMs: 500, hasReasoning: true, endedAt: Date.now() - 5_000 };
    const hours = runGuest(surface.bundle, surface.url, {
      locale: 'en',
      rate: { ...RATE, lastTurn: { ...turn, split: { totalMs: 20_460_000, readMs: 0, waitMs: 60_000, writeMs: 400_000, toolMs: 20_000_000 } } },
    });
    await settle();
    check(`${surface.name}: a reply of hours reads in hours`, hours.root().includes('5h 41m · mostly tools') && !hours.root().includes('341m'), JSON.stringify(hours.root()));
    const asked = runGuest(surface.bundle, surface.url, {
      locale: 'en',
      rate: { ...RATE, lastTurn: { ...turn, askMs: 3_600_000, split: { totalMs: 300_000, readMs: 0, waitMs: 60_000, writeMs: 200_000, toolMs: 40_000 } } },
    });
    await settle();
    check(`${surface.name}: a reply that mostly waited on the person says so`, asked.root().includes('1h 5m · mostly waiting on you') && asked.root().includes('1h waiting on you'), JSON.stringify(asked.root()));
    const brief = runGuest(surface.bundle, surface.url, {
      locale: 'en',
      rate: { ...RATE, lastTurn: { ...turn, askMs: 20_000, split: { totalMs: 300_000, readMs: 0, waitMs: 60_000, writeMs: 200_000, toolMs: 40_000 } } },
    });
    await settle();
    check(`${surface.name}: a short wait on the person stays out of the headline wording`, brief.root().includes('5m · mostly writing'), JSON.stringify(brief.root()));
  }

  // The service tells a page whether this host takes what it posts. Told no, the
  // page asks on every tick; told yes, a reading it has heard is not asked for
  // again while it is fresh.
  {
    const deaf = runGuest(surface.bundle, surface.url, { locale: 'en', pushAnswer: false });
    await settle();
    const askedBefore = polls(deaf);
    await deaf.tick(4);
    check(`${surface.name}: a host that takes no posts is asked on every tick`, polls(deaf) >= askedBefore + 3, `polls=${polls(deaf)} from ${askedBefore}`);

    const taken = runGuest(surface.bundle, surface.url, { locale: 'en' });
    await settle();
    taken.push('rate', { session: SESSION, rate: RATE });
    await settle();
    const takenBefore = polls(taken);
    await taken.tick(4);
    check(`${surface.name}: a host that takes them is not asked again`, polls(taken) === takenBefore, `polls=${polls(taken)} from ${takenBefore}`);
  }

  // A machine with no memory reading (any non-Mac) does not get a Memory line.
  {
    const offMac = runGuest(surface.bundle, surface.url, {
      locale: 'en',
      rate: {
        ...RATE,
        gauge: {
          macSupported: false,
          mac: { pressure: 'normal', usedBytes: 34 * 1024 ** 3, totalBytes: 48 * 1024 ** 3, swapUsedBytes: 0, at: Date.now() },
          prompt: null,
          render: null,
        },
      },
    });
    await settle();
    check(
      `${surface.name}: no memory line is drawn off a Mac`,
      findLine(offMac.rootEl, 'Memory') === null && !offMac.root().includes('Memory'),
      JSON.stringify(offMac.root()),
    );
    check(`${surface.name}: nothing waits for a memory number off a Mac`, !offMac.root().includes('34.0 / 48.0 GB'), JSON.stringify(offMac.root()));
    const onMac = runGuest(surface.bundle, surface.url, {
      locale: 'en',
      rate: {
        ...RATE,
        gauge: {
          macSupported: true,
          mac: { pressure: 'normal', usedBytes: 34 * 1024 ** 3, totalBytes: 48 * 1024 ** 3, swapUsedBytes: 0, at: Date.now() },
          prompt: null,
          render: null,
        },
      },
    });
    await settle();
    check(`${surface.name}: a Mac keeps its memory line`, String(findLine(onMac.rootEl, 'Memory')?.hidden) === 'false', JSON.stringify(onMac.root()));
  }

  // The approval that lets Gauge read sessions is a different problem from a
  // service that is not running, and says so.
  {
    const denied = runGuest(surface.bundle, surface.url, {
      locale: 'en',
      rate: { ...RATE, connection: 'error', error: null, errorKind: 'access', sessionId: null, busy: false, live: { tps: 0 }, running: null, curve: [], turn: { active: false, ttftMs: null }, lastTurn: null, cache: null, gauge: null },
    });
    await settle();
    check(
      `${surface.name}: a refused read names the permission, not the network`,
      denied.root().includes('Allow Gauge to read your sessions'),
      JSON.stringify(denied.root()),
    );
  }

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
