import { key } from './store.js';

const PROVIDER_ID = /^[a-zA-Z0-9_-]{1,80}$/;
const LM_STUDIO = /bionic|lm[\s_-]*studio/;
/** Ollama runs llama.cpp inside and answers with its own API, which knows neither option. */
const OLLAMA = /ollama/;
/** LM Studio and Ollama are never prompt-progress engines, whatever else the name says. */
const refusedName = (id, name) => LM_STUDIO.test(`${id} ${name}`.toLowerCase()) || OLLAMA.test(`${id} ${name}`.toLowerCase());

/** Which OpenCode provider is Splash: the id/name rule MLX Scope used, LM Studio's precedence included. */
export const namesSplash = (id, name) => !refusedName(id, name)
  && (id.trim().toLowerCase() === 'splash' || /splash/i.test(name) || /splish/i.test(`${id} ${name}`));

/**
 * A provider named for a llama.cpp engine: llama.cpp's own server, or llama-swap
 * proxying one. Both pass `return_progress` through and answer with
 * `prompt_progress` frames.
 */
export const namesLlamaCpp = (id, name) => !refusedName(id, name)
  && /llama[\s_.-]*c(\+\+|pp)|llama[\s_.-]*server|llama[\s_.-]*swap/.test(`${id} ${name}`.toLowerCase());

/**
 * A provider's loopback `/v1` endpoint, as Gauge may use it.
 *
 * Loopback only, and `/v1` only: Gauge adds a field to this provider's chat
 * requests, so it does that only to an engine it can see the whole of.
 */
export function progressEndpoint(input = {}) {
  const providerID = typeof input.providerID === 'string' && PROVIDER_ID.test(input.providerID) ? input.providerID : 'splish';
  let url;
  try { url = new URL(input.baseURL ?? 'http://127.0.0.1:8000/v1'); }
  catch { throw new Error('Gauge prompt progress requires a loopback /v1 endpoint.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname.replace(/\/+$/, '') !== '/v1') throw new Error('Gauge prompt progress requires a loopback /v1 endpoint.');
  const canonical = new URL(url.origin); if (canonical.hostname === 'localhost') canonical.hostname = '127.0.0.1';
  return { providerID, origin: canonical.origin, endpointKey: key('endpoint', canonical.origin) };
}

/**
 * Whether a `GET /props` answer is llama.cpp's own server properties.
 *
 * `/props` is llama.cpp's endpoint, documented in its server README, and its body
 * is its own: the generation settings it runs with, and the slots serving them.
 * Two of the three tellings is enough. An OpenAI-shaped error, or a proxy naming
 * itself, is not llama.cpp, and progress stays off for it.
 */
export function isLlamaCppProps(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  if (typeof value.src === 'string' || (value.error !== null && typeof value.error === 'object')) return false;
  const slots = typeof value.total_slots === 'number' || Array.isArray(value.slots);
  const settings = value.default_generation_settings !== null && typeof value.default_generation_settings === 'object';
  const model = typeof value.model_path === 'string' || typeof value.model_alias === 'string';
  return [slots, settings, model].filter(Boolean).length >= 2;
}

const PROBE_TIMEOUT_MS = 2_000;
const PROBE_BODY_MAX = 256 * 1024;

/**
 * Ask a local engine whether it is llama.cpp, with no credential and no retry.
 *
 * An engine behind an API key answers 401 and Gauge does not go looking for that
 * key: what not asking costs is only the prompt line for that provider.
 */
export async function probeLlamaCpp(origin, { fetchImpl = fetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  try {
    const response = await fetchImpl(`${origin}/props`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    });
    if (!response.ok || !(response.headers.get('content-type') ?? '').toLowerCase().includes('json')) {
      await response.body?.cancel().catch(() => undefined);
      return false;
    }
    const text = await response.text();
    if (text.length > PROBE_BODY_MAX) return false;
    return isLlamaCppProps(JSON.parse(text));
  } catch { return false; }
}

/** Only a provider's id, name and base URL are read from OpenCode's list; its settings hold keys. */
function providerRow(row) {
  const id = typeof row?.id === 'string' ? row.id : '', name = typeof row?.name === 'string' ? row.name : '';
  if (!PROVIDER_ID.test(id) || refusedName(id, name)) return null;
  let endpoint;
  try { endpoint = progressEndpoint({ providerID: id, baseURL: row.settings?.baseURL }); } catch { return null; }
  // A named engine is asked at once; any other local engine is asked only after
  // its own `/props` has said it is llama.cpp.
  return { ...endpoint, named: namesSplash(id, name) || namesLlamaCpp(id, name) };
}

const waitFor = (promise, ms) => {
  let timer;
  return Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, ms); })]).finally(() => clearTimeout(timer));
};

/**
 * Which providers Gauge may ask for prompt progress, read from OpenCode when a request arrives.
 *
 * OpenCode loads configured providers after its plugins start (a plugin sees only its own at setup), so the list is
 * read lazily and kept for `ttlMs`. Requests arriving during the very first read share one wait of at most
 * `firstWaitMs`; every other lookup answers from the last read while a fresh one runs behind it, even if the list
 * never answers. A failed read changes nothing and is retried after `retryMs`. A lookup never throws.
 *
 * An unnamed local engine is probed in the background, never on a request's own path: a chat does not wait for a
 * probe, and while one is running its requests leave exactly as OpenCode wrote them. A positive answer is kept for
 * `probeTtlMs`; a negative or unfinished one is re-asked after `probeRetryMs`.
 */
export function createProgressLookup({
  list,
  probe = probeLlamaCpp,
  now = Date.now,
  ttlMs = 30_000,
  retryMs = 5_000,
  firstWaitMs = 750,
  probeTtlMs = 5 * 60_000,
  probeRetryMs = 30_000,
} = {}) {
  let snapshot = null, flight = null, attemptedAt = -Infinity, firstWait = null;
  /** endpointKey -> { at, ok }: what each engine said about itself. */
  const answers = new Map(), askings = new Set();
  const refresh = () => flight ??= (async () => {
    attemptedAt = now();
    try {
      const byId = new Map();
      for (const row of (await list()).slice(0, 256)) if (typeof row?.id === 'string') byId.set(row.id, providerRow(row));
      snapshot = { at: now(), byId };
    } catch { /* keep the last read; the next attempt is at least retryMs away */ }
    finally { flight = null; }
  })();
  const asking = (config) => {
    if (askings.has(config.endpointKey)) return;
    askings.add(config.endpointKey);
    const settled = (ok) => { askings.delete(config.endpointKey); answers.set(config.endpointKey, { at: now(), ok }); };
    void Promise.resolve().then(() => probe(config.origin)).then((ok) => settled(ok === true), () => settled(false));
  };
  const progress = (config) => {
    if (config.named) return true;
    const answer = answers.get(config.endpointKey);
    if (answer && now() - answer.at < (answer.ok ? probeTtlMs : probeRetryMs)) return answer.ok;
    asking(config);
    return false;
  };
  return async providerID => {
    if (typeof providerID !== 'string' || !PROVIDER_ID.test(providerID)) return null;
    // A provider the last read did not list may have just been added; look again, never more often than retryMs.
    if (now() - attemptedAt >= retryMs && (!snapshot || now() - snapshot.at >= ttlMs || !snapshot.byId.has(providerID))) void refresh();
    if (!snapshot && flight) await (firstWait ??= waitFor(flight, firstWaitMs));
    const config = snapshot?.byId.get(providerID) ?? null;
    // `progress` is the whole question the request hooks ask.
    return config ? { ...config, progress: progress(config) } : null;
  };
}
