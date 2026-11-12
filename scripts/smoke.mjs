// Smoke test: mock OpenCode event feed + the built service.
//
// Feed synthetic OpenCode 2 events through the read-only connection an approved
// service is given (OPENCHAMBER_OPENCODE_URL), and assert instant live rate,
// TTFT, last-turn average, reasoning split, session filtering, and what the
// service does when that connection is missing, refused, or cut.
//
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';

const SERVICE_TOKEN = 'smoke-test-token';
const SESSION = 'ses_smoke';
const OTHER = 'ses_other';
// The service keeps its durable numbers, so a restarted process still shows
// them. Point it at a scratch file so runs cannot leak into each other, and so
// nothing lands in the repo. (Where the file lands when nothing overrides it is
// regressions.mjs's question.)
const STATE_FILE = path.join(os.tmpdir(), `gauge-smoke-state-${process.pid}.json`);
fs.rmSync(STATE_FILE, { force: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`ok   ${name}`);
  else {
    failures += 1;
    console.log(`FAIL ${name} ${extra}`);
  }
};

// --- the mock feed ----------------------------------------------------------
// What OpenChamber hands an approved `opencode` service: OpenCode's own event
// stream, authenticated with the service token, at the address it names.
const clients = new Set();
const feedPath = (url) => (url ?? '').split('?')[0];
const feedSeen = [];
const feedServer = http.createServer((req, res) => {
  if (feedPath(req.url) !== '/api/event') {
    res.writeHead(404).end();
    return;
  }
  feedSeen.push({ authorization: req.headers.authorization ?? null, url: req.url });
  if (req.headers.authorization !== `Bearer ${SERVICE_TOKEN}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":{"message":"nope"}}');
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  // A real SSE server pushes its status line before the first event, and the
  // service treats a connection that answered as a healthy one.
  res.flushHeaders();
  clients.add(res);
  req.on('close', () => clients.delete(res));
});
await new Promise((r) => feedServer.listen(0, '127.0.0.1', r));
const FEED_URL = `http://127.0.0.1:${feedServer.address().port}`;

/** Anything else listening on this machine must never be dialled. */
const decoyHits = [];
const decoy = http.createServer((req, res) => { decoyHits.push(req.url); res.writeHead(200).end(); });
await new Promise((r) => decoy.listen(0, '127.0.0.1', r));

const emit = (event) => {
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(frame);
};
const ev = (type, data) => emit({ id: 'e', created: Date.now(), type, data });

// --- start the built service -------------------------------------------------
const svcPort = 18751;
const svc = spawn(process.execPath, ['service/main.js'], {
  env: {
    ...process.env,
    OPENCHAMBER_SERVICE_PORT: String(svcPort),
    OPENCHAMBER_SERVICE_TOKEN: SERVICE_TOKEN,
    OPENCHAMBER_GAUGE_STATE: STATE_FILE,
    OPENCHAMBER_OPENCODE_URL: FEED_URL,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
svc.stderr.on('data', (d) => process.stderr.write(`[service] ${d}`));
const svcFetch = (path, init) => fetch(`http://127.0.0.1:${svcPort}${path}`, {
  ...init,
  headers: { Authorization: `Bearer ${SERVICE_TOKEN}`, ...(init?.headers ?? {}) },
});

let ready = false;
for (let i = 0; i < 50 && !ready; i++) {
  try {
    const r = await svcFetch('/health');
    ready = r.ok;
  } catch { /* not up yet */ }
  if (!ready) await sleep(100);
}
check('service becomes ready', ready);
if (!ready) {
  svc.kill();
  sseServer.close();
  process.exit(1);
}

await svcFetch('/watch', {
  method: 'POST',
  body: JSON.stringify({ sessionId: SESSION }),
});
await sleep(300); // let the stream subscription establish

// --- turn 1: text + reasoning, instant rate ----------------------------------
const t0 = Date.now();
ev('session.execution.started', { sessionID: SESSION });
ev('session.step.started', { sessionID: SESSION, assistantMessageID: 'msg1' });
await sleep(400); // TTFT window: 400 ms of silence before the first token
// ~200 tok/s worth of chars: 50 chars per 250 ms chunk at ratio 0.25
for (let i = 0; i < 4; i++) {
  ev('session.text.delta', {
    sessionID: SESSION,
    assistantMessageID: 'msg1',
    ordinal: 0,
    delta: 'x'.repeat(50),
  });
  await sleep(60);
}
ev('session.reasoning.delta', {
  sessionID: SESSION,
  assistantMessageID: 'msg1',
  ordinal: 0,
  delta: 'r'.repeat(40),
});
await sleep(120);
let midRate = await (await svcFetch('/rate')).json();
check(
  'running average exists mid-turn (estimate before settle)',
  midRate.running !== null && midRate.running.tps > 0 && midRate.running.source === 'estimate',
  JSON.stringify(midRate.running),
);
let rate = await (await svcFetch('/rate')).json();
check('live rate is instant, not climbing from 0', rate.live.tps > 80, `tps=${rate.live.tps}`);
// The wire carries one live number: reasoning streams are counted as generated
// work in the same window as text, and only the finished turn separates them.
check('the wire reports one live number', Object.keys(rate.live).length === 1 && rate.live.tps > 0, JSON.stringify(rate.live));
check('turn TTFT observed (~400ms)', rate.turn.ttftMs !== null && rate.turn.ttftMs >= 300 && rate.turn.ttftMs < 1500, `ttft=${rate.turn.ttftMs}`);

// Other sessions must not leak in.
ev('session.text.delta', { sessionID: OTHER, assistantMessageID: 'msgX', ordinal: 0, delta: 'z'.repeat(5000) });
await sleep(150);
const rate2 = await (await svcFetch('/rate')).json();
check(
  'other sessions ignored',
  rate2.live.tps <= rate.live.tps + 50,
  `tps=${rate2.live.tps} instead of ${rate.live.tps}`,
);

// Settle with real token counts, then end the turn.
ev('session.step.ended', {
  sessionID: SESSION,
  assistantMessageID: 'msg1',
  tokens: { output: 90, reasoning: 10 },
});
await sleep(150); // let the service consume the settlement before polling
midRate = await (await svcFetch('/rate')).json();
check(
  'running average switches to real counts after settle',
  midRate.running !== null && midRate.running.source === 'tokens',
  JSON.stringify(midRate.running),
);
const runningBeforeEnd = midRate.running?.tps ?? NaN;
ev('session.execution.succeeded', { sessionID: SESSION });
await sleep(150);
rate = await (await svcFetch('/rate')).json();
check('last turn uses real token counts', rate.lastTurn?.source === 'tokens', JSON.stringify(rate.lastTurn));
check('last turn tokens = output + reasoning', rate.lastTurn?.tokens === 100, JSON.stringify(rate.lastTurn));
check('last turn has TTFT', typeof rate.lastTurn?.ttftMs === 'number' && rate.lastTurn.ttftMs >= 300, JSON.stringify(rate.lastTurn));
check('last turn saw reasoning', rate.lastTurn?.hasReasoning === true, JSON.stringify(rate.lastTurn));
check(
  'last turn tps ≈ tokens/activeMs',
  Math.abs(rate.lastTurn.tokensPerSecond - rate.lastTurn.tokens / (rate.lastTurn.activeMs / 1000)) < 0.01,
  JSON.stringify(rate.lastTurn),
);
{
  const split = rate.lastTurn?.split;
  check(
    'last turn carries a receipt whose slices add up to the turn',
    !!split && split.totalMs > 0
      && split.readMs + split.waitMs + split.writeMs + split.toolMs === split.totalMs
      && split.writeMs === rate.lastTurn.activeMs,
    JSON.stringify(split),
  );
}
check(
  'headline is continuous: running average converges to the final number',
  Number.isFinite(runningBeforeEnd)
    && Math.abs(rate.lastTurn.tokensPerSecond - runningBeforeEnd) / rate.lastTurn.tokensPerSecond < 0.2,
  `running=${runningBeforeEnd} final=${rate.lastTurn.tokensPerSecond}`,
);

// --- turn 2: text only, permission wait ---------------------------------------
ev('session.execution.started', { sessionID: SESSION });
ev('session.step.started', { sessionID: SESSION, assistantMessageID: 'msg2' });
ev('session.text.delta', { sessionID: SESSION, assistantMessageID: 'msg2', ordinal: 0, delta: 'y'.repeat(60) });
ev('permission.asked', { sessionID: SESSION, id: 'perm1' });
await sleep(150);
rate = await (await svcFetch('/rate')).json();
check('waiting-for-permission detected', rate.waiting === 'permission', JSON.stringify(rate.waiting));
ev('permission.replied', { sessionID: SESSION, requestID: 'perm1' });
ev('session.step.ended', { sessionID: SESSION, assistantMessageID: 'msg2', tokens: { output: 15, reasoning: 0 } });
ev('session.execution.succeeded', { sessionID: SESSION });
await sleep(150);
rate = await (await svcFetch('/rate')).json();
check('text-only turn reports no reasoning', rate.lastTurn?.hasReasoning === false, JSON.stringify(rate.lastTurn));
check('waiting cleared after reply', rate.waiting === null, JSON.stringify(rate.waiting));

// --- turn 3: hidden reasoning (long silence, small burst, big token bill) ----
ev('session.execution.started', { sessionID: SESSION });
ev('session.step.started', { sessionID: SESSION, assistantMessageID: 'msg3' });
await sleep(1200); // model "thinks" with no deltas for over a second
ev('session.text.delta', { sessionID: SESSION, assistantMessageID: 'msg3', ordinal: 0, delta: 'q'.repeat(80) });
await sleep(80);
ev('session.step.ended', {
  sessionID: SESSION,
  assistantMessageID: 'msg3',
  tokens: { output: 20, reasoning: 480 },
});
ev('session.execution.succeeded', { sessionID: SESSION });
await sleep(150);
rate = await (await svcFetch('/rate')).json();
check('hidden-reasoning turn stays tokens-based', rate.lastTurn?.source === 'tokens', JSON.stringify(rate.lastTurn));
check(
  'hidden-reasoning turn does not explode (denominator covers the wait)',
  rate.lastTurn?.tokensPerSecond < 1000 && rate.lastTurn?.activeMs >= 1000,
  JSON.stringify(rate.lastTurn),
);

// --- turn 4: small but measurable step stays tokens-based ---------------------
ev('session.execution.started', { sessionID: SESSION });
ev('session.step.started', { sessionID: SESSION, assistantMessageID: 'msg4' });
await sleep(300);
ev('session.text.delta', { sessionID: SESSION, assistantMessageID: 'msg4', ordinal: 0, delta: 'w'.repeat(60) });
await sleep(50);
ev('session.step.ended', { sessionID: SESSION, assistantMessageID: 'msg4', tokens: { output: 15, reasoning: 0 } });
ev('session.execution.succeeded', { sessionID: SESSION });
await sleep(150);
rate = await (await svcFetch('/rate')).json();
check('measurable small step stays tokens-based', rate.lastTurn?.source === 'tokens' && rate.lastTurn?.tokens === 15, JSON.stringify(rate.lastTurn));
check('small step rate is sane', rate.lastTurn?.tokensPerSecond < 1000, JSON.stringify(rate.lastTurn));

// --- turn 5: tool call freezes the headline ----------------------------------
ev('session.execution.started', { sessionID: SESSION });
ev('session.step.started', { sessionID: SESSION, assistantMessageID: 'msg5' });
await sleep(100);
ev('session.text.delta', { sessionID: SESSION, assistantMessageID: 'msg5', ordinal: 0, delta: 'v'.repeat(200) });
await sleep(250); // let some generation time accumulate before the tool starts
ev('session.tool.called', { sessionID: SESSION, assistantMessageID: 'msg5', id: 'tool1' });
await sleep(150);
let toolRate1 = await (await svcFetch('/rate')).json();
check('tool execution detected', toolRate1.toolActive === true, JSON.stringify({ toolActive: toolRate1.toolActive }));
await sleep(700); // tool runs ~0.7s with no deltas: denominator must stay frozen
let toolRate2 = await (await svcFetch('/rate')).json();
check(
  'headline locked while tool runs',
  toolRate1.running !== null && toolRate2.running !== null
    && Math.abs(toolRate2.running.tps - toolRate1.running.tps) / Math.max(1, toolRate1.running.tps) < 0.05,
  `before=${toolRate1.running?.tps} after=${toolRate2.running?.tps}`,
);
ev('session.tool.success', { sessionID: SESSION, assistantMessageID: 'msg5', id: 'tool1' });
ev('session.text.delta', { sessionID: SESSION, assistantMessageID: 'msg5', ordinal: 1, delta: 'v'.repeat(200) });
await sleep(150);
ev('session.step.ended', { sessionID: SESSION, assistantMessageID: 'msg5', tokens: { output: 100, reasoning: 0 } });
ev('session.execution.succeeded', { sessionID: SESSION });
await sleep(150);
rate = await (await svcFetch('/rate')).json();
check(
  'final average excludes tool time',
  rate.lastTurn?.activeMs < (rate.lastTurn?.split?.totalMs ?? 0) - 500,
  JSON.stringify(rate.lastTurn),
);

// --- turn 6: stale execution start must not dilute the average --------------
// Regression test for the 6.1-vs-147 bug: 1.5 s of pre-step silence (queue,
// compaction, whatever) before the step even starts. Step-scoped accounting
// must report the step's own rate, not tokens over the whole execution span.
ev('session.execution.started', { sessionID: SESSION });
await sleep(1500);
ev('session.step.started', { sessionID: SESSION, assistantMessageID: 'msg6' });
ev('session.text.delta', { sessionID: SESSION, assistantMessageID: 'msg6', ordinal: 0, delta: 's'.repeat(200) });
await sleep(150);
ev('session.step.ended', { sessionID: SESSION, assistantMessageID: 'msg6', tokens: { output: 100, reasoning: 0 } });
ev('session.execution.succeeded', { sessionID: SESSION });
await sleep(150);
rate = await (await svcFetch('/rate')).json();
check('pre-step silence does not dilute (tokens-based)', rate.lastTurn?.source === 'tokens', JSON.stringify(rate.lastTurn));
check(
  'pre-step silence excluded from denominator',
  rate.lastTurn?.activeMs < 1000 && rate.lastTurn?.tokensPerSecond > 150,
  JSON.stringify(rate.lastTurn),
);

// --- turn 7: zero-token step contributes no time -----------------------------
ev('session.execution.started', { sessionID: SESSION });
ev('session.step.started', { sessionID: SESSION, assistantMessageID: 'msg7a' });
await sleep(700); // tool-only step, settles zero tokens: its wall must not count
ev('session.step.ended', { sessionID: SESSION, assistantMessageID: 'msg7a', tokens: { output: 0, reasoning: 0 } });
ev('session.step.started', { sessionID: SESSION, assistantMessageID: 'msg7b' });
ev('session.text.delta', { sessionID: SESSION, assistantMessageID: 'msg7b', ordinal: 0, delta: 't'.repeat(60) });
await sleep(100);
ev('session.step.ended', { sessionID: SESSION, assistantMessageID: 'msg7b', tokens: { output: 60, reasoning: 0 } });
ev('session.execution.succeeded', { sessionID: SESSION });
await sleep(150);
rate = await (await svcFetch('/rate')).json();
check('zero-token step adds no tokens', rate.lastTurn?.tokens === 60, JSON.stringify(rate.lastTurn));
check('zero-token step adds no time', rate.lastTurn?.activeMs < 700, JSON.stringify(rate.lastTurn));

// --- turn 8: reasoning time is generation time ------------------------------
// The reasoning span used to be subtracted from the divisor whenever the
// provider reported `reasoning: 0`, on the theory that the time produced
// nothing countable. It does: providers fold reasoning tokens into `output`
// (every `step.ended` in a 200 s capture reported `reasoning: 0` while
// streaming thousands of reasoning characters, and `output` matched chars/4
// across reasoning plus text together). Subtracting it counted the same tokens
// twice and inflated one session from 74 to 218 tok/s.
ev('session.execution.started', { sessionID: SESSION });
ev('session.step.started', { sessionID: SESSION, assistantMessageID: 'msg8' });
ev('session.reasoning.delta', { sessionID: SESSION, assistantMessageID: 'msg8', ordinal: 0, delta: 'r'.repeat(40) });
await sleep(500); // reasoning streams half a second and settles inside `output`
ev('session.reasoning.delta', { sessionID: SESSION, assistantMessageID: 'msg8', ordinal: 0, delta: 'r'.repeat(40) });
ev('session.text.delta', { sessionID: SESSION, assistantMessageID: 'msg8', ordinal: 0, delta: 't'.repeat(40) });
await sleep(300); // then a measurable text phase settles 50 output tokens
ev('session.text.delta', { sessionID: SESSION, assistantMessageID: 'msg8', ordinal: 1, delta: 't'.repeat(40) });
ev('session.step.ended', { sessionID: SESSION, assistantMessageID: 'msg8', tokens: { output: 50, reasoning: 0 } });
ev('session.execution.succeeded', { sessionID: SESSION });
await sleep(150);
rate = await (await svcFetch('/rate')).json();
check('reasoning turn stays tokens-based', rate.lastTurn?.source === 'tokens' && rate.lastTurn?.tokens === 50, JSON.stringify(rate.lastTurn));
check(
  'reasoning span counts as generation time',
  (rate.lastTurn?.activeMs ?? 0) >= 700,
  `activeMs=${rate.lastTurn?.activeMs}`,
);

// --- turn 8b: a step published after it began ------------------------------
// OpenCode 2 publishes `session.step.started` once the step produces output, so
// the event lands one model-latency after `started` (6.2 s on the session this
// was found in). Anchoring the step at arrival drops that latency from the
// divisor — 151.9 tok/s where the events say 30.6 — and reports the delivery
// interval as time to first token.
ev('session.execution.started', { sessionID: SESSION });
const lateStepAt = Date.now();
emit({
  id: 'e',
  created: Date.now() + 2000, // published 2 s after the step really began
  type: 'session.step.started',
  data: {
    sessionID: SESSION,
    assistantMessageID: 'msg8b',
    started: lateStepAt,
    // v2 carries the model as an object; a plain string read misses it and
    // every model then shares one wildcard calibration entry.
    model: { id: 'smoke-model', providerID: 'smoke', variant: 'default' },
  },
});
await sleep(400); // the step's first output arrives 2.4 s after it began
for (let i = 0; i < 4; i += 1) {
  ev('session.text.delta', { sessionID: SESSION, assistantMessageID: 'msg8b', ordinal: 0, delta: 'L'.repeat(200) });
  await sleep(100); // 400 ms of generation after the first token
}
ev('session.step.ended', { sessionID: SESSION, assistantMessageID: 'msg8b', tokens: { output: 100, reasoning: 0 } });
ev('session.execution.succeeded', { sessionID: SESSION });
await sleep(150);
rate = await (await svcFetch('/rate')).json();
check(
  'ttft is the real delay, not the delivery interval',
  (rate.lastTurn?.ttftMs ?? 0) > 1500,
  `ttft=${rate.lastTurn?.ttftMs}`,
);
check(
  'time to first token is not in the divisor',
  rate.lastTurn?.source === 'tokens' && rate.lastTurn?.tokensPerSecond > 150,
  JSON.stringify(rate.lastTurn),
);

// --- turn 9: backfilled counts with no observed start are excluded -----------
const beforeBackfill = await (await svcFetch('/rate')).json();
ev('session.execution.started', { sessionID: SESSION });
ev('session.step.ended', { sessionID: SESSION, assistantMessageID: 'msg9', tokens: { output: 4000, reasoning: 0 } });
ev('session.execution.succeeded', { sessionID: SESSION });
await sleep(150);
rate = await (await svcFetch('/rate')).json();
check(
  'unmeasurable step never explodes the average',
  rate.lastTurn?.endedAt === beforeBackfill.lastTurn?.endedAt,
  JSON.stringify(rate.lastTurn),
);

// --- turn 10: missed terminal flushes on the next execution start ------------
ev('session.execution.started', { sessionID: SESSION });
ev('session.step.started', { sessionID: SESSION, assistantMessageID: 'msgAa' });
ev('session.text.delta', { sessionID: SESSION, assistantMessageID: 'msgAa', ordinal: 0, delta: 'a'.repeat(100) });
await sleep(100);
// No terminal event (simulates a missed `execution.succeeded` during a gap),
// then a new turn begins: the leftover must settle from its own steps.
ev('session.execution.started', { sessionID: SESSION });
ev('session.step.started', { sessionID: SESSION, assistantMessageID: 'msgAb' });
ev('session.text.delta', { sessionID: SESSION, assistantMessageID: 'msgAb', ordinal: 0, delta: 'b'.repeat(100) });
await sleep(100);
ev('session.step.ended', { sessionID: SESSION, assistantMessageID: 'msgAb', tokens: { output: 60, reasoning: 0 } });
ev('session.execution.succeeded', { sessionID: SESSION });
await sleep(150);
rate = await (await svcFetch('/rate')).json();
check(
  'post-gap turn counts only its own steps',
  rate.lastTurn?.source === 'tokens' && rate.lastTurn?.tokens === 60,
  JSON.stringify(rate.lastTurn),
);

// --- turn 11: headline freezes during silent thinking -------------------------
ev('session.execution.started', { sessionID: SESSION });
ev('session.step.started', { sessionID: SESSION, assistantMessageID: 'msgF' });
ev('session.text.delta', { sessionID: SESSION, assistantMessageID: 'msgF', ordinal: 0, delta: 'f'.repeat(100) });
await sleep(150);
// Two chunks a span apart, the way a model actually streams. One chunk has no
// elapsed time to divide by, and the number that fell out of a 1 ms floor was
// the same artifact as the spike the last two cases in this file guard.
ev('session.text.delta', { sessionID: SESSION, assistantMessageID: 'msgF', ordinal: 0, delta: 'f'.repeat(100) });
await sleep(150);
const freeze1 = await (await svcFetch('/rate')).json();
await sleep(600); // model thinks with no deltas: nothing new countable
const freeze2 = await (await svcFetch('/rate')).json();
check(
  'headline frozen while thinking (no new tokens, no new time)',
  freeze1.running !== null && freeze2.running !== null && freeze2.running.tps === freeze1.running.tps,
  `before=${freeze1.running?.tps} after=${freeze2.running?.tps}`,
);
ev('session.step.ended', { sessionID: SESSION, assistantMessageID: 'msgF', tokens: { output: 100, reasoning: 0 } });
ev('session.execution.succeeded', { sessionID: SESSION });
await sleep(150);
rate = await (await svcFetch('/rate')).json();
check('frozen turn still settles tokens-based', rate.lastTurn?.source === 'tokens' && rate.lastTurn?.tokens === 100, JSON.stringify(rate.lastTurn));

// --- turn 12: multi-step total = sum(tokens) / sum(nets) -----------------------
ev('session.execution.started', { sessionID: SESSION });
ev('session.step.started', { sessionID: SESSION, assistantMessageID: 'msgGa' });
ev('session.text.delta', { sessionID: SESSION, assistantMessageID: 'msgGa', ordinal: 0, delta: 'g'.repeat(80) });
await sleep(200);
ev('session.step.ended', { sessionID: SESSION, assistantMessageID: 'msgGa', tokens: { output: 40, reasoning: 0 } });
ev('session.step.started', { sessionID: SESSION, assistantMessageID: 'msgGb' });
ev('session.text.delta', { sessionID: SESSION, assistantMessageID: 'msgGb', ordinal: 0, delta: 'g'.repeat(80) });
await sleep(200);
ev('session.step.ended', { sessionID: SESSION, assistantMessageID: 'msgGb', tokens: { output: 60, reasoning: 0 } });
ev('session.execution.succeeded', { sessionID: SESSION });
await sleep(150);
rate = await (await svcFetch('/rate')).json();
check('multi-step tokens are summed', rate.lastTurn?.tokens === 100, JSON.stringify(rate.lastTurn));
check(
  'multi-step nets are summed',
  (rate.lastTurn?.source === 'tokens') && (rate.lastTurn?.activeMs ?? 0) >= 300 && (rate.lastTurn?.activeMs ?? 0) < 800,
  JSON.stringify(rate.lastTurn),
);

// --- turn 13: fallback estimate freezes without observed step starts ----------
ev('session.execution.started', { sessionID: SESSION });
ev('session.text.delta', { sessionID: SESSION, assistantMessageID: 'msgH', ordinal: 0, delta: 'h'.repeat(50) });
await sleep(150);
ev('session.text.delta', { sessionID: SESSION, assistantMessageID: 'msgH', ordinal: 0, delta: 'h'.repeat(50) });
await sleep(300);
const fb1 = await (await svcFetch('/rate')).json();
await sleep(400); // silence with unmeasurable steps: estimate must hold too
const fb2 = await (await svcFetch('/rate')).json();
check(
  'fallback estimate frozen during silence',
  fb1.running !== null && fb2.running !== null
    && fb1.running.source === 'estimate' && fb2.running.tps === fb1.running.tps,
  `before=${JSON.stringify(fb1.running)} after=${JSON.stringify(fb2.running)}`,
);
ev('session.step.ended', { sessionID: SESSION, assistantMessageID: 'msgH', tokens: { output: 30, reasoning: 0 } });
ev('session.execution.succeeded', { sessionID: SESSION });
await sleep(150);
rate = await (await svcFetch('/rate')).json();
check('unobserved step never becomes measured', rate.lastTurn?.source === 'estimate', JSON.stringify(rate.lastTurn));

// --- session switch: memory survives -----------------------------------------
const firstTurnTps = (await (await svcFetch('/rate')).json()).lastTurn?.tokensPerSecond;
await svcFetch('/watch', { method: 'POST', body: JSON.stringify({ sessionId: OTHER }) });
await sleep(200);
ev('session.execution.started', { sessionID: OTHER });
ev('session.step.started', { sessionID: OTHER, assistantMessageID: 'msgO' });
ev('session.text.delta', { sessionID: OTHER, assistantMessageID: 'msgO', ordinal: 0, delta: 'o'.repeat(100) });
await sleep(100);
ev('session.step.ended', { sessionID: OTHER, assistantMessageID: 'msgO', tokens: { output: 25, reasoning: 0 } });
ev('session.execution.succeeded', { sessionID: OTHER });
await sleep(150);
let otherRate = await (await svcFetch('/rate')).json();
check('other session has its own last turn', otherRate.lastTurn?.tokens === 25, JSON.stringify(otherRate.lastTurn));
await svcFetch('/watch', { method: 'POST', body: JSON.stringify({ sessionId: SESSION }) });
await sleep(200);
rate = await (await svcFetch('/rate')).json();
check('switching back restores last turn', rate.lastTurn?.tokensPerSecond === firstTurnTps, JSON.stringify(rate.lastTurn));
check('switching back restores the live curve', Array.isArray(rate.curve) && rate.curve.length > 0, JSON.stringify(rate.curve));

// --- two surfaces at once: neither disturbs the other ------------------------
// The status page and a second surface (another window, or a second panel) can
// ask about different sessions at the same time. Registering one used to reset
// the other's in-progress turn and drop the shared event stream, so both pages
// flipped between data and an empty section roughly once a second.
ev('session.execution.started', { sessionID: SESSION });
ev('session.step.started', { sessionID: SESSION, assistantMessageID: 'msgBoth' });
// A gap before the first character, or the span the estimate divides by is
// still under a millisecond and the number is refused by design.
await sleep(150);
ev('session.text.delta', { sessionID: SESSION, assistantMessageID: 'msgBoth', ordinal: 0, delta: 'b'.repeat(120) });
await sleep(150);
await svcFetch('/watch', { method: 'POST', body: JSON.stringify({ sessionId: OTHER }) });
await sleep(150);
const mineMidTurn = await (await svcFetch(`/rate?sessionId=${SESSION}`)).json();
check(
  'a second watch leaves this session mid-turn intact',
  mineMidTurn.running !== null && mineMidTurn.turn.active === true,
  JSON.stringify({ running: mineMidTurn.running, active: mineMidTurn.turn.active }),
);
check('each page reads its own session id', mineMidTurn.sessionId === SESSION, `sessionId=${mineMidTurn.sessionId}`);
const theirsMidTurn = await (await svcFetch(`/rate?sessionId=${OTHER}`)).json();
check('the other page reads its own session', theirsMidTurn.sessionId === OTHER, `sessionId=${theirsMidTurn.sessionId}`);
const bareRate = await (await svcFetch('/rate')).json();
check('bare /rate still answers for the last watch', bareRate.sessionId === OTHER, `sessionId=${bareRate.sessionId}`);
ev('session.step.ended', { sessionID: SESSION, assistantMessageID: 'msgBoth', tokens: { output: 40, reasoning: 0 } });
ev('session.execution.succeeded', { sessionID: SESSION });
await sleep(150);
await svcFetch('/watch', { method: 'POST', body: JSON.stringify({ sessionId: SESSION }) });
await sleep(200);

// --- a new conversation must never read another session's numbers ------------
// The status page of a brand-new chat registers `sessionId: null` and then
// polls bare `/rate`. With a watch registered the last one still answers (see
// "bare /rate still answers for the last watch" above); with no watch at all
// the answer used to come from the register the last event left behind, so the
// empty chat showed whichever *other* session had just streamed. It must
// answer "no session": empty numbers, no turn, no last turn.
ev('session.execution.started', { sessionID: OTHER });
ev('session.step.started', { sessionID: OTHER, assistantMessageID: 'msgNew' });
for (let i = 0; i < 3; i += 1) {
  ev('session.text.delta', { sessionID: OTHER, assistantMessageID: 'msgNew', ordinal: 0, delta: 'n'.repeat(50) });
  await sleep(60);
}
await svcFetch('/watch', { method: 'POST', body: JSON.stringify({ sessionId: null }) });
await sleep(120);
const newChat = await (await svcFetch('/rate')).json();
check(
  'a new conversation reads no live numbers',
  newChat.sessionId === null && newChat.busy === false && newChat.live.tps === 0,
  JSON.stringify({ sessionId: newChat.sessionId, busy: newChat.busy, live: newChat.live }),
);
check(
  'a new conversation reads no active turn',
  newChat.turn.active === false && newChat.running === null && newChat.toolActive === false && newChat.waiting === null,
  JSON.stringify({ turn: newChat.turn, running: newChat.running, waiting: newChat.waiting }),
);
const otherStreaming = await (await svcFetch(`/rate?sessionId=${OTHER}`)).json();
check(
  'the streaming session still reads its own live numbers',
  otherStreaming.sessionId === OTHER && otherStreaming.busy === true && otherStreaming.live.tps > 0,
  JSON.stringify({ sessionId: otherStreaming.sessionId, busy: otherStreaming.busy, live: otherStreaming.live }),
);
// Settle OTHER while the new conversation is still the latest watch: a
// finished turn must not leak either.
ev('session.step.ended', { sessionID: OTHER, assistantMessageID: 'msgNew', tokens: { output: 20, reasoning: 0 } });
ev('session.execution.succeeded', { sessionID: OTHER });
await sleep(150);
const newChatSettled = await (await svcFetch('/rate')).json();
check(
  'a new conversation reads no finished turn',
  newChatSettled.lastTurn === null && newChatSettled.busy === false,
  JSON.stringify({ lastTurn: newChatSettled.lastTurn, busy: newChatSettled.busy }),
);
// Registering a session again brings the numbers back.
await svcFetch('/watch', { method: 'POST', body: JSON.stringify({ sessionId: SESSION }) });
await sleep(200);
const backOnSession = await (await svcFetch('/rate')).json();
check('re-watching a session brings its numbers back', backOnSession.sessionId === SESSION, `sessionId=${backOnSession.sessionId}`);

// --- turn 14: missed execution.started must not stick the turn on idle -----
// Regression for the "tools running but status shows idle/empty" report:
// the service attached after the turn began, so no `execution.started` was
// ever seen. Tool activity alone must mark the turn busy, and streamed tool
// input (the model's call arguments) must count live.
ev('session.step.started', { sessionID: SESSION, assistantMessageID: 'msgLate' });
await sleep(120);
ev('session.tool.input.started', { sessionID: SESSION, assistantMessageID: 'msgLate', id: 'toolLate' });
ev('session.tool.input.delta', { sessionID: SESSION, assistantMessageID: 'msgLate', id: 'toolLate', delta: '{"path":' });
await sleep(120);
ev('session.tool.input.delta', { sessionID: SESSION, assistantMessageID: 'msgLate', id: 'toolLate', delta: '"a"}' });
ev('session.tool.called', { sessionID: SESSION, assistantMessageID: 'msgLate', id: 'toolLate' });
await sleep(150);
rate = await (await svcFetch('/rate')).json();
check('missed start still shows busy', rate.busy === true, JSON.stringify({ busy: rate.busy }));
check('tool execution detected without started', rate.toolActive === true, JSON.stringify({ toolActive: rate.toolActive }));
check('tool input counted live', rate.live.tps > 0 && rate.toolActive === true, JSON.stringify({ live: rate.live, toolActive: rate.toolActive }));
check('running exists during tool input', rate.running !== null && rate.running.tps > 0, JSON.stringify(rate.running));
ev('session.tool.success', { sessionID: SESSION, assistantMessageID: 'msgLate', id: 'toolLate' });
ev('session.text.delta', { sessionID: SESSION, assistantMessageID: 'msgLate', ordinal: 0, delta: 'z'.repeat(60) });
await sleep(100);
ev('session.step.ended', { sessionID: SESSION, assistantMessageID: 'msgLate', tokens: { output: 25, reasoning: 0 } });
ev('session.execution.succeeded', { sessionID: SESSION });
await sleep(150);
rate = await (await svcFetch('/rate')).json();
check('late-attach turn settles tokens-based', rate.lastTurn?.source === 'tokens' && rate.lastTurn?.tokens === 25, JSON.stringify(rate.lastTurn));

// --- turn 15: `session.next.*` names and callID shape are accepted ---------
ev('session.next.execution.started', { sessionID: SESSION });
ev('session.next.step.started', { sessionID: SESSION, assistantMessageID: 'msgNext' });
ev('session.next.tool.input.delta', { sessionID: SESSION, assistantMessageID: 'msgNext', callID: 'callNext', delta: '{"a":1}' });
await sleep(150);
rate = await (await svcFetch('/rate')).json();
check('next-prefixed input delta counted', rate.live.tps > 0 && rate.busy === true, JSON.stringify({ live: rate.live, busy: rate.busy }));
ev('session.next.step.ended', { sessionID: SESSION, assistantMessageID: 'msgNext', tokens: { output: 12, reasoning: 0 } });
ev('session.next.execution.succeeded', { sessionID: SESSION });
await sleep(150);
rate = await (await svcFetch('/rate')).json();
check('next-prefixed turn settles tokens-based', rate.lastTurn?.source === 'tokens' && rate.lastTurn?.tokens === 12, JSON.stringify(rate.lastTurn));

// --- turn 16: input streaming time counts, execution time does not ---------
ev('session.execution.started', { sessionID: SESSION });
ev('session.step.started', { sessionID: SESSION, assistantMessageID: 'msgTool' });
ev('session.tool.input.started', { sessionID: SESSION, assistantMessageID: 'msgTool', id: 'tool2' });
ev('session.tool.input.delta', { sessionID: SESSION, assistantMessageID: 'msgTool', id: 'tool2', delta: 'x'.repeat(100) });
await sleep(300); // model writes the tool call: generation time, must be kept
ev('session.tool.called', { sessionID: SESSION, assistantMessageID: 'msgTool', id: 'tool2' });
await sleep(500); // tool executes with no deltas: excluded from the average
ev('session.tool.success', { sessionID: SESSION, assistantMessageID: 'msgTool', id: 'tool2' });
ev('session.text.delta', { sessionID: SESSION, assistantMessageID: 'msgTool', ordinal: 0, delta: 'x'.repeat(60) });
await sleep(100);
ev('session.step.ended', { sessionID: SESSION, assistantMessageID: 'msgTool', tokens: { output: 50, reasoning: 0 } });
ev('session.execution.succeeded', { sessionID: SESSION });
await sleep(150);
rate = await (await svcFetch('/rate')).json();
check('input-streaming turn stays tokens-based', rate.lastTurn?.source === 'tokens' && rate.lastTurn?.tokens === 50, JSON.stringify(rate.lastTurn));
check(
  'execution silence excluded but input time kept',
  (rate.lastTurn?.activeMs ?? 0) >= 200
    && (rate.lastTurn?.activeMs ?? 0) < (rate.lastTurn?.split?.totalMs ?? 0) - 300,
  JSON.stringify(rate.lastTurn),
);

// --- turn 17: the curve must not carry an implausible point ------------------
// A bucket holding a single chunk measured it over `last - first + 1` = 1 ms,
// and sparkPaths normalizes by the largest point, so one such bucket flattened
// every other point on the curve (the finished turns read 70-560 against it).
ev('session.execution.started', { sessionID: SESSION });
for (let i = 0; i < 5; i += 1) {
  ev('session.text.delta', {
    sessionID: SESSION,
    assistantMessageID: 'msgR',
    ordinal: 0,
    delta: 'r'.repeat(60),
  });
  await sleep(120);
}
const streamingRate = await (await svcFetch('/rate')).json();
check(
  'curve carries no implausible point (spark normalizes by the max)',
  Array.isArray(streamingRate.curve)
    && streamingRate.curve.length > 0
    && streamingRate.curve.every((v) => Number.isFinite(v) && v <= 5000),
  JSON.stringify(streamingRate.curve),
);
// The curve used to drop its zero buckets, so the point count moved between 0
// and 8 every poll and the sparkline's x-axis and scale jumped with it. A
// fixed number of fixed-width buckets holds both still.
const curveLengths = [];
for (let i = 0; i < 4; i += 1) {
  curveLengths.push((await (await svcFetch('/rate')).json()).curve.length);
  await sleep(120);
}
check(
  'curve holds a fixed number of points across polls',
  curveLengths.every((n) => n === curveLengths[0] && n > 1),
  JSON.stringify(curveLengths),
);
// The old curve re-cut its 24 slices at "now" on every poll, so each edge slid
// a fifth of a bucket every 250 ms and one chunk changed buckets repeatedly —
// the shape breathed in place instead of sliding. On the absolute grid an edge
// either stays put or advances by whole buckets, which is what lets the guest
// draw a translation. The timestamps travel with the values for that reason.
const edges = [];
for (let i = 0; i < 8; i += 1) {
  const polled = await (await svcFetch('/rate')).json();
  edges.push({
    start: polled.curveStart,
    step: polled.curveStep,
    at: polled.curveAt,
    length: polled.curve.length,
    values: polled.curve,
  });
  await sleep(80);
}
check(
  'curve buckets sit on an absolute grid',
  edges.every((e) => e.step === 1250 && Number.isFinite(e.start) && e.start % e.step === 0),
  JSON.stringify(edges.map((e) => [e.start, e.step])),
);
check(
  'bucket edges never slide between polls',
  edges.every((e, i) => {
    if (i === 0) return true;
    const delta = e.start - edges[i - 1].start;
    return delta >= 0 && delta % e.step === 0;
  }),
  JSON.stringify(edges.map((e) => e.start)),
);
check(
  'curve ends on the newest complete bucket',
  edges.every((e) => {
    const end = e.start + e.length * e.step;
    return end <= e.at && e.at - end < e.step;
  }),
  JSON.stringify(edges.map((e) => [e.start + e.length * e.step, e.at])),
);
// The same bucket must read the same from two polls: a value that changes
// while its x stands still is the deformation, whichever way it moves.
check(
  'a bucket reads the same for as long as its edges hold',
  edges.every((e, i) => i === 0 || e.start !== edges[i - 1].start
    || JSON.stringify(e.values) === JSON.stringify(edges[i - 1].values)),
  JSON.stringify(edges.map((e) => e.values)),
);
ev('session.execution.succeeded', { sessionID: SESSION });
await sleep(150);

// --- turn 17b: a backfilled tool input must not spike the curve ------------
// This stream carries no `tool.input.delta`, so `tool.input.ended` replays the
// whole argument string in one sample. At 83 ms a bucket that read as ~12 000
// tok/s, clamped to 5000, and hijacked the normalization for that poll.
ev('session.execution.started', { sessionID: SESSION });
ev('session.step.started', { sessionID: SESSION, assistantMessageID: 'msgS' });
ev('session.text.delta', { sessionID: SESSION, assistantMessageID: 'msgS', ordinal: 0, delta: 's'.repeat(60) });
await sleep(150);
ev('session.tool.input.ended', {
  sessionID: SESSION,
  assistantMessageID: 'msgS',
  id: 'toolBackfill',
  text: `{"command":"${'x'.repeat(2000)}"}`,
});
await sleep(150);
const backfillRate = await (await svcFetch('/rate')).json();
check(
  'a backfilled tool input does not spike the curve',
  Array.isArray(backfillRate.curve) && Math.max(...backfillRate.curve) < 2000,
  JSON.stringify(backfillRate.curve),
);
ev('session.execution.succeeded', { sessionID: SESSION });
await sleep(150);

// --- turn 18: the character-estimate denominator must stay a real span -------
// Late attach (no `step.started`) puts the turn on the character-estimate
// path, which reconstructs its span as (last char - execution start) minus
// finished tool and wait time. A tool that ran entirely *after* the last
// counted character is subtracted from a span that ends before it, the result
// goes negative, and `Math.max(1, ...)` turns that into 1 ms: a few hundred
// characters then read as over a hundred thousand tok/s. No poll between the
// deltas and the tool close, so the frozen-estimate cache cannot mask it.
ev('session.execution.started', { sessionID: SESSION });
for (let i = 0; i < 5; i += 1) {
  ev('session.text.delta', {
    sessionID: SESSION,
    assistantMessageID: 'msgQ',
    ordinal: 0,
    delta: 'q'.repeat(60),
  });
  await sleep(120);
}
ev('session.tool.called', { sessionID: SESSION, assistantMessageID: 'msgQ', id: 'toolQ' });
await sleep(1500); // the tool outlasts the ~600 ms of generation before it
ev('session.tool.success', { sessionID: SESSION, assistantMessageID: 'msgQ', id: 'toolQ' });
await sleep(200);
rate = await (await svcFetch('/rate')).json();
check(
  'estimate survives a tool that outlasts generation',
  rate.running === null || rate.running.tps < 1000,
  `tps=${rate.running?.tps}`,
);
ev('session.execution.succeeded', { sessionID: SESSION });
await sleep(150);
rate = await (await svcFetch('/rate')).json();
check(
  'finalized estimate stays plausible',
  rate.lastTurn === null || rate.lastTurn.tokensPerSecond < 1000,
  `tps=${rate.lastTurn?.tokensPerSecond}`,
);

// --- the feed is the only thing the service dials ---------------------------
// No borrowed client token, no scanning a parent's listening ports, no guessing
// a desktop port: everything read goes to the address OpenChamber named, with
// the service's own token.
check('the service dialled nothing else on this machine', decoyHits.length === 0, JSON.stringify(decoyHits));
check(
  'every feed request carries the service token',
  feedSeen.length > 0 && feedSeen.every((entry) => entry.authorization === `Bearer ${SERVICE_TOKEN}`),
  JSON.stringify(feedSeen.slice(0, 2)),
);

const startService = async (label, port, env) => {
  const child = spawn(process.execPath, ['service/main.js'], {
    env: { ...process.env, OPENCHAMBER_SERVICE_PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[${label}] ${d}`));
  const call = (route, init) => fetch(`http://127.0.0.1:${port}${route}`, {
    ...init,
    headers: { Authorization: `Bearer ${env.OPENCHAMBER_SERVICE_TOKEN}`, ...(init?.headers ?? {}) },
  });
  let ready = false;
  for (let i = 0; i < 50 && !ready; i += 1) {
    try { ready = (await call('/health')).ok; } catch { /* not up yet */ }
    if (!ready) await sleep(100);
  }
  check(`${label}: starts`, ready);
  return { child, call };
};
const stopService = async (handle) => {
  handle.child.kill();
  await once(handle.child, 'exit');
};

// --- without the approval there is nothing to measure -----------------------
// `provides: ["opencode"]` is what makes OpenChamber hand the service its
// OpenCode. Without that address the service has no second source to fall back
// on, and the panel has to say what is missing.
{
  const svc6 = await startService('no-feed', svcPort + 20, {
    OPENCHAMBER_SERVICE_TOKEN: SERVICE_TOKEN,
    OPENCHAMBER_GAUGE_STATE: `${STATE_FILE}.nofeed`,
  });
  await sleep(300);
  const rate = await (await svc6.call('/rate')).json();
  check(
    'no feed address answers as a missing permission, not as a broken network',
    rate.connection === 'error' && rate.errorKind === 'access',
    JSON.stringify({ connection: rate.connection, errorKind: rate.errorKind, error: rate.error }),
  );
  await stopService(svc6);
  fs.rmSync(`${STATE_FILE}.nofeed`, { force: true });
}

// --- a feed that refuses the token says so ----------------------------------
{
  const svc7 = await startService('refused', svcPort + 21, {
    OPENCHAMBER_SERVICE_TOKEN: 'not-the-feed-token',
    OPENCHAMBER_GAUGE_STATE: `${STATE_FILE}.refused`,
    OPENCHAMBER_OPENCODE_URL: FEED_URL,
  });
  let refused = null;
  for (let i = 0; i < 40 && refused?.errorKind !== 'access'; i += 1) {
    await sleep(100);
    refused = await (await svc7.call('/rate')).json();
  }
  check(
    'a refused feed is reported as a permission problem',
    refused?.connection === 'error' && refused?.errorKind === 'access',
    JSON.stringify({ connection: refused?.connection, errorKind: refused?.errorKind, error: refused?.error }),
  );
  await stopService(svc7);
  fs.rmSync(`${STATE_FILE}.refused`, { force: true });
}

// --- an OpenCode that does not know the type list reads the whole stream ----
// Gauge asks for the event types it uses so a busy afternoon does not spend the
// host's response limit on traffic it never reads. An OpenCode that refuses the
// list must not leave the panel without numbers.
{
  const plain = new Set();
  const filtered = http.createServer((req, res) => {
    if (feedPath(req.url) !== '/api/event') { res.writeHead(404).end(); return; }
    if (new URL(req.url, 'http://127.0.0.1').searchParams.has('types')) {
      res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"error":{"message":"unknown event type"}}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    plain.add(res);
    req.on('close', () => plain.delete(res));
  });
  await new Promise((resolve) => filtered.listen(0, '127.0.0.1', resolve));
  const svc8 = await startService('unfiltered', svcPort + 22, {
    OPENCHAMBER_SERVICE_TOKEN: SERVICE_TOKEN,
    OPENCHAMBER_GAUGE_STATE: `${STATE_FILE}.unfiltered`,
    OPENCHAMBER_OPENCODE_URL: `http://127.0.0.1:${filtered.address().port}`,
  });
  let plainLive = null;
  for (let i = 0; i < 60; i += 1) {
    await sleep(100);
    plainLive = await (await svc8.call('/rate')).json();
    if (plain.size > 0 && plainLive?.connection === 'live') break;
  }
  check(
    'a refused type list falls back to the whole stream',
    plain.size > 0 && plainLive?.connection === 'live',
    JSON.stringify(plainLive && { connection: plainLive.connection, error: plainLive.error }),
  );
  for (const res of plain) res.destroy();
  filtered.close();
  await stopService(svc8);
  fs.rmSync(`${STATE_FILE}.unfiltered`, { force: true });
}

// --- the stream is cut in the middle of a reply -----------------------------
// The host ends every transfer at 8 MB and OpenCode drops a consumer that falls
// behind, so a cut mid-reply is ordinary, not an outage: the turn in flight
// keeps its measurement, and the numbers continue from the next event.
{
  ev('session.execution.started', { sessionID: SESSION });
  ev('session.step.started', { sessionID: SESSION, assistantMessageID: 'msgCut' });
  ev('session.text.delta', { sessionID: SESSION, assistantMessageID: 'msgCut', ordinal: 0, delta: 'a'.repeat(400) });
  await sleep(200);
  const beforeCut = await (await svcFetch('/rate')).json();
  check('the turn is live before the cut', beforeCut.busy === true && beforeCut.live.tps > 0, JSON.stringify({ busy: beforeCut.busy, tps: beforeCut.live.tps }));
  for (const res of clients) res.destroy();
  await sleep(400); // the reconnect is immediate; this is the round trip
  const afterCut = await (await svcFetch('/rate')).json();
  check('the service reconnected', afterCut.connection === 'live', JSON.stringify({ connection: afterCut.connection, error: afterCut.error }));
  check(
    'a cut that was healthy keeps the turn in flight',
    afterCut.busy === true && afterCut.turn.active === true,
    JSON.stringify({ busy: afterCut.busy, turn: afterCut.turn }),
  );
  ev('session.text.delta', { sessionID: SESSION, assistantMessageID: 'msgCut', ordinal: 1, delta: 'b'.repeat(400) });
  ev('session.step.ended', { sessionID: SESSION, assistantMessageID: 'msgCut', tokens: { input: 0, output: 200, reasoning: 0 }, cost: 0 });
  ev('session.execution.succeeded', { sessionID: SESSION });
  await sleep(200);
  const settled = await (await svcFetch('/rate')).json();
  check(
    'the turn settles with the tokens it reported',
    settled.lastTurn?.tokens === 200 && settled.turn.active === false,
    JSON.stringify(settled.lastTurn),
  );
  check('the live rate keeps counting after the cut', settled.live.tps >= 0, JSON.stringify(settled.live));
}

// --- the service sends its readings to the open pages -----------------------
// A page used to ask four times a second whether anything had changed. Now the
// service posts each watched session's reading to the host, which delivers it to
// the section's frame. The mock callback is what an OpenChamber does.
{
  const calls = [];
  const callback = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (req.url !== '/service/call') { res.writeHead(404).end(); return; }
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* not a call */ }
      calls.push(parsed);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result: { delivered: true } }));
    });
  });
  await new Promise((resolve) => callback.listen(0, '127.0.0.1', resolve));
  const svc9 = await startService('pushing', svcPort + 23, {
    OPENCHAMBER_SERVICE_TOKEN: SERVICE_TOKEN,
    OPENCHAMBER_GAUGE_STATE: `${STATE_FILE}.push`,
    OPENCHAMBER_OPENCODE_URL: FEED_URL,
    OPENCHAMBER_HOST_CALLBACK_URL: `http://127.0.0.1:${callback.address().port}`,
  });
  const watched = await (await svc9.call('/watch', { method: 'POST', body: JSON.stringify({ sessionId: SESSION, model: 'smoke-model' }) })).json();
  check('a watch reports that this host takes events', watched.push === true, JSON.stringify(watched));
  ev('session.execution.started', { sessionID: SESSION });
  ev('session.step.started', { sessionID: SESSION, assistantMessageID: 'msgPush' });
  ev('session.text.delta', { sessionID: SESSION, assistantMessageID: 'msgPush', ordinal: 0, delta: 'c'.repeat(600) });
  let pushed = null;
  for (let i = 0; i < 40 && !pushed; i += 1) {
    await sleep(100);
    const call = calls.find((entry) => entry?.method === 'panels.emit');
    pushed = call?.input?.topic === 'rate' ? call.input.data : null;
  }
  check(
    'a watched session gets its reading pushed',
    pushed !== null && pushed.session === SESSION && pushed.rate?.connection === 'live',
    JSON.stringify(pushed && { session: pushed.session, connection: pushed.rate?.connection }),
  );
  check(
    'a push carries the same body a page reads',
    pushed !== null && ['live', 'curve', 'turn', 'lastTurn', 'cache', 'gauge'].every((field) => field in (pushed?.rate ?? {})),
    JSON.stringify(pushed && Object.keys(pushed.rate)),
  );
  const quiet = calls.filter((entry) => entry?.method === 'panels.emit').length;
  check('an unchanged reading is sent at most once every couple of seconds', quiet <= 6, `emits=${quiet}`);
  ev('session.text.delta', { sessionID: SESSION, assistantMessageID: 'msgPush', ordinal: 1, delta: 'd'.repeat(600) });
  let moved = false;
  for (let i = 0; i < 40 && !moved; i += 1) {
    await sleep(100);
    moved = calls.filter((entry) => entry?.method === 'panels.emit').length > quiet;
  }
  check('a changed reading is pushed at once', moved, `emits=${calls.filter((entry) => entry?.method === 'panels.emit').length}`);
  ev('session.execution.succeeded', { sessionID: SESSION });
  await stopService(svc9);
  callback.close();
  fs.rmSync(`${STATE_FILE}.push`, { force: true });
}

