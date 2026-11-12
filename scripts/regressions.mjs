// Plumbing regressions for 1.0: who the service may talk to, where it keeps its
// numbers, and what it does when the connection wobbles.
//
// Run: node scripts/regressions.mjs  (from the package root, after `bun run build`)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path'
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const TOKEN = 'regression-token';
const LEGACY_SESSION = 'ses_legacy_state';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gauge-regressions-'));
const servers = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`ok   ${name}`);
  else {
    failures += 1;
    console.log(`FAIL ${name} ${extra}`);
  }
};
/** Every service this script starts, so a failure cannot leave one running. */
const started = [];
process.on('exit', () => { for (const child of started) try { child.kill(); } catch { /* already gone */ } });

const listen = async (handler) => {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port, origin: `http://127.0.0.1:${server.address().port}` };
};

/** A feed that answers as the approved connection does, and remembers each dial. */
const makeFeed = async () => {
  const clients = new Set();
  const dials = [];
  const state = { refuse: null };
  const server = await listen((req, res) => {
    const url = (req.url ?? '').split('?')[0];
    if (url !== '/api/event') {
      res.writeHead(404).end();
      return;
    }
    dials.push({ at: Date.now(), authorization: req.headers.authorization ?? null, types: (req.url ?? '').includes('types=') });
    if (state.refuse !== null) {
      res.writeHead(state.refuse, { 'Content-Type': 'application/json' }).end('{"error":{"message":"no"}}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    clients.add(res);
    req.on('close', () => clients.delete(res));
  });
  return {
    ...server,
    dials,
    clients,
    refuse: (status) => { state.refuse = status; },
    allow: () => { state.refuse = null; },
    cut: () => { for (const res of clients) res.destroy(); clients.clear(); },
    emit: (type, data) => {
      const frame = `data: ${JSON.stringify({ id: 'e', created: Date.now(), type, data })}\n\n`;
      for (const res of clients) res.write(frame);
    },
  };
};

/** A stand-in for OpenChamber's callback listener: what `emit` posts to. */
const makeCallback = async (status = 200) => {
  const calls = [];
  const server = await listen((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (req.url !== '/service/call') { res.writeHead(404).end(); return; }
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* not a call */ }
      calls.push(parsed);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status === 200 ? { result: { delivered: true } } : { error: { code: 'TOO_MANY_EVENTS', message: 'no' } }));
    });
  });
  return { ...server, calls, emits: () => calls.filter((call) => call?.method === 'panels.emit') };
};

