// What Gauge adds to the speed service: the Mac's memory, the prompt a local
// Splash chat is reading, a ComfyUI render, and the model the engine holds. Each is a passive read; nothing
// here sends inference, starts a render or changes a setting.
//
// The readers only run while a Work Status section is asking (`noteDemand`,
// called from `/rate`). The speed measurement next door keeps counting in the
// background either way; these readings are only worth taking while visible.
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** A page that has not polled for this long is gone; stop sampling for it. */
const DEMAND_MS = 10_000;
let demandAt = 0;
const wanted = (now: number): boolean => now - demandAt < DEMAND_MS;

// --- Mac memory ---------------------------------------------------------------

export type MacReading = {
  /** The kernel's own level: 1 normal, 2 warning, 4 critical. */
  pressure: 'normal' | 'warning' | 'critical' | null;
  /** Activity Monitor's "Memory Used": app memory + wired + compressed. */
  usedBytes: number | null;
  totalBytes: number | null;
  swapUsedBytes: number | null;
  at: number;
};

const MAC_EVERY_MS = 2_000;
const UNIT: Record<string, number> = { K: 2 ** 10, M: 2 ** 20, G: 2 ** 30, T: 2 ** 40 };

/** vm_stat prints its own page size; Apple Silicon uses 16 KiB, never assume 4. */
export const parseVmStat = (text: string): number | null => {
  const pageSize = Number(/^Mach Virtual Memory Statistics: \(page size of (\d{1,6}) bytes\)$/m.exec(text)?.[1]);
  if (!(Number.isSafeInteger(pageSize) && pageSize >= 1024 && pageSize <= 65_536)) return null;
  const pages = (label: string): number | null => {
    const match = new RegExp(`^${label}:[ ]+(\\d{1,16})\\.$`, 'm').exec(text);
    return match ? Number(match[1]) : null;
  };
  const anonymous = pages('Anonymous pages');
  const purgeable = pages('Pages purgeable') ?? 0;
  const wired = pages('Pages wired down');
  const compressed = pages('Pages occupied by compressor');
  if (anonymous === null || wired === null || compressed === null) return null;
  return (Math.max(0, anonymous - purgeable) + wired + compressed) * pageSize;
};

/** `sysctl -i vm.swapusage kern.memorystatus_vm_pressure_level hw.memsize`; a missing key leaves its field null. */
export const parseSysctl = (text: string): Pick<MacReading, 'pressure' | 'totalBytes' | 'swapUsedBytes'> => {
  const value = (key: string): string | undefined =>
    new RegExp(`^${key.replaceAll('.', '\\.')}: (.+)$`, 'm').exec(text)?.[1]?.trim();
  const level = value('kern.memorystatus_vm_pressure_level');
  const pressure = level === '1' ? 'normal' : level === '2' ? 'warning' : level === '4' ? 'critical' : null;
  const mem = Number(value('hw.memsize'));
  const swap = /(?:^|\s)used = (\d{1,12}(?:\.\d{1,2})?)([KMGT])(?=\s|$)/.exec(value('vm.swapusage') ?? '');
  return {
    pressure,
    totalBytes: Number.isSafeInteger(mem) && mem > 0 ? mem : null,
    swapUsedBytes: swap ? Math.round(Number(swap[1]) * UNIT[swap[2]]) : null,
  };
};

let mac: MacReading | null = null;
let macBusy = false;

const sampleMac = async (): Promise<void> => {
  if (macBusy || process.platform !== 'darwin') return;
  macBusy = true;
  try {
    const run = async (file: string, args: string[]): Promise<string> => {
      try {
        const { stdout } = await execFileAsync(file, args, { encoding: 'utf8', timeout: 2_000, maxBuffer: 256 * 1024 });
        return String(stdout);
      } catch {
        return '';
      }
    };
    const [vm, ctl] = await Promise.all([
      run('/usr/bin/vm_stat', []),
      run('/usr/sbin/sysctl', ['-i', 'vm.swapusage', 'kern.memorystatus_vm_pressure_level', 'hw.memsize']),
    ]);
    const parsed = parseSysctl(ctl);
    mac = { ...parsed, totalBytes: parsed.totalBytes ?? os.totalmem(), usedBytes: parseVmStat(vm), at: Date.now() };
  } finally {
    macBusy = false;
  }
};

