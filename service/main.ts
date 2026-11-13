// Gauge service for the `gauge` OpenChamber extension.
//
// Runs as the extension's local process (manifest `contributes.service`) on
// 127.0.0.1, reachable only through the host proxy. It reads OpenCode's own
// event stream through the read-only connection OpenChamber hands an approved
// `opencode` service (`OPENCHAMBER_OPENCODE_URL`, `GET /api/event`), and
// derives an instant generation rate per watched session.
//
// Differences from a naive rolling average: the live rate divides the buffered
// characters by the span they actually cover (up to the window), so the number
// is correct ~200 ms after streaming starts instead of climbing from 0 while
// the window fills.
//
// The stream carries the OpenCode 2 wire events: `session.text.delta` and
// `session.reasoning.delta` fragments, per-step token settlements
// (`session.step.ended`), and execution status (`session.execution.*`).
//
// The status page names the session it shows with `POST /watch`. The service
// pushes each watched session's reading to the open pages (`emit`), and still
// answers `GET /rate` for a host that does not deliver those events. The
// service never reaches the browser and the page never dials this process
// directly.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServiceHost } from '@openchamber/sdk';
import { modelDisplayName } from '../shared/models';
import { splitTurn, type TurnSplit } from '../shared/receipt';
import { tokensFromChars } from '../shared/tokens';
import { engineFigures, gaugeWire, modelKey, noteDemand, sessionKey, takeReadMs, type EngineFigure } from './gauge';

/**
 * The read-only OpenCode connection OpenChamber gives an approved service.
 *
 * Its bearer is this service's own token, and the host forwards only the
 * listed reads (sessions, projects, the event stream) to the OpenCode it is
 * using now. Without it there is nothing to measure: the SDK is explicit that
 * a service must not go looking for another OpenCode server instead.
 */
const OPENCODE_URL = (process.env.OPENCHAMBER_OPENCODE_URL ?? '').replace(/\/+$/, '');

const opencodeHeaders = (accept: string): Record<string, string> => ({
  Accept: accept,
  Authorization: `Bearer ${process.env.OPENCHAMBER_SERVICE_TOKEN ?? ''}`,
});

/**
 * The event types the measurement reads. Asking for these alone keeps the
 * stream small: the host ends a transfer at 8 MB, and the rest of OpenCode's
 * traffic would only bring that reconnect sooner. An OpenCode that does not
 * know one of these names refuses the list, and then the stream is read whole.
 */
const EVENT_TYPES = [
  'session.created',
  'session.text.delta', 'session.text.ended',
  'session.reasoning.delta', 'session.reasoning.ended',
  'session.tool.input.started', 'session.tool.input.delta', 'session.tool.input.ended',
  'session.tool.called', 'session.tool.success', 'session.tool.failed',
  'session.shell.started', 'session.shell.ended',
  'session.step.started', 'session.step.ended', 'session.step.failed',
  'session.execution.started', 'session.execution.succeeded',
  'session.execution.failed', 'session.execution.interrupted',
  'permission.asked', 'permission.replied',
  'form.created', 'form.replied', 'form.cancelled',
];
let filterTypes = true;

/** The way back into OpenChamber: pushes readings to the open pages. */
const serviceHost = createServiceHost({ env: process.env });

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';
if (!Number.isInteger(port) || port <= 0 || !token) {
  console.error('OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required');
  process.exit(1);
}

/**
 * Rolling measurement window. The live rate covers "about the last second":
 * characters older than this fall out, and the divisor is the span the
 * remaining samples actually cover, never more than this.
 */
const WINDOW_MS = 1_000;
/**
 * How far back the drawn curve reaches. Long enough to read a shape out of a
 * stream that arrives in ~150 ms batches, short of the minute a reader would
 * still call "now".
 */
const CURVE_WINDOW_MS = 30_000;
/** Points on the drawn curve, one per bucket of `CURVE_WINDOW_MS`. */
const CURVE_BUCKETS = 24;
/** Hard cap on retained delta samples; half a minute of chunks fits far below this. */
const SAMPLE_LIMIT = 20_000;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 15_000;
/** What a `/watch` may name: an OpenCode session id, and a model name. */
const SESSION_ID_MAX = 256;
const MODEL_NAME_MAX = 256;
/**
 * A stream that was live this recently resumes the turns it was measuring.
 *
 * The host ends every transfer at 8 MB and OpenCode drops a consumer that falls
 * behind, so a busy afternoon reconnects many times; a reconnect takes a few
 * milliseconds and loses a handful of deltas at most. Only a real outage, long
 * enough that a turn may have ended unseen, clears what was in flight.
 */
const RESUME_GAP_MS = 15_000;

// Characters are converted to tokens with the heuristic ported from
// opencode-tps-meter (see shared/tokens.ts): ceil(chars / 4). It is an
// approximation and is meant to be — provider-reported counts replace it
// whenever they arrive.
//
// Until they do, the correction below is what keeps the live number honest:
// the `calibrated live rate` from opencode-tps-meter v2, learned per model.
// A model whose real ratio departs from chars/4 is corrected by a factor here
// rather than by picking a different divisor, so the estimate converges on the
// provider's own count after a step or two.
const CALIBRATION_WEIGHT = 0.3;
const MIN_CALIBRATION_FACTOR = 0.25;
const MAX_CALIBRATION_FACTOR = 4;
/** Learned correction per model id; `*` covers a stream that never names one. */
let calibration = new Map<string, number>();
/** Model behind the turn currently streaming, used when a step names none. */
let currentModel = '*';

const calibrationFactor = (): number => calibration.get(currentModel) ?? 1;

/** Tokens for a streamed character total, corrected toward the model's real ratio. */
const estimateTokens = (chars: number): number =>
  Math.round(tokensFromChars(chars) * calibrationFactor());

const calibrate = (model: string, chars: number, generated: number): void => {
  if (!Number.isFinite(chars) || chars <= 0) return;
  if (!Number.isFinite(generated) || generated <= 0) return;
  const heuristic = tokensFromChars(chars);
  if (heuristic <= 0) return;
  const ratio = generated / heuristic;
  const factor = Math.min(MAX_CALIBRATION_FACTOR, Math.max(MIN_CALIBRATION_FACTOR, ratio));
  const previous = calibration.get(model) ?? 1;
  calibration.set(model, previous + (factor - previous) * CALIBRATION_WEIGHT);
};
/**
 * A gap between streamed characters longer than this is a pause, not
 * generation: tool execution, a retry, or the agent waiting for the user. That
 * time is excluded from the turn's average. Streamed chunks normally arrive in
 * tens of milliseconds, so the separation is wide.
 */
const MAX_STREAM_GAP_MS = 1_000;

type ConnectionState = 'idle' | 'connecting' | 'live' | 'error';

/** What kind of failure `lastError` describes, so the panel can word it. */
type ErrorKind = 'network' | 'http' | 'closed' | 'access';

/** One streamed fragment, and what the headline said when it arrived (0 when it said nothing). */
type Sample = { at: number; chars: number; kind: 'text' | 'reasoning' | 'tool'; tps: number };

type WatchConfig = {
  sessionId: string | null;
  /**
   * The model the chat has selected, as the page knows it.
   *
   * It is the model in play, which is not the model the local engine holds: a
   * cloud chat runs on a cloud model while the Mac keeps a local one in
   * memory. The page sends it with every watch.
   */
  model: string | null;
};

/** The finished turn's average rate, shown after the session goes idle. */
type TurnResult = {
  /** Average tokens per second over the turn's generation time. */
  tokensPerSecond: number;
  /** `tokens` when a settled step reported real counts, otherwise a character estimate. */
  source: 'tokens' | 'estimate';
  tokens: number;
  /** Denominator of the average: summed measurable step nets (step spans minus in-step tool time minus unreported-reasoning spans). */
  activeMs: number;
  /** Execution start to first streamed character; null when never observed. */
  ttftMs: number | null;
  /** Whether any reasoning (deltas or settled tokens) was seen this turn. */
  hasReasoning: boolean;
  endedAt: number;
  /** Cache share of the steps this turn settled; null when none reported any. */
  cache: TurnCache | null;
  /** Where the turn's time went; absent from a turn an older service recorded. */
  split?: TurnSplit;
  /** Time the turn sat waiting on a person (a permission, a question); not part of `split`. */
  askMs?: number;
  /** The speed the reply ended at: its last step's. What the headline keeps once the turn is over. */
  lastStep?: { tps: number; source: 'engine' | 'tokens' | 'estimate' };
};

type WaitingKind = 'permission' | 'question';

/** Cache totals of one finished turn, kept in its history point. */
type TurnCache = {
  hit: number;
  miss: number;
  steps: number;
  output: number;
  hitRate: number | null;
};

/** Provider usage of one settled step, as the cache accounting sees it. */
type StepUsage = {
  /** `tokens.input`: the prompt tokens billed without a cache hit. */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  /** `cost` carried by the event, 0 when the provider reports none. */
  cost: number;
  /** Whether the provider sent a `tokens.cache` block at all. */
  hasCache: boolean;
};

/** One settled step as the two hit rates remember it. */
type StepCachePoint = {
  at: number;
  sessionId: string;
  messageID: string;
  hit: number;
  miss: number;
  hitRate: number | null;
  /** Percentage points against the step before this one; null for the first. */
  delta: number | null;
  output: number;
  reasoning: number;
  /** Prompt split of this step, so a retry can take the old values back out. */
  input: number;
  write: number;
};

/**
 * Conversation-wide cache accounting.
 *
 * Every settled step of the watched session — and of every session below it
 * in the tree (`session.created` names the parent) — folds its provider usage
 * in here, so one number covers the whole call tree. `steps` counts the settled
 * steps that reported no cache too; only the two rates ignore those.
 */
type CacheTotals = {
  startedAt: number | null;
  steps: number;
  /** Sessions whose usage is folded in; the wire reports its size. */
  sessions: Set<string>;
  /** Σ `cache.read`. */
  hit: number;
  /** Σ `input + cache.write`: prompt tokens that were not served from cache. */
  miss: number;
  /** Σ `cache.write`, shown separately because a write is not a hit. */
  write: number;
  /** Σ `input` (uncached prompt). */
  input: number;
  output: number;
  reasoning: number;
  cost: number;
  last: StepCachePoint | null;
  /** Rate of the step before `last`; a retry needs it to recompute the delta. */
  prevHitRate: number | null;
  /** Totals already folded into a finished turn: the base of the next snapshot. */
  turnBase: { hit: number; miss: number; steps: number; output: number } | null;
  /** What the newest step added, so a retry of it can take that back out. */
  lastStep: StepFolded | null;
};

/** One settled step's share of the totals. */
type StepFolded = {
  sessionId: string;
  messageID: string;
  cost: number;
  output: number;
  reasoning: number;
  /** Whether it reported a cache block, so its prompt split is in the totals. */
  cached: boolean;
  hit: number;
  miss: number;
  input: number;
  write: number;
};

/** A session's durable numbers, as written to disk and read back on startup. */
/** The persisted form of `CacheTotals`: a Set does not survive JSON. */
type CacheMemory = Omit<CacheTotals, 'sessions'> & { sessions: string[] };
type SessionMemory = {
  lastTurn: TurnResult | null;
  cache?: CacheMemory | null;
};
/** Sessions remembered; oldest evicted past this. */
const SESSIONS_CAP = 20;
/**
 * What one state file may carry. Two OpenChamber servers on one workspace share
 * this file, and each keeps `SESSIONS_CAP` sessions of its own: twice that is
 * what lets both of them keep their history instead of taking turns overwriting
 * each other.
 */
const STATE_FILE_CAP = SESSIONS_CAP * 2;
/** How long a change waits before it is written, so a burst of events coalesces. */
const PERSIST_DEBOUNCE_MS = 1_500;
/** On-disk schema version; a mismatch discards the file instead of guessing. */
const PERSIST_VERSION = 1;

/** Rate of hit tokens out of the prompt tokens that had a cache answer. */
const cacheRate = (hit: number, miss: number): number | null => (
  hit + miss > 0 ? (hit / (hit + miss)) * 100 : null
);

function emptyCache(): CacheTotals {
  return {
    startedAt: null,
    steps: 0,
    sessions: new Set<string>(),
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
    lastStep: null,
  };
}

