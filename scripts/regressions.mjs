import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gauge-regressions-'));
const dataDir = path.join(root, '.config', 'openchamber');
await fs.mkdir(path.join(dataDir, 'run'), { recursive: true });
const servers = [];
const streams = new Set();
let service;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listen = async (handler) => {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port, origin: `http://127.0.0.1:${server.address().port}` };
};

let leakedRequests = 0;
const sink = await listen((req, res) => {
  // Origin discovery may probe this parent-owned port without credentials.
  if (req.url === '/login' || req.url === '/events' || req.headers.cookie || req.headers.authorization) {
    leakedRequests += 1;
  }
  res.writeHead(200).end();
});

const password = 'test-password';
let cookie = 'oc_ui_session_123=test-session';
let cookieRequests = 0;
const protectedHost = await listen(async (req, res) => {
  if (req.url === '/auth/session') {
    let body = '';
    for await (const chunk of req) body += chunk;
    assert.equal(JSON.parse(body).password, password);
    res.writeHead(200, { 'Set-Cookie': `${cookie}; HttpOnly; Path=/`, 'Content-Type': 'application/json' });
    res.end('{}');
    return;
  }
  if (req.headers.cookie !== cookie) {
    res.writeHead(401).end();
    return;
  }
  cookieRequests += 1;
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.flushHeaders();
  streams.add(res);
  res.on('close', () => streams.delete(res));
});

let desktopLoginAttempts = 0;
let desktopAuthenticatedRequests = 0;
let holdDesktopResponse = false;
const desktopHost = await listen((req, res) => {
  if (req.url === '/auth/session') {
    desktopLoginAttempts += 1;
    res.writeHead(500).end();
    return;
  }
  if (req.headers.authorization !== 'Bearer test-desktop-token') {
    res.writeHead(401).end();
    return;
  }
  if (req.url === '/api/global/event') desktopAuthenticatedRequests += 1;
  // Keep the initial desktop request open until the other origin is tried, so
  // the service cannot establish a sticky desktop connection before /watch.
  if (holdDesktopResponse) return;
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.flushHeaders();
  streams.add(res);
  res.on('close', () => streams.delete(res));
});

let loginRedirects = 0;
let streamRedirects = 0;
const redirectedLogin = await listen((req, res) => {
  if (req.url === '/auth/session') {
    loginRedirects += 1;
    res.writeHead(307, { Location: `${sink.origin}/login` }).end();
  } else res.writeHead(401).end();
});
const redirectedStream = await listen((req, res) => {
  if (req.url === '/auth/session') {
    res.writeHead(200, { 'Set-Cookie': `${cookie}; Path=/` }).end('{}');
  } else if (req.headers.cookie === cookie) {
    streamRedirects += 1;
    res.writeHead(302, { Location: `${sink.origin}/events` }).end();
  } else res.writeHead(401).end();
});

const untrustedAuthHeaders = [];
const untrustedHost = await listen((req, res) => {
  untrustedAuthHeaders.push(req.headers.authorization ?? null);
  holdDesktopResponse = false;
  res.writeHead(401).end();
});

for (const host of [protectedHost, redirectedLogin, redirectedStream]) {
  await fs.writeFile(
    path.join(dataDir, 'run', `openchamber-${host.port}.json`),
    JSON.stringify({ uiPassword: password }),
  );
}
// Start without a desktop token: the password fallback is the only credential
// available, and origin discovery must not mistake desktopHost for a usable
// stream before its own test.
await fs.writeFile(path.join(dataDir, 'settings.json'), JSON.stringify({
  desktopLocalPort: desktopHost.port,
}));

/**
 * Start the service on a free port with its own state file.
 *
 * Each host under test needs a service that has not yet found its server:
 * once the service knows one, it keeps that origin on purpose, so a second
 * surface does not tear the stream down, and the host it should have dialled
 * is never reached.
 */