// --- Splash prompt progress ---------------------------------------------------

export type PromptReading = {
  kind: 'primary' | 'compaction';
  total: number;
  cache: number;
  processed: number;
  /** Splash's own prefill time so far, for a time-left estimate. */
  timeMs: number;
  observedAt: number;
};

/** Where Gauge's OpenCode helper writes (bridge/opencode/store.js). */
export const PROGRESS_DIR = process.env.GAUGE_PROGRESS_DIR || path.join(os.homedir(), '.cache', 'gauge', 'prompt-progress');
const MAX_WRITERS = 16;
const MAX_ENTRIES = 16;
const MAX_FILE_BYTES = 64 * 1024;
const PROGRESS_EVERY_MS = 400;

/** The helper's model key, as it hashes the model id OpenCode asked for. */
export const modelKey = (modelId: string): string =>
  createHash('sha256').update(`gauge-model-v1\0${modelId}`).digest('hex');

/** The helper's session key: never the raw id on disk. */
export const sessionKey = (sessionId: string): string =>
  createHash('sha256').update(`gauge-session-v1\0${sessionId}`).digest('hex');

const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** Every valid, unexpired entry in the helper's files. Anything odd is skipped, never trusted. */
export const readProgressEntries = (dir: string, now: number): Array<PromptReading & { sessionKey: string }> => {
  const out: Array<PromptReading & { sessionKey: string }> = [];
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => !name.startsWith('.') && name.endsWith('.json')).slice(0, MAX_WRITERS);
  } catch {
    return out;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    let doc: unknown;
    try {
      const info = fs.lstatSync(file);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) continue;
      doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const record = doc as { schemaVersion?: unknown; expiresAtMs?: unknown; entries?: unknown };
    if (!record || record.schemaVersion !== 1 || !Array.isArray(record.entries)) continue;
    if (typeof record.expiresAtMs !== 'number' || record.expiresAtMs <= now) continue;
    for (const raw of record.entries.slice(0, MAX_ENTRIES)) {
      const e = raw as Record<string, unknown>;
      if (!e || typeof e.sessionKey !== 'string') continue;
      if (e.kind !== 'primary' && e.kind !== 'compaction') continue;
      if (!count(e.total) || e.total === 0 || !count(e.cache) || !count(e.processed)) continue;
      if (e.cache > e.processed || e.processed > e.total) continue;
      if (typeof e.observedAtMs !== 'number' || e.observedAtMs > now + 1_000) continue;
      if (typeof e.expiresAtMs !== 'number' || e.expiresAtMs <= now) continue;
      const timeMs = typeof e.timeMs === 'number' && Number.isFinite(e.timeMs) && e.timeMs >= 0 ? e.timeMs : 0;
      out.push({
        sessionKey: e.sessionKey,
        kind: e.kind,
        total: e.total,
        cache: e.cache,
        processed: e.processed,
        timeMs,
        observedAt: e.observedAtMs,
      });
    }
  }
  return out;
};

/**
 * How long each chat has spent reading prompts since its last finished turn.
 *
 * A reply's receipt wants the reading as its own slice. Splash reports the
 * prefill time of the prompt it is reading; a turn can read several, so the
 * finished ones are added up and the running one counts at its latest value.
 * Readings are only taken while a page is looking, so a turn nobody watched
 * has no reading slice and that time stays in the wait.
 */
type ReadRecord = { doneMs: number; curMs: number; skipMs: number; processed: number; total: number; at: number };
const reads = new Map<string, ReadRecord>();
const READS_CAP = 64;