/** One settled step's provider usage; a missing `cache` block means "not reported". */
const stepUsageFrom = (tokens: Record<string, unknown>, cost: number): StepUsage => {
  const block = readRecord(tokens.cache);
  return {
    input: readNumber(tokens.input),
    cacheRead: block ? readNumber(block.read) : 0,
    cacheWrite: block ? readNumber(block.write) : 0,
    output: readNumber(tokens.output),
    reasoning: readNumber(tokens.reasoning),
    cost,
    hasCache: block !== null,
  };
};

/**
 * Fold one settled step into a conversation's totals.
 *
 * A retried step reuses its `assistantMessageID`, so when the last folded step
 * is the same one its previous numbers are taken back out first. `prevHitRate`
 * already names the step before it, which is why the new delta still compares
 * against the right step.
 */
const foldCacheStep = (
  agg: CacheTotals,
  sessionId: string,
  messageID: string,
  usage: StepUsage,
  now: number,
): void => {
  const last = agg.last;
  // A retry is recognized by the step it repeats, whatever that step
  // reported. Matching on the cache point alone missed a provider that reports
  // no cache (no point is kept for it) and left its first cost in the total.
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
  if (agg.startedAt === null) agg.startedAt = now;
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
    write: usage.cacheWrite,
  };
  if (!usage.hasCache) {
    // A provider that reports no cache still counts as a call, but must not
    // move the two rates: its miss share is unknown, not zero. A retry that
    // took back a cached first attempt takes its point with it.
    if (retrying && before?.cached && last?.messageID === messageID) agg.last = null;
    return;
  }
  agg.hit += hit;
  agg.miss += miss;
  agg.write += usage.cacheWrite;
  agg.input += usage.input;
  const repeatsPoint = last !== null && last.sessionId === sessionId && last.messageID === messageID;
  const previous = repeatsPoint ? agg.prevHitRate : (last?.hitRate ?? null);
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
    write: usage.cacheWrite,
  };
  agg.prevHitRate = previous;
};

/** Record a settled step into every watched conversation it belongs to. */
const recordCacheStep = (sessionId: string, messageID: string, usage: StepUsage, now: number): void => {
  if (!sessionId) return;
  for (const root of watchedRootsFor(sessionId)) {
    const state = sessionStates.get(root);
    if (state) foldCacheStep(state.cache, sessionId, messageID, usage, now);
  }
};

/**
 * Conversations whose tree contains `sessionId` (itself included).
 *
 * The last watched session keeps counting after every page unloads — the
 * section is unloaded while collapsed, and losing the turns it was closed for
 * would make the conversation total a lie. A new watch replaces it.
 */
const watchedRootsFor = (sessionId: string): string[] => {
  const roots: string[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined = sessionId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    if (watched.has(cursor) || cursor === watch?.sessionId || activeRoots.has(cursor)) roots.push(cursor);
    cursor = sessionParents.get(cursor);
  }
  return roots;
};

/**
 * The sessions whose prompt progress belongs to one chat: the chat itself and
 * the subagent sessions below it. A subagent's prompt is part of the same
 * conversation, so it is counted the same way.
 */
const sessionIdsFor = (requested: string | null): string[] => {
  if (!requested) return [];
  const ids = new Set<string>([requested]);
  for (const [child, parent] of sessionParents) {
    let cursor: string | undefined = parent;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      if (cursor === requested) { ids.add(child); break; }
      cursor = sessionParents.get(cursor);
    }
  }
  return [...ids];
};

type CacheWire = {
  startedAt: number | null;
  steps: number;
  sessions: number;
  hit: number;
  miss: number;
  hitRate: number | null;
  write: number;
  input: number;
  output: number;
  reasoning: number;
  cost: number;
  last: StepCachePoint | null;
  prevHitRate: number | null;
};

/** What both surfaces receive; null until a step settles. */
const cacheWire = (agg: CacheTotals): CacheWire | null => (
  agg.steps === 0 ? null : {
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
    prevHitRate: agg.prevHitRate,
  }
);

/** Durable shape: the session set becomes a bounded list of ids. */
const cacheMemory = (agg: CacheTotals): CacheMemory => ({
  ...agg,
  sessions: [...agg.sessions].slice(-60),
});

/** Restore a persisted aggregate; anything unreadable is simply an empty one. */
const restoreCache = (raw: unknown): CacheTotals => {
  const rec = readRecord(raw);
  if (!rec) return emptyCache();
  const agg = emptyCache();
  agg.startedAt = typeof rec.startedAt === 'number' && Number.isFinite(rec.startedAt) ? rec.startedAt : null;
  agg.steps = readNumber(rec.steps);
  const sessions = Array.isArray(rec.sessions) ? rec.sessions : [];
  for (const id of sessions.slice(-60)) if (typeof id === 'string' && id) agg.sessions.add(id);
  agg.hit = readNumber(rec.hit);
  agg.miss = readNumber(rec.miss);
  agg.write = readNumber(rec.write);
  agg.input = readNumber(rec.input);
  agg.output = readNumber(rec.output);
  agg.reasoning = readNumber(rec.reasoning);
  agg.cost = readNumber(rec.cost);
  const last = readRecord(rec.last);
  if (last && typeof last.sessionId === 'string') {
    agg.last = {
      at: readNumber(last.at),
      sessionId: last.sessionId,
      messageID: readString(last.messageID),
      hit: readNumber(last.hit),
      miss: readNumber(last.miss),
      hitRate: typeof last.hitRate === 'number' && Number.isFinite(last.hitRate) ? last.hitRate : null,
      delta: typeof last.delta === 'number' && Number.isFinite(last.delta) ? last.delta : null,
      output: readNumber(last.output),
      reasoning: readNumber(last.reasoning),
      input: readNumber(last.input),
      write: readNumber(last.write),
    };
  }
  agg.prevHitRate = typeof rec.prevHitRate === 'number' && Number.isFinite(rec.prevHitRate) ? rec.prevHitRate : null;
  const base = readRecord(rec.turnBase);
  if (base) {
    agg.turnBase = {
      hit: readNumber(base.hit),
      miss: readNumber(base.miss),
      steps: readNumber(base.steps),
      output: readNumber(base.output),
    };
  }
  const step = readRecord(rec.lastStep);
  if (step && typeof step.sessionId === 'string' && typeof step.messageID === 'string') {
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
      write: readNumber(step.write),
    };
  }
  return agg;
};

// Collection-valued state is `let` rather than `const`: `enterSession` swaps the
// reference to the one belonging to the session being processed, so mutations
// land in that session's own record. See `SessionState` below.
let samples: Sample[] = [];
/** Characters seen per part id, used to diff `session.text.ended` / `session.reasoning.ended` snapshots. */
let partChars = new Map<string, number>();
/** Parts already counted through streaming deltas, never diffed again. */
let deltaParts = new Set<string>();
/** Tool-input fragments already counted through input deltas, never diffed again. */
let deltaToolCalls = new Set<string>();
/** Characters seen per assistant message id. */
let messageChars = new Map<string, number>();
/**
 * The model the watched session's chat is using, as the page reported it.
 *
 * Mirrored like the rest of the session register: the page sets it through
 * `/watch`, and `/rate` reads it for the session it answers about.
 */
let chatModel: string | null = null;

let watch: WatchConfig | null = null;
let connection: ConnectionState = 'idle';
let lastError: string | null = null;
let lastErrorKind: ErrorKind | null = null;
/** When the stream last went down; a short gap resumes the turns in flight. */
let streamLostAt: number | null = null;
let busy = false;
let controller: AbortController | null = null;
let retryTimer: NodeJS.Timeout | null = null;
let retryDelay = RETRY_BASE_MS;

// The turn in progress. A turn spans `session.execution.started` until
// `session.execution.succeeded` / `failed`, but its average is built per
// assistant step (mirroring the native turn stats): total settled tokens over
// the steps' own durations minus tool execution inside each step. Only spans
// that produced countable tokens count — a step whose start was never
// observed, whose duration is unmeasurable, or that settled zero tokens is
// excluded; a settled step that streamed reasoning but reported zero
// reasoning tokens excludes its reasoning span. Whatever is left
// unmeasurable falls back to a character estimate, never to real counts over
// guessed time.
let turnExecAt: number | null = null;
let turnStartedAt: number | null = null;
let turnLastCharAt: number | null = null;
let turnChars = 0;
let turnReasoningChars = 0;
let turnActiveMs = 0;
let turnWaitMs = 0;
let waitStartAt: number | null = null;
/** Tool calls in flight (plus shell executions): generation is paused while non-empty. */
let activeToolIds = new Set<string>();
let turnToolMs = 0;
let toolStartAt: number | null = null;

/**
 * One assistant step (`assistantMessageID`) of the current turn.
 *
 * `startAt` is the step's real start, taken from the event's own `started`
 * field rather than from when the event arrived — see the `step.started`
 * handler. A step whose `step.started` was missed is marked
 * `startObserved: false` and excluded from measured averages.
 */
type StepRecord = {
  id: string;
  startAt: number;
  startObserved: boolean;
  endAt: number | null;
  settled: boolean;
  output: number;
  reasoning: number;
  firstCharAt: number | null;
  chars: number;
  /** Arrival of the latest counted delta; open steps freeze their span here. */
  lastDeltaAt: number | null;
  /** Whether any reasoning delta was counted; see `generationStart`. */
  sawReasoning: boolean;
  /** Closed tool intervals within this step; overlapping calls merge by counter. */
  toolSpans: Array<[number, number]>;
  toolOpen: number;
  toolSince: number | null;
  /** The model this step ran on. */
  model: string;
  /** The local engine's own figures for this step's reply, once claimed. */
  engine: { tps: number; tokens: number } | null;
};
let steps = new Map<string, StepRecord>();
/** Step ids seen in this turn, in arrival order. */
let turnStepOrder: string[] = [];
/** In-flight tool key -> step id it belongs to (`''` when unattributable). */
let pendingToolStep = new Map<string, string>();
/** Frozen-estimate cache: recomputed only when new characters arrive. */
let fbChars = -1;
let fbTps = NaN;
let lastTurn: TurnResult | null = null;
/**
 * The watched session's cache totals. Mirrored like the rest: every event is
 * dispatched inside `enterSession`, and cache steps from a child session are
 * folded into the *root's* record through `sessionStates`, not this mirror.
 */
let cache: CacheTotals = emptyCache();
// Pending permission and question requests for the watched session. OpenCode
// keeps the session `busy` while an agent waits for the user; these sets are
// what distinguishes generation from waiting.
let pendingPermissions = new Set<string>();
let pendingQuestions = new Set<string>();

const waitingKind = (): WaitingKind | null => (
  pendingPermissions.size > 0 ? 'permission' : pendingQuestions.size > 0 ? 'question' : null
);

const clearTurn = (): void => {
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
  for (const id of turnStepOrder) steps.delete(id);
  turnStepOrder = [];
};


/**
 * Everything the measurement keeps for one session.
 *
 * The service reads one global event stream that carries every session at once,
 * and more than one status page can be asking about a different session at the
 * same time — two windows, or a window with a second surface open. These fields
 * used to live in module-level variables, so the second caller reset the first
 * one's in-progress turn and dropped the shared SSE connection on every watch.
 * They live in a per-session record now; the module-level variables are only
 * the register `enterSession` loads the active record into, which is why the
 * rest of this file did not have to change.
 */
type SessionState = {
  sessionId: string;
  /** Model behind this session's turn, kept apart from the others' models. */
  currentModel: string;
  /**
   * The model this session's chat is using, as the status page reports it.
   *
   * `currentModel` is what the last step actually ran; this is what the chat
   * has selected, which is known before the first step and survives a restart
   * of the service. The page sends it with `/watch`.
   */
  chatModel: string | null;
  /** Last time this record was touched; drives the tracked-session cap. */
  lastSeenAt: number;
  samples: Sample[];
  partChars: Map<string, number>;
  deltaParts: Set<string>;
  deltaToolCalls: Set<string>;
  messageChars: Map<string, number>;
  busy: boolean;
  turnExecAt: number | null;
  turnStartedAt: number | null;
  turnLastCharAt: number | null;
  turnChars: number;
  turnReasoningChars: number;
  turnActiveMs: number;
  turnWaitMs: number;
  waitStartAt: number | null;
  activeToolIds: Set<string>;
  turnToolMs: number;
  toolStartAt: number | null;
  steps: Map<string, StepRecord>;
  turnStepOrder: string[];
  pendingToolStep: Map<string, string>;
  fbChars: number;
  fbTps: number;
  lastTurn: TurnResult | null;
  cache: CacheTotals;
  pendingPermissions: Set<string>;
  pendingQuestions: Set<string>;
};

