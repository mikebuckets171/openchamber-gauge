import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makePlugin } from './index.js';
import { key } from './store.js';
import { createProgressLookup, isLlamaCppProps, namesLlamaCpp, namesSplash, probeLlamaCpp, progressEndpoint } from './providers.js';

const row = (id, name, baseURL) => ({ id, name, activation: 'enabled', package: '@opencode/ai/providers/openai-compatible', settings: { baseURL, apiKey: 'sk-never-read' } });
const SPLASH = row('splash', 'Splash', 'http://127.0.0.1:18181/v1');
const clock = (start = 1_000_000) => { let at = start; return { now: () => at, advance: ms => { at += ms; } }; };
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };

test('Splash is named by id or name, with LM Studio taking precedence', () => {
  for (const [id, name] of [['splash', 'Splash'], ['Splash ', ''], ['local', 'Splash'], ['splish', 'x'], ['my-splish-fork', ''], ['llama-swap', 'Splash via llama-swap']]) assert.equal(namesSplash(id, name), true, `${id}/${name}`);
  for (const [id, name] of [['splash-bionic', 'Splash via Bionic'], ['lmstudio', 'Splash'], ['omlx', 'oMLX'], ['openai', 'OpenAI'], ['ollama', 'Ollama'], ['', '']]) assert.equal(namesSplash(id, name), false, `${id}/${name}`);
});

test('a llama.cpp engine is named by id or name, with LM Studio and Ollama refused', () => {
  for (const [id, name] of [['llama', 'llama.cpp'], ['local', 'llama-server'], ['llama-cpp', 'Local'], ['llamacpp', ''], ['swap', 'llama-swap'], ['cpp', 'llama.cpp router']]) assert.equal(namesLlamaCpp(id, name), true, `${id}/${name}`);
  // Ollama runs llama.cpp inside and answers with its own API; LM Studio is the
  // rule MLX Scope already refused first.
  for (const [id, name] of [['ollama', 'Ollama'], ['ollama-local', 'llama.cpp through Ollama'], ['lmstudio', 'llama.cpp'], ['local', 'Bionic llama.cpp'], ['splash', 'Splash'], ['openai', 'OpenAI'], ['', '']]) assert.equal(namesLlamaCpp(id, name), false, `${id}/${name}`);
});

test('a loopback /v1 endpoint is canonicalized; anything else is refused', () => {
  assert.deepEqual(progressEndpoint({ providerID: 'splash', baseURL: 'http://localhost:8000/v1/' }),
    { providerID: 'splash', origin: 'http://127.0.0.1:8000', endpointKey: key('endpoint', 'http://127.0.0.1:8000') });
  for (const [baseURL, origin] of [['https://127.0.0.1:8000/v1', 'https://127.0.0.1:8000'], ['http://[::1]:8000/v1', 'http://[::1]:8000'], ['http://localhost:8000/v1/', 'http://127.0.0.1:8000']]) {
    assert.equal(progressEndpoint({ providerID: 'splash', baseURL }).origin, origin, baseURL);
  }
  for (const baseURL of [undefined, 'http://127.0.0.1:8000', 'http://127.0.0.1:8000/v1/chat', 'http://example.com/v1', 'http://127.0.0.1:8000/v1?x=1', 'http://user:pw@127.0.0.1:8000/v1', 'http://127.0.0.1:8000/v1#f', 'not a url']) {
    if (baseURL === undefined) { assert.equal(progressEndpoint({}).origin, 'http://127.0.0.1:8000'); continue; }
    assert.throws(() => progressEndpoint({ providerID: 'splash', baseURL }), /loopback/);
  }
});

test('only llama.cpp server properties answer as llama.cpp', () => {
  // The body shape llama.cpp's server README documents for GET /props.
  assert.equal(isLlamaCppProps({ total_slots: 4, slots: [{ id: 0 }], default_generation_settings: { id: 0, n_ctx: 262144 }, model_path: '/models/qwen.gguf', model_alias: 'qwen' }), true);
  assert.equal(isLlamaCppProps({ default_generation_settings: { id: 0 }, model_path: '/models/qwen.gguf' }), true);
  assert.equal(isLlamaCppProps({ total_slots: 4, default_generation_settings: { id: 0 } }), true);
  assert.equal(isLlamaCppProps({ error: { type: 'unknown', message: 'not found' } }), false);
  assert.equal(isLlamaCppProps({ src: 'llama-swap', error: { message: 'unauthorized' } }), false);
  assert.equal(isLlamaCppProps({ data: [{ id: 'qwen', object: 'model' }] }), false);
  assert.equal(isLlamaCppProps({ status: 'ok' }), false);
  assert.equal(isLlamaCppProps({ model_path: '/models/qwen.gguf' }), false);
  assert.equal(isLlamaCppProps(null), false);
  assert.equal(isLlamaCppProps([]), false);
  assert.equal(isLlamaCppProps('llama.cpp'), false);
});