const startService = async ({ port, dataDir, stateFile, feedUrl, callbackUrl, env = {} }) => {
  const child = spawn(process.execPath, ['service/main.js'], {
    env: {
      ...process.env,
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      OPENCHAMBER_SERVICE_PORT: String(port),
      OPENCHAMBER_SERVICE_TOKEN: TOKEN,
      ...(dataDir ? { OPENCHAMBER_SERVICE_DATA_DIR: dataDir } : {}),
      ...(stateFile ? { OPENCHAMBER_GAUGE_STATE: stateFile } : {}),
      ...(feedUrl ? { OPENCHAMBER_OPENCODE_URL: feedUrl } : {}),
      ...(callbackUrl ? { OPENCHAMBER_HOST_CALLBACK_URL: callbackUrl } : {}),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  started.push(child);
  child.stderr.on('data', (chunk) => process.stderr.write(`[service] ${chunk}`));
  const call = (route, init) => fetch(`http://127.0.0.1:${port}${route}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(5_000),
  });
  let ready = false;
  for (let i = 0; i < 50 && !ready; i += 1) {
    try { ready = (await call('/health')).ok; } catch { /* not up yet */ }
    if (!ready) await sleep(100);
  }
  check(`service starts (port ${port})`, ready);
  const rate = async (sessionId) => (await (await call(sessionId ? `/rate?sessionId=${encodeURIComponent(sessionId)}` : '/rate')).json());
  const watch = async (body) => {
    const response = await call('/watch', { method: 'POST', body: JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const stop = async () => { child.kill(); await once(child, 'exit'); };
  /** The stream must be attached before events are worth sending. */
  const live = async () => {
    for (let i = 0; i < 60; i += 1) {
      if ((await rate(null)).connection === 'live') return true;
      await sleep(100);
    }
    return false;
  };
  return { call, rate, watch, stop, live };
};

// Ask the OS for a free port rather than guessing one: a run that was cut off
// must not collide with the service it left behind.
const freePort = async () => {
  const holder = http.createServer((req, res) => res.writeHead(200).end());
  await new Promise((resolve) => holder.listen(0, '127.0.0.1', resolve));
  const taken = holder.address().port;
  await new Promise((resolve) => holder.close(resolve));
  return taken;
};

// --- the numbers land in the folder OpenChamber keeps for this extension -----
// Before 1.0 the service wrote beside itself, inside the installed package: a
// write there can make the host reload the extension, and removing the extension
// left the numbers behind.
{
  const feed = await makeFeed();
  const dataDir = path.join(root, 'service-data');
  const insidePackage = path.join('service', '.gauge-state.json');
  const fallback = path.join(os.tmpdir(), 'openchamber-gauge-state.json');
  fs.rmSync(insidePackage, { force: true });
  fs.rmSync(fallback, { force: true });
  const svc = await startService({ port: await freePort(), dataDir, feedUrl: feed.origin });
  await svc.watch({ sessionId: 'ses_in_data_dir' });
  check('the stream attaches before anything is measured', await svc.live());
  feed.emit('session.execution.started', { sessionID: 'ses_in_data_dir' });
  feed.emit('session.step.started', { sessionID: 'ses_in_data_dir', assistantMessageID: 'msg1' });
  feed.emit('session.text.delta', { sessionID: 'ses_in_data_dir', assistantMessageID: 'msg1', ordinal: 0, delta: 'x'.repeat(120) });
  await sleep(200); // a reply that begins and ends in the same millisecond measures nothing
  feed.emit('session.step.ended', {
    sessionID: 'ses_in_data_dir', assistantMessageID: 'msg1',
    tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 100, write: 0 } }, cost: 0,
  });
  feed.emit('session.execution.succeeded', { sessionID: 'ses_in_data_dir' });
  await sleep(2_200); // past the persistence debounce
  const saved = path.join(dataDir, 'state.json');
  check('the service writes in its own data dir', fs.existsSync(saved), saved);
  const payload = fs.existsSync(saved) ? JSON.parse(fs.readFileSync(saved, 'utf8')) : null;
  check('and the numbers it wrote are the ones it measured',
    payload?.sessions?.ses_in_data_dir?.lastTurn?.tokens === 20,
    JSON.stringify(payload?.sessions?.ses_in_data_dir?.lastTurn));
  check('nothing is written inside the package', !fs.existsSync(insidePackage) && !fs.existsSync(`${insidePackage}.tmp`));
  check('and it did not fall back to the temp file', !fs.existsSync(fallback));
  await svc.stop();
  feed.cut();
  feed.server.close();
}

// --- the file 0.x wrote beside the service is read once, then gone ----------
// Michael's install has one; the calibration factors and last turns in it are
// worth keeping, and keeping them must not leave a stale copy behind.
{
  const feed = await makeFeed();
  const dataDir = path.join(root, 'legacy-data');
  const legacy = path.join('service', '.gauge-state.json');
  const endedAt = Date.now() - 60_000;
  fs.writeFileSync(legacy, JSON.stringify({
    version: 1,
    savedAt: endedAt,
    models: { 'legacy-model': 1.08 },
    sessions: {
      [LEGACY_SESSION]: {
        lastTurn: { tokensPerSecond: 40, source: 'tokens', tokens: 80, activeMs: 2_000, wallMs: 4_000, ttftMs: 300, hasReasoning: false, endedAt },
        cache: { startedAt: endedAt, steps: 2, sessions: [LEGACY_SESSION], hit: 100, miss: 10, write: 0, input: 10, output: 80, reasoning: 0, cost: 0, last: null, prevHitRate: null, turnBase: null },
        turns: [{ tps: 40, at: endedAt }],
      },
    },
  }));
  const svc = await startService({ port: await freePort(), dataDir, feedUrl: feed.origin });
  await svc.watch({ sessionId: LEGACY_SESSION });
  check('a service reading a legacy file still attaches', await svc.live());
  const cold = await svc.rate(LEGACY_SESSION);
  check('a pre-1.0 state file is read', cold.lastTurn?.tokensPerSecond === 40, JSON.stringify(cold.lastTurn));
  feed.emit('session.execution.started', { sessionID: LEGACY_SESSION });
  feed.emit('session.step.started', { sessionID: LEGACY_SESSION, assistantMessageID: 'msg2' });
  feed.emit('session.text.delta', { sessionID: LEGACY_SESSION, assistantMessageID: 'msg2', ordinal: 0, delta: 'x'.repeat(80) });
  await sleep(200);
  feed.emit('session.step.ended', {
    sessionID: LEGACY_SESSION, assistantMessageID: 'msg2',
    tokens: { input: 5, output: 10, reasoning: 0, cache: { read: 50, write: 0 } }, cost: 0,
  });
  feed.emit('session.execution.succeeded', { sessionID: LEGACY_SESSION });
  await sleep(2_200);
  check('the migrated numbers are written in the new place', fs.existsSync(path.join(dataDir, 'state.json')));
  check('the copy inside the package is removed once it is safe', !fs.existsSync(legacy));
  const warm = await svc.rate(LEGACY_SESSION);
  check('the migrated cache keeps counting', warm.cache?.hit === 150, JSON.stringify(warm.cache));
  await svc.stop();
  feed.cut();
  feed.server.close();
  fs.rmSync(legacy, { force: true });
}

// --- no borrowed key, no port scanning --------------------------------------
// 0.x read OpenChamber's own settings to find a port and a token. The service may
// now talk to one address, with the credential OpenChamber gave it.
{
  const feed = await makeFeed();
  const snoopedHits = [];
  const snooped = await listen((req, res) => { snoopedHits.push({ url: req.url, authorization: req.headers.authorization ?? null }); res.writeHead(200).end(); });
  const openChamberDir = path.join(root, 'openchamber-settings');
  fs.mkdirSync(openChamberDir, { recursive: true });
  fs.writeFileSync(path.join(openChamberDir, 'settings.json'), JSON.stringify({
    desktopLocalPort: snooped.port,
    desktopLocalClientToken: 'a borrowed client token',
    uiPassword: 'a UI password',
  }));
  const svc = await startService({
    port: await freePort(),
    dataDir: path.join(root, 'no-borrow-data'),
    feedUrl: feed.origin,
    env: { OPENCHAMBER_DATA_DIR: openChamberDir },
  });
  await svc.watch({ sessionId: 'ses_no_borrow' });
  await sleep(800);
  const answered = await svc.rate('ses_no_borrow');
  check('the approved feed is used', answered.connection === 'live', JSON.stringify({ connection: answered.connection, error: answered.error }));
  check('nothing on the port named in OpenChamber settings was dialled', snoopedHits.length === 0, JSON.stringify(snoopedHits.slice(0, 2)));
  check('every dial carries only the service token',
    feed.dials.length > 0 && feed.dials.every((dial) => dial.authorization === `Bearer ${TOKEN}`),
    JSON.stringify(feed.dials.slice(0, 2)));
  await svc.stop();
  feed.cut();
  feed.server.close();
  snooped.server.close();
}

// --- a refused feed backs off, and the panel stays alive ---------------------
{
  const feed = await makeFeed();
  feed.refuse(503);
  const svc = await startService({ port: await freePort(), dataDir: path.join(root, 'backoff-data'), feedUrl: feed.origin });
  await sleep(3_000);
  const attempts = feed.dials.length;
  check('a refused feed is retried', attempts >= 2, `dials=${attempts}`);
  check('and retried slowly, not hammered', attempts <= 5, `dials=${attempts}`);
  const answering = await svc.call('/health');
  check('the service itself stays reachable while the feed is down', answering.ok);
  const rate = await svc.rate(null);
  check('a refused feed is reported as an HTTP failure', rate.connection === 'error' && rate.errorKind === 'http', JSON.stringify({ connection: rate.connection, errorKind: rate.errorKind }));
  feed.allow();
  let live = null;
  for (let i = 0; i < 60 && live?.connection !== 'live'; i += 1) {
    await sleep(100);
    live = await svc.rate(null);
  }
  check('it reconnects on its own once the feed answers', live?.connection === 'live', JSON.stringify({ connection: live?.connection, error: live?.error }));
  await svc.stop();
  feed.cut();
  feed.server.close();
}

// --- a gap long enough to have missed the end of a turn clears it ------------
// Without this, a section that was asleep while a reply finished would keep
// showing "writing" forever.
{
  const feed = await makeFeed();
  const svc = await startService({ port: await freePort(), dataDir: path.join(root, 'gap-data'), feedUrl: feed.origin });
  await svc.watch({ sessionId: 'ses_gap' });
  feed.emit('session.execution.started', { sessionID: 'ses_gap' });
  feed.emit('session.step.started', { sessionID: 'ses_gap', assistantMessageID: 'msgGap' });
  feed.emit('session.text.delta', { sessionID: 'ses_gap', assistantMessageID: 'msgGap', ordinal: 0, delta: 'a'.repeat(400) });
  await sleep(300);
  const midTurn = await svc.rate('ses_gap');
  check('the turn is live before the outage', midTurn.busy === true && midTurn.turn.active === true, JSON.stringify({ busy: midTurn.busy, turn: midTurn.turn }));
  feed.cut();
  feed.refuse(503);
  await sleep(16_500); // past the gap that may have carried a turn's closing events
  feed.allow();
  let after = null;
  // The backoff had grown during the outage, so reconnecting takes its time.
  for (let i = 0; i < 220 && after?.connection !== 'live'; i += 1) {
    await sleep(100);
    after = await svc.rate('ses_gap');
  }
  check('after a long outage the stream is live again', after?.connection === 'live', JSON.stringify({ connection: after?.connection }));
  check('and a turn that may have ended unseen is not held open',
    after?.busy === false && after?.turn?.active === false,
    JSON.stringify({ busy: after?.busy, turn: after?.turn }));
  // The next turn measures normally.
  feed.emit('session.execution.started', { sessionID: 'ses_gap' });
  feed.emit('session.step.started', { sessionID: 'ses_gap', assistantMessageID: 'msgAfter' });
  feed.emit('session.text.delta', { sessionID: 'ses_gap', assistantMessageID: 'msgAfter', ordinal: 0, delta: 'b'.repeat(400) });
  await sleep(200);
  const busy = await svc.rate('ses_gap');
  check('measuring works again after the gap', busy.busy === true && busy.live.tps > 0, JSON.stringify({ busy: busy.busy, live: busy.live }));
  feed.emit('session.step.ended', { sessionID: 'ses_gap', assistantMessageID: 'msgAfter', tokens: { input: 0, output: 100, reasoning: 0 }, cost: 0 });
  feed.emit('session.execution.succeeded', { sessionID: 'ses_gap' });
  await sleep(200);
  const settled = await svc.rate('ses_gap');
  check('and the next turn settles', settled.lastTurn?.tokens === 100, JSON.stringify(settled.lastTurn));
  await svc.stop();
  feed.cut();
  feed.server.close();
}

// --- what a page may name in a watch -----------------------------------------
{
  const feed = await makeFeed();
  const svc = await startService({ port: await freePort(), dataDir: path.join(root, 'watch-data'), feedUrl: feed.origin });
  const long = await svc.watch({ sessionId: 'ses_'.repeat(200) });
  check('an absurd session id is refused', long.status === 400, `status=${long.status}`);
  const legacyPage = await svc.watch({ sessionId: 'ses_watch_ok', origin: 'http://127.0.0.1:27777' });
  check('a 0.x page still sending an origin is not turned away', legacyPage.status === 200, `status=${legacyPage.status}`);
  const longModel = await svc.watch({ sessionId: 'ses_watch_ok', model: 'm'.repeat(4_000) });
  check('an absurd model name is ignored rather than trusted', longModel.status === 200, `status=${longModel.status}`);
  const unnamed = await svc.rate('ses_watch_ok');
  check('and nothing is reported as the model in play', unnamed.gauge?.chatModel == null, JSON.stringify(unnamed.gauge?.chatModel));
  const named = await svc.watch({ sessionId: 'ses_watch_ok', model: 'Qwen3.8-Flash-Next' });
  check('a normal watch names the model in play', named.status === 200, JSON.stringify(named));
  const shown = await svc.rate('ses_watch_ok');
  check('and the reading carries it', shown.gauge?.chatModel?.id === 'Qwen3.8-Flash-Next', JSON.stringify(shown.gauge?.chatModel));
  await svc.stop();
  feed.cut();
  feed.server.close();
}

// --- two pages watching, inside the host's event budget ---------------------
// The host takes at most 30 events a second from one service. Two sections on
// two chats must not exceed that, and each must still get its own numbers.
{
  const feed = await makeFeed();
  const callback = await makeCallback();
  const svc = await startService({
    port: await freePort(),
    dataDir: path.join(root, 'two-page-data'),
    feedUrl: feed.origin,
    callbackUrl: callback.origin,
  });
  await svc.watch({ sessionId: 'ses_page_a' });
  await svc.watch({ sessionId: 'ses_page_b' });
  for (const session of ['ses_page_a', 'ses_page_b']) {
    feed.emit('session.execution.started', { sessionID: session });
    feed.emit('session.step.started', { sessionID: session, assistantMessageID: `msg_${session}` });
  }
  const started = Date.now();
  while (Date.now() - started < 3_000) {
    for (const session of ['ses_page_a', 'ses_page_b']) {
      feed.emit('session.text.delta', { sessionID: session, assistantMessageID: `msg_${session}`, ordinal: 0, delta: 'x'.repeat(120) });
      await sleep(120);
    }
  }
  for (const session of ['ses_page_a', 'ses_page_b']) {
    feed.emit('session.step.ended', { sessionID: session, assistantMessageID: `msg_${session}`, tokens: { input: 0, output: 60, reasoning: 0 }, cost: 0 });
    feed.emit('session.execution.succeeded', { sessionID: session });
  }
  const emits = callback.emits();
  const perSecond = emits.length / 3;
  check('two watched sessions both get pushed',
    new Set(emits.map((call) => call?.input?.data?.session)).size === 2,
    JSON.stringify([...new Set(emits.map((call) => call?.input?.data?.session))]));
  check('and stay under the host limit of 30 events a second', perSecond <= 30, `emits/s=${perSecond.toFixed(1)} of 30`);
  const a = await svc.rate('ses_page_a');
  const b = await svc.rate('ses_page_b');
  check('each page reads its own last turn', a.lastTurn?.tokens === 60 && b.lastTurn?.tokens === 60, JSON.stringify({ a: a.lastTurn?.tokens, b: b.lastTurn?.tokens }));
  await svc.stop();
  feed.cut();
  feed.server.close();
  callback.server.close();
}

for (const server of servers) {
  server.closeAllConnections();
  server.close();
}
fs.rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? '\nALL REGRESSION TESTS PASSED' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