// --- a host that does not deliver events is not a broken service ------------
{
  const refusing = http.createServer((req, res) => { res.writeHead(502).end(); });
  await new Promise((resolve) => refusing.listen(0, '127.0.0.1', resolve));
  const svc10 = await startService('no-push', svcPort + 24, {
    OPENCHAMBER_SERVICE_TOKEN: SERVICE_TOKEN,
    OPENCHAMBER_GAUGE_STATE: `${STATE_FILE}.nopush`,
    OPENCHAMBER_OPENCODE_URL: FEED_URL,
    OPENCHAMBER_HOST_CALLBACK_URL: `http://127.0.0.1:${refusing.address().port}`,
  });
  const answered = await (await svc10.call('/watch', { method: 'POST', body: JSON.stringify({ sessionId: SESSION }) })).json();
  let told = answered;
  for (let i = 0; i < 20 && told.push !== false; i += 1) {
    await sleep(100);
    told = await (await svc10.call('/watch', { method: 'POST', body: JSON.stringify({ sessionId: SESSION }) })).json();
  }
  check('a host that will not take events says so to the page', told.push === false, JSON.stringify(told));
  const stillReading = await (await svc10.call(`/rate?sessionId=${SESSION}`)).json();
  check('and the page can still ask for numbers itself', stillReading.connection === 'live', JSON.stringify(stillReading.connection));
  await stopService(svc10);
  refusing.close();
  fs.rmSync(`${STATE_FILE}.nopush`, { force: true });
}

console.log(failures === 0 ? '\nALL SMOKE TESTS PASSED' : `\n${failures} FAILURES`);
svc.kill();
for (const res of clients) res.destroy();
feedServer.closeAllConnections();
feedServer.close();
decoy.close();
fs.rmSync(STATE_FILE, { force: true });
process.exit(failures === 0 ? 0 : 1);