export const noteRead = (entry: PromptReading & { sessionKey: string }): void => {
  const key = `${entry.sessionKey}:${entry.kind}`;
  const record = reads.get(key);
  if (!record) {
    if (reads.size >= READS_CAP) reads.delete(reads.keys().next().value as string);
    reads.set(key, { doneMs: 0, curMs: entry.timeMs, skipMs: 0, processed: entry.processed, total: entry.total, at: entry.observedAt });
    return;
  }
  if (entry.observedAt <= record.at) return;
  // Another prompt: its counters started over.
  if (entry.total !== record.total || entry.processed < record.processed || entry.timeMs < record.curMs) {
    record.doneMs += Math.max(0, record.curMs - record.skipMs);
    record.skipMs = 0;
    record.curMs = entry.timeMs;
  } else {
    record.curMs = Math.max(record.curMs, entry.timeMs);
  }
  record.processed = entry.processed;
  record.total = entry.total;
  record.at = entry.observedAt;
};

/** The reading time these sessions gathered, handed over once: the next turn starts from zero. */
export const takeReadMs = (sessionIds: string[]): number => {
  let sum = 0;
  for (const id of sessionIds) {
    const prefix = `${sessionKey(id)}:`;
    for (const [key, record] of reads) {
      if (!key.startsWith(prefix)) continue;
      sum += record.doneMs + Math.max(0, record.curMs - record.skipMs);
      record.doneMs = 0;
      // The same entry stays on disk until it expires; do not count it twice.
      record.skipMs = record.curMs;
    }
  }
  return sum;
};

/**
 * The engine's own figures for one finished local reply: what llama.cpp's
 * server, or Splash, put in the reply's closing `timings` frame. The helper
 * keeps each for 15 s, so the step that asked for it claims it as soon as it is
 * there: OpenCode ends a step only after its tools have run, often later.
 */
export type EngineFigure = {
  id: string;
  sessionKey: string;
  /** The hashed model id the request was made for (`modelKey`), so a figure only goes to a step of that model. */
  modelKey: string | null;
  /** Tokens the engine wrote. */
  tokens: number;
  /** The engine's own rate: tokens over first token to done. */
  tps: number;
  endedAt: number;
};

export const readEngineEntries = (dir: string, now: number): EngineFigure[] => {
  const out: EngineFigure[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => !name.startsWith('.') && name.endsWith('.json')).slice(0, MAX_WRITERS);
  } catch {
    return out;
  }
  for (const name of names) {
    let doc: unknown;
    try {
      const file = path.join(dir, name);
      const info = fs.lstatSync(file);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) continue;
      doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const record = doc as { schemaVersion?: unknown; entries?: unknown };
    if (!record || record.schemaVersion !== 1 || !Array.isArray(record.entries)) continue;
    for (const raw of record.entries.slice(0, MAX_ENTRIES)) {
      const e = raw as Record<string, unknown>;
      const done = e?.done as Record<string, unknown> | undefined;
      if (!e || typeof e.requestID !== 'string' || typeof e.sessionKey !== 'string' || !done) continue;
      // Only a step's own call. A compaction is read just before the next step
      // starts, inside that step's window, and is no step of its own.
      if (e.kind !== 'primary') continue;
      if (typeof e.expiresAtMs !== 'number' || e.expiresAtMs <= now) continue;
      if (typeof e.endedAtMs !== 'number' || !Number.isFinite(e.endedAtMs) || e.endedAtMs > now + 1_000) continue;
      const tokens = done.tokens;
      const tps = done.tps;
      if (!Number.isSafeInteger(tokens) || (tokens as number) <= 0) continue;
      if (typeof tps !== 'number' || !Number.isFinite(tps) || tps <= 0 || tps > 5_000) continue;
      const modelKey = typeof e.modelKey === 'string' ? e.modelKey : null;
      out.push({ id: e.requestID, sessionKey: e.sessionKey, modelKey, tokens: tokens as number, tps, endedAt: e.endedAtMs });
    }
  }
  return out;
};

