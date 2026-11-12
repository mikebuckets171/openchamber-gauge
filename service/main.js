// service/main.ts
import http from "node:http";
import fs2 from "node:fs";
import os2 from "node:os";
import path2 from "node:path";
// node_modules/@openchamber/sdk/dist/scrollbar-style.js
var GUEST_SCROLLING_ATTRIBUTE = "data-oc-scrolling";
var GUEST_SCROLLBAR_CSS = `
:root {
  /* Quiet at rest like the app's own thumbs; hover gives a clear grab target. */
  --oc-scrollbar-thumb: color-mix(in srgb, var(--oc-muted, currentColor) 18%, transparent);
  --oc-scrollbar-thumb-hover: color-mix(in srgb, var(--oc-muted, currentColor) 36%, transparent);
  scrollbar-gutter: stable;
}
* {
  scrollbar-width: thin;
  scrollbar-color: transparent transparent;
}
:hover, [${GUEST_SCROLLING_ATTRIBUTE}] {
  scrollbar-color: var(--oc-scrollbar-thumb) transparent;
}
/* Chromium's standard scrollbar properties otherwise override its pseudo-elements. */
@supports selector(::-webkit-scrollbar) {
  *, :hover, [${GUEST_SCROLLING_ATTRIBUTE}] { scrollbar-width: auto; scrollbar-color: auto; }
  ::-webkit-scrollbar { width: 6px; height: 6px; background: transparent; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb {
    background: transparent;
    border-radius: 999px;
    min-width: 24px;
    min-height: 24px;
  }
  :hover::-webkit-scrollbar-thumb, [${GUEST_SCROLLING_ATTRIBUTE}]::-webkit-scrollbar-thumb { background: var(--oc-scrollbar-thumb); }
  ::-webkit-scrollbar-thumb:hover { background: var(--oc-scrollbar-thumb-hover); }
  ::-webkit-scrollbar-corner { background: transparent; }
  ::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
}
@media (forced-colors: active) {
  *, :hover, [${GUEST_SCROLLING_ATTRIBUTE}] { scrollbar-color: auto; }
  ::-webkit-scrollbar-thumb, ::-webkit-scrollbar-thumb:hover { background: CanvasText; }
}
`;
function installGuestScrollbarActivity(doc) {
  const root = doc.documentElement;
  if (root.hasAttribute("data-oc-scrollbar-activity"))
    return;
  root.setAttribute("data-oc-scrollbar-activity", "");
  const timers = new WeakMap;
  doc.addEventListener("scroll", (event) => {
    const target = event.target === doc ? root : event.target;
    if (!(target instanceof Element))
      return;
    if (!target.hasAttribute("data-oc-scrolling"))
      target.setAttribute("data-oc-scrolling", "");
    const pending = timers.get(target);
    if (pending !== undefined)
      clearTimeout(pending);
    timers.set(target, setTimeout(() => {
      timers.delete(target);
      target.removeAttribute("data-oc-scrolling");
    }, 1000));
  }, { capture: true, passive: true });
}
var GUEST_SCROLLBAR_SCRIPT = `(${installGuestScrollbarActivity.toString()})(document);`;
// node_modules/@openchamber/sdk/dist/manifest.js
var TRACKER_URL_TOKENS = ["{id}", "{segment}", "{segments+}"];
var TRACKER_URL_TOKEN_SET = new Set(TRACKER_URL_TOKENS);
// node_modules/@openchamber/sdk/dist/session-events.js
var GUEST_SESSION_EVENT_TYPES = [
  "turn-finished",
  "turn-failed",
  "permission-asked",
  "question-asked",
  "turn-started",
  "session-created",
  "session-archived",
  "session-deleted"
];
var SESSION_EVENTS_IDLE_MS = 10 * 60000;
var EVENT_TYPES = new Set(GUEST_SESSION_EVENT_TYPES);
// node_modules/@openchamber/sdk/dist/service-host.js
var SERVICE_HOST_PATH = "/service/call";
var OPENCHAMBER_HOST_CALLBACK_URL_ENV = "OPENCHAMBER_HOST_CALLBACK_URL";
var SERVICE_HOST_TIMEOUT_MS = 30000;
var SERVICE_SCHEDULE_IDLE_MS = 10 * 60000;
var MENTIONS_IDLE_MS = 10 * 60000;
class ServiceHostError extends Error {
  code;
  status;
  constructor(message, code, status) {
    super(message);
    this.name = "ServiceHostError";
    this.code = code;
    this.status = status;
  }
}
var createServiceHost = ({ env }) => {
  const call = async (method, input) => {
    const base = env[OPENCHAMBER_HOST_CALLBACK_URL_ENV];
    const token = env.OPENCHAMBER_SERVICE_TOKEN;
    if (!base || !token)
      throw new ServiceHostError("This service was not started by OpenChamber.", "HOST_UNAVAILABLE", 0);
    let response;
    try {
      response = await fetch(`${base.replace(/\/+$/, "")}${SERVICE_HOST_PATH}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ method, input }),
        signal: AbortSignal.timeout(SERVICE_HOST_TIMEOUT_MS)
      });
    } catch {
      throw new ServiceHostError("OpenChamber did not answer.", "HOST_UNAVAILABLE", 0);
    }
    const body = await response.json().catch(() => null);
    if (response.ok && body?.result !== undefined)
      return body.result;
    throw new ServiceHostError(body?.error?.message ?? `OpenChamber answered HTTP ${response.status}.`, body?.error?.code ?? "HOST_UNAVAILABLE", response.status);
  };
  return {
    sessions: {
      start: (input) => call("sessions.start", input),
      send: (sessionId, prompt) => call("sessions.send", { sessionId, prompt }),
      retry: (sessionId) => call("sessions.retry", { sessionId }),
      status: (sessionId) => call("sessions.status", { sessionId }),
      lastReply: (sessionId) => call("sessions.lastReply", { sessionId }),
      stop: (sessionId) => call("sessions.stop", { sessionId }),
      answerPermission: (sessionId, requestId, answer) => call("sessions.answerPermission", { sessionId, requestId, ...answer }),
      answerForm: (sessionId, formId, values, message) => call("sessions.answerForm", { sessionId, formId, values, ...message === undefined ? {} : { message } })
    },
    setInstructions: (directory, text) => call("instructions.set", { directory, text }),
    emit: (topic, data) => call("panels.emit", { topic, data }),
    readSettings: () => call("settings.read", {}).then(({ settings }) => settings),
    needsConfiguration: (message) => call("status.set", { needsConfiguration: message })
  };
};
// node_modules/@openchamber/sdk/dist/file-editor.js
var patternExpressions = new Map;
// node_modules/@openchamber/sdk/dist/contract.js
var GUEST_FILE_STAT_KINDS = ["file", "directory", "other", "missing"];
var GUEST_GENERATE_LATE_KEEP_MS = 60 * 60000;
var HOST_REQUEST_ERROR_CODES = [
  "HOST_UNAVAILABLE",
  "HOST_TIMEOUT",
  "HOST_REJECTED",
  "DISCONNECTED",
  "DISABLED",
  "BAD_PATH",
  "NO_INTEGRATION",
  "NO_SERVICE",
  "SERVICE_FAILED",
  "REQUEST_FAILED",
  "RESPONSE_TOO_LARGE",
  "NO_SESSION",
  "SESSION_BUSY",
  "NOT_GRANTED",
  "NO_DIRECTORY",
  "NOT_FOUND",
  "FILE_TOO_LARGE",
  "DENIED",
  "NO_MODEL",
  "MODEL_FAILED",
  "UNSUPPORTED"
];
var SERVICE_STATUS_VALUES = ["stopped", "starting", "ready", "failed"];
var hostRequestErrorCodeSet = new Set(HOST_REQUEST_ERROR_CODES);
var serviceStatusSet = new Set(SERVICE_STATUS_VALUES);
var fileStatKindSet = new Set(GUEST_FILE_STAT_KINDS);
var HOST_PUSH_TYPES = new Set([
  "workspace",
  "shells",
  "ready",
  "directory",
  "session",
  "connection",
  "settings",
  "session-lifecycle",
  "item",
  "resolve",
  "action",
  "service-event",
  "status-control-event",
  "popover-closed",
  "file-open",
  "file-snapshot",
  "file-saved",
  "generate-late"
]);
// node_modules/@openchamber/sdk/dist/service-providers.js
var BROWSER_CONTROL_ACTIONS = [
  "browser.open",
  "browser.snapshot",
  "browser.click",
  "browser.type",
  "browser.select",
  "browser.scroll",
  "browser.back",
  "browser.forward",
  "browser.inspect",
  "browser.capture",
  "browser.resize",
  "browser.close"
];
var BROWSER_PROVIDER_IDLE_MS = 10 * 60000;
var CONTROL_ACTIONS = new Set(BROWSER_CONTROL_ACTIONS);
var SOURCE_CONTROL_PROVIDER_IDLE_MS = 10 * 60000;
var NOTIFICATIONS_PROVIDER_IDLE_MS = 10 * 60000;
var TRACKER_PROVIDER_IDLE_MS = 10 * 60000;
var QUOTA_PROVIDER_IDLE_MS = 10 * 60000;
// node_modules/@openchamber/sdk/dist/service-surface.js
var SURFACE_CONTROLLERS = ["none", "agent", "user"];
var CONTROLLERS = new Set(SURFACE_CONTROLLERS);
// shared/models.ts
var modelDisplayName = (id) => {
  const trimmed = id.trim();
  if (!trimmed)
    return "";
  const withoutQuant = trimmed.split(":")[0] ?? "";
  const last = withoutQuant.slice(withoutQuant.lastIndexOf("/") + 1);
  return last.replace(/-GGUF$/i, "");
};

// shared/receipt.ts
var whole = (value) => typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
var splitTurn = (input) => {
  const writeMs = whole(input.writeMs);
  const totalMs = Math.max(whole(input.totalMs), writeMs);
  const toolMs = Math.min(whole(input.toolMs), totalMs - writeMs);
  const readMs = Math.min(whole(input.readMs), totalMs - writeMs - toolMs);
  return { totalMs, readMs, waitMs: totalMs - writeMs - toolMs - readMs, writeMs, toolMs };
};

// shared/tokens.ts
var tokensFromChars = (chars) => {
  if (!Number.isFinite(chars) || chars <= 0)
    return 0;
  return Math.ceil(chars / 4);
};

// service/gauge.ts
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
var DEMAND_MS = 1e4;
var demandAt = 0;
var wanted = (now) => now - demandAt < DEMAND_MS;
var MAC_EVERY_MS = 2000;
var UNIT = { K: 2 ** 10, M: 2 ** 20, G: 2 ** 30, T: 2 ** 40 };
var parseVmStat = (text) => {
  const pageSize = Number(/^Mach Virtual Memory Statistics: \(page size of (\d{1,6}) bytes\)$/m.exec(text)?.[1]);
  if (!(Number.isSafeInteger(pageSize) && pageSize >= 1024 && pageSize <= 65536))
    return null;
  const pages = (label) => {
    const match = new RegExp(`^${label}:[ ]+(\\d{1,16})\\.$`, "m").exec(text);
    return match ? Number(match[1]) : null;
  };
  const anonymous = pages("Anonymous pages");
  const purgeable = pages("Pages purgeable") ?? 0;
  const wired = pages("Pages wired down");
  const compressed = pages("Pages occupied by compressor");
  if (anonymous === null || wired === null || compressed === null)
    return null;
  return (Math.max(0, anonymous - purgeable) + wired + compressed) * pageSize;
};
var parseSysctl = (text) => {
  const value = (key) => new RegExp(`^${key.replaceAll(".", "\\.")}: (.+)$`, "m").exec(text)?.[1]?.trim();
  const level = value("kern.memorystatus_vm_pressure_level");
  const pressure = level === "1" ? "normal" : level === "2" ? "warning" : level === "4" ? "critical" : null;
  const mem = Number(value("hw.memsize"));
  const swap = /(?:^|\s)used = (\d{1,12}(?:\.\d{1,2})?)([KMGT])(?=\s|$)/.exec(value("vm.swapusage") ?? "");
  return {
    pressure,
    totalBytes: Number.isSafeInteger(mem) && mem > 0 ? mem : null,
    swapUsedBytes: swap ? Math.round(Number(swap[1]) * UNIT[swap[2]]) : null
  };
};
var mac = null;
var macBusy = false;
var sampleMac = async () => {
  if (macBusy || process.platform !== "darwin")
    return;
  macBusy = true;
  try {
    const run = async (file, args) => {
      try {
        const { stdout } = await execFileAsync(file, args, { encoding: "utf8", timeout: 2000, maxBuffer: 256 * 1024 });
        return String(stdout);
      } catch {
        return "";
      }
    };
    const [vm, ctl] = await Promise.all([
      run("/usr/bin/vm_stat", []),
      run("/usr/sbin/sysctl", ["-i", "vm.swapusage", "kern.memorystatus_vm_pressure_level", "hw.memsize"])
    ]);
    const parsed = parseSysctl(ctl);
    mac = { ...parsed, totalBytes: parsed.totalBytes ?? os.totalmem(), usedBytes: parseVmStat(vm), at: Date.now() };
  } finally {
    macBusy = false;
  }
};
var PROGRESS_DIR = process.env.GAUGE_PROGRESS_DIR || path.join(os.homedir(), ".cache", "gauge", "prompt-progress");
var MAX_WRITERS = 16;
var MAX_ENTRIES = 16;
var MAX_FILE_BYTES = 64 * 1024;
var PROGRESS_EVERY_MS = 400;
var sessionKey = (sessionId) => createHash("sha256").update(`gauge-session-v1\x00${sessionId}`).digest("hex");
var count = (value) => Number.isSafeInteger(value) && value >= 0;
var readProgressEntries = (dir, now) => {
  const out = [];
  let names;
  try {
    names = fs.readdirSync(dir).filter((name) => !name.startsWith(".") && name.endsWith(".json")).slice(0, MAX_WRITERS);
  } catch {
    return out;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    let doc;
    try {
      const info = fs.lstatSync(file);
      if (!info.isFile() || info.size > MAX_FILE_BYTES)
        continue;
      doc = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const record = doc;
    if (!record || record.schemaVersion !== 1 || !Array.isArray(record.entries))
      continue;
    if (typeof record.expiresAtMs !== "number" || record.expiresAtMs <= now)
      continue;
    for (const raw of record.entries.slice(0, MAX_ENTRIES)) {
      const e = raw;
      if (!e || typeof e.sessionKey !== "string")
        continue;
      if (e.kind !== "primary" && e.kind !== "compaction")
        continue;
      if (!count(e.total) || e.total === 0 || !count(e.cache) || !count(e.processed))
        continue;
      if (e.cache > e.processed || e.processed > e.total)
        continue;
      if (typeof e.observedAtMs !== "number" || e.observedAtMs > now + 1000)
        continue;
      if (typeof e.expiresAtMs !== "number" || e.expiresAtMs <= now)
        continue;
      const timeMs = typeof e.timeMs === "number" && Number.isFinite(e.timeMs) && e.timeMs >= 0 ? e.timeMs : 0;
      out.push({
        sessionKey: e.sessionKey,
        kind: e.kind,
        total: e.total,
        cache: e.cache,
        processed: e.processed,
        timeMs,
        observedAt: e.observedAtMs
      });
    }
  }
  return out;
};
var reads = new Map;
var READS_CAP = 64;
var noteRead = (entry) => {
  const key = `${entry.sessionKey}:${entry.kind}`;
  const record = reads.get(key);
  if (!record) {
    if (reads.size >= READS_CAP)
      reads.delete(reads.keys().next().value);
    reads.set(key, { doneMs: 0, curMs: entry.timeMs, skipMs: 0, processed: entry.processed, total: entry.total, at: entry.observedAt });
    return;
  }
  if (entry.observedAt <= record.at)
    return;
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
var takeReadMs = (sessionIds) => {
  let sum = 0;
  for (const id of sessionIds) {
    const prefix = `${sessionKey(id)}:`;
    for (const [key, record] of reads) {
      if (!key.startsWith(prefix))
        continue;
      sum += record.doneMs + Math.max(0, record.curMs - record.skipMs);
      record.doneMs = 0;
      record.skipMs = record.curMs;
    }
  }
  return sum;
};
var progressCache = null;
var promptFor = (sessionIds, now) => {
  if (sessionIds.length === 0)
    return null;
  if (!progressCache || now - progressCache.at >= PROGRESS_EVERY_MS) {
    progressCache = { at: now, entries: readProgressEntries(PROGRESS_DIR, now) };
    for (const entry of progressCache.entries)
      noteRead(entry);
  }
  const keys = new Set(sessionIds.map(sessionKey));
  let best = null;
  for (const entry of progressCache.entries) {
    if (!keys.has(entry.sessionKey))
      continue;
    if (!best || entry.observedAt > best.observedAt) {
      const { sessionKey: _ignored, ...reading } = entry;
      best = reading;
    }
  }
  return best;
};
var COMFY_ORIGINS = (process.env.GAUGE_COMFY_URL || "http://127.0.0.1:18188,http://127.0.0.1:8188,http://127.0.0.1:8000").split(",").map((value) => value.trim()).filter(Boolean);
var COMFY_RUNNING_MS = 2000;
var COMFY_IDLE_MS = 1e4;
var COMFY_OFFLINE_MS = 30000;
var STEP_FRESH_MS = 60000;
var comfyOrigin = null;
var comfyNextAt = 0;
var comfyBusy = false;
var render = null;
var runningId = null;
var startedAt = null;
var seenQueued = new Set;
var steps = new Map;
var socket = null;
var socketOrigin = null;
var parseJobs = (body) => {
  const jobs = body?.jobs;
  if (!Array.isArray(jobs))
    return null;
  const out = [];
  for (const raw of jobs) {
    const job = raw;
    if (!job || typeof job.id !== "string" || typeof job.status !== "string")
      continue;
    out.push({
      id: job.id,
      status: job.status,
      ...typeof job.create_time === "number" && Number.isFinite(job.create_time) ? { create_time: job.create_time } : {}
    });
  }
  return out;
};
var fetchJobs = async (origin) => {
  try {
    const url = new URL("/api/jobs", origin);
    url.searchParams.set("status", "in_progress,pending");
    url.searchParams.set("limit", "32");
    const response = await fetch(url, { signal: AbortSignal.timeout(1500), redirect: "manual" });
    if (!response.ok) {
      response.body?.cancel().catch(() => {
        return;
      });
      return null;
    }
    return parseJobs(await response.json());
  } catch {
    return null;
  }
};
var openSocket = (origin) => {
  if (socket && socketOrigin === origin)
    return;
  closeSocket();
  const WS = globalThis.WebSocket;
  if (!WS)
    return;
  try {
    const url = new URL(`/ws?clientId=gauge-${randomUUID()}`, origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WS(url);
    socket = ws;
    socketOrigin = origin;
    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string" || event.data.length > 64 * 1024)
        return;
      try {
        const message = JSON.parse(event.data);
        if (message.type !== "progress" || !message.data)
          return;
        const { value, max, prompt_id: id } = message.data;
        if (typeof id !== "string" || !count(value) || !count(max) || max === 0 || value > max)
          return;
        steps.set(id, { value, max, at: Date.now() });
        if (steps.size > 64)
          steps.delete(steps.keys().next().value);
      } catch {}
    });
    const drop = () => {
      if (socket === ws) {
        socket = null;
        socketOrigin = null;
      }
    };
    ws.addEventListener("close", drop);
    ws.addEventListener("error", drop);
  } catch {
    socket = null;
    socketOrigin = null;
  }
};
var closeSocket = () => {
  const ws = socket;
  socket = null;
  socketOrigin = null;
  try {
    ws?.close();
  } catch {}
};
var pollComfy = async (now) => {
  if (comfyBusy || now < comfyNextAt)
    return;
  comfyBusy = true;
  try {
    let jobs = null;
    let found = null;
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
    const running = jobs.find((job) => job.status === "in_progress") ?? null;
    const pending = jobs.filter((job) => job.status === "pending");
    for (const job of pending)
      seenQueued.add(job.id);
    if (running) {
      if (runningId !== running.id) {
        runningId = running.id;
        startedAt = seenQueued.has(running.id) ? Date.now() : running.create_time ?? null;
        seenQueued.delete(running.id);
      }
      openSocket(found);
      const step = steps.get(running.id) ?? null;
      render = {
        state: "running",
        startedAt,
        queued: pending.length,
        step: step && Date.now() - step.at < STEP_FRESH_MS ? step : null
      };
      comfyNextAt = Date.now() + COMFY_RUNNING_MS;
    } else {
      runningId = null;
      render = pending.length > 0 ? { state: "queued", startedAt: null, queued: pending.length, step: null } : null;
      if (pending.length === 0)
        closeSocket();
      comfyNextAt = Date.now() + (pending.length > 0 ? COMFY_RUNNING_MS : COMFY_IDLE_MS);
    }
    if (seenQueued.size > 256)
      seenQueued.clear();
  } finally {
    comfyBusy = false;
  }
};
var SPLASH_RUNTIME_DIR = process.env.GAUGE_SPLASH_RUNTIME_DIR || path.join(os.homedir(), "Library", "Application Support", "Splash", "runtime");
var MODEL_EVERY_MS = 3000;
var MODEL_GIVE_UP_MS = 30000;
var MODEL_FILE_BYTES = 64 * 1024;
var parseServeRecord = (file, body) => {
  const name = /^serve-(\d{1,5})\.json$/.exec(file);
  if (!name)
    return null;
  const port = Number(name[1]);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535)
    return null;
  const record = body;
  if (!record || record.phase !== "ready")
    return null;
  const pid = record.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0)
    return null;
  return { port, pid };
};
var parseSplashStatus = (body) => {
  const doc = body;
  if (!doc || doc.ready !== true)
    return null;
  const transport = doc.transport ?? {};
  if (transport.stopped === true || transport.recovering === true || transport.status_stale === true)
    return null;
  const weights = doc.weights ?? {};
  if (weights.released === true)
    return null;
  const instance = doc.instance ?? {};
  const model = instance.model;
  if (typeof model !== "string" || !model.trim())
    return null;
  const pid = instance.pid;
  const port = instance.port;
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(port))
    return null;
  const started = Number(instance.started_at);
  const requests = doc.active_requests;
  return {
    pid,
    port,
    model: model.trim(),
    startedAt: Number.isFinite(started) ? Math.round(started * 1000) : 0,
    serving: Array.isArray(requests) && requests.length > 0
  };
};
var splitModelName = (model) => {
  const trimmed = model.trim();
  const colon = trimmed.lastIndexOf(":");
  const quant = colon > 0 ? trimmed.slice(colon + 1) : "";
  const base = (colon > 0 ? trimmed.slice(0, colon) : trimmed).replace(/-GGUF$/i, "");
  const slash = base.indexOf("/");
  const name = slash > 0 && !base.slice(slash + 1).includes("/") ? base.slice(slash + 1) : base;
  return { name, quant: /^[A-Za-z0-9_.-]{1,32}$/.test(quant) ? quant : null };
};
var readJsonFile = (file) => {
  try {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.size > MODEL_FILE_BYTES)
      return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};
var processAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};
var fetchSplashStatus = async (port) => {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/status`, {
      signal: AbortSignal.timeout(1500),
      redirect: "manual",
      headers: { Accept: "application/json" }
    });
    if (!response.ok) {
      response.body?.cancel().catch(() => {
        return;
      });
      return null;
    }
    return parseSplashStatus(await response.json());
  } catch {
    return null;
  }
};
var discoverSplash = async (dir = SPLASH_RUNTIME_DIR, read = fetchSplashStatus) => {
  let names;
  try {
    names = fs.readdirSync(dir).filter((name) => name.startsWith("serve-") && name.endsWith(".json")).slice(0, 16);
  } catch {
    return [];
  }
  const found = [];
  for (const name of names) {
    const record = parseServeRecord(name, readJsonFile(path.join(dir, name)));
    if (!record)
      continue;
    if (!processAlive(record.pid))
      continue;
    const status = await read(record.port);
    if (!status)
      continue;
    if (status.pid !== record.pid || status.port !== record.port)
      continue;
    found.push(status);
  }
  return found;
};
var pickSplash = (list) => {
  if (list.length === 0)
    return null;
  const serving = list.filter((status) => status.serving);
  const pool = serving.length > 0 ? serving : list;
  return pool.reduce((best, status) => status.startedAt > best.startedAt ? status : best, pool[0]);
};
var model = null;
var modelNextAt = 0;
var modelBusy = false;
var sampleModel = async () => {
  if (modelBusy)
    return;
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
var noteDemand = (now) => {
  demandAt = now;
  if (!mac || now - mac.at >= MAC_EVERY_MS)
    sampleMac();
  if (now - modelNextAt >= MODEL_EVERY_MS) {
    modelNextAt = now;
    sampleModel();
  }
  pollComfy(now);
};
var gaugeWire = (sessionIds, now) => {
  const job = render ? { ...render } : null;
  if (job && job.state === "running" && runningId) {
    const step = steps.get(runningId);
    job.step = step && now - step.at < STEP_FRESH_MS ? step : null;
  }
  return { macSupported: process.platform === "darwin", mac, prompt: promptFor(sessionIds, now), render: job, model };
};
var idleTimer = setInterval(() => {
  if (!wanted(Date.now())) {
    closeSocket();
    comfyNextAt = 0;
  }
}, DEMAND_MS);
idleTimer.unref?.();

// service/main.ts
var OPENCODE_URL = (process.env.OPENCHAMBER_OPENCODE_URL ?? "").replace(/\/+$/, "");
var opencodeHeaders = (accept) => ({
  Accept: accept,
  Authorization: `Bearer ${process.env.OPENCHAMBER_SERVICE_TOKEN ?? ""}`
});
var EVENT_TYPES2 = [
  "session.created",
  "session.text.delta",
  "session.text.ended",
  "session.reasoning.delta",
  "session.reasoning.ended",
  "session.tool.input.started",
  "session.tool.input.delta",
  "session.tool.input.ended",
  "session.tool.called",
  "session.tool.success",
  "session.tool.failed",
  "session.shell.started",
  "session.shell.ended",
  "session.step.started",
  "session.step.ended",
  "session.step.failed",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "permission.asked",
  "permission.replied",
  "form.created",
  "form.replied",
  "form.cancelled"
];
var filterTypes = true;
var serviceHost = createServiceHost({ env: process.env });
var port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
var token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
if (!Number.isInteger(port) || port <= 0 || !token) {
  console.error("OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required");
  process.exit(1);
}
var WINDOW_MS = 1000;
var CURVE_WINDOW_MS = 30000;
var CURVE_BUCKETS = 24;
var SAMPLE_LIMIT = 20000;
var RETRY_BASE_MS = 1000;
var RETRY_MAX_MS = 15000;
var SESSION_ID_MAX = 256;
var MODEL_NAME_MAX = 256;
var RESUME_GAP_MS = 15000;
var CALIBRATION_WEIGHT = 0.3;
var MIN_CALIBRATION_FACTOR = 0.25;
var MAX_CALIBRATION_FACTOR = 4;
var calibration = new Map;
var currentModel = "*";
var calibrationFactor = () => calibration.get(currentModel) ?? 1;
var estimateTokens = (chars) => Math.round(tokensFromChars(chars) * calibrationFactor());
var calibrate = (model, chars, generated) => {
  if (!Number.isFinite(chars) || chars <= 0)
    return;
  if (!Number.isFinite(generated) || generated <= 0)
    return;
  const heuristic = tokensFromChars(chars);
  if (heuristic <= 0)
    return;
  const ratio = generated / heuristic;
  const factor = Math.min(MAX_CALIBRATION_FACTOR, Math.max(MIN_CALIBRATION_FACTOR, ratio));
  const previous = calibration.get(model) ?? 1;
  calibration.set(model, previous + (factor - previous) * CALIBRATION_WEIGHT);
};
var MAX_STREAM_GAP_MS = 1000;
var SESSIONS_CAP = 20;
var PERSIST_DEBOUNCE_MS = 1500;
var PERSIST_VERSION = 1;
var cacheRate = (hit, miss) => hit + miss > 0 ? hit / (hit + miss) * 100 : null;
function emptyCache() {
  return {
    startedAt: null,
    steps: 0,
    sessions: new Set,
    hit: 0,
    miss: 0,
    write: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cost: 0,
    last: null,
    prevHitRate: null,
    turnBase: null,
    lastStep: null
  };
}
var stepUsageFrom = (tokens, cost) => {
  const block = readRecord(tokens.cache);
  return {
    input: readNumber(tokens.input),
    cacheRead: block ? readNumber(block.read) : 0,
    cacheWrite: block ? readNumber(block.write) : 0,
    output: readNumber(tokens.output),
    reasoning: readNumber(tokens.reasoning),
    cost,
    hasCache: block !== null
  };
};
var foldCacheStep = (agg, sessionId, messageID, usage, now) => {
  const last = agg.last;
  const before = agg.lastStep;
  const retrying = before !== null && before.sessionId === sessionId && before.messageID === messageID;
  if (retrying && before) {
    agg.output -= before.output;
    agg.reasoning -= before.reasoning;
    agg.cost -= before.cost;
    agg.steps = Math.max(0, agg.steps - 1);
    if (before.cached) {
      agg.hit -= before.hit;
      agg.miss -= before.miss;
      agg.input -= before.input;
      agg.write -= before.write;
    }
  }
  if (agg.startedAt === null)
    agg.startedAt = now;
  agg.sessions.add(sessionId);
  agg.steps += 1;
  agg.output += usage.output;
  agg.reasoning += usage.reasoning;
  agg.cost += usage.cost;
  const hit = usage.cacheRead;
  const miss = usage.input + usage.cacheWrite;
  agg.lastStep = {
    sessionId,
    messageID,
    cost: usage.cost,
    output: usage.output,
    reasoning: usage.reasoning,
    cached: usage.hasCache,
    hit,
    miss,
    input: usage.input,
    write: usage.cacheWrite
  };
  if (!usage.hasCache) {
    if (retrying && before?.cached && last?.messageID === messageID)
      agg.last = null;
    return;
  }
  agg.hit += hit;
  agg.miss += miss;
  agg.write += usage.cacheWrite;
  agg.input += usage.input;
  const repeatsPoint = last !== null && last.sessionId === sessionId && last.messageID === messageID;
  const previous = repeatsPoint ? agg.prevHitRate : last?.hitRate ?? null;
  const hitRate = cacheRate(hit, miss);
  agg.last = {
    at: now,
    sessionId,
    messageID,
    hit,
    miss,
    hitRate,
    delta: hitRate !== null && previous !== null ? hitRate - previous : null,
    output: usage.output,
    reasoning: usage.reasoning,
    input: usage.input,
    write: usage.cacheWrite
  };
  agg.prevHitRate = previous;
};
var recordCacheStep = (sessionId, messageID, usage, now) => {
  if (!sessionId)
    return;
  for (const root of watchedRootsFor(sessionId)) {
    const state = sessionStates.get(root);
    if (state)
      foldCacheStep(state.cache, sessionId, messageID, usage, now);
  }
};
var watchedRootsFor = (sessionId) => {
  const roots = [];
  const seen = new Set;
  let cursor = sessionId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    if (watched.has(cursor) || cursor === watch?.sessionId || activeRoots.has(cursor))
      roots.push(cursor);
    cursor = sessionParents.get(cursor);
  }
  return roots;
};
var sessionIdsFor = (requested) => {
  if (!requested)
    return [];
  const ids = new Set([requested]);
  for (const [child, parent] of sessionParents) {
    let cursor = parent;
    const seen = new Set;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      if (cursor === requested) {
        ids.add(child);
        break;
      }
      cursor = sessionParents.get(cursor);
    }
  }
  return [...ids];
};
var cacheWire = (agg) => agg.steps === 0 ? null : {
  startedAt: agg.startedAt,
  steps: agg.steps,
  sessions: agg.sessions.size,
  hit: agg.hit,
  miss: agg.miss,
  hitRate: cacheRate(agg.hit, agg.miss),
  write: agg.write,
  input: agg.input,
  output: agg.output,
  reasoning: agg.reasoning,
  cost: agg.cost,
  last: agg.last,
  prevHitRate: agg.prevHitRate
};
var cacheMemory = (agg) => ({
  ...agg,
  sessions: [...agg.sessions].slice(-60)
});
var restoreCache = (raw) => {
  const rec = readRecord(raw);
  if (!rec)
    return emptyCache();
  const agg = emptyCache();
  agg.startedAt = typeof rec.startedAt === "number" && Number.isFinite(rec.startedAt) ? rec.startedAt : null;
  agg.steps = readNumber(rec.steps);
  const sessions = Array.isArray(rec.sessions) ? rec.sessions : [];
  for (const id of sessions.slice(-60))
    if (typeof id === "string" && id)
      agg.sessions.add(id);
  agg.hit = readNumber(rec.hit);
  agg.miss = readNumber(rec.miss);
  agg.write = readNumber(rec.write);
  agg.input = readNumber(rec.input);
  agg.output = readNumber(rec.output);
  agg.reasoning = readNumber(rec.reasoning);
  agg.cost = readNumber(rec.cost);
  const last = readRecord(rec.last);
  if (last && typeof last.sessionId === "string") {
    agg.last = {
      at: readNumber(last.at),
      sessionId: last.sessionId,
      messageID: readString(last.messageID),
      hit: readNumber(last.hit),
      miss: readNumber(last.miss),
      hitRate: typeof last.hitRate === "number" && Number.isFinite(last.hitRate) ? last.hitRate : null,
      delta: typeof last.delta === "number" && Number.isFinite(last.delta) ? last.delta : null,
      output: readNumber(last.output),
      reasoning: readNumber(last.reasoning),
      input: readNumber(last.input),
      write: readNumber(last.write)
    };
  }
  agg.prevHitRate = typeof rec.prevHitRate === "number" && Number.isFinite(rec.prevHitRate) ? rec.prevHitRate : null;
  const base = readRecord(rec.turnBase);
  if (base) {
    agg.turnBase = {
      hit: readNumber(base.hit),
      miss: readNumber(base.miss),
      steps: readNumber(base.steps),
      output: readNumber(base.output)
    };
  }
  const step = readRecord(rec.lastStep);
  if (step && typeof step.sessionId === "string" && typeof step.messageID === "string") {
    agg.lastStep = {
      sessionId: step.sessionId,
      messageID: step.messageID,
      cost: readNumber(step.cost),
      output: readNumber(step.output),
      reasoning: readNumber(step.reasoning),
      cached: step.cached === true,
      hit: readNumber(step.hit),
      miss: readNumber(step.miss),
      input: readNumber(step.input),
      write: readNumber(step.write)
    };
  }
  return agg;
};
var samples = [];
var partChars = new Map;
var deltaParts = new Set;
var deltaToolCalls = new Set;
var messageChars = new Map;
var chatModel = null;
var watch = null;
var connection = "idle";
var lastError = null;
var lastErrorKind = null;
var streamLostAt = null;
var lastEventAt = 0;
var busy = false;
var controller = null;
var retryTimer = null;
var retryDelay = RETRY_BASE_MS;
var turnExecAt = null;
var turnStartedAt = null;
var turnLastCharAt = null;
var turnChars = 0;
var turnReasoningChars = 0;
var turnActiveMs = 0;
var turnWaitMs = 0;
var waitStartAt = null;
var activeToolIds = new Set;
var turnToolMs = 0;
var toolStartAt = null;
var steps2 = new Map;
var turnStepOrder = [];
var pendingToolStep = new Map;
var fbChars = -1;
var fbTps = NaN;
var lastTurn = null;
var cache = emptyCache();
var pendingPermissions = new Set;
var pendingQuestions = new Set;
var waitingKind = () => pendingPermissions.size > 0 ? "permission" : pendingQuestions.size > 0 ? "question" : null;
var clearTurn = () => {
  turnExecAt = null;
  turnStartedAt = null;
  turnLastCharAt = null;
  turnChars = 0;
  turnReasoningChars = 0;
  turnActiveMs = 0;
  turnWaitMs = 0;
  waitStartAt = null;
  turnToolMs = 0;
  toolStartAt = null;
  fbChars = -1;
  fbTps = NaN;
  for (const id of turnStepOrder)
    steps2.delete(id);
  turnStepOrder = [];
};
var sessionStates = new Map;
var watched = new Set;
var sessionParents = new Map;
var BACKGROUND_ROOT_CAP = 8;
var activeRoots = new Map;
var lookedUp = new Set;
var deferredEvents = new Map;
var TRACKED_CAP = SESSIONS_CAP;
var createSessionState = (sessionId) => ({
  sessionId,
  currentModel: "*",
  chatModel: null,
  lastSeenAt: Date.now(),
  samples: [],
  partChars: new Map,
  deltaParts: new Set,
  deltaToolCalls: new Set,
  messageChars: new Map,
  busy: false,
  turnExecAt: null,
  turnStartedAt: null,
  turnLastCharAt: null,
  turnChars: 0,
  turnReasoningChars: 0,
  turnActiveMs: 0,
  turnWaitMs: 0,
  waitStartAt: null,
  activeToolIds: new Set,
  turnToolMs: 0,
  toolStartAt: null,
  steps: new Map,
  turnStepOrder: [],
  pendingToolStep: new Map,
  fbChars: -1,
  fbTps: NaN,
  lastTurn: null,
  cache: emptyCache(),
  pendingPermissions: new Set,
  pendingQuestions: new Set
});
var activeSession = createSessionState("");
var activeSessionId = null;
var inSession = false;
var trimSessionStates = () => {
  while (sessionStates.size > TRACKED_CAP) {
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [key, value] of sessionStates) {
      if (key === activeSessionId || watched.has(key) || key === watch?.sessionId)
        continue;
      if (activeRoots.has(key))
        continue;
      if (value.lastSeenAt < oldestAt) {
        oldestAt = value.lastSeenAt;
        oldestKey = key;
      }
    }
    if (oldestKey === null)
      break;
    sessionStates.delete(oldestKey);
  }
};
var trackSession = (sessionId) => {
  const existing = sessionStates.get(sessionId);
  if (existing) {
    existing.lastSeenAt = Date.now();
    return existing;
  }
  const created = createSessionState(sessionId);
  sessionStates.set(sessionId, created);
  trimSessionStates();
  return created;
};
var loadState = (state) => {
  if (inSession)
    throw new Error("loadState called while already inside a session");
  activeSession = state;
  activeSessionId = state.sessionId || null;
  inSession = true;
  currentModel = state.currentModel;
  chatModel = state.chatModel;
  samples = state.samples;
  partChars = state.partChars;
  deltaParts = state.deltaParts;
  deltaToolCalls = state.deltaToolCalls;
  messageChars = state.messageChars;
  busy = state.busy;
  turnExecAt = state.turnExecAt;
  turnStartedAt = state.turnStartedAt;
  turnLastCharAt = state.turnLastCharAt;
  turnChars = state.turnChars;
  turnReasoningChars = state.turnReasoningChars;
  turnActiveMs = state.turnActiveMs;
  turnWaitMs = state.turnWaitMs;
  waitStartAt = state.waitStartAt;
  activeToolIds = state.activeToolIds;
  turnToolMs = state.turnToolMs;
  toolStartAt = state.toolStartAt;
  steps2 = state.steps;
  turnStepOrder = state.turnStepOrder;
  pendingToolStep = state.pendingToolStep;
  fbChars = state.fbChars;
  fbTps = state.fbTps;
  lastTurn = state.lastTurn;
  cache = state.cache;
  pendingPermissions = state.pendingPermissions;
  pendingQuestions = state.pendingQuestions;
};
var enterSession = (sessionId) => {
  if (inSession)
    throw new Error("enterSession called while already inside a session");
  loadState(trackSession(sessionId));
};
var leaveSession = () => {
  if (!inSession)
    return;
  const state = activeSession;
  state.currentModel = currentModel;
  state.chatModel = chatModel;
  state.lastSeenAt = Date.now();
  state.samples = samples;
  state.partChars = partChars;
  state.deltaParts = deltaParts;
  state.deltaToolCalls = deltaToolCalls;
  state.messageChars = messageChars;
  state.busy = busy;
  state.turnExecAt = turnExecAt;
  state.turnStartedAt = turnStartedAt;
  state.turnLastCharAt = turnLastCharAt;
  state.turnChars = turnChars;
  state.turnReasoningChars = turnReasoningChars;
  state.turnActiveMs = turnActiveMs;
  state.turnWaitMs = turnWaitMs;
  state.waitStartAt = waitStartAt;
  state.activeToolIds = activeToolIds;
  state.turnToolMs = turnToolMs;
  state.toolStartAt = toolStartAt;
  state.steps = steps2;
  state.turnStepOrder = turnStepOrder;
  state.pendingToolStep = pendingToolStep;
  state.fbChars = fbChars;
  state.fbTps = fbTps;
  state.lastTurn = lastTurn;
  state.cache = cache;
  state.pendingPermissions = pendingPermissions;
  state.pendingQuestions = pendingQuestions;
  inSession = false;
  activeSessionId = null;
};
var blankSession = createSessionState("");
var statePaths = () => {
  const override = process.env.OPENCHAMBER_GAUGE_STATE;
  if (override)
    return [override];
  const dataDir = process.env.OPENCHAMBER_SERVICE_DATA_DIR;
  const fallback = path2.join(os2.tmpdir(), "openchamber-gauge-state.json");
  return dataDir ? [path2.join(dataDir, "state.json"), fallback] : [fallback];
};
var legacyStatePath = () => {
  if (process.env.OPENCHAMBER_GAUGE_STATE)
    return null;
  const entry = process.argv[1];
  return entry ? path2.join(path2.dirname(entry), ".gauge-state.json") : null;
};
var memoryOf = (state) => ({
  lastTurn: state.lastTurn,
  cache: cacheMemory(state.cache)
});
var readSessions = (file) => {
  try {
    const parsed = JSON.parse(fs2.readFileSync(file, "utf8"));
    if (!parsed || parsed.version !== PERSIST_VERSION || !parsed.sessions)
      return {};
    const out = {};
    for (const [id, raw] of Object.entries(parsed.sessions)) {
      if (id && raw && typeof raw === "object")
        out[id] = raw;
    }
    return out;
  } catch {
    return {};
  }
};
var readModels = (file) => {
  try {
    const parsed = JSON.parse(fs2.readFileSync(file, "utf8"));
    const out = {};
    const models = parsed && typeof parsed.models === "object" ? parsed.models : null;
    if (models) {
      for (const [key, value] of Object.entries(models)) {
        if (key && typeof value === "number" && Number.isFinite(value))
          out[key] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
};
var readPersisted = () => {
  const legacy = legacyStatePath();
  for (const file of [...statePaths().slice(0, 1), ...legacy ? [legacy] : [], ...statePaths().slice(1)]) {
    const sessions = readSessions(file);
    if (Object.keys(sessions).length === 0)
      continue;
    for (const [model, factor] of Object.entries(readModels(file))) {
      calibration.set(model, factor);
    }
    for (const [id, raw] of Object.entries(sessions)) {
      const memory = raw;
      const state = createSessionState(id);
      state.lastTurn = memory.lastTurn ?? null;
      state.cache = restoreCache(memory.cache);
      sessionStates.set(id, state);
    }
    return;
  }
};
var persistTimer = null;
var persistDirty = false;
var writePersisted = () => {
  const own = {};
  for (const [id, state] of sessionStates)
    own[id] = memoryOf(state);
  for (const file of statePaths()) {
    try {
      const foreign = Object.entries(readSessions(file)).filter(([id]) => own[id] === undefined);
      const sessions = { ...own };
      for (const [id, memory] of foreign.slice(0, Math.max(0, SESSIONS_CAP - Object.keys(own).length))) {
        sessions[id] = memory;
      }
      const payload = JSON.stringify({
        version: PERSIST_VERSION,
        savedAt: Date.now(),
        sessions,
        models: { ...readModels(file), ...Object.fromEntries(calibration) }
      });
      const tmp = `${file}.${process.pid}.tmp`;
      fs2.mkdirSync(path2.dirname(file), { recursive: true });
      fs2.writeFileSync(tmp, payload, "utf8");
      fs2.renameSync(tmp, file);
      const legacy = legacyStatePath();
      if (legacy && legacy !== file)
        fs2.rmSync(legacy, { force: true });
      return;
    } catch {}
  }
};
var flushPersist = () => {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (!persistDirty)
    return;
  persistDirty = false;
  writePersisted();
};
var schedulePersist = () => {
  persistDirty = true;
  if (persistTimer)
    return;
  persistTimer = setTimeout(flushPersist, PERSIST_DEBOUNCE_MS);
  persistTimer.unref?.();
};
var resetInFlight = () => {
  if (inSession)
    return;
  for (const id of [...sessionStates.keys()]) {
    enterSession(id);
    clearTurn();
    busy = false;
    activeToolIds.clear();
    pendingToolStep.clear();
    pendingPermissions.clear();
    pendingQuestions.clear();
    waitStartAt = null;
    toolStartAt = null;
    leaveSession();
  }
};
var turnTtftMs = () => turnExecAt !== null && turnStartedAt !== null ? Math.max(0, turnStartedAt - turnExecAt) : null;
var liveTtftMs = () => {
  const ttfts = [];
  for (const id of turnStepOrder) {
    const step = steps2.get(id);
    if (step && step.startObserved && step.firstCharAt !== null) {
      ttfts.push(Math.max(0, step.firstCharAt - step.startAt));
    }
  }
  if (ttfts.length > 0)
    return ttfts.reduce((a, b) => a + b, 0) / ttfts.length;
  return turnTtftMs();
};
var noteWaiting = (now) => {
  if (waitingKind() !== null) {
    if (waitStartAt === null)
      waitStartAt = now;
  } else if (waitStartAt !== null) {
    turnWaitMs += now - waitStartAt;
    waitStartAt = null;
  }
};
var toolActive = () => activeToolIds.size > 0;
var noteTools = (now) => {
  if (toolActive()) {
    if (toolStartAt === null)
      toolStartAt = now;
  } else if (toolStartAt !== null) {
    turnToolMs += now - toolStartAt;
    toolStartAt = null;
  }
};
var stepFor = (messageID, now) => {
  let step = steps2.get(messageID);
  if (!step) {
    step = {
      id: messageID,
      startAt: now,
      startObserved: false,
      endAt: null,
      settled: false,
      output: 0,
      reasoning: 0,
      firstCharAt: null,
      chars: 0,
      lastDeltaAt: null,
      sawReasoning: false,
      toolSpans: [],
      toolOpen: 0,
      toolSince: null
    };
    steps2.set(messageID, step);
    turnStepOrder.push(messageID);
    if (steps2.size > 500) {
      const oldest = steps2.keys().next();
      if (!oldest.done)
        steps2.delete(oldest.value);
    }
  }
  return step;
};
var latestOpenStepId = () => {
  for (let i = turnStepOrder.length - 1;i >= 0; i -= 1) {
    if (steps2.get(turnStepOrder[i])?.endAt === null)
      return turnStepOrder[i];
  }
  return null;
};
var closeStepTool = (step, now) => {
  if (step.toolSince !== null) {
    step.toolSpans.push([step.toolSince, Math.max(step.toolSince, now)]);
    step.toolSince = null;
  }
  step.toolOpen = 0;
};
var stepToolWithinMs = (step, fromMs, toMs) => {
  let total = 0;
  for (const [from, to] of step.toolSpans) {
    total += Math.max(0, Math.min(to, toMs) - Math.max(from, fromMs));
  }
  if (step.toolOpen > 0 && step.toolSince !== null) {
    total += Math.max(0, toMs - Math.max(step.toolSince, fromMs));
  }
  return total;
};
var MAX_PLAUSIBLE_TOKENS_PER_SECOND = 5000;
var plausibleRate = (tokens, ms) => {
  if (!(ms >= 1))
    return null;
  const tps = tokens / (ms / 1000);
  return tps > MAX_PLAUSIBLE_TOKENS_PER_SECOND ? null : tps;
};
var generationStart = (step) => {
  if (step.firstCharAt === null)
    return step.startAt;
  if (step.reasoning > 0 && !step.sawReasoning)
    return step.startAt;
  return step.firstCharAt;
};
var contributeStep = (step) => {
  if (!step.startObserved)
    return null;
  const genStart = generationStart(step);
  const endRef = step.endAt ?? step.lastDeltaAt ?? step.startAt;
  const netMs = Math.max(0, endRef - genStart) - stepToolWithinMs(step, genStart, endRef);
  if (!(netMs >= 1))
    return null;
  let tokens;
  let real;
  if (step.settled && step.output + step.reasoning > 0) {
    tokens = step.output + step.reasoning;
    real = true;
  } else if (!step.settled && step.chars > 0) {
    tokens = estimateTokens(step.chars);
    real = false;
  } else {
    return null;
  }
  if (tokens / (netMs / 1000) > MAX_PLAUSIBLE_TOKENS_PER_SECOND)
    return null;
  return {
    tokens,
    netMs,
    real,
    ttftMs: step.firstCharAt !== null ? Math.max(0, step.firstCharAt - step.startAt) : null
  };
};
var sumSteps = () => {
  let tokens = 0;
  let netMs = 0;
  let real = false;
  const ttfts = [];
  for (const id of turnStepOrder) {
    const step = steps2.get(id);
    if (!step)
      continue;
    const part = contributeStep(step);
    if (!part)
      continue;
    tokens += part.tokens;
    netMs += part.netMs;
    real = real || part.real;
    if (part.ttftMs !== null)
      ttfts.push(part.ttftMs);
  }
  if (!(netMs >= 1) || !(tokens > 0))
    return null;
  return {
    tokens,
    netMs,
    real,
    ttftMs: ttfts.length > 0 ? ttfts.reduce((a, b) => a + b, 0) / ttfts.length : null
  };
};
var computeRunning = () => {
  const sum = sumSteps();
  if (sum)
    return { tps: sum.tokens / (sum.netMs / 1000), source: sum.real ? "tokens" : "estimate" };
  if (turnStartedAt === null || turnChars === 0)
    return null;
  if (turnChars === fbChars && Number.isFinite(fbTps)) {
    return { tps: fbTps, source: "estimate" };
  }
  const ref = turnLastCharAt ?? turnStartedAt;
  const frozenWait = turnWaitMs + (waitStartAt !== null ? Math.max(0, ref - waitStartAt) : 0);
  const frozenTool = turnToolMs + (toolStartAt !== null ? Math.max(0, ref - toolStartAt) : 0);
  const reconstructed = turnExecAt === null ? ref - turnStartedAt : ref - turnExecAt - frozenWait - frozenTool;
  const elapsedMs = reconstructed >= 1 ? reconstructed : turnActiveMs;
  const tps = plausibleRate(estimateTokens(turnChars), elapsedMs);
  if (tps === null) {
    fbTps = NaN;
    return null;
  }
  fbChars = turnChars;
  fbTps = tps;
  return { tps, source: "estimate" };
};
var snapshotTurnCache = () => {
  const agg = cache;
  if (agg.steps === 0)
    return null;
  const base = agg.turnBase ?? { hit: 0, miss: 0, steps: 0, output: 0 };
  const hit = Math.max(0, agg.hit - base.hit);
  const miss = Math.max(0, agg.miss - base.miss);
  const steps = Math.max(0, agg.steps - base.steps);
  const output = Math.max(0, agg.output - base.output);
  agg.turnBase = { hit: agg.hit, miss: agg.miss, steps: agg.steps, output: agg.output };
  if (steps === 0 || hit + miss === 0)
    return null;
  return { hit, miss, steps, output, hitRate: cacheRate(hit, miss) };
};
var turnSplit = (now, writeMs) => {
  const started = turnExecAt ?? turnStartedAt;
  return splitTurn({
    totalMs: started !== null ? now - started - turnWaitMs : 0,
    writeMs,
    toolMs: turnToolMs,
    readMs: takeReadMs(sessionIdsFor(activeSessionId))
  });
};
var finalizeTurn = (now) => {
  noteWaiting(now);
  noteTools(now);
  const wallMs = turnStartedAt !== null ? Math.max(1, now - turnStartedAt) : 1;
  const sum = sumSteps();
  if (sum) {
    const turnCache = snapshotTurnCache();
    lastTurn = {
      tokensPerSecond: sum.tokens / (sum.netMs / 1000),
      source: sum.real ? "tokens" : "estimate",
      tokens: sum.tokens,
      activeMs: Math.round(sum.netMs),
      ttftMs: sum.ttftMs,
      hasReasoning: turnReasoningChars > 0 || [...steps2.values()].some((s) => s.reasoning > 0),
      endedAt: now,
      cache: turnCache,
      split: turnSplit(now, sum.netMs)
    };
    schedulePersist();
    clearTurn();
    return;
  }
  if (turnStartedAt === null || turnLastCharAt === null || turnChars === 0) {
    clearTurn();
    return;
  }
  const activeMs = Math.max(1, turnActiveMs > 0 ? Math.round(turnActiveMs) : Math.min(wallMs, MAX_STREAM_GAP_MS));
  const tps = plausibleRate(estimateTokens(turnChars), activeMs);
  if (tps === null) {
    clearTurn();
    return;
  }
  const turnCache = snapshotTurnCache();
  lastTurn = {
    tokensPerSecond: tps,
    source: "estimate",
    tokens: estimateTokens(turnChars),
    activeMs,
    ttftMs: turnTtftMs(),
    hasReasoning: turnReasoningChars > 0,
    endedAt: now,
    cache: turnCache,
    split: turnSplit(now, activeMs)
  };
  schedulePersist();
  clearTurn();
};
var pruneSamples = (cutoff) => {
  let expired = 0;
  while (expired < samples.length && samples[expired].at < cutoff) {
    expired += 1;
  }
  if (expired > 0)
    samples.splice(0, expired);
};
var recordChars = (messageID, partID, kind, chars, now) => {
  if (chars <= 0)
    return;
  busy = true;
  samples.push({ at: now, chars, kind });
  if (samples.length > SAMPLE_LIMIT)
    samples.splice(0, samples.length - SAMPLE_LIMIT);
  partChars.set(partID, (partChars.get(partID) ?? 0) + chars);
  messageChars.set(messageID, (messageChars.get(messageID) ?? 0) + chars);
  lastEventAt = now;
  if (turnStartedAt === null) {
    turnStartedAt = now;
    if (turnExecAt !== null && now - turnExecAt <= MAX_STREAM_GAP_MS) {
      turnActiveMs += now - turnExecAt;
    }
  } else if (turnLastCharAt !== null && waitingKind() === null) {
    const gap = now - turnLastCharAt;
    if (gap <= MAX_STREAM_GAP_MS)
      turnActiveMs += gap;
  }
  turnLastCharAt = now;
  turnChars += chars;
  if (kind === "reasoning")
    turnReasoningChars += chars;
  if (messageID) {
    const step = stepFor(messageID, now);
    step.chars += chars;
    step.lastDeltaAt = now;
    if (step.firstCharAt === null)
      step.firstCharAt = now;
    if (kind === "reasoning")
      step.sawReasoning = true;
  }
};
var isWatchedSession = (sessionID) => typeof sessionID === "string" && activeSessionId !== null && sessionID === activeSessionId;
var readString = (value) => typeof value === "string" ? value : "";
var readNumber = (value) => typeof value === "number" && Number.isFinite(value) ? value : 0;
var readRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
var fragmentPartID = (messageID, kind, ordinal) => {
  if (!messageID)
    return "";
  const index = typeof ordinal === "number" && Number.isInteger(ordinal) && ordinal >= 0 ? ordinal : 0;
  return `${messageID}:${kind}:${index}`;
};
var normType = (type) => type.replace(".next.", ".");
var markActive = (now) => {
  if (turnExecAt === null)
    turnExecAt = now;
  busy = true;
  lastEventAt = now;
};
var readToolCallID = (payload) => readString(payload.callID) || readString(payload.id) || readString(payload.toolCallID);
var toolPartID = (messageID, callID) => `${messageID}:tool:${callID || "input"}`;
var settleStep = (messageID, output, reasoning, now) => {
  const generated = output + reasoning;
  if (!messageID || generated <= 0)
    return;
  calibrate(currentModel, messageChars.get(messageID) ?? 0, generated);
  const step = stepFor(messageID, now);
  step.output = output;
  step.reasoning = reasoning;
  step.settled = true;
  if (step.endAt === null)
    step.endAt = now;
  closeStepTool(step, now);
};
var eventSessionID = (event) => {
  const payload = readRecord(event.data) ?? readRecord(event.properties);
  if (!payload)
    return null;
  const direct = readString(payload.sessionID);
  if (direct)
    return direct;
  const form = readRecord(payload.form);
  return form ? readString(form.sessionID) : "";
};
var handleEvent = (event, now) => {
  const sessionId = eventSessionID(event);
  const type = normType(readString(event.type));
  if (sessionId && type === "session.created") {
    const data = readRecord(event.data) ?? readRecord(event.properties);
    const parentID = data ? readString(data.parentID) : "";
    if (parentID)
      sessionParents.set(sessionId, parentID);
    else {
      sessionParents.delete(sessionId);
      noteBackgroundRoot(sessionId, now);
    }
    if (watchedRootsFor(sessionId).length > 0)
      trackSession(sessionId);
  }
  if (!sessionId || !sessionStates.has(sessionId)) {
    if (sessionId && (type === "session.step.ended" || type === "session.step.failed")) {
      holdForLookup(sessionId, event);
    }
    return;
  }
  if (sessionId && !sessionParents.has(sessionId) && watchedRootsFor(sessionId).length === 0 && (type === "session.step.ended" || type === "session.step.failed")) {
    holdForLookup(sessionId, event);
    return;
  }
  enterSession(sessionId);
  try {
    dispatchEvent(event, now);
  } finally {
    leaveSession();
  }
};
var holdForLookup = (sessionId, event) => {
  if (watched.size === 0 && !watch?.sessionId && activeRoots.size === 0)
    return;
  if (!lookedUp.has(sessionId)) {
    lookedUp.add(sessionId);
    if (lookedUp.size > 200) {
      const oldest = lookedUp.values().next();
      if (!oldest.done)
        lookedUp.delete(oldest.value);
    }
    resolveSessionParent(sessionId);
  }
  const held = deferredEvents.get(sessionId) ?? [];
  held.push(event);
  if (held.length > 4)
    held.shift();
  deferredEvents.set(sessionId, held);
};
var fetchSessionParent = async (sessionId) => {
  if (!OPENCODE_URL)
    return null;
  try {
    const response = await fetch(`${OPENCODE_URL}/api/session/${encodeURIComponent(sessionId)}`, {
      headers: opencodeHeaders("application/json"),
      signal: AbortSignal.timeout(3000),
      redirect: "manual"
    });
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok || !contentType.includes("json")) {
      await response.body?.cancel().catch(() => {
        return;
      });
      return null;
    }
    const body = readRecord(await response.json());
    if (!body)
      return null;
    const record = readRecord(body.data) ?? body;
    return readString(record.parentID) || readString(record.parentId);
  } catch {
    return null;
  }
};
var resolveSessionParent = async (sessionId) => {
  const parentID = await fetchSessionParent(sessionId);
  if (parentID === null) {
    deferredEvents.delete(sessionId);
    return;
  }
  if (parentID)
    sessionParents.set(sessionId, parentID);
  else
    sessionParents.delete(sessionId);
  if (watchedRootsFor(sessionId).length === 0) {
    deferredEvents.delete(sessionId);
    return;
  }
  trackSession(sessionId);
  const held = deferredEvents.get(sessionId) ?? [];
  deferredEvents.delete(sessionId);
  for (const event of held)
    handleEvent(event, Date.now());
};
var dispatchEvent = (event, now) => {
  const type = normType(readString(event.type));
  if (!type)
    return;
  const payload = readRecord(event.data) ?? readRecord(event.properties);
  if (!payload)
    return;
  if (type === "session.text.delta" || type === "session.reasoning.delta") {
    if (!isWatchedSession(payload.sessionID))
      return;
    const messageID = readString(payload.assistantMessageID);
    const delta = readString(payload.delta);
    const kind = type === "session.reasoning.delta" ? "reasoning" : "text";
    const partID = fragmentPartID(messageID, kind, payload.ordinal);
    if (!partID || delta.length === 0)
      return;
    deltaParts.add(partID);
    recordChars(messageID, partID, kind, delta.length, now);
    return;
  }
  if (type === "session.text.ended" || type === "session.reasoning.ended") {
    if (!isWatchedSession(payload.sessionID))
      return;
    const messageID = readString(payload.assistantMessageID);
    const kind = type === "session.reasoning.ended" ? "reasoning" : "text";
    const partID = fragmentPartID(messageID, kind, payload.ordinal);
    if (!partID)
      return;
    if (deltaParts.has(partID))
      return;
    const text = readString(payload.text);
    const previous = partChars.get(partID) ?? 0;
    if (text.length <= previous)
      return;
    recordChars(messageID, partID, kind, text.length - previous, now);
    return;
  }
  if (type === "session.tool.input.started") {
    if (!isWatchedSession(payload.sessionID))
      return;
    markActive(now);
    const mid = readString(payload.assistantMessageID);
    if (mid)
      stepFor(mid, now);
    return;
  }
  if (type === "session.tool.input.delta") {
    if (!isWatchedSession(payload.sessionID))
      return;
    const messageID = readString(payload.assistantMessageID);
    const delta = readString(payload.delta);
    if (delta.length === 0)
      return;
    markActive(now);
    const partID = toolPartID(messageID, readToolCallID(payload));
    deltaToolCalls.add(partID);
    recordChars(messageID, partID, "tool", delta.length, now);
    return;
  }
  if (type === "session.tool.input.ended") {
    if (!isWatchedSession(payload.sessionID))
      return;
    const messageID = readString(payload.assistantMessageID);
    const partID = toolPartID(messageID, readToolCallID(payload));
    if (deltaToolCalls.has(partID))
      return;
    const text = readString(payload.text) || readString(payload.input);
    const previous = partChars.get(partID) ?? 0;
    if (text.length <= previous)
      return;
    markActive(now);
    recordChars(messageID, partID, "tool", text.length - previous, now);
    return;
  }
  if (type === "session.tool.called") {
    if (!isWatchedSession(payload.sessionID))
      return;
    markActive(now);
    const id = readToolCallID(payload) || readString(payload.assistantMessageID);
    if (id) {
      activeToolIds.add(`tool:${id}`);
      if (toolStartAt === null && turnExecAt !== null)
        toolStartAt = now;
      const mid = readString(payload.assistantMessageID);
      const target = mid ? stepFor(mid, now) : latestOpenStepId() ? steps2.get(latestOpenStepId()) ?? null : null;
      pendingToolStep.set(`tool:${id}`, target ? target.id : "");
      if (target) {
        target.toolOpen += 1;
        if (target.toolSince === null)
          target.toolSince = now;
      }
    }
    lastEventAt = now;
    return;
  }
  if (type === "session.tool.success" || type === "session.tool.failed") {
    if (!isWatchedSession(payload.sessionID))
      return;
    markActive(now);
    const id = readToolCallID(payload) || readString(payload.assistantMessageID);
    if (id)
      activeToolIds.delete(`tool:${id}`);
    if (id) {
      const stepId = pendingToolStep.get(`tool:${id}`);
      pendingToolStep.delete(`tool:${id}`);
      const target = stepId ? steps2.get(stepId) : undefined;
      if (target) {
        target.toolOpen = Math.max(0, target.toolOpen - 1);
        if (target.toolOpen === 0)
          closeStepTool(target, now);
      }
    }
    noteTools(now);
    lastEventAt = now;
    return;
  }
  if (type === "session.shell.started") {
    if (!isWatchedSession(payload.sessionID))
      return;
    markActive(now);
    const key = `shell:${readString(payload.id) || `at${now}`}`;
    activeToolIds.add(key);
    if (toolStartAt === null && turnExecAt !== null)
      toolStartAt = now;
    const openId = latestOpenStepId();
    const target = openId ? steps2.get(openId) ?? null : null;
    pendingToolStep.set(key, target ? target.id : "");
    if (target) {
      target.toolOpen += 1;
      if (target.toolSince === null)
        target.toolSince = now;
    }
    lastEventAt = now;
    return;
  }
  if (type === "session.shell.ended") {
    if (!isWatchedSession(payload.sessionID))
      return;
    markActive(now);
    const id = readString(payload.id);
    const closeKey = (key) => {
      activeToolIds.delete(key);
      const stepId = pendingToolStep.get(key);
      pendingToolStep.delete(key);
      const target = stepId ? steps2.get(stepId) : undefined;
      if (target) {
        target.toolOpen = Math.max(0, target.toolOpen - 1);
        if (target.toolOpen === 0)
          closeStepTool(target, now);
      }
    };
    if (id)
      closeKey(`shell:${id}`);
    else
      activeToolIds.forEach((key) => {
        if (key.startsWith("shell:"))
          closeKey(key);
      });
    noteTools(now);
    lastEventAt = now;
    return;
  }
  if (type === "session.step.started") {
    if (!isWatchedSession(payload.sessionID))
      return;
    markActive(now);
    const messageID = readString(payload.assistantMessageID);
    if (!messageID)
      return;
    const model = readString(payload.modelID) || readString(readRecord(payload.model)?.id);
    if (model)
      currentModel = model;
    const existing = steps2.get(messageID);
    if (existing && (existing.settled || existing.endAt !== null)) {
      steps2.delete(messageID);
      turnStepOrder = turnStepOrder.filter((id) => id !== messageID);
    }
    const serverCreated = readNumber(event.created) || now;
    const started = readNumber(payload.started);
    const startAt = started > 0 ? now - Math.max(0, serverCreated - started) : now;
    stepFor(messageID, startAt).startObserved = true;
    lastEventAt = now;
    return;
  }
  if (type === "session.step.ended" || type === "session.step.failed") {
    if (!isWatchedSession(payload.sessionID))
      return;
    markActive(now);
    const tokens = readRecord(payload.tokens);
    if (!tokens) {
      lastEventAt = now;
      return;
    }
    const messageID = readString(payload.assistantMessageID);
    recordCacheStep(readString(payload.sessionID), messageID || `step@${now}`, stepUsageFrom(tokens, readNumber(payload.cost)), now);
    settleStep(messageID, readNumber(tokens.output), readNumber(tokens.reasoning), now);
    lastEventAt = now;
    return;
  }
  if (type === "session.execution.started") {
    if (!isWatchedSession(payload.sessionID))
      return;
    const startedSession = readString(payload.sessionID);
    if (startedSession && !sessionParents.has(startedSession)) {
      noteBackgroundRoot(startedSession, now);
    }
    if (turnStepOrder.length > 0 || turnChars > 0) {
      finalizeTurn(now);
    }
    if (turnExecAt === null)
      turnExecAt = now;
    busy = true;
    lastEventAt = now;
    return;
  }
  if (type === "session.execution.succeeded" || type === "session.execution.failed") {
    if (!isWatchedSession(payload.sessionID))
      return;
    busy = false;
    lastEventAt = now;
    finalizeTurn(now);
    return;
  }
  if (type === "session.execution.interrupted") {
    if (!isWatchedSession(payload.sessionID))
      return;
    lastEventAt = now;
    if (readString(payload.reason) === "shutdown")
      return;
    busy = false;
    finalizeTurn(now);
    return;
  }
  if (type === "permission.asked" || type === "permission.v2.asked") {
    if (!isWatchedSession(payload.sessionID))
      return;
    const requestId = readString(payload.id);
    if (requestId)
      pendingPermissions.add(requestId);
    lastEventAt = now;
    return;
  }
  if (type === "permission.replied" || type === "permission.v2.replied") {
    if (!isWatchedSession(payload.sessionID))
      return;
    const requestId = readString(payload.requestID);
    if (requestId)
      pendingPermissions.delete(requestId);
    lastEventAt = now;
    return;
  }
  if (type === "form.created") {
    const form = readRecord(payload.form);
    if (!form || !isWatchedSession(form.sessionID))
      return;
    const requestId = readString(form.id);
    if (requestId)
      pendingQuestions.add(requestId);
    lastEventAt = now;
    return;
  }
  if (type === "form.replied" || type === "form.cancelled") {
    if (!isWatchedSession(payload.sessionID))
      return;
    const requestId = readString(payload.id);
    if (requestId)
      pendingQuestions.delete(requestId);
    lastEventAt = now;
    return;
  }
  if (type === "question.asked" || type === "question.v2.asked") {
    if (!isWatchedSession(payload.sessionID))
      return;
    const requestId = readString(payload.id);
    if (requestId)
      pendingQuestions.add(requestId);
    lastEventAt = now;
    return;
  }
  if (type === "question.replied" || type === "question.rejected" || type === "question.v2.replied" || type === "question.v2.rejected") {
    if (!isWatchedSession(payload.sessionID))
      return;
    const requestId = readString(payload.requestID);
    if (requestId)
      pendingQuestions.delete(requestId);
    lastEventAt = now;
    return;
  }
  if (type === "session.status") {
    if (!isWatchedSession(payload.sessionID))
      return;
    const status = readRecord(payload.status);
    const nextBusy = status?.type === "busy" || status?.type === "retry";
    if (busy && !nextBusy)
      finalizeTurn(now);
    if (nextBusy && turnExecAt === null)
      turnExecAt = now;
    busy = nextBusy;
    lastEventAt = now;
    return;
  }
  if (type === "session.idle") {
    if (!isWatchedSession(payload.sessionID))
      return;
    busy = false;
    lastEventAt = now;
    finalizeTurn(now);
  }
};
var handleSseChunk = (chunk) => {
  const data = [];
  for (const line of chunk.split(`
`)) {
    if (!line.startsWith("data:"))
      continue;
    data.push(line.slice(5).trimStart());
  }
  if (data.length === 0)
    return;
  let parsed;
  try {
    parsed = JSON.parse(data.join(`
`));
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object")
    return;
  const envelope = parsed;
  const event = envelope.payload && typeof envelope.payload === "object" ? envelope.payload : parsed;
  handleEvent(event, Date.now());
};
var scheduleReconnect = (message, kind, delay = retryDelay) => {
  lastError = message;
  lastErrorKind = kind;
  connection = "error";
  if (streamLostAt === null)
    streamLostAt = Date.now();
  if (retryTimer)
    return;
  retryDelay = Math.min(RETRY_MAX_MS, Math.max(RETRY_BASE_MS, retryDelay * 2));
  retryTimer = setTimeout(() => {
    retryTimer = null;
    beginStream();
  }, delay);
  retryTimer.unref?.();
};
var eventUrl = () => {
  const url = new URL(`${OPENCODE_URL}/api/event`);
  if (filterTypes)
    for (const type of EVENT_TYPES2)
      url.searchParams.append("types", type);
  return url.toString();
};
var startStream = async () => {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  controller?.abort();
  const local = new AbortController;
  controller = local;
  if (!OPENCODE_URL) {
    lastError = null;
    lastErrorKind = "access";
    connection = "error";
    return;
  }
  if (connection !== "live")
    connection = "connecting";
  let response;
  try {
    response = await fetch(eventUrl(), {
      headers: opencodeHeaders("text/event-stream"),
      signal: local.signal,
      redirect: "manual"
    });
  } catch (error) {
    if (local.signal.aborted)
      return;
    scheduleReconnect(error instanceof Error ? error.message : String(error), "network");
    return;
  }
  if (response.status === 400 && filterTypes) {
    await response.body?.cancel().catch(() => {
      return;
    });
    filterTypes = false;
    scheduleReconnect("Event stream refused the type list", "http", 0);
    return;
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel().catch(() => {
      return;
    });
    scheduleReconnect(`Event stream answered HTTP ${response.status}`, "access");
    return;
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {
      return;
    });
    scheduleReconnect(`Event stream answered HTTP ${response.status}`, "http");
    return;
  }
  const lostFor = streamLostAt === null ? 0 : Date.now() - streamLostAt;
  if (lostFor > RESUME_GAP_MS) {
    resetInFlight();
  }
  streamLostAt = null;
  connection = "live";
  lastError = null;
  lastErrorKind = null;
  retryDelay = RETRY_BASE_MS;
  lastEventAt = Date.now();
  let healthy = false;
  try {
    const decoder = new TextDecoder;
    const reader = response.body.getReader();
    let buffer = "";
    while (!local.signal.aborted) {
      const { value, done } = await reader.read();
      if (done)
        break;
      healthy = true;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf(`

`);
      while (boundary !== -1) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        handleSseChunk(chunk);
        boundary = buffer.indexOf(`

`);
      }
    }
  } catch (error) {
    if (local.signal.aborted)
      return;
    scheduleReconnect(error instanceof Error ? error.message : String(error), "closed", healthy ? 0 : retryDelay);
    return;
  }
  if (local.signal.aborted)
    return;
  scheduleReconnect("Event stream closed", "closed", healthy ? 0 : retryDelay);
};
var beginStream = () => {
  startStream().catch((error) => {
    scheduleReconnect(error instanceof Error ? error.message : String(error), "network");
  });
};
var ensureStream = () => {
  if (controller !== null || retryTimer !== null)
    return;
  beginStream();
};
var stopStream = () => {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  controller?.abort();
  controller = null;
  connection = "idle";
};
var computeLive = (now) => {
  const from = now - WINDOW_MS;
  let chars = 0;
  let oldest = now;
  for (const sample of samples) {
    if (sample.at < from)
      continue;
    chars += sample.chars;
    if (sample.at < oldest)
      oldest = sample.at;
  }
  if (chars === 0)
    return 0;
  const spanMs = Math.max(1, Math.min(WINDOW_MS, now - oldest));
  return Math.min(estimateTokens(chars) / (spanMs / 1000), MAX_PLAUSIBLE_TOKENS_PER_SECOND);
};
var computeCurve = (now) => {
  const width = CURVE_WINDOW_MS / CURVE_BUCKETS;
  const newest = Math.floor(now / width) * width;
  const oldest = newest - CURVE_WINDOW_MS;
  pruneSamples(oldest);
  const buckets = new Array(CURVE_BUCKETS).fill(0);
  for (const sample of samples) {
    if (sample.at < oldest || sample.at >= newest)
      continue;
    const b = Math.min(CURVE_BUCKETS - 1, Math.floor((sample.at - oldest) / width));
    buckets[b] += sample.chars;
  }
  const values = [];
  for (let b = 0;b < CURVE_BUCKETS; b += 1) {
    values.push(Math.min(estimateTokens(buckets[b]) / (width / 1000), MAX_PLAUSIBLE_TOKENS_PER_SECOND));
  }
  return { values, startAt: oldest, stepMs: width };
};
var applyWatch = (next, now) => {
  watch = next;
  leases.set(next.sessionId ?? "", now + LEASE_MS);
  if (next.sessionId) {
    watched.add(next.sessionId);
    const state = trackSession(next.sessionId);
    if (next.model)
      state.chatModel = next.model;
  }
  ensureStream();
};
var LEASE_MS = 12000;
var PUSH_EVERY_MS = 250;
var PUSH_KEEPALIVE_MS = 2000;
var PUSH_SESSIONS_MAX = 6;
var leases = new Map;
var lastPushed = new Map;
var pushing = true;
var VOLATILE = new Set(["curveAt", "at", "observedAt"]);
var signature = (body) => {
  const quiet = Array.isArray(body.curve) && body.curve.every((value) => value <= 0.05);
  return JSON.stringify(body, (key, value) => VOLATILE.has(key) || quiet && key === "curveStart" ? undefined : value);
};
var pushTick = () => {
  const now = Date.now();
  for (const [key, until] of leases) {
    if (until <= now) {
      leases.delete(key);
      lastPushed.delete(key);
    }
  }
  if (leases.size === 0)
    return;
  noteDemand(now);
  if (!pushing)
    return;
  for (const key of [...leases.keys()].slice(0, PUSH_SESSIONS_MAX)) {
    const body = rateBody(key || null, now);
    const sig = signature(body);
    const previous = lastPushed.get(key);
    if (previous && previous.sig === sig && now - previous.at < PUSH_KEEPALIVE_MS)
      continue;
    lastPushed.set(key, { sig, at: now });
    serviceHost.emit("rate", { session: key || null, rate: body }).catch((error) => {
      if (error?.code === "HOST_UNAVAILABLE")
        pushing = false;
      lastPushed.delete(key);
    });
  }
};
var pushTimer = setInterval(pushTick, PUSH_EVERY_MS);
pushTimer.unref?.();
var json = (res, status, body) => {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body));
};
var readJsonBody = (req) => new Promise((resolve, reject) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 64000) {
      reject(new Error("Request body too large"));
      req.destroy();
    }
  });
  req.on("end", () => {
    if (!body.trim()) {
      resolve(null);
      return;
    }
    try {
      resolve(JSON.parse(body));
    } catch {
      reject(new Error("Request body is not valid JSON"));
    }
  });
  req.on("error", reject);
});
var noteBackgroundRoot = (sessionId, now) => {
  activeRoots.delete(sessionId);
  activeRoots.set(sessionId, now);
  while (activeRoots.size > BACKGROUND_ROOT_CAP) {
    const oldest = activeRoots.keys().next();
    if (oldest.done)
      break;
    activeRoots.delete(oldest.value);
  }
};
var SESSION_EVENT_TYPES = new Set([
  "turn-finished",
  "turn-failed",
  "permission-asked",
  "question-asked",
  "turn-started",
  "session-created",
  "session-archived",
  "session-deleted"
]);
var handleSessionEvent = (body) => {
  const request = readRecord(body);
  if (!request || request.v !== 1)
    return false;
  const event = readRecord(request.event);
  if (!event)
    return false;
  const type = readString(event.type);
  if (!SESSION_EVENT_TYPES.has(type))
    return false;
  const session = readRecord(event.session);
  const sessionId = session ? readString(session.id) : "";
  const parentId = session ? readString(session.parentId) : "";
  if (!sessionId)
    return false;
  const now = Date.now();
  if (type === "session-created") {
    if (parentId)
      sessionParents.set(sessionId, parentId);
    else
      sessionParents.delete(sessionId);
  }
  if (type === "turn-started" && !parentId)
    noteBackgroundRoot(sessionId, now);
  if (type === "turn-started" || type === "turn-finished") {
    if (parentId)
      sessionParents.set(sessionId, parentId);
    if (watchedRootsFor(sessionId).length > 0)
      trackSession(sessionId);
    ensureStream();
  }
  if (type === "turn-finished")
    flushPersist();
  return true;
};
var chatModelReading = () => {
  const id = chatModel || (currentModel !== "*" ? currentModel : null);
  if (!id)
    return null;
  return { id, name: modelDisplayName(id) };
};
var rateBody = (requested, now) => {
  if (requested !== null)
    enterSession(requested);
  else
    loadState(blankSession);
  try {
    const curve = computeCurve(now);
    return {
      connection,
      error: lastError,
      errorKind: lastErrorKind,
      sessionId: requested !== null && watched.has(requested) ? requested : null,
      busy,
      waiting: waitingKind(),
      toolActive: toolActive(),
      live: { tps: computeLive(now) },
      running: turnStartedAt !== null ? computeRunning() : null,
      curve: curve.values,
      curveStart: curve.startAt,
      curveStep: curve.stepMs,
      curveAt: now,
      turn: {
        active: turnStartedAt !== null,
        ttftMs: liveTtftMs()
      },
      lastTurn,
      cache: cacheWire(cache),
      gauge: { ...gaugeWire(sessionIdsFor(requested), now), chatModel: chatModelReading() }
    };
  } finally {
    leaveSession();
  }
};
var server = http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    json(res, 401, { error: "unauthorized" });
    return;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/health") {
    json(res, 200, { ok: true, pid: process.pid });
    return;
  }
  if (url.pathname === "/watch" && req.method === "POST") {
    readJsonBody(req).then((raw) => {
      const body = raw && typeof raw === "object" ? raw : {};
      if (typeof body.sessionId === "string" && body.sessionId.trim().length > SESSION_ID_MAX) {
        json(res, 400, { error: "session id too long" });
        return;
      }
      const sessionId = typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim() : null;
      const model = typeof body.model === "string" && body.model.trim() && body.model.trim().length <= MODEL_NAME_MAX ? body.model.trim() : null;
      const changed = sessionId !== null && !watched.has(sessionId);
      applyWatch({ sessionId, model }, Date.now());
      json(res, 200, { ok: true, changed, connection, sessionId, push: pushing });
    }).catch((error) => {
      json(res, 400, { error: error instanceof Error ? error.message : "Invalid request" });
    });
    return;
  }
  if (url.pathname === "/session-events" && req.method === "POST") {
    readJsonBody(req).then((body) => {
      if (!handleSessionEvent(body)) {
        json(res, 400, { ok: false, error: "unsupported session event" });
        return;
      }
      json(res, 200, { ok: true });
    }).catch((error) => {
      json(res, 400, { ok: false, error: error instanceof Error ? error.message : "bad body" });
    });
    return;
  }
  if (url.pathname === "/rate") {
    const now = Date.now();
    noteDemand(now);
    const requested = readString(url.searchParams.get("sessionId")) || watch?.sessionId || null;
    json(res, 200, rateBody(requested, now));
    return;
  }
  json(res, 404, { error: "not-found" });
});
readPersisted();
server.listen(port, "127.0.0.1", () => {
  ensureStream();
});
var shutdown = () => {
  flushPersist();
  stopStream();
  server.close(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