const sessionStates = new Map<string, SessionState>();
/**
 * Sessions a page has asked about **in this process**. Kept apart from
 * `sessionStates`, which also holds records restored from disk: `/rate` reports
 * `sessionId` from this set, so a page polls until it has watched again and
 * the stream gets started after a restart.
 */
const watched = new Set<string>();
/**
 * Child session -> parent session. `session.created` carries the link, and a
 * session that the service missed that event for is asked about once through
 * `/api/session/{id}` instead.
 */
const sessionParents = new Map<string, string>();
/**
 * Conversations counted in the background, without a page watching them.
 *
 * `contributes.sessionEvents` wakes the service at the start of every turn,
 * even when Gauge is closed, so the numbers are already there when the
 * panel opens. The most recent roots are kept; older ones fall out, which
 * bounds the work a long-running app does for chats nobody is looking at.
 */
const BACKGROUND_ROOT_CAP = 8;
const activeRoots = new Map<string, number>();
/** Sessions already asked about; a failure is not retried on every event. */
const lookedUp = new Set<string>();
/**
 * Settled steps held back while a session's ancestry is unknown. Without this
 * a service that restarts mid-subagent would drop the subagent's in-flight
 * step instead of folding it into the conversation after the lookup answers.
 */
const deferredEvents = new Map<string, RawEvent[]>();
/** How many sessions keep a record at once; the least recently touched goes. */
const TRACKED_CAP = SESSIONS_CAP;

const createSessionState = (sessionId: string): SessionState => ({
  sessionId,
  currentModel: '*',
  chatModel: null,
  lastSeenAt: Date.now(),
  samples: [],
  partChars: new Map(),
  deltaParts: new Set(),
  deltaToolCalls: new Set(),
  messageChars: new Map(),
  busy: false,
  turnExecAt: null,
  turnStartedAt: null,
  turnLastCharAt: null,
  turnChars: 0,
  turnReasoningChars: 0,
  turnActiveMs: 0,
  turnWaitMs: 0,
  waitStartAt: null,
  activeToolIds: new Set(),
  turnToolMs: 0,
  toolStartAt: null,
  steps: new Map(),
  turnStepOrder: [],
  pendingToolStep: new Map(),
  fbChars: -1,
  fbTps: NaN,
  lastTurn: null,
  cache: emptyCache(),
  pendingPermissions: new Set(),
  pendingQuestions: new Set(),
});

/** The record the module-level variables currently mirror. */
let activeSession: SessionState = createSessionState('');
/** Session mirrored by the module-level variables, or null outside a session. */
let activeSessionId: string | null = null;
let inSession = false;

const trimSessionStates = (): void => {
  while (sessionStates.size > TRACKED_CAP) {
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [key, value] of sessionStates) {
      if (key === activeSessionId || watched.has(key) || key === watch?.sessionId) continue;
      if (activeRoots.has(key)) continue;
      if (value.lastSeenAt < oldestAt) {
        oldestAt = value.lastSeenAt;
        oldestKey = key;
      }
    }
    if (oldestKey === null) break;
    sessionStates.delete(oldestKey);
  }
};

const trackSession = (sessionId: string): SessionState => {
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

/** Point the module-level register at `state`; `leaveSession` copies it back. */
const loadState = (state: SessionState): void => {
  if (inSession) throw new Error('loadState called while already inside a session');
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
  steps = state.steps;
  turnStepOrder = state.turnStepOrder;
  pendingToolStep = state.pendingToolStep;
  fbChars = state.fbChars;
  fbTps = state.fbTps;
  lastTurn = state.lastTurn;
  cache = state.cache;
  pendingPermissions = state.pendingPermissions;
  pendingQuestions = state.pendingQuestions;
};

/**
 * Load `sessionId`'s record into the module-level variables. Everything read
 * and written between `enterSession` and `leaveSession` belongs to that
 * session. The two never nest: the stream delivers one event at a time and
 * `/rate` answers without awaiting, so there is no `await` to interleave them.
 */
const enterSession = (sessionId: string): void => {
  if (inSession) throw new Error('enterSession called while already inside a session');
  loadState(trackSession(sessionId));
};

/** Copy the register back into the record it was loaded from. */
const leaveSession = (): void => {
  if (!inSession) return;
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
  state.steps = steps;
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

/**
 * The record a `/rate` is answered from when no session is named.
 *
 * A new conversation's status page watches `sessionId: null` until its first
 * message exists, and a bare `/rate` used to be answered from the register the
 * last streamed event left behind — still mirroring whichever *other* session
 * had just streamed — so the brand-new chat showed a background conversation's
 * live numbers. This record is never tracked, persisted, or dispatched into,
 * so it stays blank: what "no session yet" should show.
 */
const blankSession = createSessionState('');

/**
 * Where the durable numbers live.
 *
 * In the folder OpenChamber keeps for this extension
 * (`OPENCHAMBER_SERVICE_DATA_DIR`), which survives restarts and updates and
 * goes when the extension is removed. A write inside the package itself can
 * reload the extension, which is why the file no longer sits beside the
 * service. `OPENCHAMBER_GAUGE_STATE` overrides it, so tests cannot leak into
 * each other, and a folder that cannot be written falls back to the temp dir
 * instead of failing startup.
 */
const statePaths = (): string[] => {
  const override = process.env.OPENCHAMBER_GAUGE_STATE;
  if (override) return [override];
  const dataDir = process.env.OPENCHAMBER_SERVICE_DATA_DIR;
  const fallback = path.join(os.tmpdir(), 'openchamber-gauge-state.json');
  return dataDir ? [path.join(dataDir, 'state.json'), fallback] : [fallback];
};

/**
 * Where versions before 1.0 kept the numbers: beside the service, inside the
 * package. Read once so nothing is lost on the update, then removed.
 */
const legacyStatePath = (): string | null => {
  if (process.env.OPENCHAMBER_GAUGE_STATE) return null;
  const entry = process.argv[1];
  return entry ? path.join(path.dirname(entry), '.gauge-state.json') : null;
};

const memoryOf = (state: SessionState): SessionMemory => ({
  lastTurn: state.lastTurn,
  cache: cacheMemory(state.cache),
});

/** Read a state file's raw session entries; anything unreadable is just empty. */
const readSessions = (file: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: unknown; sessions?: unknown };
    if (!parsed || parsed.version !== PERSIST_VERSION || !parsed.sessions) return {};
    const out: Record<string, unknown> = {};
    for (const [id, raw] of Object.entries(parsed.sessions as Record<string, unknown>)) {
      if (id && raw && typeof raw === 'object') out[id] = raw;
    }
    return out;
  } catch {
    return {};
  }
};

/** Learned per-model corrections stored beside the sessions. */
const readModels = (file: string): Record<string, number> => {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { models?: unknown };
    const out: Record<string, number> = {};
    const models = parsed && typeof parsed.models === 'object' ? parsed.models : null;
    if (models) {
      for (const [key, value] of Object.entries(models as Record<string, unknown>)) {
        if (key && typeof value === 'number' && Number.isFinite(value)) out[key] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
};

/** Models stored as reporting their own figures. */
const readEngineModels = (file: string): string[] => {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { engines?: unknown };
    return Array.isArray(parsed?.engines)
      ? parsed.engines.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= MODEL_NAME_MAX).slice(-32)
      : [];
  } catch {
    return [];
  }
};

/** Restore durable numbers so a restarted service answers immediately. */
let legacyConsumed = false;

const readPersisted = (): void => {
  const legacy = legacyStatePath();
  for (const file of [...statePaths().slice(0, 1), ...(legacy ? [legacy] : []), ...statePaths().slice(1)]) {
    const sessions = readSessions(file);
    if (Object.keys(sessions).length === 0) continue;
    for (const [model, factor] of Object.entries(readModels(file))) {
      calibration.set(model, factor as number);
    }
    for (const model of readEngineModels(file)) engineModels.add(model);
    for (const [id, raw] of Object.entries(sessions)) {
      const memory = raw as Partial<SessionMemory>;
      const state = createSessionState(id);
      state.lastTurn = memory.lastTurn ?? null;
      state.cache = restoreCache(memory.cache);
      sessionStates.set(id, state);
    }
    // Only a file this service actually read is safe to remove; one it walked
    // past keeps its numbers until something has taken them over.
    if (legacy && file === legacy) legacyConsumed = true;
    return;
  }
};

let persistTimer: NodeJS.Timeout | null = null;
let persistDirty = false;

const writePersisted = (): void => {
  const own: Record<string, unknown> = {};
  for (const [id, state] of sessionStates) own[id] = memoryOf(state);
  for (const file of statePaths()) {
    try {
      // Two OpenChamber servers can share one workspace, so two services share
      // this directory. Overlay our sessions on whatever is already there
      // instead of clobbering the other instance's history, with room in the
      // file for both instances' full share of it.
      const foreign = Object.entries(readSessions(file)).filter(([id]) => own[id] === undefined);
      const sessions: Record<string, unknown> = { ...own };
      for (const [id, memory] of foreign.slice(0, Math.max(0, STATE_FILE_CAP - Object.keys(own).length))) {
        sessions[id] = memory;
      }
      const payload = JSON.stringify({
        version: PERSIST_VERSION,
        savedAt: Date.now(),
        sessions,
        models: { ...readModels(file), ...Object.fromEntries(calibration) },
        // Models that report their own figures, so a restarted service can
        // estimate their steps live again without waiting for one to end.
        engines: [...new Set([...readEngineModels(file), ...engineModels])].slice(-32),
      });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, payload, 'utf8');
      fs.renameSync(tmp, file);
      // The numbers are safe in their new home: the old copy inside the
      // package goes, once.
      const legacy = legacyStatePath();
      if (legacy && legacy !== file && legacyConsumed) fs.rmSync(legacy, { force: true });
      return;
    } catch {
      // Read-only extension folder: try the next path, and if none works the
      // numbers simply start fresh next time. Losing history is better than
      // losing the service.
    }
  }
};

const flushPersist = (): void => {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (!persistDirty) return;
  persistDirty = false;
  writePersisted();
};

/** Coalesce writes: a turn's worth of events must not become disk traffic. */
const schedulePersist = (): void => {
  persistDirty = true;
  if (persistTimer) return;
  persistTimer = setTimeout(flushPersist, PERSIST_DEBOUNCE_MS);
  persistTimer.unref?.();
};

/**
 * Drop everything still in flight once the stream is back.
 *
 * A turn's closing events were sent while we were disconnected, so they are
 * gone for good: leaving `busy` or an open step behind would freeze the panel
 * on "generating" forever. Finished work — `lastTurn` — is untouched,
 * which is the part worth keeping. This replaces the reset that a watch change
 * used to perform as a side effect.
 */
const resetInFlight = (): void => {
  if (inSession) return;
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

const turnTtftMs = (): number | null => (
  turnExecAt !== null && turnStartedAt !== null
    ? Math.max(0, turnStartedAt - turnExecAt)
    : null
);

/** Mean first-character delay of the current turn's observed steps, else the execution-based fallback. */
const liveTtftMs = (): number | null => {
  const ttfts: number[] = [];
  for (const id of turnStepOrder) {
    const step = steps.get(id);
    if (step && step.startObserved && step.firstCharAt !== null) {
      ttfts.push(Math.max(0, step.firstCharAt - step.startAt));
    }
  }
  if (ttfts.length > 0) return ttfts.reduce((a, b) => a + b, 0) / ttfts.length;
  return turnTtftMs();
};

/** Accumulate time spent waiting for the user (permission/question) this turn. */
const noteWaiting = (now: number): void => {
  if (waitingKind() !== null) {
    if (waitStartAt === null) waitStartAt = now;
  } else if (waitStartAt !== null) {
    turnWaitMs += now - waitStartAt;
    waitStartAt = null;
  }
};

/** Whether a tool (or shell) call is currently executing for the watched session. */
const toolActive = (): boolean => activeToolIds.size > 0;

/** Accumulate tool-execution time this turn. Open while a tool runs. */
const noteTools = (now: number): void => {
  // A tool that is open while the chat waits on a person (the question tool is
  // one) is not running: that stretch is the person's, not the tool's.
  if (toolActive() && waitingKind() === null) {
    if (toolStartAt === null) toolStartAt = now;
  } else if (toolStartAt !== null) {
    turnToolMs += now - toolStartAt;
    toolStartAt = null;
  }
};

/** A request to the person opened or closed: both clocks move together. */
const noteAsk = (now: number): void => {
  noteWaiting(now);
  noteTools(now);
};

/** Get or create this turn's record for an assistant message. */
const stepFor = (messageID: string, now: number): StepRecord => {
  let step = steps.get(messageID);
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
      toolSince: null,
      model: currentModel,
      engine: null,
    };
    steps.set(messageID, step);
    turnStepOrder.push(messageID);
    if (steps.size > 500) {
      const oldest = steps.keys().next();
      if (!oldest.done) steps.delete(oldest.value);
    }
  }
  return step;
};