let engineCache: { at: number; entries: EngineFigure[] } | null = null;
const ENGINE_EVERY_MS = 200;

/**
 * Finished local replies the helper has written, read at most five times a
 * second. Read whenever a step asks, page or no page: a reply's own figure is
 * what its speed is, not a reading that only matters while someone looks.
 */
export const engineFigures = (now: number, fresh = false): EngineFigure[] => {
  if (fresh || !engineCache || now - engineCache.at >= ENGINE_EVERY_MS) {
    engineCache = { at: now, entries: readEngineEntries(PROGRESS_DIR, now) };
  }
  return engineCache.entries;
};

let progressCache: { at: number; entries: Array<PromptReading & { sessionKey: string }> } | null = null;

/** The newest prompt being read by one of these sessions (the chat and its subagents), or null. */
const promptFor = (sessionIds: string[], now: number): PromptReading | null => {
  if (sessionIds.length === 0) return null;
  if (!progressCache || now - progressCache.at >= PROGRESS_EVERY_MS) {
    progressCache = { at: now, entries: readProgressEntries(PROGRESS_DIR, now) };
    for (const entry of progressCache.entries) noteRead(entry);
  }
  const keys = new Set(sessionIds.map(sessionKey));
  let best: PromptReading | null = null;
  for (const entry of progressCache.entries) {
    if (!keys.has(entry.sessionKey)) continue;
    if (!best || entry.observedAt > best.observedAt) {
      const { sessionKey: _ignored, ...reading } = entry;
      best = reading;
    }
  }
  return best;
};

// --- ComfyUI ------------------------------------------------------------------

export type RenderReading = {
  state: 'running' | 'queued';
  /** When the running job started, as best known: first seen running, else its queue time. */
  startedAt: number | null;
  /** Jobs waiting behind it. */
  queued: number;
  /** The latest sampler step ComfyUI broadcast for this job; null when it sends progress only to its own client. */
  step: { value: number; max: number; at: number } | null;
};

/** A headless server on 18188, ComfyUI's default (8188), Comfy Desktop (8000). */
const COMFY_ORIGINS = (process.env.GAUGE_COMFY_URL || 'http://127.0.0.1:18188,http://127.0.0.1:8188,http://127.0.0.1:8000')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const COMFY_RUNNING_MS = 2_000;
const COMFY_IDLE_MS = 10_000;
const COMFY_OFFLINE_MS = 30_000;
/** A step older than this is not shown as current. */
const STEP_FRESH_MS = 60_000;

type ComfyJob = { id: string; status: string; create_time?: number };

let comfyOrigin: string | null = null;
let comfyNextAt = 0;
let comfyBusy = false;
let render: RenderReading | null = null;
let runningId: string | null = null;
/** When the running job started, as best known. */
let startedAt: number | null = null;
const seenQueued = new Set<string>();
const steps = new Map<string, { value: number; max: number; at: number }>();
let socket: WebSocket | null = null;
let socketOrigin: string | null = null;

export const parseJobs = (body: unknown): ComfyJob[] | null => {
  const jobs = (body as { jobs?: unknown } | null)?.jobs;
  if (!Array.isArray(jobs)) return null;
  const out: ComfyJob[] = [];
  for (const raw of jobs) {
    const job = raw as Record<string, unknown>;
    if (!job || typeof job.id !== 'string' || typeof job.status !== 'string') continue;
    out.push({
      id: job.id,
      status: job.status,
      ...(typeof job.create_time === 'number' && Number.isFinite(job.create_time) ? { create_time: job.create_time } : {}),
    });
  }
  return out;
};