const serveProps = async (handler) => {
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
};

test('the probe is one GET /props, and only a llama.cpp body answers yes', async () => {
  const seen = [];
  const engine = await serveProps((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ total_slots: 2, default_generation_settings: { id: 0, n_ctx: 32768 }, model_path: '/models/m.gguf' }));
  });
  assert.equal(await probeLlamaCpp(engine.origin), true);
  assert.deepEqual(seen, ['/props']);

  const swap = await serveProps((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ src: 'llama-swap', error: { message: 'unauthorized: invalid or missing API key', type: 'authentication_error' } }));
  });
  assert.equal(await probeLlamaCpp(swap.origin), false, 'an engine behind an API key is not asked for its key');

  const other = await serveProps((req, res) => { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'not found' } })); });
  assert.equal(await probeLlamaCpp(other.origin), false);

  const html = await serveProps((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html><title>llama.cpp</title></html>'); });
  assert.equal(await probeLlamaCpp(html.origin), false, 'a web page is not the properties endpoint');

  const silent = await serveProps(() => { /* never answers */ });
  assert.equal(await probeLlamaCpp(silent.origin, { timeoutMs: 60 }), false, 'a stalled engine is refused rather than waited for');
  for (const host of [engine, swap, other, html, silent]) await host.close();
});

test('a named engine is asked at once; any other local engine only after /props', async () => {
  const asks = [];
  const time = clock();
  const lookup = createProgressLookup({
    list: async () => [SPLASH, row('swap', 'llama-swap', 'http://127.0.0.1:8080/v1'), row('local', 'Local model', 'http://127.0.0.1:8081/v1'), row('openai', 'OpenAI', 'https://api.openai.com/v1')],
    probe: async origin => { asks.push(origin); return origin.endsWith('8081'); },
    now: time.now,
  });
  assert.equal((await lookup('splash'))?.progress, true);
  assert.equal((await lookup('swap'))?.progress, true);
  await settle();
  assert.deepEqual(asks, [], 'a named engine is never probed');

  const unnamed = await lookup('local');
  assert.equal(unnamed.progress, false, 'the first request leaves unaltered while the probe runs');
  await settle();
  assert.deepEqual(asks, ['http://127.0.0.1:8081']);
  assert.equal((await lookup('local')).progress, true, 'a probe that answered makes the next request ask');
  assert.equal(await lookup('openai'), null, 'a cloud provider is not a local engine');
});

test('a probe that answered no is kept, and re-asked only after its own interval', async () => {
  const asks = [];
  const time = clock();
  const lookup = createProgressLookup({
    list: async () => [row('local', 'Local model', 'http://127.0.0.1:8081/v1')],
    probe: async () => { asks.push(1); return false; },
    now: time.now, probeRetryMs: 30_000,
  });
  for (let i = 0; i < 3; i++) assert.equal((await lookup('local')).progress, false);
  await settle();
  assert.equal(asks.length, 1, 'one engine gets one probe');
  time.advance(29_000);
  assert.equal((await lookup('local')).progress, false);
  await settle();
  assert.equal(asks.length, 1, 'a fresh negative answer is respected');
  time.advance(2_000);
  assert.equal((await lookup('local')).progress, false);
  await settle();
  assert.equal(asks.length, 2, 'the engine is asked again once the answer is old');
});

test('a probe that answered yes is kept for minutes, and one flight per endpoint', async () => {
  const asks = [];
  const time = clock();
  let resolveProbe;
  const lookup = createProgressLookup({
    list: async () => [row('a', 'Local a', 'http://127.0.0.1:8081/v1'), row('b', 'Local b', 'http://localhost:8081/v1')],
    probe: async () => { asks.push(1); return new Promise(resolve => { resolveProbe = resolve; }); },
    now: time.now,
  });
  assert.equal((await lookup('a')).progress, false);
  assert.equal((await lookup('b')).progress, false, 'localhost and 127.0.0.1 are the same endpoint');
  await settle();
  assert.equal(asks.length, 1, 'two providers on one endpoint share one probe');
  resolveProbe(true);
  await settle();
  assert.equal((await lookup('a')).progress, true);
  assert.equal((await lookup('b')).progress, true);
  time.advance(4 * 60_000);
  assert.equal((await lookup('a')).progress, true);
  await settle();
  assert.equal(asks.length, 1);
  time.advance(61_000);
  assert.equal((await lookup('a')).progress, false, 'a kept answer is asked again once it is old');
  await settle();
  assert.equal(asks.length, 2);
  resolveProbe(true);
  await settle();
  assert.equal((await lookup('a')).progress, true, 'and the engine is asked again, not left unasked');
});