/** Latest turn step still open, if any. */
const latestOpenStepId = (): string | null => {
  for (let i = turnStepOrder.length - 1; i >= 0; i -= 1) {
    if (steps.get(turnStepOrder[i])?.endAt === null) return turnStepOrder[i];
  }
  return null;
};

const closeStepTool = (step: StepRecord, now: number): void => {
  if (step.toolSince !== null) {
    step.toolSpans.push([step.toolSince, Math.max(step.toolSince, now)]);
    step.toolSince = null;
  }
  step.toolOpen = 0;
};

/** Tool time of a step inside [fromMs, toMs]: closed spans overlapped, plus the open call capped at toMs. */
const stepToolWithinMs = (step: StepRecord, fromMs: number, toMs: number): number => {
  let total = 0;
  for (const [from, to] of step.toolSpans) {
    total += Math.max(0, Math.min(to, toMs) - Math.max(from, fromMs));
  }
  if (step.toolOpen > 0 && step.toolSince !== null) {
    total += Math.max(0, toMs - Math.max(step.toolSince, fromMs));
  }
  return total;
};


/**
 * No provider streams anywhere near this fast; a rate above it means the
 * measured window is broken (backfilled burst, truncated start), not that the
 * model was quick. Same guard the native stats use.
 */
const MAX_PLAUSIBLE_TOKENS_PER_SECOND = 5_000;

/**
 * tok/s for `tokens` over `ms`, or null when the window cannot carry a
 * number: a span under a millisecond is a clamp artifact rather than elapsed
 * time, and a rate over the ceiling is a broken window rather than a fast
 * model. Every derived rate goes through here.
 */
const plausibleRate = (tokens: number, ms: number): number | null => {
  if (!(ms >= 1)) return null;
  const tps = tokens / (ms / 1000);
  return tps > MAX_PLAUSIBLE_TOKENS_PER_SECOND ? null : tps;
};

type StepContribution = { tokens: number; netMs: number; real: boolean; ttftMs: number | null };

/**
 * Where a step's divisor starts.
 *
 * Streamed deltas are timestamped, so output is divided by the time it was
 * actually emitted in: time to first token is a latency, reported on its own
 * as `ttft`, not something a throughput should divide by.
 *
 * Tokens the provider settled without ever streaming are the exception. A step
 * that reports reasoning tokens but streamed no reasoning produced them during
 * the silence before the first delta, and nothing else places them, so the
 * divisor has to reach back to the step's real start or those tokens would
 * carry no time at all.
 */
const generationStart = (step: StepRecord): number => {
  if (step.firstCharAt === null) return step.startAt;
  if (step.reasoning > 0 && !step.sawReasoning) return step.startAt;
  return step.firstCharAt;
};

/**
 * One step's share of the turn average, or null when the step carries no
 * measurable signal: start never observed, net duration unmeasurable,
 * nothing countable settled, or an implausible rate from a truncated window.
 */
const contributeStep = (step: StepRecord): StepContribution | null => {
  if (!step.startObserved) return null;
  // An open step ends at its last counted activity, not at "now": silence
  // (a model thinking with no deltas) extends no denominator, so the number
  // holds instead of sagging. Tool time past that point is excluded the same
  // way. Settled steps keep their settle timestamp, matching server timing.
  // Reasoning time stays in: providers fold reasoning tokens into `output`
  // (a 200 s capture of three sessions reported `reasoning: 0` on every step
  // while thousands of reasoning characters streamed), so cutting that span
  // counted the work twice and read 218 tok/s where the events support 74.
  const genStart = generationStart(step);
  const endRef = step.endAt ?? step.lastDeltaAt ?? step.startAt;
  const netMs = Math.max(0, endRef - genStart)
    - stepToolWithinMs(step, genStart, endRef);
  if (!(netMs >= 1)) return null;
  let tokens: number;
  let real: boolean;
  if (step.settled && step.output + step.reasoning > 0) {
    tokens = step.output + step.reasoning;
    real = true;
  } else if (!step.settled && step.chars > 0) {
    tokens = estimateTokens(step.chars);
    real = false;
  } else {
    return null;
  }
  if (tokens / (netMs / 1000) > MAX_PLAUSIBLE_TOKENS_PER_SECOND) return null;
  return {
    tokens,
    netMs,
    real,
    ttftMs: step.firstCharAt !== null ? Math.max(0, step.firstCharAt - step.startAt) : null,
  };
};

const sumSteps = (): {
  tokens: number;
  netMs: number;
  real: boolean;
  ttftMs: number | null;
} | null => {
  let tokens = 0;
  let netMs = 0;
  let real = false;
  const ttfts: number[] = [];
  for (const id of turnStepOrder) {
    const step = steps.get(id);
    if (!step) continue;
    const part = contributeStep(step);
    if (!part) continue;
    tokens += part.tokens;
    netMs += part.netMs;
    real = real || part.real;
    if (part.ttftMs !== null) ttfts.push(part.ttftMs);
  }
  if (!(netMs >= 1) || !(tokens > 0)) return null;
  return {
    tokens,
    netMs,
    real,
    ttftMs: ttfts.length > 0 ? ttfts.reduce((a, b) => a + b, 0) / ttfts.length : null,
  };
};

// --- the speed of one step ------------------------------------------------------
//
// The headline is the speed of the model call in progress, not an average over
// the whole turn: an agent turn can run for hours across models, and its
// average said little about what the chat was doing now.
//
// A local llama.cpp engine (Splash included) reports its own figure for every
// reply in the reply's closing frame, and that is the step's speed. Every other
// step is timed from the start of the call to its end, less the tools it ran:
// a provider that sends a step's text in one burst gave no honest span to
// divide by (a 370-token Fable step landed in 0.59 s of a 6.3 s call and read
// 624 tok/s), and one rule for all of them never switches methods mid-chat.

type StepFigure = { tps: number; tokens: number; source: 'engine' | 'tokens' | 'estimate' };

/** Models whose steps came back with an engine figure: their open steps may be estimated live. */
const engineModels = new Set<string>();
/** Engine figures already given to a step, so one reply is never counted twice. */
const claimedEngine = new Set<string>();
/** How long an ended local step waits for its engine figure before it is timed like any other. */
const ENGINE_WAIT_MS = 3_000;
/** How long after its end a step may still claim its figure (the helper's file lives 15 s). */
const ENGINE_CLAIM_MS = 16_000;
/** An open local step is estimated only once it has written for this long. */
const OPEN_ESTIMATE_MIN_MS = 1_000;

const noteClaimed = (id: string): void => {
  claimedEngine.add(id);
  if (claimedEngine.size > 256) claimedEngine.delete(claimedEngine.values().next().value as string);
};

/**
 * The earliest unclaimed figure of this session and model that could belong to
 * a step spanning [from, to]. The helper notes the reply's end as it reads it,
 * just before OpenCode ends the step, so the window is the step itself plus a
 * moment's slack either side.
 */
const ENGINE_SLACK_MS = 3_000;
const findEngineFigure = (entries: EngineFigure[], key: string, model: string, from: number, to: number): EngineFigure | null => {
  const wanted = model && model !== '*' ? modelKey(model) : null;
  let best: EngineFigure | null = null;
  for (const entry of entries) {
    if (entry.sessionKey !== key || claimedEngine.has(entry.id)) continue;
    if (wanted && entry.modelKey && entry.modelKey !== wanted) continue;
    if (entry.endedAt < from - 1_000 || entry.endedAt > to + ENGINE_SLACK_MS) continue;
    if (!best || entry.endedAt < best.endedAt) best = entry;
  }
  return best;
};

/**
 * Give the turn's recently ended steps their engine figures. Oldest first: the
 * requests of one chat run one after another, so the earliest figure belongs
 * to the earliest step still without one.
 */
const claimEngineFigures = (now: number, fresh = false): void => {
  if (!activeSessionId) return;
  let entries: EngineFigure[] | null = null;
  const key = sessionKey(activeSessionId);
  for (const id of turnStepOrder) {
    const step = steps.get(id);
    if (!step || step.engine || step.endAt === null || now - step.endAt > ENGINE_CLAIM_MS) continue;
    entries ??= engineFigures(now, fresh);
    if (entries.length === 0) return;
    const found = findEngineFigure(entries, key, step.model, step.startAt, step.endAt);
    if (!found) continue;
    noteClaimed(found.id);
    step.engine = { tps: found.tps, tokens: found.tokens };
    engineModels.add(step.model);
    schedulePersist();
  }
};

/**
 * One step's speed, or null when it has none yet.
 *
 * An ended step of a model that reports its own figures waits a moment for
 * that figure instead of showing a different number first.
 */
const stepFigure = (step: StepRecord, now: number): StepFigure | null => {
  if (step.engine) return { tps: step.engine.tps, tokens: step.engine.tokens, source: 'engine' };
  if (!step.settled || !step.startObserved || step.endAt === null) return null;
  if (engineModels.has(step.model) && now - step.endAt < ENGINE_WAIT_MS) return null;
  const tokens = step.output + step.reasoning;
  if (!(tokens > 0)) return null;
  const ms = (step.endAt - step.startAt) - stepToolWithinMs(step, step.startAt, step.endAt);
  const tps = plausibleRate(tokens, ms);
  return tps === null ? null : { tps, tokens, source: 'tokens' };
};

/**
 * A local step still writing, estimated from what it has streamed: the same
 * span the engine itself measures, first word to now, less tools. Only for a
 * model whose steps have come back with engine figures; anything else has no
 * speed until its call ends.
 */
const openStepEstimate = (step: StepRecord): StepFigure | null => {
  if (!engineModels.has(step.model) || step.firstCharAt === null || step.lastDeltaAt === null) return null;
  const span = (step.lastDeltaAt - step.firstCharAt) - stepToolWithinMs(step, step.firstCharAt, step.lastDeltaAt);
  if (span < OPEN_ESTIMATE_MIN_MS) return null;
  const tokens = estimateTokens(step.chars);
  const tps = plausibleRate(tokens, span);
  return tps === null ? null : { tps, tokens, source: 'estimate' };
};

/**
 * What the headline says while a turn runs: the step writing now when it can
 * be told, else the last step of this turn that has a speed. Null before any
 * step of the turn has one; the page then keeps the last reply's number.
 */
const headlineFigure = (now: number): StepFigure | null => {
  for (let i = turnStepOrder.length - 1; i >= 0; i -= 1) {
    const step = steps.get(turnStepOrder[i]);
    if (!step) continue;
    const figure = step.endAt === null ? openStepEstimate(step) : stepFigure(step, now);
    if (figure) return figure;
  }
  return null;
};

/** The turn's speeds: every step that has one, the reply's average over them, and the last. */
const turnFigures = (now: number): { average: StepFigure; last: StepFigure } | null => {
  let tokens = 0;
  let ms = 0;
  let last: StepFigure | null = null;
  let source: StepFigure['source'] = 'tokens';
  let anyEngine = false;
  for (const id of turnStepOrder) {
    const step = steps.get(id);
    if (!step) continue;
    // At the turn's end nothing is still to come: an ended step is timed now.
    const figure = stepFigure(step, now + ENGINE_WAIT_MS);
    if (!figure) continue;
    tokens += figure.tokens;
    ms += (figure.tokens / figure.tps) * 1000;
    anyEngine = anyEngine || figure.source === 'engine';
    last = figure;
  }
  if (!last || !(ms >= 1)) return null;
  if (anyEngine && last.source === 'engine') source = 'engine';
  return { average: { tps: tokens / (ms / 1000), tokens, source }, last };
};

/** A turn that ended before its last step's engine figure was written: give it that figure when it lands. */
const patchLastStep = (sessionId: string, endedAt: number, step: { startAt: number; endAt: number; model: string }): void => {
  const state = sessionStates.get(sessionId);
  const turn = state?.lastTurn;
  if (!state || !turn || turn.endedAt !== endedAt || turn.lastStep?.source === 'engine') return;
  const found = findEngineFigure(engineFigures(Date.now(), true), sessionKey(sessionId), step.model, step.startAt, step.endAt);
  if (!found) return;
  noteClaimed(found.id);
  engineModels.add(step.model);
  turn.lastStep = { tps: found.tps, source: 'engine' };
  schedulePersist();
};