const startService = async (stateName, serviceDataDir = dataDir) => {
  const reservation = await listen((req, res) => res.end());
  const port = reservation.port;
  await new Promise((resolve) => reservation.server.close(resolve));
  const child = spawn(process.execPath, ['service/main.js'], {
    env: {
      PATH: process.env.PATH, HOME: root, USERPROFILE: root,
      OPENCHAMBER_SERVICE_PORT: String(port), OPENCHAMBER_SERVICE_TOKEN: 'test-service-token',
      OPENCHAMBER_GAUGE_STATE: path.join(root, stateName),
      OPENCHAMBER_DATA_DIR: serviceDataDir,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const request = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      headers: { Authorization: 'Bearer test-service-token', 'Content-Type': 'application/json' },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  return { child, request };
};

const stopService = async (child) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  const timer = setTimeout(() => child.kill('SIGKILL'), 2_000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
};

try {
  const started = await startService('state.json');
  service = started.child;
  const { request } = started;
  const until = async (condition) => {
    for (let i = 0; i < 80; i += 1) {
      try { if (await condition()) return; } catch {}
      await delay(100);
    }
    throw new Error('Timed out waiting for service state');
  };
  await until(async () => (await request('/health')).ok);
  const watch = (host) => request('/watch', { origin: host.origin, sessionId: 'session-a' });
  await watch(protectedHost);
  await until(async () => (await request('/rate')).connection === 'live');
  assert.ok(cookieRequests > 0);
  console.log('ok password-protected event stream');

  // Interleave two models before either settles. Each correction must land on its own model.
  await request('/watch', { origin: protectedHost.origin, sessionId: 'session-b' });
  const emit = (type, data) => {
    for (const stream of streams) stream.write(`data: ${JSON.stringify({ type, data })}\n\n`);
  };
  for (const [sessionID, modelID] of [['session-a', 'model-a'], ['session-b', 'model-b']]) {
    emit('session.execution.started', { sessionID });
    emit('session.step.started', { sessionID, modelID, assistantMessageID: sessionID });
    emit('session.text.delta', { sessionID, assistantMessageID: sessionID, delta: 'x'.repeat(400) });
  }
  await delay(200);
  for (const [sessionID, output] of [['session-a', 200], ['session-b', 50]]) {
    emit('session.step.ended', { sessionID, assistantMessageID: sessionID, tokens: { output, reasoning: 0 } });
    emit('session.execution.succeeded', { sessionID });
  }
  await until(async () => {
    const saved = JSON.parse(await fs.readFile(path.join(root, 'state.json'), 'utf8'));
    return saved.models['model-a'] === 1.3 && saved.models['model-b'] === 0.85;
  });
  console.log('ok concurrent sessions keep separate model calibration');

  cookie = 'oc_ui_session_123=refreshed-session';
  for (const stream of streams) stream.destroy();
  const beforeRefresh = cookieRequests;
  await until(async () => cookieRequests > beforeRefresh && (await request('/rate')).connection === 'live');
  console.log('ok expired session credentials are refreshed on reconnect');

  // A host that redirects the login, and a host that redirects the event
  // stream, must never carry a credential to the place the redirect points.
  // Each gets its own service, because a service that already found its
  // server keeps that origin on purpose and would never dial this host.
  for (const [host, attempted] of [[redirectedLogin, () => loginRedirects], [redirectedStream, () => streamRedirects]]) {
    // Give each process only this host's instance file. Otherwise Linux origin
    // discovery can authenticate to another mock before /watch reaches it.
    const caseDataDir = path.join(root, `host-${host.port}`);
    await fs.mkdir(path.join(caseDataDir, 'run'), { recursive: true });
    await fs.writeFile(path.join(caseDataDir, 'run', `openchamber-${host.port}.json`), JSON.stringify({ uiPassword: password }));
    const fresh = await startService(`state-${host.port}.json`, caseDataDir);
    try {
      await until(async () => (await fresh.request('/health')).ok);
      await fresh.request('/watch', { origin: host.origin, sessionId: 'session-a' });
      await until(async () => attempted() > 0);
      await delay(200);
      assert.equal(leakedRequests, 0);
    } finally {
      await stopService(fresh.child);
    }
  }
  console.log('ok login and authenticated event redirects cannot leak credentials');

  // A previously connected service deliberately keeps its original origin.
  // Use a fresh one and require an authenticated request at the desktop host;
  // merely seeing the old stream still live would be a false pass.
  await stopService(service);
  service = undefined;
  await fs.writeFile(path.join(dataDir, 'settings.json'), JSON.stringify({
    desktopLocalPort: desktopHost.port, desktopLocalClientToken: 'test-desktop-token',
  }));
  untrustedAuthHeaders.length = 0;
  holdDesktopResponse = true;
  const desktop = await startService('desktop-state.json');
  try {
    await until(async () => (await desktop.request('/health')).ok);
    await desktop.request('/watch', { origin: untrustedHost.origin, sessionId: 'session-a' });
    await until(async () => untrustedAuthHeaders.length > 0
      && desktopAuthenticatedRequests > 0 && (await desktop.request('/rate')).connection === 'live');
    assert.ok(untrustedAuthHeaders.every((header) => header === null));
    assert.equal(desktopLoginAttempts, 0);
  } finally {
    holdDesktopResponse = false;
    await stopService(desktop.child);
  }
  console.log('ok an untrusted origin never receives the desktop bearer');
  console.log('ok desktop local bearer authentication is tried before a password');
} finally {
  if (service) await stopService(service);
  for (const stream of streams) stream.destroy();
  for (const server of servers) server.closeAllConnections();
  await Promise.all(servers.filter((server) => server.listening).map((server) => new Promise((resolve) => server.close(resolve))));
  await fs.rm(root, { recursive: true, force: true });
}