test('the provider list is read lazily, once, and a hung read cannot hold a request', async () => {
  let reads = 0, down = false;
  const time = clock();
  const lookup = createProgressLookup({ list: async () => { reads++; if (down) throw new Error('down'); return [SPLASH]; }, now: time.now });
  assert.equal((await lookup('splash'))?.progress, true);
  assert.equal((await lookup('splash'))?.progress, true);
  assert.equal(reads, 1);
  time.advance(31_000);
  void lookup('splash');
  await settle();
  assert.equal(reads, 2);
  time.advance(1_000);
  void lookup('splash');
  await settle();
  assert.equal(reads, 2, 'retries are at least retryMs apart');
  down = true;
  time.advance(31_000);
  assert.equal((await lookup('splash'))?.progress, true, 'a failed read keeps the last answer');

  const hung = createProgressLookup({ list: () => new Promise(() => {}), now: time.now, firstWaitMs: 100 });
  const at = time.now();
  assert.equal(await hung('splash'), null);
  assert.ok(time.now() - at <= 100, 'a request waits for the first read at most firstWaitMs');

  for (const list of [async () => null, async () => [null], async () => [{ id: 1 }], async () => [{ id: 'ok' }], () => { throw new Error('boom'); }]) {
    const lazy = createProgressLookup({ list });
    assert.equal(await lazy('splash'), null);
  }
  for (const id of [undefined, null, 1, 'x'.repeat(81), 'not an id', '']) assert.equal(await lookup(id), null);
});

test('an unnamed engine without a loopback /v1 is never asked, whatever it is named', async () => {
  const asks = [];
  const lookup = createProgressLookup({
    list: async () => [row('cpp', 'llama.cpp', 'https://cpp.example/v1'), row('odd', 'llama-server', 'http://127.0.0.1:8081/v1/chat')],
    probe: async () => { asks.push(1); return true; },
  });
  assert.equal(await lookup('cpp'), null);
  assert.equal(await lookup('odd'), null);
  await settle();
  assert.deepEqual(asks, []);
});

test('the plugin adds return_progress only where progress is known', async () => {
  const store = { update: () => {}, remove: () => {}, close: async () => {} };
  const seen = [];
  const plugin = makePlugin({
    storeFactory: () => store,
    shared: {},
    warn: () => {},
    probe: async () => { seen.push('probe'); return false; },
  });
  const hooks = {};
  const teardown = await plugin.setup({
    app: { version: '2.0.25' },
    provider: { list: async () => [row('splash', 'Splash', 'http://127.0.0.1:18181/v1'), row('other', 'Local model', 'http://127.0.0.1:18182/v1')] },
    session: { hook: async (name, handler) => { (hooks[name] ??= []).push(handler); return { dispose: async () => {} }; } },
  });
  const fire = async (name, event) => { for (const handler of hooks[name] ?? []) await handler(event); };
  const request = (providerID, origin) => new Request(`${origin}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-opencode-session-id': 'ses_1' },
    body: JSON.stringify({ model: 'm', stream: true }),
  });
  const event = (providerID, origin) => ({ kind: 'primary', sessionID: 'ses_1', model: { providerID, id: 'm' }, request: request(providerID, origin) });

  const splash = event('splash', 'http://127.0.0.1:18181');
  await fire('http.request', splash);
  assert.deepEqual(JSON.parse(await splash.request.text()), { model: 'm', stream: true, return_progress: true }, 'a named engine is asked');

  const other = event('other', 'http://127.0.0.1:18182');
  await fire('http.request', other);
  assert.deepEqual(JSON.parse(await other.request.text()), { model: 'm', stream: true }, 'an unprobed engine is left as OpenCode wrote it');
  await settle();
  assert.deepEqual(seen, ['probe'], 'the probe runs in the background, not on the request');
  assert.equal(JSON.parse(await event('other', 'http://127.0.0.1:18182').request.text()).return_progress, undefined);
  await teardown();
});