/**
 * Cache totals of the turn that is ending.
 *
 * The aggregate is conversation-wide, so a finished turn is the delta against
 * the base the previous one left behind. A turn whose steps reported no cache
 * stores null instead of a misleading 0%.
 */
const snapshotTurnCache = (): TurnCache | null => {
  const agg = cache;
  if (agg.steps === 0) return null;
  const base = agg.turnBase ?? { hit: 0, miss: 0, steps: 0, output: 0 };
  const hit = Math.max(0, agg.hit - base.hit);
  const miss = Math.max(0, agg.miss - base.miss);
  const steps = Math.max(0, agg.steps - base.steps);
  const output = Math.max(0, agg.output - base.output);
  agg.turnBase = { hit: agg.hit, miss: agg.miss, steps: agg.steps, output: agg.output };
  if (steps === 0 || hit + miss === 0) return null;
  return { hit, miss, steps, output, hitRate: cacheRate(hit, miss) };
};

/**
 * The finished turn's receipt: its whole span without the time spent waiting
 * on the user, cut into reading, waiting, writing and tools.
 */
const turnSplit = (now: number, writeMs: number): TurnSplit => {
  const started = turnExecAt ?? turnStartedAt;
  return splitTurn({
    totalMs: started !== null ? now - started - turnWaitMs : 0,
    writeMs,
    toolMs: turnToolMs,
    readMs: takeReadMs(sessionIdsFor(activeSessionId)),
  });
};

const finalizeTurn = (now: number): void => {
  noteWaiting(now);
  noteTools(now);
  const wallMs = turnStartedAt !== null ? Math.max(1, now - turnStartedAt) : 1;
  const sum = sumSteps();
  claimEngineFigures(now, true);
  const figures = turnFigures(now);
  if (sum || figures) {
    // Only consume the aggregate's base once the turn is actually recorded.
    const turnCache = snapshotTurnCache();
    // The receipt's writing slice stays the time words were arriving; the
    // speeds are the steps' own.
    const writeMs = sum ? sum.netMs : 0;
    const average = figures?.average ?? null;
    lastTurn = {
      tokensPerSecond: average ? average.tps : sum!.tokens / (sum!.netMs / 1000),
      source: average ? (average.source === 'estimate' ? 'estimate' : 'tokens') : (sum!.real ? 'tokens' : 'estimate'),
      tokens: average ? average.tokens : sum!.tokens,
      activeMs: Math.round(writeMs),
      ttftMs: sum ? sum.ttftMs : null,
      hasReasoning: turnReasoningChars > 0 || [...steps.values()].some((s) => s.reasoning > 0),
      endedAt: now,
      cache: turnCache,
      split: turnSplit(now, writeMs),
      askMs: Math.round(turnWaitMs),
      ...(figures ? { lastStep: { tps: figures.last.tps, source: figures.last.source } } : {}),
    };
    // The last step's own figure can land a moment after the turn ends.
    const lastId = [...turnStepOrder].reverse().find((id) => steps.get(id)?.endAt !== null);
    const lastStep = lastId ? steps.get(lastId) : undefined;
    if (activeSessionId && lastStep && !lastStep.engine && lastStep.endAt !== null) {
      const sessionId = activeSessionId;
      const span = { startAt: lastStep.startAt, endAt: lastStep.endAt, model: lastStep.model };
      for (const delay of [500, 2_000, 5_000]) {
        const timer = setTimeout(() => patchLastStep(sessionId, now, span), delay);
        timer.unref?.();
      }
    }
    schedulePersist();
    clearTurn();
    return;
  }
  if (turnStartedAt === null || turnLastCharAt === null || turnChars === 0) {
    clearTurn();
    return;
  }
  // Nothing measurable per step: fall back to a self-consistent character
  // estimate, never real counts over guessed time.
  const activeMs = Math.max(
    1,
    turnActiveMs > 0 ? Math.round(turnActiveMs) : Math.min(wallMs, MAX_STREAM_GAP_MS),
  );
  const tps = plausibleRate(estimateTokens(turnChars), activeMs);
  if (tps === null) {
    // The window cannot carry a number: keep the previous turn's average
    // rather than publishing one built on a clamped span.
    clearTurn();
    return;
  }
  const turnCache = snapshotTurnCache();
  lastTurn = {
    tokensPerSecond: tps,
    source: 'estimate',
    tokens: estimateTokens(turnChars),
    activeMs,
    ttftMs: turnTtftMs(),
    hasReasoning: turnReasoningChars > 0,
    endedAt: now,
    cache: turnCache,
    split: turnSplit(now, activeMs),
    askMs: Math.round(turnWaitMs),
  };
  schedulePersist();
  clearTurn();
};

/**
 * Drop samples older than `cutoff`. Only the curve prunes: its oldest bucket
 * edge can sit a full bucket before `now - CURVE_WINDOW_MS`, so the caller
 * passes that edge rather than a window measured from "now" — pruning from
 * "now" would leave the oldest bucket half empty and understate its rate.
 */
const pruneSamples = (cutoff: number): void => {
  let expired = 0;
  while (expired < samples.length && samples[expired].at < cutoff) {
    expired += 1;
  }
  if (expired > 0) samples.splice(0, expired);
};

const recordChars = (messageID: string, partID: string, kind: Sample['kind'], chars: number, now: number): void => {
  if (chars <= 0) return;
  // Any streamed model output proves the turn is alive, even when the
  // `execution.started` event was missed (late watch attach).
  busy = true;
  const sample: Sample = { at: now, chars, kind, tps: 0 };
  samples.push(sample);
  if (samples.length > SAMPLE_LIMIT) samples.splice(0, samples.length - SAMPLE_LIMIT);
  partChars.set(partID, (partChars.get(partID) ?? 0) + chars);
  messageChars.set(messageID, (messageChars.get(messageID) ?? 0) + chars);

  if (turnStartedAt === null) {
    turnStartedAt = now;
    // Time to the first character counts only when it looks like generation
    // rather than a pause before the model call.
    if (turnExecAt !== null && now - turnExecAt <= MAX_STREAM_GAP_MS) {
      turnActiveMs += now - turnExecAt;
    }
  } else if (turnLastCharAt !== null && waitingKind() === null) {
    // Streaming gap, so it is generation time. A wait for the user is never
    // generation even when the user answers within the gap threshold.
    const gap = now - turnLastCharAt;
    if (gap <= MAX_STREAM_GAP_MS) turnActiveMs += gap;
  }

  turnLastCharAt = now;
  turnChars += chars;
  if (kind === 'reasoning') turnReasoningChars += chars;
  if (messageID) {
    const step = stepFor(messageID, now);
    step.chars += chars;
    step.lastDeltaAt = now;
    if (step.firstCharAt === null) step.firstCharAt = now;
    if (kind === 'reasoning') step.sawReasoning = true;
  }
  // The curve draws the headline's own history, so it never shows a speed the
  // number did not.
  // Before this turn has a speed of its own the headline still shows the last
  // reply's, and so does the curve.
  sample.tps = headlineFigure(now)?.tps ?? lastTurn?.lastStep?.tps ?? lastTurn?.tokensPerSecond ?? 0;
};

/**
 * True when `sessionID` is the session the module-level variables mirror.
 * `handleEvent` enters that session before dispatching, so this stays a plain
 * equality check and the twenty-odd call sites inside the switch never change.
 */
const isWatchedSession = (sessionID: unknown): boolean => (
  typeof sessionID === 'string' && activeSessionId !== null && sessionID === activeSessionId
);

const readString = (value: unknown): string => (typeof value === 'string' ? value : '');

const readNumber = (value: unknown): number => (
  typeof value === 'number' && Number.isFinite(value) ? value : 0
);

const readRecord = (value: unknown): Record<string, unknown> | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

/** Stable part identity for OpenCode 2 text and reasoning fragments. */
const fragmentPartID = (messageID: string, kind: 'text' | 'reasoning', ordinal: unknown): string => {
  if (!messageID) return '';
  const index = typeof ordinal === 'number' && Number.isInteger(ordinal) && ordinal >= 0 ? ordinal : 0;
  return `${messageID}:${kind}:${index}`;
};

/** Strip the OpenCode 2 `next` generation marker: `session.next.X` and `session.X` are the same event. */
const normType = (type: string): string => type.replace('.next.', '.');

/**
 * A watched-session event that proves the turn is alive. Covers late watch
 * attaches that missed `session.execution.started`: the turn is marked busy
 * instead of staying idle for its whole duration.
 */
const markActive = (now: number): void => {
  if (turnExecAt === null) turnExecAt = now;
  busy = true;
};

/** Stable tool-call identity across OpenChamber/OpenCode payload shapes. */
const readToolCallID = (payload: Record<string, unknown>): string => (
  readString(payload.callID) || readString(payload.id) || readString(payload.toolCallID)
);

/** Stable part identity for streamed tool-input fragments. */
const toolPartID = (messageID: string, callID: string): string => `${messageID}:tool:${callID || 'input'}`;

/**
 * Settles a step with its provider-reported token counts. Always recorded —
 * even before any character streamed — so early tool-only steps count; the
 * average decides per step whether its time was measurable. A retried step
 * keeps its first timing and latest counts.
 */
const settleStep = (messageID: string, output: number, reasoning: number, now: number): void => {
  const generated = output + reasoning;
  if (!messageID || generated <= 0) return;
  calibrate(currentModel, messageChars.get(messageID) ?? 0, generated);
  const step = stepFor(messageID, now);
  step.output = output;
  step.reasoning = reasoning;
  step.settled = true;
  if (step.endAt === null) step.endAt = now;
  closeStepTool(step, now);
  // Earlier steps' figures are on disk by now; this one's usually a moment later.
  claimEngineFigures(now);
};

type RawEvent = { type?: unknown; data?: unknown; properties?: unknown; created?: unknown };

/** Session an event belongs to: `sessionID` in `data` (2.x) / `properties` (1.x), or under `form`. */
const eventSessionID = (event: RawEvent): string | null => {
  const payload = readRecord(event.data) ?? readRecord(event.properties);
  if (!payload) return null;
  const direct = readString(payload.sessionID);
  if (direct) return direct;
  const form = readRecord(payload.form);
  return form ? readString(form.sessionID) : '';
};

/**
 * Route an event into its own session's record.
 *
 * The stream carries every session at once and the pages watching different
 * sessions must not disturb each other, so the session is entered for the
 * duration of the dispatch and left afterwards. Only sessions a page asked
 * about are tracked, which bounds the map by the pages actually open.
 */
