// Gauge's OpenCode helper: Splash prompt progress, nothing else.
//
// Ported from MLX Scope 6.0's helper (bridge/opencode, MIT) with its chat-delivery
// observer removed. On a streaming Splash request it adds Splash's documented
// `return_progress: true` option, watches the same response for `prompt_progress`
// frames until output starts, and writes `{ total, cache, processed }` per request
// to ~/.cache/gauge/prompt-progress. Gauge's service reads that file. No prompt,
// reply, header, key or raw session id is saved.
import { randomUUID } from 'node:crypto';
import { createStore, key } from './store.js';
import { observeStream } from './stream.js';
import { createSplashLookup, splashOptions } from './providers.js';

const SHARED = Symbol.for('gauge.prompt-progress.1');
const PATHS = new Set(['/v1/chat/completions', '/v1/responses', '/v1/messages']);
const KINDS = new Set(['primary', 'compaction', 'title', 'generate']);
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

/** OpenCode 2 releases from 2.0.25 keep the session hook contract this reads; a new major is not assumed. */
export const acceptsRuntime = version => {
  if (typeof version !== 'string') return false;
  if (version === '2.1.1-compaction.1') return true;
  const match = /^2\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/.exec(version);
  return !!match && (match[1] !== '0' || Number(match[2]) >= 25);
};

function eligible(event, config) {
  if (event.model?.providerID !== config.providerID || !KINDS.has(event.kind)
    || typeof event.sessionID !== 'string' || event.sessionID.length === 0 || event.sessionID.length > 256
    || typeof event.model.id !== 'string' || event.model.id.length > 1024) return false;
  const request = event.request;
  try {
    const url = new URL(request.url);
    return request.method === 'POST' && url.origin === config.origin && PATHS.has(url.pathname.replace(/\/+$/, ''))
      && !url.search && !url.hash && !url.username && !url.password
      && request.headers.get('x-opencode-session-id') === event.sessionID
      && request.headers.get('content-type')?.toLowerCase().includes('application/json');
  } catch { return false; }
}

async function jsonBody(request) {
  if (Number(request.headers.get('content-length')) > MAX_REQUEST_BYTES) return null;
  const reader = request.clone().body?.getReader();
  if (!reader) return null;
  let length = 0; const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > MAX_REQUEST_BYTES) { void reader.cancel().catch(() => {}); return null; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const body = JSON.parse(new TextDecoder().decode(bytes));
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch { return null; } finally { reader.releaseLock(); }
}

export function makePlugin({ storeFactory = createStore, shared = globalThis, warn = message => console.warn(message) } = {}) {
  return {
    id: 'gauge-prompt-progress',
    async setup(ctx) {
      const active = new Map(), prepared = new WeakMap(), registrations = [];
      if (!acceptsRuntime(ctx.app?.version) || ctx.options?.promptProgress === false) return async () => {};
      if (typeof ctx.session?.hook !== 'function') { warn('Gauge prompt progress is unavailable: no session hooks.'); return async () => {}; }
      // OpenChamber lists the plugin without options, so Splash is found from OpenCode's own provider list as
      // requests arrive. A copy added by hand with `providerID` and `baseURL` uses exactly those.
      let config = null, lookup = null;
      const named = ctx.options?.providerID !== undefined || ctx.options?.baseURL !== undefined;
      if (!named && typeof ctx.provider?.list === 'function') {
        lookup = createSplashLookup({ list: async () => {
          const value = await ctx.provider.list();
          return Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data : [];
        } });
      } else {
        try { config = splashOptions(ctx.options); }
        catch { warn('Gauge prompt progress options are not a loopback Splash /v1 endpoint.'); return async () => {}; }
      }
      const holder = shared[SHARED] ??= { store: storeFactory({ warn }), refs: 0 };
      holder.refs += 1;
      const store = holder.store;
      let released = false;
      const teardown = async () => {
        if (released) return; released = true;
        for (const registration of registrations) try { await registration?.dispose?.(); } catch { /* passive cleanup */ }
        for (const close of active.values()) try { close(); } catch { /* passive cleanup */ }
        if (--holder.refs === 0) {
          if (shared[SHARED] === holder) delete shared[SHARED];
          await store.close();
        }
      };
      const hook = async (...args) => { registrations.push(await ctx.session.hook(...args)); };
      try {
        const filter = config ? [{ providerID: config.providerID }] : [];
        await hook('http.request', async event => {
          if (released) return;
          const target = config ?? await lookup(event.model?.providerID);
          if (!target || !eligible(event, target) || event.request.signal.aborted) return;
          const body = await jsonBody(event.request);
          if (!body || body.stream !== true || event.request.signal.aborted) return;
          const headers = new Headers(event.request.headers); headers.delete('content-length');
          event.request = new Request(event.request, { headers, body: JSON.stringify({ ...body, return_progress: true }) });
          prepared.set(event.request, target);
        }, ...filter);
        await hook('http.response', event => {
          if (released) return;
          const target = prepared.get(event.request);
          if (!target || !eligible(event, target)) return;
          const requestID = randomUUID();
          const metadata = { requestID, sessionKey: key('session', event.sessionID), providerID: target.providerID,
            endpointKey: target.endpointKey, modelKey: key('model', event.model.id), kind: event.kind };
          event.response = observeStream(event.response, { metadata, store, signal: event.request.signal,
            onObserver: finish => active.set(requestID, finish), onClose: () => active.delete(requestID) });
        }, ...filter);
        return teardown;
      } catch {
        await teardown().catch(() => {});
        warn('Gauge prompt progress is unavailable: OpenCode refused its hooks.');
        return async () => {};
      }
    },
  };
}

export default makePlugin();