const fetchJobs = async (origin: string): Promise<ComfyJob[] | null> => {
  try {
    const url = new URL('/api/jobs', origin);
    url.searchParams.set('status', 'in_progress,pending');
    url.searchParams.set('limit', '32');
    const response = await fetch(url, { signal: AbortSignal.timeout(1_500), redirect: 'manual' });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      return null;
    }
    return parseJobs(await response.json());
  } catch {
    return null;
  }
};

/**
 * ComfyUI broadcasts `progress` to every listener only when the job was queued
 * without a `client_id`; otherwise it goes to the client that queued it alone.
 * Listening costs nothing either way, and a broadcast step is exact.
 */
const openSocket = (origin: string): void => {
  if (socket && socketOrigin === origin) return;
  closeSocket();
  const WS = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!WS) return;
  try {
    const url = new URL(`/ws?clientId=gauge-${randomUUID()}`, origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WS(url);
    socket = ws;
    socketOrigin = origin;
    ws.addEventListener('message', (event: MessageEvent) => {
      if (typeof event.data !== 'string' || event.data.length > 64 * 1024) return;
      try {
        const message = JSON.parse(event.data) as { type?: unknown; data?: Record<string, unknown> };
        if (message.type !== 'progress' || !message.data) return;
        const { value, max, prompt_id: id } = message.data;
        if (typeof id !== 'string' || !count(value) || !count(max) || max === 0 || value > max) return;
        steps.set(id, { value, max, at: Date.now() });
        if (steps.size > 64) steps.delete(steps.keys().next().value as string);
      } catch {
        // Not JSON or not ours: ignore it.
      }
    });
    const drop = (): void => {
      if (socket === ws) {
        socket = null;
        socketOrigin = null;
      }
    };
    ws.addEventListener('close', drop);
    ws.addEventListener('error', drop);
  } catch {
    socket = null;
    socketOrigin = null;
  }
};

const closeSocket = (): void => {
  const ws = socket;
  socket = null;
  socketOrigin = null;
  try {
    ws?.close();
  } catch {
    // Already gone.
  }
};

const pollComfy = async (now: number): Promise<void> => {
  if (comfyBusy || now < comfyNextAt) return;
  comfyBusy = true;
  try {
    let jobs: ComfyJob[] | null = null;
    let found: string | null = null;
    for (const origin of comfyOrigin ? [comfyOrigin, ...COMFY_ORIGINS.filter((o) => o !== comfyOrigin)] : COMFY_ORIGINS) {
      jobs = await fetchJobs(origin);
      if (jobs) {
        found = origin;
        break;
      }
    }
    comfyOrigin = found;
    if (!jobs || !found) {
      render = null;
      runningId = null;
      closeSocket();
      comfyNextAt = Date.now() + COMFY_OFFLINE_MS;
      return;
    }
    const running = jobs.find((job) => job.status === 'in_progress') ?? null;
    const pending = jobs.filter((job) => job.status === 'pending');
    for (const job of pending) seenQueued.add(job.id);
    if (running) {
      if (runningId !== running.id) {
        runningId = running.id;
        // A job we watched wait in the queue started now; otherwise its queue time is the best start we have.
        startedAt = seenQueued.has(running.id) ? Date.now() : (running.create_time ?? null);
        seenQueued.delete(running.id);
      }
      openSocket(found);
      const step = steps.get(running.id) ?? null;
      render = {
        state: 'running',
        startedAt,
        queued: pending.length,
        step: step && Date.now() - step.at < STEP_FRESH_MS ? step : null,
      };
      comfyNextAt = Date.now() + COMFY_RUNNING_MS;
    } else {
      runningId = null;
      render = pending.length > 0 ? { state: 'queued', startedAt: null, queued: pending.length, step: null } : null;
      if (pending.length === 0) closeSocket();
      comfyNextAt = Date.now() + (pending.length > 0 ? COMFY_RUNNING_MS : COMFY_IDLE_MS);
    }
    if (seenQueued.size > 256) seenQueued.clear();
  } finally {
    comfyBusy = false;
  }
};