const handleEvent = (event: RawEvent, now: number): void => {
  const sessionId = eventSessionID(event);
  const type = normType(readString(event.type));
  if (sessionId && type === 'session.created') {
    // The stream announces every session with its parent, including the
    // subagent sessions a turn spawns below the watched one.
    const data = readRecord(event.data) ?? readRecord(event.properties);
    const parentID = data ? readString(data.parentID) : '';
    if (parentID) sessionParents.set(sessionId, parentID);
    else {
      sessionParents.delete(sessionId);
      // A top-level conversation created while the service runs starts out as
      // a background target; its steps then fold in even with no page open.
      noteBackgroundRoot(sessionId, now);
    }
    if (watchedRootsFor(sessionId).length > 0) trackSession(sessionId);
  }
  if (!sessionId || !sessionStates.has(sessionId)) {
    if (sessionId && (type === 'session.step.ended' || type === 'session.step.failed')) {
      holdForLookup(sessionId, event);
    }
    return;
  }
  if (
    sessionId
    && !sessionParents.has(sessionId)
    && watchedRootsFor(sessionId).length === 0
    && (type === 'session.step.ended' || type === 'session.step.failed')
  ) {
    // A record restored from disk has no parent link: after a restart the
    // child's ancestry has to be asked again before its step can be folded
    // into the conversation.
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

/**
 * Start tracking a session the service has never seen.
 *
 * A session the stream announced through `session.created` is already linked
 * and comes here through `trackSession`. One the service attached after it
 * existed (a restart in the middle of a subagent turn) is looked up once: a
 * short poll of its `parentID` decides whether it belongs below a watched
 * session. The step that triggered the lookup is replayed afterwards.
 */
const holdForLookup = (sessionId: string, event: RawEvent): void => {
  if (watched.size === 0 && !watch?.sessionId && activeRoots.size === 0) return;
  if (!lookedUp.has(sessionId)) {
    lookedUp.add(sessionId);
    if (lookedUp.size > 200) {
      const oldest = lookedUp.values().next();
      if (!oldest.done) lookedUp.delete(oldest.value);
    }
    void resolveSessionParent(sessionId);
  }
  const held = deferredEvents.get(sessionId) ?? [];
  held.push(event);
  if (held.length > 4) held.shift();
  deferredEvents.set(sessionId, held);
};

/** `parentID` of one session, read from OpenCode; null when it cannot be read. */
const fetchSessionParent = async (sessionId: string): Promise<string | null> => {
  if (!OPENCODE_URL) return null;
  try {
    const response = await fetch(`${OPENCODE_URL}/api/session/${encodeURIComponent(sessionId)}`, {
      headers: opencodeHeaders('application/json'),
      signal: AbortSignal.timeout(3_000),
      redirect: 'manual',
    });
    const contentType = response.headers.get('content-type') ?? '';
    if (!response.ok || !contentType.includes('json')) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const body = readRecord(await response.json());
    if (!body) return null;
    // OpenCode answers the session itself, or wraps it in `data`.
    const record = readRecord(body.data) ?? body;
    return readString(record.parentID) || readString(record.parentId);
  } catch {
    return null;
  }
};

const resolveSessionParent = async (sessionId: string): Promise<void> => {
  const parentID = await fetchSessionParent(sessionId);
  if (parentID === null) {
    deferredEvents.delete(sessionId);
    return;
  }
  if (parentID) sessionParents.set(sessionId, parentID);
  else sessionParents.delete(sessionId);
  if (watchedRootsFor(sessionId).length === 0) {
    deferredEvents.delete(sessionId);
    return;
  }
  trackSession(sessionId);
  const held = deferredEvents.get(sessionId) ?? [];
  deferredEvents.delete(sessionId);
  for (const event of held) handleEvent(event, Date.now());
};

const dispatchEvent = (event: RawEvent, now: number): void => {
  const type = normType(readString(event.type));
  if (!type) return;
  // OpenCode 2 carries fields in `data`; the 1.x shapes used `properties`.
  const payload = readRecord(event.data) ?? readRecord(event.properties);
  if (!payload) return;

  // --- streamed output (OpenCode 2) ---------------------------------------

  if (type === 'session.text.delta' || type === 'session.reasoning.delta') {
    if (!isWatchedSession(payload.sessionID)) return;
    const messageID = readString(payload.assistantMessageID);
    const delta = readString(payload.delta);
    const kind = type === 'session.reasoning.delta' ? 'reasoning' : 'text';
    const partID = fragmentPartID(messageID, kind, payload.ordinal);
    if (!partID || delta.length === 0) return;
    deltaParts.add(partID);
    recordChars(messageID, partID, kind, delta.length, now);
    return;
  }

  // The replayable full-value boundary of a fragment. It stands in for a
  // service that attached after the deltas went by; a part counted through
  // deltas is never diffed again.
  if (type === 'session.text.ended' || type === 'session.reasoning.ended') {
    if (!isWatchedSession(payload.sessionID)) return;
    const messageID = readString(payload.assistantMessageID);
    const kind = type === 'session.reasoning.ended' ? 'reasoning' : 'text';
    const partID = fragmentPartID(messageID, kind, payload.ordinal);
    if (!partID) return;
    if (deltaParts.has(partID)) return;
    const text = readString(payload.text);
    const previous = partChars.get(partID) ?? 0;
    if (text.length <= previous) return;
    recordChars(messageID, partID, kind, text.length - previous, now);
    return;
  }

  // Tool execution is not generation: while a tool (or shell) call runs, the
  // headline denominator freezes so the number locks instead of sliding.
  // Each call is also attributed to its step so the finished average can cut
  // tool time per step.
  //
  // Streaming tool *input* is the opposite: those deltas are the model
  // writing the tool-call arguments, i.e. real output tokens counted live
  // like text. The execution clock therefore starts at `session.tool.called`,
  // not at `session.tool.input.started`.
  if (type === 'session.tool.input.started') {
    if (!isWatchedSession(payload.sessionID)) return;
    markActive(now);
    const mid = readString(payload.assistantMessageID);
    if (mid) stepFor(mid, now);
    return;
  }

  if (type === 'session.tool.input.delta') {
    if (!isWatchedSession(payload.sessionID)) return;
    const messageID = readString(payload.assistantMessageID);
    const delta = readString(payload.delta);
    if (delta.length === 0) return;
    markActive(now);
    const partID = toolPartID(messageID, readToolCallID(payload));
    deltaToolCalls.add(partID);
    recordChars(messageID, partID, 'tool', delta.length, now);
    return;
  }

  // The replayable full-value boundary of a tool-input fragment. It stands
  // in for a service that attached after the deltas went by; an input
  // counted through deltas is never diffed again. Tool *results* are never
  // counted here — only the model's input arguments.
  if (type === 'session.tool.input.ended') {
    if (!isWatchedSession(payload.sessionID)) return;
    const messageID = readString(payload.assistantMessageID);
    const partID = toolPartID(messageID, readToolCallID(payload));
    if (deltaToolCalls.has(partID)) return;
    const text = readString(payload.text) || readString(payload.input);
    const previous = partChars.get(partID) ?? 0;
    if (text.length <= previous) return;
    markActive(now);
    recordChars(messageID, partID, 'tool', text.length - previous, now);
    return;
  }

  if (type === 'session.tool.called') {
    if (!isWatchedSession(payload.sessionID)) return;
    markActive(now);
    const id = readToolCallID(payload) || readString(payload.assistantMessageID);
    if (id) {
      activeToolIds.add(`tool:${id}`);
      if (toolStartAt === null && turnExecAt !== null) toolStartAt = now;
      const mid = readString(payload.assistantMessageID);
      const target = mid ? stepFor(mid, now) : (latestOpenStepId() ? steps.get(latestOpenStepId()!) ?? null : null);
      pendingToolStep.set(`tool:${id}`, target ? target.id : '');
      if (target) {
        target.toolOpen += 1;
        if (target.toolSince === null) target.toolSince = now;
      }
    }
    return;
  }

  if (type === 'session.tool.success' || type === 'session.tool.failed') {
    if (!isWatchedSession(payload.sessionID)) return;
    markActive(now);
    const id = readToolCallID(payload) || readString(payload.assistantMessageID);
    if (id) activeToolIds.delete(`tool:${id}`);
    if (id) {
      const stepId = pendingToolStep.get(`tool:${id}`);
      pendingToolStep.delete(`tool:${id}`);
      const target = stepId ? steps.get(stepId) : undefined;
      if (target) {
        target.toolOpen = Math.max(0, target.toolOpen - 1);
        if (target.toolOpen === 0) closeStepTool(target, now);
      }
    }
    noteTools(now);
    return;
  }

  if (type === 'session.shell.started') {
    if (!isWatchedSession(payload.sessionID)) return;
    markActive(now);
    const key = `shell:${readString(payload.id) || `at${now}`}`;
    activeToolIds.add(key);
    if (toolStartAt === null && turnExecAt !== null) toolStartAt = now;
    const openId = latestOpenStepId();
    const target = openId ? steps.get(openId) ?? null : null;
    pendingToolStep.set(key, target ? target.id : '');
    if (target) {
      target.toolOpen += 1;
      if (target.toolSince === null) target.toolSince = now;
    }
    return;
  }

  if (type === 'session.shell.ended') {
    if (!isWatchedSession(payload.sessionID)) return;
    markActive(now);
    const id = readString(payload.id);
    const closeKey = (key: string): void => {
      activeToolIds.delete(key);
      const stepId = pendingToolStep.get(key);
      pendingToolStep.delete(key);
      const target = stepId ? steps.get(stepId) : undefined;
      if (target) {
        target.toolOpen = Math.max(0, target.toolOpen - 1);
        if (target.toolOpen === 0) closeStepTool(target, now);
      }
    };
    if (id) closeKey(`shell:${id}`);
    else activeToolIds.forEach((key) => { if (key.startsWith('shell:')) closeKey(key); });
    noteTools(now);
    return;
  }

  // `session.tool.input.delta` and the other tool progress events only confirm
  // a tracked call is still running.

  // --- assistant steps and their real token counts (OpenCode 2) -------------

  if (type === 'session.step.started') {
    if (!isWatchedSession(payload.sessionID)) return;
    markActive(now);
    const messageID = readString(payload.assistantMessageID);
    if (!messageID) return;
    // v2 names the model on the step; remember it so the correction is learned
    // per model rather than per session. `model` is an object here, so a plain
    // string read returns '' and every model would share one wildcard entry.
    const model = readString(payload.modelID) || readString(readRecord(payload.model)?.id);
    if (model) currentModel = model;
    const existing = steps.get(messageID);
    if (existing && (existing.settled || existing.endAt !== null)) {
      // A retried step reuses its message id: time the new attempt fresh.
      steps.delete(messageID);
      turnStepOrder = turnStepOrder.filter((id) => id !== messageID);
    }
    // The event is published once the step produces output, so it arrives one
    // model-latency after `started` — 6.2 s on the session this was found in.
    // Anchoring at arrival instead drops that latency from every measurement
    // built on the step and reports the delivery interval as time to first
    // token. `started` is rebased onto our own clock rather than used raw, so
    // a service whose clock disagrees with the server's still measures the
    // right *span*.
    const serverCreated = readNumber(event.created) || now;
    const started = readNumber(payload.started);
    const startAt = started > 0 ? now - Math.max(0, serverCreated - started) : now;
    const step = stepFor(messageID, startAt);
    // A step whose first output beat its start event still started when it did.
    step.startAt = Math.min(step.startAt, startAt);
    step.startObserved = true;
    step.model = currentModel;
    return;
  }

  if (type === 'session.step.ended' || type === 'session.step.failed') {
    if (!isWatchedSession(payload.sessionID)) return;
    markActive(now);
    const tokens = readRecord(payload.tokens);
    if (!tokens) {
      return;
    }
    // The cache accounting runs before `settleStep` because that one skips
    // steps with no generated tokens, while a tool-only step can still carry
    // a whole prompt's worth of cache hits.
    const messageID = readString(payload.assistantMessageID);
    recordCacheStep(
      readString(payload.sessionID),
      messageID || `step@${now}`,
      stepUsageFrom(tokens, readNumber(payload.cost)),
      now,
    );
    settleStep(
      messageID,
      readNumber(tokens.output),
      readNumber(tokens.reasoning),
      now,
    );
    return;
  }

  // --- live status (OpenCode 2) -------------------------------------------

  if (type === 'session.execution.started') {
    if (!isWatchedSession(payload.sessionID)) return;
    const startedSession = readString(payload.sessionID);
    if (startedSession && !sessionParents.has(startedSession)) {
      // A conversation that existed before this service started never emits
      // its `session.created`: its first turn is the first time we see it.
      // A subagent whose parent link was missed would look the same; the root
      // cap keeps that bounded.
      noteBackgroundRoot(startedSession, now);
    }
    if (turnStepOrder.length > 0 || turnChars > 0) {
      // A previous turn never saw its terminal event (missed during a stream
      // gap): settle it from its own steps — step durations are
      // self-contained, so no idle time leaks in — then start fresh.
      finalizeTurn(now);
    }
    // Mark where the turn began so time to first token can be judged.
    if (turnExecAt === null) turnExecAt = now;
    busy = true;
    return;
  }

  if (type === 'session.execution.succeeded' || type === 'session.execution.failed') {
    if (!isWatchedSession(payload.sessionID)) return;
    busy = false;
    finalizeTurn(now);
    return;
  }

  if (type === 'session.execution.interrupted') {
    if (!isWatchedSession(payload.sessionID)) return;
    // A shutdown is not the end of the turn: OpenCode keeps the execution
    // claim and resumes the same turn after restart, so the session stays busy
    // until the real terminal outcome arrives.
    if (readString(payload.reason) === 'shutdown') return;
    busy = false;
    finalizeTurn(now);
    return;
  }

  // --- requests to the user -----------------------------------------------

  if (type === 'permission.asked' || type === 'permission.v2.asked') {
    if (!isWatchedSession(payload.sessionID)) return;
    const requestId = readString(payload.id);
    if (requestId) pendingPermissions.add(requestId);
    noteAsk(now);
    return;
  }

  if (type === 'permission.replied' || type === 'permission.v2.replied') {
    if (!isWatchedSession(payload.sessionID)) return;
    const requestId = readString(payload.requestID);
    if (requestId) pendingPermissions.delete(requestId);
    noteAsk(now);
    return;
  }

  // OpenCode 2 models the question tool as a form.
  if (type === 'form.created') {
    const form = readRecord(payload.form);
    if (!form || !isWatchedSession(form.sessionID)) return;
    const requestId = readString(form.id);
    if (requestId) pendingQuestions.add(requestId);
    noteAsk(now);
    return;
  }

  if (type === 'form.replied' || type === 'form.cancelled') {
    if (!isWatchedSession(payload.sessionID)) return;
    const requestId = readString(payload.id);
    if (requestId) pendingQuestions.delete(requestId);
    noteAsk(now);
    return;
  }

  if (type === 'question.asked' || type === 'question.v2.asked') {
    if (!isWatchedSession(payload.sessionID)) return;
    const requestId = readString(payload.id);
    if (requestId) pendingQuestions.add(requestId);
    noteAsk(now);
    return;
  }

  if (type === 'question.replied' || type === 'question.rejected' || type === 'question.v2.replied' || type === 'question.v2.rejected') {
    if (!isWatchedSession(payload.sessionID)) return;
    const requestId = readString(payload.requestID);
    if (requestId) pendingQuestions.delete(requestId);
    noteAsk(now);
    return;
  }

  // OpenCode 2 declares `session.status` and `session.idle` but its own status
  // comes from the execution events above; a server that still emits them is
  // handled here for completeness.
  if (type === 'session.status') {
    if (!isWatchedSession(payload.sessionID)) return;
    const status = readRecord(payload.status);
    const nextBusy = status?.type === 'busy' || status?.type === 'retry';
    if (busy && !nextBusy) finalizeTurn(now);
    if (nextBusy && turnExecAt === null) turnExecAt = now;
    busy = nextBusy;
    return;
  }

  if (type === 'session.idle') {
    if (!isWatchedSession(payload.sessionID)) return;
    busy = false;
    finalizeTurn(now);
  }
};

const handleSseChunk = (chunk: string): void => {
  const data: string[] = [];
  for (const line of chunk.split('\n')) {
    if (!line.startsWith('data:')) continue;
    data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.join('\n'));
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== 'object') return;
  // OpenCode 2 frames are the event itself; a proxy that wraps them as
  // `{ payload, directory, eventId }` is unwrapped here.
  const envelope = parsed as { payload?: unknown };
  const event = (envelope.payload && typeof envelope.payload === 'object' ? envelope.payload : parsed) as RawEvent;
  handleEvent(event, Date.now());
};

const scheduleReconnect = (message: string, kind: ErrorKind, delay = retryDelay): void => {
  lastError = message;
  lastErrorKind = kind;
  connection = 'error';
  if (streamLostAt === null) streamLostAt = Date.now();
  if (retryTimer) return;
  retryDelay = Math.min(RETRY_MAX_MS, Math.max(RETRY_BASE_MS, retryDelay * 2));
  retryTimer = setTimeout(() => {
    retryTimer = null;
    beginStream();
  }, delay);
  retryTimer.unref?.();
};

/**
 * Which sessions OpenCode says are running right now, or null when it could not
 * be asked. `/api/session/active` is global and answers `{ data: { [id]: status } }`:
 * an id that is absent from it is idle.
 */
const fetchActiveSessions = async (): Promise<Set<string> | null> => {
  if (!OPENCODE_URL) return null;
  try {
    const response = await fetch(`${OPENCODE_URL}/api/session/active`, {
      headers: opencodeHeaders('application/json'),
      signal: AbortSignal.timeout(3_000),
      redirect: 'manual',
    });
    const contentType = response.headers.get('content-type') ?? '';
    if (!response.ok || !contentType.includes('json')) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const body = readRecord(await response.json());
    if (!body) return null;
    const statuses = readRecord(body.data) ?? body;
    const running = new Set<string>();
    for (const [id, status] of Object.entries(statuses)) {
      if (status === null || status === undefined) continue;
      const record = readRecord(status);
      const kind = record ? readString(record.type) : '';
      if (kind && kind !== 'running') continue;
      running.add(id);
    }
    return running;
  } catch {
    return null;
  }
};

/**
 * Settle what a cut left in flight, now that the stream is back.
 *
 * A turn's closing events were published while the stream was down, so they are
 * gone for good, and a session left `busy` reads as "writing" forever. OpenCode
 * answers which sessions are running right now, so the question is asked rather
 * than guessed from how long the gap was: a turn it still holds keeps its
 * measurement, and one it no longer holds is recorded from what was measured
 * before the cut — stamped at the moment the stream went down, so an idle stretch
 * spent waiting for the stream never becomes part of the reply's time — and then
 * cleared. A chat waiting on a person (a permission, a question) is still its own
 * turn whatever the read says, and a turn that began after the cut is a live turn
 * with its own ending coming.
 */
const settleAfterCut = async (lostFor: number, lostAt: number): Promise<void> => {
  if (inSession) return;
  const inFlight = [...sessionStates.values()].filter((state) => (
    state.busy
    || state.turnStartedAt !== null
    || state.activeToolIds.size > 0
    || state.pendingPermissions.size > 0
    || state.pendingQuestions.size > 0
  ));
  if (inFlight.length === 0) return;
  const running = await fetchActiveSessions();
  if (running === null) {
    // Could not ask: a gap long enough for the closing events to have gone by
    // unseen is treated as a loss, as it always was.
    if (lostFor > RESUME_GAP_MS) resetInFlight();
    return;
  }
  for (const state of inFlight) {
    if (running.has(state.sessionId)) continue;
    if (state.pendingPermissions.size > 0 || state.pendingQuestions.size > 0) continue;
    if (state.turnExecAt !== null && state.turnExecAt > lostAt) continue;
    enterSession(state.sessionId);
    if (state.turnStartedAt !== null) finalizeTurn(lostAt);
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

const eventUrl = (): string => {
  const url = new URL(`${OPENCODE_URL}/api/event`);
  if (filterTypes) for (const type of EVENT_TYPES) url.searchParams.append('types', type);
  return url.toString();
};

/**
 * Read OpenCode's event stream until it ends, then come back.
 *
 * One stream carries every session in every project. It ends on its own every
 * so often (the host's 8 MB limit, an idle socket, a consumer OpenCode found
 * too slow), so an end after a healthy read reconnects at once and keeps the
 * turns in flight; a failure to connect backs off.
 */
const startStream = async (): Promise<void> => {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  controller?.abort();
  const local = new AbortController();
  controller = local;
  if (!OPENCODE_URL) {
    // The host starts an approved service with this address. Without it the
    // approval is missing or the host is too old, and nothing else may stand in.
    lastError = null;
    lastErrorKind = 'access';
    connection = 'error';
    return;
  }
  if (connection !== 'live') connection = 'connecting';

  let response: Response;
  try {
    response = await fetch(eventUrl(), {
      headers: opencodeHeaders('text/event-stream'),
      signal: local.signal,
      redirect: 'manual',
    });
  } catch (error) {
    if (local.signal.aborted) return;
    scheduleReconnect(error instanceof Error ? error.message : String(error), 'network');
    return;
  }
  if (response.status === 400 && filterTypes) {
    // An OpenCode that does not know one of the names: read everything.
    await response.body?.cancel().catch(() => undefined);
    filterTypes = false;
    scheduleReconnect('Event stream refused the type list', 'http', 0);
    return;
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel().catch(() => undefined);
    scheduleReconnect(`Event stream answered HTTP ${response.status}`, 'access');
    return;
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    scheduleReconnect(`Event stream answered HTTP ${response.status}`, 'http');
    return;
  }

  const lostAt = streamLostAt ?? Date.now();
  const lostFor = streamLostAt === null ? 0 : Date.now() - lostAt;
  streamLostAt = null;
  if (lostFor > 0) {
    // Whatever is still marked in flight is checked against what OpenCode is
    // really running, whatever the gap was: a three-second cut can swallow a
    // turn's closing event just as a three-minute one can.
    void settleAfterCut(lostFor, lostAt).catch(() => undefined);
  }
  connection = 'live';
  lastError = null;
  lastErrorKind = null;
  retryDelay = RETRY_BASE_MS;

  let healthy = false;
  try {
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = '';
    while (!local.signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      healthy = true;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        handleSseChunk(chunk);
        boundary = buffer.indexOf('\n\n');
      }
    }
  } catch (error) {
    if (local.signal.aborted) return;
    scheduleReconnect(error instanceof Error ? error.message : String(error), 'closed', healthy ? 0 : retryDelay);
    return;
  }
  if (local.signal.aborted) return;
  scheduleReconnect('Event stream closed', 'closed', healthy ? 0 : retryDelay);
};

/**
 * The only entry point: a rejection here would take the process down and leave
 * the panel with nothing to read, so it lands in the same state the panel
 * already knows how to show.
 */
const beginStream = (): void => {
  void startStream().catch((error: unknown) => {
    scheduleReconnect(error instanceof Error ? error.message : String(error), 'network');
  });
};

/** Start the stream once; it then keeps itself running. */
const ensureStream = (): void => {
  if (controller !== null || retryTimer !== null) return;
  beginStream();
};

const stopStream = (): void => {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  controller?.abort();
  controller = null;
  connection = 'idle';
};

/** The rate of about the last second, which says whether tokens are arriving now. */
const computeLive = (now: number): number => {
  const from = now - WINDOW_MS;
  let chars = 0;
  let oldest = now;
  for (const sample of samples) {
    if (sample.at < from) continue;
    chars += sample.chars;
    if (sample.at < oldest) oldest = sample.at;
  }
  if (chars === 0) return 0;
  // Divide by the span the samples actually cover, so the number is correct
  // as soon as streaming starts instead of climbing while the window fills. A
  // window whose samples all landed in one millisecond is capped rather than
  // reported as a broken rate.
  const spanMs = Math.max(1, Math.min(WINDOW_MS, now - oldest));
  return Math.min(estimateTokens(chars) / (spanMs / 1000), MAX_PLAUSIBLE_TOKENS_PER_SECOND);
};

/**
 * The drawn curve, oldest first: one rate per bucket of the rolling window.
 *
 * Only live samples belong here. Finished-turn averages used to be prepended,
 * but a point per turn and a point per bucket are different time bases, and
 * sharing one normalized axis squashed whichever side was smaller — a history
 * that peaked at 523 pushed a live 120 down to a quarter of the height, which
 * read as the graph collapsing on the right.
 *
 * The length is always `CURVE_BUCKETS`, and the bucket edges sit on a fixed
 * absolute grid (`floor(t / width)`), not at `now - k * width`. Anchoring them
 * at "now" re-cut every slice on each 250 ms poll: the edges slid 20% of a
 * bucket per poll, so one chunk moved between neighbouring buckets, a spike
 * split in two and merged again, and the shape deformed in place while the x
 * positions stood still. On the absolute grid a chunk belongs to the same
 * bucket for its whole life, so the curve can only translate (see
 * `shared/spark.ts` for the matching x mapping).
 *
 * Only complete buckets are drawn, and each divides by the full width. The
 * bucket still filling would otherwise change height as it slides: divided by
 * its elapsed time it reads a huge rate the moment one chunk lands in it, and
 * divided by the full width it starts near the floor and climbs. Either way
 * the leading point deforms, which is the artifact this curve exists to avoid.
 *
 * Trailing silence is kept rather than trimmed: the line decays to the floor
 * while the model thinks or a tool runs, which is what actually happened,
 * rather than the tail being cut off to hide it. A window with nothing in it
 * draws that floor rather than nothing at all, so the sparkline never
 * disappears on a session that has gone quiet.
 */
const computeCurve = (now: number): { values: number[]; startAt: number; stepMs: number } => {
  const width = CURVE_WINDOW_MS / CURVE_BUCKETS;
  // The newest edge at or before `now`: every drawn bucket is one that has
  // already happened in full.
  const newest = Math.floor(now / width) * width;
  const oldest = newest - CURVE_WINDOW_MS;
  pruneSamples(oldest);
  const buckets = new Array<number>(CURVE_BUCKETS).fill(0);
  const said = new Array<number>(CURVE_BUCKETS).fill(0);
  for (const sample of samples) {
    if (sample.at < oldest || sample.at >= newest) continue;
    // Every sample before the newest edge falls inside the 24 buckets above;
    // the clamp only guards the index against rounding.
    const b = Math.min(CURVE_BUCKETS - 1, Math.floor((sample.at - oldest) / width));
    buckets[b] += sample.chars;
    if (sample.tps > 0) said[b] = sample.tps;
  }
  const values: number[] = [];
  for (let b = 0; b < CURVE_BUCKETS; b += 1) {
    // A bucket where words arrived is what the headline said then; a quiet one
    // is the floor. Only a bucket from before the headline had any number to
    // say falls back to the rate of what it holds across its own width (the
    // width, not the span its samples covered: one chunk over 1 ms would read
    // as a spike that flattens every other point).
    values.push(buckets[b] === 0 ? 0 : said[b] > 0
      ? said[b]
      : Math.min(estimateTokens(buckets[b]) / (width / 1000), MAX_PLAUSIBLE_TOKENS_PER_SECOND));
  }
  return { values, startAt: oldest, stepMs: width };
};

/**
 * Record what a page asked to watch.
 *
 * Registering a session never touches the measurement: its record either
 * already exists or starts empty, and nothing belonging to another session is
 * reset or dropped. The stream is OpenCode's global one, so a new session
 * needs no reconnect.
 */
const applyWatch = (next: WatchConfig, now: number): void => {
  watch = next;
  leases.set(next.sessionId ?? '', now + LEASE_MS);
  if (next.sessionId) {
    watched.add(next.sessionId);
    const state = trackSession(next.sessionId);
    // A page that names no model keeps the one it named last: the row then
    // still says which model the chat is on.
    if (next.model) state.chatModel = next.model;
  }
  ensureStream();
};

// --- push ---------------------------------------------------------------------
//
// A page used to ask for its reading four times a second whether or not
// anything had changed. Now each page holds a lease on the session it shows
// (its `/watch`, renewed every few seconds), and the service sends that
// session's reading to the open pages when it changes, plus a short sign of
// life while it does not. A host that does not deliver the events leaves the
// page hearing nothing, and the page then asks for itself.

/** How long one `/watch` keeps a session's reading coming. */
const LEASE_MS = 12_000;
/** Fastest a reading is sent, and how often an unchanged one is sent anyway. */
const PUSH_EVERY_MS = 250;
const PUSH_KEEPALIVE_MS = 2_000;
/** The host takes 30 events a second; four a second each leaves room. */
const PUSH_SESSIONS_MAX = 6;

/** Session shown by a page (`''` for a page with no session yet) -> lease end. */
const leases = new Map<string, number>();
const lastPushed = new Map<string, { sig: string; at: number }>();
/** Off once the host says it takes no events from this process. */
let pushing = true;

/** Fields that change on every reading without the picture changing. */
const VOLATILE = new Set(['curveAt', 'at', 'observedAt']);

const signature = (body: Record<string, unknown>): string => {
  const quiet = Array.isArray(body.curve) && (body.curve as number[]).every((value) => value <= 0.05);
  return JSON.stringify(body, (key, value) => (
    VOLATILE.has(key) || (quiet && key === 'curveStart') ? undefined : value
  ));
};

const pushTick = (): void => {
  const now = Date.now();
  for (const [key, until] of leases) {
    if (until <= now) {
      leases.delete(key);
      lastPushed.delete(key);
    }
  }
  if (leases.size === 0) return;
  // A page is looking: keep the Mac, prompt and render readers warm.
  noteDemand(now);
  if (!pushing) return;
  // Least recently pushed first, and only a real push spends the budget: with
  // more pages open than one tick can carry, every one of them gets a turn
  // instead of the first six holding the channel while the rest fall back to
  // asking.
  const due = [...leases.keys()].sort(
    (a, b) => (lastPushed.get(a)?.at ?? 0) - (lastPushed.get(b)?.at ?? 0) || (a < b ? -1 : 1),
  );
  let sent = 0;
  for (const key of due) {
    if (sent >= PUSH_SESSIONS_MAX) break;
    const body = rateBody(key || null, now);
    const sig = signature(body);
    const previous = lastPushed.get(key);
    if (previous && previous.sig === sig && now - previous.at < PUSH_KEEPALIVE_MS) continue;
    sent += 1;
    lastPushed.set(key, { sig, at: now });
    void serviceHost.emit('rate', { session: key || null, rate: body as never }).catch((error: unknown) => {
      // No callback address: this host was not told to take events from us.
      if ((error as { code?: unknown })?.code === 'HOST_UNAVAILABLE') pushing = false;
      // Anything else (a busy second, a frame closing) is simply skipped.
      lastPushed.delete(key);
    });
  }
};
const pushTimer = setInterval(pushTick, PUSH_EVERY_MS);
pushTimer.unref?.();

const json = (res: http.ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
};

const readJsonBody = (req: http.IncomingMessage): Promise<unknown> => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', (chunk: Buffer) => {
    body += chunk;
    if (body.length > 64_000) {
      reject(new Error('Request body too large'));
      req.destroy();
    }
  });
  req.on('end', () => {
    if (!body.trim()) {
      resolve(null);
      return;
    }
    try {
      resolve(JSON.parse(body));
    } catch {
      reject(new Error('Request body is not valid JSON'));
    }
  });
  req.on('error', reject);
});

