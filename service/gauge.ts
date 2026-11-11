// What Gauge adds to the speed service: the Mac's memory, the prompt a local
// Splash chat is reading, and a ComfyUI render. Each is a passive read; nothing
// here sends inference, starts a render or changes a setting.
//
// The three readers only run while a Work Status section is asking (`noteDemand`,
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

let progressCache: { at: number; entries: Array<PromptReading & { sessionKey: string }> } | null = null;

/** The newest prompt being read by one of these sessions (the chat and its subagents), or null. */
const promptFor = (sessionIds: string[], now: number): PromptReading | null => {
  if (sessionIds.length === 0) return null;
  if (!progressCache || now - progressCache.at >= PROGRESS_EVERY_MS) {
    progressCache = { at: now, entries: readProgressEntries(PROGRESS_DIR, now) };
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

/** The headless server Michael's scripts start (18188), ComfyUI's default (8188), Comfy Desktop (8000). */
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

// --- the wire -----------------------------------------------------------------

export type GaugeWire = {
  mac: MacReading | null;
  prompt: PromptReading | null;
  render: RenderReading | null;
};

/** A page is looking: keep the three readers warm. Never awaits; answers from the last reading. */
export const noteDemand = (now: number): void => {
  demandAt = now;
  if (!mac || now - mac.at >= MAC_EVERY_MS) void sampleMac();
  void pollComfy(now);
};

export const gaugeWire = (sessionIds: string[], now: number): GaugeWire => {
  const job = render ? { ...render } : null;
  if (job && job.state === 'running' && runningId) {
    const step = steps.get(runningId);
    job.step = step && now - step.at < STEP_FRESH_MS ? step : null;
  }
  return { mac, prompt: promptFor(sessionIds, now), render: job };
};

/** Drop what nobody is watching: the ComfyUI socket closes when no page has asked for a while. */
const idleTimer = setInterval(() => {
  if (!wanted(Date.now())) {
    closeSocket();
    comfyNextAt = 0;
  }
}, DEMAND_MS);
idleTimer.unref?.();