// --- Loaded model -------------------------------------------------------------

/**
 * The model the local engine actually has in memory, read from Splash's own
 * status rather than from the chat's selected model: the two differ whenever a
 * route is warm, idle or swapped.
 *
 * Splash's launcher writes `serve-PORT.json` beside its lock for every server
 * it starts, so the records name the port and the process that answers on it.
 * A record outlives its server, so each one is checked twice: the process must
 * still be alive, and the server on that port must answer with the same
 * process and port. A server that is stopped, recovering or that has released
 * its weights says so, and then there is no loaded model to show.
 */
export type ServeRecord = { port: number; pid: number };

export type SplashStatus = {
  pid: number;
  port: number;
  /** The engine's model name, with its quantization. */
  model: string;
  /** Epoch ms when this server started. */
  startedAt: number;
  /** Whether it is generating right now. */
  serving: boolean;
};

export type ModelReading = {
  /** The model's name without its organization prefix. */
  name: string;
  /** The quantization the engine loaded, when it reports one. */
  quant: string | null;
  /** The identifier the engine reported, in full. */
  id: string;
  at: number;
};

const SPLASH_RUNTIME_DIR = process.env.GAUGE_SPLASH_RUNTIME_DIR
  || path.join(os.homedir(), 'Library', 'Application Support', 'Splash', 'runtime');
const MODEL_EVERY_MS = 3_000;
/** A reading this old is dropped rather than shown as if it were current. */
const MODEL_GIVE_UP_MS = 30_000;
const MODEL_FILE_BYTES = 64 * 1024;

/** A runtime record: the port it names, and the process that serves it. */
export const parseServeRecord = (file: string, body: unknown): ServeRecord | null => {
  const name = /^serve-(\d{1,5})\.json$/.exec(file);
  if (!name) return null;
  const port = Number(name[1]);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) return null;
  const record = body as { phase?: unknown; pid?: unknown } | null;
  if (!record || record.phase !== 'ready') return null;
  const pid = record.pid;
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return null;
  return { port, pid: pid as number };
};

/** A Splash status body: the model it has loaded, or null when it has none. */
export const parseSplashStatus = (body: unknown): SplashStatus | null => {
  const doc = body as Record<string, unknown> | null;
  if (!doc || doc.ready !== true) return null;
  const transport = (doc.transport ?? {}) as Record<string, unknown>;
  if (transport.stopped === true || transport.recovering === true || transport.status_stale === true) return null;
  const weights = (doc.weights ?? {}) as Record<string, unknown>;
  // Released weights are a server that kept running after the model went back
  // to disk: it is up, but nothing is loaded.
  if (weights.released === true) return null;
  const instance = (doc.instance ?? {}) as Record<string, unknown>;
  const model = instance.model;
  if (typeof model !== 'string' || !model.trim()) return null;
  const pid = instance.pid;
  const port = instance.port;
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(port)) return null;
  const started = Number(instance.started_at);
  const requests = doc.active_requests;
  return {
    pid: pid as number,
    port: port as number,
    model: model.trim(),
    startedAt: Number.isFinite(started) ? Math.round(started * 1000) : 0,
    serving: Array.isArray(requests) && requests.length > 0,
  };
};

/**
 * The name to show: without the organization prefix and without the file
 * format the quantization already names, plus the quantization on its own.
 */
export const splitModelName = (model: string): { name: string; quant: string | null } => {
  const trimmed = model.trim();
  const colon = trimmed.lastIndexOf(':');
  const quant = colon > 0 ? trimmed.slice(colon + 1) : '';
  const base = (colon > 0 ? trimmed.slice(0, colon) : trimmed).replace(/-GGUF$/i, '');
  const slash = base.indexOf('/');
  const name = slash > 0 && !base.slice(slash + 1).includes('/') ? base.slice(slash + 1) : base;
  return { name, quant: /^[A-Za-z0-9_.-]{1,32}$/.test(quant) ? quant : null };
};

