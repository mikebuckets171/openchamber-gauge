// Cache accounting tests: mock OpenChamber SSE stream + the built service.
//
// Covers the two hit rates the status/panel surfaces draw (last settled step
// and the conversation total, sub-sessions included), retry overwrites, steps
// that report no cache at all, zero-output tool steps that still carry cache,
// a child session discovered from the session tree API instead of its own
// `session.created`, the per-turn history snapshot, and a service restart
// reading the numbers back from disk.
//
// Run: node scripts/cache.mjs  (from the package root, after `bun run build`)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const ROOT = 'ses_cache_root';
const CHILD = 'ses_cache_child';
const GRAND = 'ses_cache_grand';
const OTHER = 'ses_cache_other';
const SERVICE_TOKEN = 'cache-test-token';
const STATE_FILE = path.join(os.tmpdir(), `gauge-cache-state-${process.pid}.json`);
fs.rmSync(STATE_FILE, { force: true });
const DATA_DIR = path.join(os.tmpdir(), `gauge-cache-data-${process.pid}`);
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(path.join(DATA_DIR, 'settings.json'), '{}');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`ok   ${name}`);
  else {
    failures += 1;
    console.log(`FAIL ${name} ${extra}`);
  };
};

// --- mock OpenChamber: global event stream + session lookup -----------------
const clients = new Set();
/** Parent links the server knows but did not announce in a `session.created`. */
const knownParents = new Map([[GRAND, CHILD], [CHILD, ROOT], [ROOT, null], [OTHER, null]]);
let sessionLookups = 0;
const sseServer = http.createServer((req, res) => {
  if (req.url === '/api/global/event') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  const lookup = /^\/api\/session\/([^/?]+)$/.exec(req.url ?? '');
  if (lookup) {
    sessionLookups += 1;
    const id = decodeURIComponent(lookup[1]);

    if (!knownParents.has(id)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id, parentID: knownParents.get(id) }));
    return;
  }
  res.writeHead(404).end();
});
await new Promise((resolve) => sseServer.listen(0, '127.0.0.1', resolve));
const sseOrigin = `http://127.0.0.1:${sseServer.address().port}`;

const emit = (type, data) => {
  const frame = `data: ${JSON.stringify({ id: 'e', created: Date.now(), type, data })}\n\n`;
  for (const client of clients) client.write(frame);
};
const stepStart = (sessionID, messageID) => emit('session.step.started', { sessionID, assistantMessageID: messageID });
const step = (sessionID, messageID, tokens, cost = 0) => emit('session.step.ended', {
  sessionID,
  assistantMessageID: messageID,
  tokens,
  cost,
});