/**
 * One event posted by the host for `contributes.sessionEvents`.
 *
 * The wire carries identifiers only; token counts still come from the SSE
 * stream, which this wakes. A `turn-started` for a top-level session makes it
 * a conversation worth counting in the background.
 */
const noteBackgroundRoot = (sessionId: string, now: number): void => {
  // Re-inserting refreshes the insertion order, so the oldest root falls out.
  activeRoots.delete(sessionId);
  activeRoots.set(sessionId, now);
  while (activeRoots.size > BACKGROUND_ROOT_CAP) {
    const oldest = activeRoots.keys().next();
    if (oldest.done) break;
    activeRoots.delete(oldest.value);
  }
};

const SESSION_EVENT_TYPES = new Set([
  'turn-finished', 'turn-failed', 'permission-asked', 'question-asked',
  'turn-started', 'session-created', 'session-archived', 'session-deleted',
]);

const handleSessionEvent = (body: unknown): boolean => {
  const request = readRecord(body);
  if (!request || request.v !== 1) return false;
  const event = readRecord(request.event);
  if (!event) return false;
  const type = readString(event.type);
  if (!SESSION_EVENT_TYPES.has(type)) return false;
  const session = readRecord(event.session);
  const sessionId = session ? readString(session.id) : '';
  const parentId = session ? readString(session.parentId) : '';
  if (!sessionId) return false;
  const now = Date.now();
  if (type === 'session-created') {
    if (parentId) sessionParents.set(sessionId, parentId);
    else sessionParents.delete(sessionId);
  }
  if (type === 'turn-started' && !parentId) noteBackgroundRoot(sessionId, now);
  if (type === 'turn-started' || type === 'turn-finished') {
    // A subagent's session is announced with its parent; remember the link so
    // its steps fold into the conversation.
    if (parentId) sessionParents.set(sessionId, parentId);
    if (watchedRootsFor(sessionId).length > 0) trackSession(sessionId);
    ensureStream();
  }
  if (type === 'turn-finished') flushPersist();
  return true;
};