const readJsonFile = (file: string): unknown => {
  try {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.size > MODEL_FILE_BYTES) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // The process exists but belongs to somebody else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const fetchSplashStatus = async (port: number): Promise<SplashStatus | null> => {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/status`, {
      signal: AbortSignal.timeout(1_500),
      redirect: 'manual',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      return null;
    }
    return parseSplashStatus(await response.json());
  } catch {
    return null;
  }
};

/** Every local Splash server that is up and has a model loaded. */
export const discoverSplash = async (
  dir: string = SPLASH_RUNTIME_DIR,
  read: (port: number) => Promise<SplashStatus | null> = fetchSplashStatus,
): Promise<SplashStatus[]> => {
  let names: string[];
  try {
    names = fs.readdirSync(dir)
      .filter((name) => name.startsWith('serve-') && name.endsWith('.json'))
      .slice(0, 16);
  } catch {
    return [];
  }
  const found: SplashStatus[] = [];
  for (const name of names) {
    const record = parseServeRecord(name, readJsonFile(path.join(dir, name)));
    if (!record) continue;
    if (!processAlive(record.pid)) continue;
    const status = await read(record.port);
    if (!status) continue;
    // The port may have been taken by something else since the record was written.
    if (status.pid !== record.pid || status.port !== record.port) continue;
    found.push(status);
  }
  return found;
};

/**
 * The server to report: one that is generating right now, else the one that
 * started last. A swap group keeps one route loaded, so this is the model the
 * Mac is holding.
 */
export const pickSplash = (list: SplashStatus[]): SplashStatus | null => {
  if (list.length === 0) return null;
  const serving = list.filter((status) => status.serving);
  const pool = serving.length > 0 ? serving : list;
  return pool.reduce((best, status) => (status.startedAt > best.startedAt ? status : best), pool[0]);
};

let model: ModelReading | null = null;
let modelNextAt = 0;
let modelBusy = false;

const sampleModel = async (): Promise<void> => {
  if (modelBusy) return;
  modelBusy = true;
  try {
    const picked = pickSplash(await discoverSplash());
    if (picked) {
      const { name, quant } = splitModelName(picked.model);
      model = { name, quant, id: picked.model, at: Date.now() };
    } else if (model && Date.now() - model.at > MODEL_GIVE_UP_MS) {
      model = null;
    }
  } finally {
    modelBusy = false;
  }
};

// --- the wire -----------------------------------------------------------------

export type GaugeWire = {
  /** Whether this machine has a memory reading at all; only a Mac does. */
  macSupported: boolean;
  mac: MacReading | null;
  prompt: PromptReading | null;
  render: RenderReading | null;
  model: ModelReading | null;
};

/** A page is looking: keep the readers warm. Never awaits; answers from the last reading. */
export const noteDemand = (now: number): void => {
  demandAt = now;
  if (!mac || now - mac.at >= MAC_EVERY_MS) void sampleMac();
  // The model is read on its own clock, whether or not there is one to show:
  // a missing model must not turn every poll into a disk read.
  if (now - modelNextAt >= MODEL_EVERY_MS) {
    modelNextAt = now;
    void sampleModel();
  }
  void pollComfy(now);
};

export const gaugeWire = (sessionIds: string[], now: number): GaugeWire => {
  const job = render ? { ...render } : null;
  if (job && job.state === 'running' && runningId) {
    const step = steps.get(runningId);
    job.step = step && now - step.at < STEP_FRESH_MS ? step : null;
  }
  return { macSupported: process.platform === 'darwin', mac, prompt: promptFor(sessionIds, now), render: job, model };
};

/** Drop what nobody is watching: the ComfyUI socket closes when no page has asked for a while. */
const idleTimer = setInterval(() => {
  if (!wanted(Date.now())) {
    closeSocket();
    comfyNextAt = 0;
  }
}, DEMAND_MS);
idleTimer.unref?.();