// --- service lifecycle ------------------------------------------------------
let service = null;
let servicePort = 0;
const openPort = async () => {
  const holder = http.createServer((req, res) => res.end());
  await new Promise((resolve) => holder.listen(0, '127.0.0.1', resolve));
  const port = holder.address().port;
  await new Promise((resolve) => holder.close(resolve));
  return port;
};
const request = async (route) => {
  const response = await fetch(`http://127.0.0.1:${servicePort}${route}`, {
    headers: { Authorization: `Bearer ${SERVICE_TOKEN}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, 200);
  return response.json();
};
const watch = async (sessionId) => {
  const response = await fetch(`http://127.0.0.1:${servicePort}/watch`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SERVICE_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ origin: sseOrigin, sessionId }),
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, 200);
  return response.json();
};
const startService = async () => {
  service = spawn(process.execPath, ['service/main.js'], {
    env: {
      ...process.env,
      OPENCHAMBER_SERVICE_PORT: String(servicePort),
      OPENCHAMBER_SERVICE_TOKEN: SERVICE_TOKEN,
      OPENCHAMBER_GAUGE_STATE: STATE_FILE,
      OPENCHAMBER_DATA_DIR: DATA_DIR,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  service.stderr.on('data', (chunk) => process.stderr.write(`[service] ${chunk}`));
  let ready = false;
  for (let i = 0; i < 60 && !ready; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${servicePort}/health`, {
        headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
      });
      ready = response.ok;
    } catch { /* not up yet */ }
    if (!ready) await sleep(100);
  }
  check('service becomes ready', ready);
  if (!ready) throw new Error('service did not start');
};
const stopService = async () => {
  if (!service || service.exitCode !== null) return;
  const exited = once(service, 'exit');
  service.kill();
  const timer = setTimeout(() => service.kill('SIGKILL'), 2_000);
  await exited;
  clearTimeout(timer);
  service = null;
};
const until = async (condition) => {
  for (let i = 0; i < 80; i += 1) {
    try {
      const value = await condition();
      if (value) return value;
    } catch { /* keep polling */ }
    await sleep(100);
  }
  throw new Error('Timed out waiting for service state');
};

try {
  servicePort = await openPort();
  await startService();
  await watch(ROOT);
  await until(async () => (await request('/rate')).connection === 'live');

  // --- no cache data yet ---------------------------------------------------
  let rate = await request('/rate');
  check('cache is absent before any step settles', rate.cache === null, JSON.stringify(rate.cache));

  emit('session.execution.started', { sessionID: ROOT });
  stepStart(ROOT, 'msg_a');
  await sleep(40);
  step(ROOT, 'msg_a', { input: 1000, output: 50, reasoning: 0, cache: { read: 9000, write: 0 } }, 0.01);
  await until(async () => (await request('/rate')).cache !== null);
  rate = await request('/rate');
  check(
    'first settled step appears as the last-step rate',
    rate.cache.last?.hitRate === 90 && rate.cache.last?.miss === 1000 && rate.cache.last?.hit === 9000,
    JSON.stringify(rate.cache?.last),
  );
  check(
    'conversation total equals the first step',
    rate.cache.hitRate === 90 && rate.cache.hit === 9000 && rate.cache.miss === 1000 && rate.cache.steps === 1,
    JSON.stringify(rate.cache),
  );
  check('first step has no delta', rate.cache.last?.delta === null, JSON.stringify(rate.cache?.last));
  check('cost is summed from the event', rate.cache.cost === 0.01, JSON.stringify(rate.cache))
  check('only one session has contributed', rate.cache.sessions === 1, JSON.stringify(rate.cache));

  // --- second step: weighted total + delta ---------------------------------
  stepStart(ROOT, 'msg_b');
  await sleep(40);
  step(ROOT, 'msg_b', { input: 400, output: 60, reasoning: 0, cache: { read: 1600, write: 100 } });
  await until(async () => (await request('/rate')).cache.steps === 2);
  rate = await request('/rate');
  check(
    'cache write counts as a miss in the step rate',
    Math.abs(rate.cache.last.hitRate - (1600 / 2100) * 100) < 1e-6,
    JSON.stringify(rate.cache.last),
  );
  check(
    'conversation total weights the steps by prompt tokens',
    Math.abs(rate.cache.hitRate - (10600 / 12100) * 100) < 1e-6 && rate.cache.miss === 1500,
    JSON.stringify(rate.cache),
  );
  check(
    'delta reports the drop against the previous step',
    rate.cache.last.delta !== null && Math.abs(rate.cache.last.delta - (rate.cache.last.hitRate - 90)) < 1e-6,
    JSON.stringify(rate.cache.last),
  );

  // --- a retried step replaces its own numbers instead of adding again -----
  step(ROOT, 'msg_b', { input: 300, output: 60, reasoning: 0, cache: { read: 1700, write: 0 } });
  await until(async () => {
    const current = await request('/rate');
    return current.cache?.last?.hit === 1700;
  });
  rate = await request('/rate');
  check(
    'retried step is replaced, not double counted',
    rate.cache.steps === 2 && rate.cache.hit === 10700 && rate.cache.miss === 1300,
    JSON.stringify(rate.cache),
  );
  check(
    'a retry takes its old prompt split back out too',
    rate.cache.input === 1300 && rate.cache.write === 0 && rate.cache.output === 110,
    JSON.stringify(rate.cache),
  );

  // --- a tool-only step with zero output still carries cache ---------------
  stepStart(ROOT, 'msg_tool');
  await sleep(40);
  step(ROOT, 'msg_tool', { input: 2000, output: 0, reasoning: 0, cache: { read: 8000, write: 0 } });
  await until(async () => (await request('/rate')).cache.steps === 3);
  rate = await request('/rate');
  check(
    'zero-output step still counts its cache',
    rate.cache.hit === 18700 && rate.cache.miss === 3300 && rate.cache.output === 110,
    JSON.stringify(rate.cache),
  );

  // --- a provider that reports no cache ------------------------------------
  stepStart(ROOT, 'msg_nocache');
  await sleep(40);
  step(ROOT, 'msg_nocache', { input: 700, output: 20, reasoning: 0 });
  await until(async () => (await request('/rate')).cache.steps === 4);
  rate = await request('/rate');
  check(
    'a step without cache counts as a step but does not move the rates',
    rate.cache.steps === 4 && rate.cache.hit === 18700 && rate.cache.miss === 3300
      && Math.abs(rate.cache.hitRate - (18700 / 22000) * 100) < 1e-6,
    JSON.stringify(rate.cache),
  );

  // --- child session, announced by its own `session.created` ---------------
  emit('session.created', { sessionID: CHILD, parentID: ROOT });
  step(CHILD, 'msg_child', { input: 500, output: 30, reasoning: 0, cache: { read: 500, write: 0 } });
  await until(async () => (await request('/rate')).cache.sessions === 2);
  rate = await request('/rate');
  check(
    'a child session adds to the conversation total',
    rate.cache.hit === 19200 && rate.cache.miss === 3800 && rate.cache.sessions === 2,
    JSON.stringify(rate.cache),
  );
  check(
    'the last-step rate can come from a child session',
    rate.cache.last.hitRate === 50,
    JSON.stringify(rate.cache.last),
  );

  // --- grandchild discovered through the session tree API ------------------
  // No `session.created` is sent for it: the service must ask the server whose
  // child it is. The step that triggered the lookup is held and replayed, so
  // both steps count once the answer arrives.
  const lookupsBefore = sessionLookups;
  step(GRAND, 'msg_grand_a', { input: 100, output: 10, reasoning: 0, cache: { read: 900, write: 0 } });
  await until(async () => sessionLookups > lookupsBefore);
  await sleep(300);
  step(GRAND, 'msg_grand_b', { input: 100, output: 10, reasoning: 0, cache: { read: 900, write: 0 } });
  await until(async () => (await request('/rate')).cache.hit === 21000);
  rate = await request('/rate');
  check(
    'a grandchild found through the session tree is counted',
    rate.cache.hit === 21000 && rate.cache.sessions === 3 && rate.cache.steps === 7,
    JSON.stringify(rate.cache),
  );

  // --- unrelated sessions stay out -----------------------------------------
  emit('session.created', { sessionID: OTHER, parentID: null });
  step(OTHER, 'msg_other', { input: 10, output: 10, reasoning: 0, cache: { read: 90, write: 0 } });
  await sleep(300);
  rate = await request('/rate');
  check('an unrelated session is not counted', rate.cache.hit === 21000, JSON.stringify(rate.cache));

  // --- per-turn history snapshot ------------------------------------------
  emit('session.execution.succeeded', { sessionID: ROOT });
  await until(async () => (await request('/rate')).turn.active === false);
  let history = await request('/history');

  const lastTurn = history.turns.at(-1);
  check(
    'the finished turn stores its own cache totals',
    lastTurn?.cache?.hit === 21000 && lastTurn?.cache?.miss === 4000,
    JSON.stringify(lastTurn),
  );
  check(
    'history exposes the conversation aggregate',
    history.cache?.hit === 21000 && history.cache?.steps === 7,
    JSON.stringify(history.cache),
  );

  // --- restart keeps the numbers ------------------------------------------
  await sleep(2_100); // past the 1.5 s persistence debounce
  const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  check(
    'the state file carries the cache totals',
    saved.sessions?.[ROOT]?.cache?.hit === 21000 && saved.sessions?.[ROOT]?.cache?.steps === 7,
    JSON.stringify(saved.sessions?.[ROOT]?.cache),
  );
  await stopService();
  await startService();
  await watch(ROOT);
  await until(async () => (await request('/rate')).connection === 'live');
  rate = await request('/rate');
  check(
    'a restarted service answers the saved totals',
    rate.cache?.hit === 21000 && rate.cache?.miss === 4000 && rate.cache?.steps === 7
      && rate.cache?.last?.hitRate === 90,
    JSON.stringify(rate.cache),
  );
  check(
    'a restarted service answers the saved last-step delta',
    rate.cache?.last?.delta !== null,
    JSON.stringify(rate.cache?.last),
  );

  // --- the tree survives as long as the watched root does -----------------
  step(CHILD, 'msg_child_after_restart', { input: 200, output: 10, reasoning: 0, cache: { read: 800, write: 0 } });

  await until(async () => (await request('/rate')).cache.hit === 21800);
  rate = await request('/rate');
  check(
    'a known child keeps counting after a restart',
    rate.cache.hit === 21800 && rate.cache.steps === 8,
    JSON.stringify(rate.cache),
  );
  // --- background counting without a panel --------------------------------
  // `contributes.sessionEvents` wakes the service at the start of a turn even
  // when no page is open. The numbers must be there when the panel is opened
  // later, so a watch that arrives after the steps still sees them.
  const BG_ROOT = 'ses_cache_bg';
  await stopService();
  fs.rmSync(STATE_FILE, { force: true });
  fs.writeFileSync(
    path.join(DATA_DIR, 'settings.json'),
    JSON.stringify({ desktopLocalPort: sseServer.address().port }),
  );
  await startService();
  const postSessionEvent = (event) => fetch(`http://127.0.0.1:${servicePort}/session-events`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SERVICE_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ v: 1, requestId: `req-${Date.now()}`, event }),
    signal: AbortSignal.timeout(5_000),
  });
  let eventReply = await postSessionEvent({
    id: 'evt-turn', type: 'turn-started', at: Date.now(),
    session: { id: BG_ROOT, parentId: null },
    project: { directory: null },
    linked: [],
  });
  check('session-events: a turn start is accepted', eventReply.status === 200 && (await eventReply.json()).ok === true);
  eventReply = await postSessionEvent({
    id: 'evt-bad', type: 'not-a-real-event', at: Date.now(),
    session: { id: BG_ROOT, parentId: null },
    project: { directory: null },
    linked: [],
  });
  check('session-events: an unknown type is refused', eventReply.status === 400, `status=${eventReply.status}`);
  await until(async () => (await request('/rate')).connection === 'live');
  step(BG_ROOT, 'msg_bg', { input: 500, output: 20, reasoning: 0, cache: { read: 5000, write: 0 } });
  await until(async () => {
    const h = await request(`/history?sessionId=${encodeURIComponent(BG_ROOT)}`);
    return h.cache?.hit === 5000;
  });
  const bgHistory = await request(`/history?sessionId=${encodeURIComponent(BG_ROOT)}`);
  check(
    'session-events: steps are counted with no page watching',
    bgHistory.cache?.hit === 5000 && bgHistory.cache?.steps === 1,
    JSON.stringify(bgHistory.cache),
  );
  await watch(BG_ROOT);
  const bgRate = await request('/rate');
  check(
    'opening the panel later shows the background numbers',
    bgRate.cache?.hit === 5000 && bgRate.cache?.hitRate === (5000 / 5500) * 100,
    JSON.stringify(bgRate.cache),
  );
  await postSessionEvent({
    id: 'evt-turn-end', type: 'turn-finished', at: Date.now(),
    session: { id: BG_ROOT, parentId: null },
    project: { directory: null },
    linked: [],
  });
  // --- roots discovered from the stream itself ---------------------------
  // `service.keepRunning` starts the service with the host; its first SSE
  // `session.created` (no parent) is enough to know a conversation to count.
  const BG_STREAM = 'ses_cache_bg_stream';
  await stopService();
  fs.rmSync(STATE_FILE, { force: true });
  await startService();
  await until(async () => (await request('/rate')).connection === 'live');
  emit('session.created', { sessionID: BG_STREAM, parentID: null });
  step(BG_STREAM, 'msg_bg_stream', { input: 400, output: 10, reasoning: 0, cache: { read: 3600, write: 0 } });
  await until(async () => {
    const h = await request(`/history?sessionId=${encodeURIComponent(BG_STREAM)}`);
    return h.cache?.hit === 3600;
  });
  const streamHistory = await request(`/history?sessionId=${encodeURIComponent(BG_STREAM)}`);
  check(
    'a root announced on the stream is counted without session events',
    streamHistory.cache?.hit === 3600 && streamHistory.cache?.steps === 1,
    JSON.stringify(streamHistory.cache),
  );
} finally {
  await stopService();
  for (const client of clients) client.destroy();
  sseServer.closeAllConnections();
  await new Promise((resolve) => sseServer.close(resolve));
  fs.rmSync(STATE_FILE, { force: true });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL CACHE TESTS PASSED' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