/**
 * The model in play for the session this answer is about.
 *
 * The page names the model the chat has selected; the step events name the
 * model that actually ran. The page wins, because that is the model the chat
 * is on now, and the step is the fallback for a page that names nothing.
 */
const chatModelReading = (): { id: string; name: string } | null => {
  const id = chatModel || (currentModel !== '*' ? currentModel : null);
  if (!id) return null;
  return { id, name: modelDisplayName(id) };
};

/** One session's reading, as `/rate` answers it and a push carries it. */
const rateBody = (requested: string | null, now: number): Record<string, unknown> => {
  if (requested !== null) enterSession(requested);
  else loadState(blankSession);
  try {
    claimEngineFigures(now);
    const curve = computeCurve(now);
    return {
      connection,
      error: lastError,
      errorKind: lastErrorKind,
      // Nothing has watched this session in this process, so say so and the
      // page re-asserts — that is how a service that just came back up learns
      // which sessions are on screen. The numbers are still answered from
      // disk, so the panel shows the last reply straight away.
      sessionId: requested !== null && watched.has(requested) ? requested : null,
      busy,
      waiting: waitingKind(),
      toolActive: toolActive(),
      live: { tps: computeLive(now) },
      // The speed of the step writing now, or the last one of this turn that
      // has one: what the headline shows while the turn runs.
      running: busy || turnStepOrder.length > 0 ? headlineFigure(now) : null,
      // The buckets' own clock travels with them: without it a guest can
      // only place them on an index axis, which is what made the curve
      // deform instead of slide. `curveAt` is the window's right edge.
      curve: curve.values,
      curveStart: curve.startAt,
      curveStep: curve.stepMs,
      curveAt: now,
      turn: {
        active: turnStartedAt !== null,
        ttftMs: liveTtftMs(),
      },
      lastTurn,
      // Conversation-wide cache accounting of the watched session and its
      // sub-sessions; null until a step settles.
      cache: cacheWire(cache),
      // Gauge's own readings: Mac memory, the prompt this chat is reading and
      // a ComfyUI render. Each is null when there is nothing to show. The
      // chat's own model rides with them: it is the model in play, which is
      // not the model the local engine holds.
      gauge: { ...gaugeWire(sessionIdsFor(requested), now), chatModel: chatModelReading() },
    };
  } finally {
    leaveSession();
  }
};

const server = http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    json(res, 401, { error: 'unauthorized' });
    return;
  }

  const url = new URL(req.url ?? '/', 'http://127.0.0.1');

  if (url.pathname === '/health') {
    json(res, 200, { ok: true, pid: process.pid });
    return;
  }

  if (url.pathname === '/watch' && req.method === 'POST') {
    void readJsonBody(req).then((raw) => {
      const body = (raw && typeof raw === 'object' ? raw : {}) as { sessionId?: unknown; model?: unknown };
      // A session id longer than OpenCode's own is not a session: refuse rather
      // than keep a key nothing can ever produce.
      if (typeof body.sessionId === 'string' && body.sessionId.trim().length > SESSION_ID_MAX) {
        json(res, 400, { error: 'session id too long' });
        return;
      }
      const sessionId = typeof body.sessionId === 'string' && body.sessionId.trim() ? body.sessionId.trim() : null;
      // The model the chat has selected. It is a name, not a credential: it
      // is kept so the panel can say which model is in play, and never leaves
      // this machine. A name too long to be one is simply not reported.
      const model = typeof body.model === 'string' && body.model.trim() && body.model.trim().length <= MODEL_NAME_MAX
        ? body.model.trim()
        : null;
      applyWatch({ sessionId, model }, Date.now());
      // `push` is this service saying whether the host takes what it posts: a
      // page that is told no starts asking again instead of waiting to notice.
      json(res, 200, { ok: true, connection, sessionId, push: pushing });
    }).catch((error: unknown) => {
      json(res, 400, { error: error instanceof Error ? error.message : 'Invalid request' });
    });
    return;
  }

  if (url.pathname === '/session-events' && req.method === 'POST') {
    void readJsonBody(req)
      .then((body) => {
        if (!handleSessionEvent(body)) {
          json(res, 400, { ok: false, error: 'unsupported session event' });
          return;
        }
        json(res, 200, { ok: true });
      })
      .catch((error: unknown) => {
        json(res, 400, { ok: false, error: error instanceof Error ? error.message : 'bad body' });
      });
    return;
  }

  if (url.pathname === '/rate') {
    const now = Date.now();
    // A page is looking: the Mac, prompt and render readers run only while
    // something asks for them. The speed measurement keeps counting anyway.
    noteDemand(now);
    // A page names its own session so two pages watching different sessions
    // each read their own record. Without the parameter the most recent watch
    // answers; with no watch either, the blank record answers.
    const requested = readString(url.searchParams.get('sessionId')) || watch?.sessionId || null;
    json(res, 200, rateBody(requested, now));
    return;
  }

  json(res, 404, { error: 'not-found' });
});

readPersisted();
server.listen(port, '127.0.0.1', () => {
  // `service.keepRunning` starts this process with the host, not with a page.
  // Subscribe immediately so background counting begins before anyone opens
  // the panel.
  ensureStream();
});

const shutdown = (): void => {
  flushPersist();
  stopStream();
  server.close(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
