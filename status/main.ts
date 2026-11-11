import { connectHost, HostRequestError } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import { clearSpark as clearSparkPaths, drawSpark, makeSparkSvg, nextScale, type SparkFrame } from '../shared/spark';

type Live = {
  tps: number;
  spanMs: number;
  chars: number;
  textChars: number;
  reasoningChars: number;
  toolChars: number;
};

type TurnResult = {
  tokensPerSecond: number;
  source: 'tokens' | 'estimate';
  tokens: number;
  activeMs: number;
  wallMs: number;
  ttftMs: number | null;
  hasReasoning: boolean;
  endedAt: number;
};

type CachePoint = {
  at: number;
  sessionId: string;
  messageID: string;
  hit: number;
  miss: number;
  hitRate: number | null;
  delta: number | null;
  output: number;
  reasoning: number;
};

type CacheInfo = {
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
  last: CachePoint | null;
  prevHitRate: number | null;
};

type GaugeWire = {
  mac: {
    pressure: 'normal' | 'warning' | 'critical' | null;
    usedBytes: number | null;
    totalBytes: number | null;
    swapUsedBytes: number | null;
    at: number;
  } | null;
  prompt: {
    kind: 'primary' | 'compaction';
    total: number;
    cache: number;
    processed: number;
    timeMs: number;
    observedAt: number;
  } | null;
  render: {
    state: 'running' | 'queued';
    startedAt: number | null;
    queued: number;
    step: { value: number; max: number; at: number } | null;
  } | null;
};

type RateResponse = {
  connection: 'idle' | 'connecting' | 'live' | 'error';
  error: string | null;
  /** `network` when the origin could not be dialled at all; see `error`. */
  errorKind: 'network' | 'http' | 'closed' | null;
  sessionId: string | null;
  busy: boolean;
  waiting: 'permission' | 'question' | null;
  toolActive: boolean;
  live: Live;
  /** Running turn average; null when nothing has streamed yet this turn. */
  running: { tps: number; source: 'tokens' | 'estimate' } | null;
  /** Drawn curve owned by the service: one rate per bucket of the last 30 s. */
  curve: number[];
  /** Epoch ms of the first bucket; absent from an older service. */
  curveStart?: number;
  /** Bucket width in ms; absent from an older service. */
  curveStep?: number;
  /** Epoch ms the curve was computed at; absent from an older service. */
  curveAt?: number;
  turn: { active: boolean; ttftMs: number | null };
  lastTurn: TurnResult | null;
  /** Conversation-wide cache accounting; null until a step settles. */
  cache?: CacheInfo | null;
  /** Gauge's own readings; absent from an older service. */
  gauge?: GaugeWire;
  eventsSeen: number;
};

type HostSession = { id: string; title: string; busy: boolean } | null;

const COPY = {
  zh: {
    unit: 'tok/s',
    toolRunning: '工具执行中',
    waitingPermission: '等授权',
    waitingQuestion: '等回答',
    connecting: '连接中',
    reconnecting: '重连中',
    noService: '需在 设置 → 扩展 里允许本地服务',
    unreachable: '连不上服务端事件流',
    noData: '对话开始后显示',
    lastTurn: '上轮',
    ttft: '首字',
    measured: '实测',
    estimated: '估计',
    noReasoning: '无推理数据',
    stepHit: '单步',
    totalHit: '累计',
    inProgress: '进行中',
    work: '工作',
    prompt: '读取提示',
    render: '渲染',
    queued: '排队',
    memory: '内存',
    swap: '交换',
    left: '剩余',
  },
  en: {
    unit: 'tok/s',
    toolRunning: 'running tool',
    waitingPermission: 'waiting for permission',
    waitingQuestion: 'waiting for answer',
    connecting: 'connecting',
    reconnecting: 'reconnecting',
    noService: 'Allow the local service in Settings → Extensions',
    unreachable: 'cannot reach the server stream',
    noData: 'shows once a turn runs',
    lastTurn: 'last',
    ttft: 'ttft',
    measured: 'measured',
    estimated: 'estimated',
    noReasoning: 'no reasoning data',
    stepHit: 'step',
    totalHit: 'total',
    inProgress: 'in progress',
    work: 'work',
    prompt: 'prompt',
    render: 'render',
    queued: 'queued',
    memory: 'memory',
    swap: 'swap',
    left: 'left',
  },
} as const;

type Copy = Record<keyof (typeof COPY)['zh'], string>;

const SPARK_W = 120;
const SPARK_H = 18;
/** Narrowest believable fallback window for a service that predates the timestamps. */
const SPARK_WINDOW_MS = 30_000;
/** Floor between watch re-asserts, so a service that is down costs one call a second, not one per poll. */
const REASSERT_MIN_MS = 1_000;

const host = connectHost();
const root = document.querySelector('#root');
if (!root) throw new Error('Missing #root');

let copy: Copy = COPY.zh;
let origin: string | null = null;
let session: HostSession = null;
let mounted = false;
let polling = false;
let stopped = false;
let configuredKey = '';
let configuring = false;
let lastReassertAt = 0;
let heightReported = false;
/** Latest curve from the service, when this page received it, and its full scale. */
let sparkFrame: SparkFrame | null = null;
let sparkFrameAt = 0;
let sparkScale = 1;
let sparkPaintedAt = 0;
/**
 * Whether the curve still holds a nonzero point. It slides as long as it does,
 * even after the turn ended and the live number is already zero — a decaying
 * tail is still moving data. Only a curve that is zero everywhere stops.
 */
let sparkMoving = false;
/** A curve that just emptied still needs one static draw to flatten out. */
let sparkNeedsStatic = false;

const row1 = document.createElement('div');
row1.className = 'row';
const dot = document.createElement('span');
dot.className = 'dot';
const valueEl = document.createElement('span');
valueEl.className = 'value';
valueEl.textContent = '—';
const unitEl = document.createElement('span');
unitEl.className = 'unit';
const sparkEl = document.createElement('div');
sparkEl.className = 'row sparkrow';
const sparkParts = makeSparkSvg(SPARK_W, SPARK_H);
// Same treatment as the panel: the drawing keeps its coordinate system and the
// element spans the section, so the curve reaches both edges.
sparkParts.svg.setAttribute('width', '100%');
sparkParts.svg.setAttribute('preserveAspectRatio', 'none');
for (const path of [sparkParts.line, sparkParts.area]) {
  path.setAttribute('vector-effect', 'non-scaling-stroke');
}
sparkEl.append(sparkParts.svg);
row1.append(dot, valueEl, unitEl);
let lastHeight = 0;

const row2 = document.createElement('div');
row2.className = 'row meta';
const stateEl = document.createElement('span');
const lastEl = document.createElement('span');
row2.append(stateEl, lastEl);

type CacheRow = {
  root: HTMLElement;
  label: HTMLElement;
  bar: HTMLElement;
  fill: HTMLElement;
  pct: HTMLElement;
  delta: HTMLElement;
};

/**
 * A fixed row: label, bar, value. Always the same height whether it shows a
 * reading or a dash, so the section never changes size under the reader.
 */
type GaugeRow = {
  root: HTMLElement;
  label: HTMLElement;
  bar: HTMLElement;
  fill: HTMLElement;
  value: HTMLElement;
};

const makeGaugeRow = (labelText: string): GaugeRow => {
  const root = document.createElement('div');
  root.className = 'row gauge';
  const label = document.createElement('span');
  label.className = 'gauge-label';
  label.textContent = labelText;
  const bar = document.createElement('span');
  bar.className = 'gaugebar';
  const fill = document.createElement('span');
  fill.className = 'fill';
  bar.append(fill);
  const value = document.createElement('span');
  value.className = 'gauge-value';
  value.textContent = '—';
  root.append(label, bar, value);
  return { root, label, bar, fill, value };
};

const workRow = makeGaugeRow('');
const macRow = makeGaugeRow('');

const makeCacheRow = (): CacheRow => {
  const root = document.createElement('div');
  root.className = 'row cache';
  const label = document.createElement('span');
  label.className = 'cache-label';
  const bar = document.createElement('span');
  bar.className = 'hitbar';
  const fill = document.createElement('span');
  fill.className = 'fill';
  bar.append(fill);
  const pct = document.createElement('span');
  pct.className = 'cache-pct';
  pct.textContent = '—';
  const delta = document.createElement('span');
  delta.className = 'cache-delta';
  root.append(label, bar, pct, delta);
  return { root, label, bar, fill, pct, delta };
};

const stepCache = makeCacheRow();
const totalCache = makeCacheRow();

const resolveOrigin = (): string | null => {
  try {
    const url = new URL(window.location.href);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin;
  } catch {
    // about:srcdoc, an opaque sandbox origin, or no window: nothing usable.
  }
  return null;
};

const formatTps = (tps: number): string => {
  if (!Number.isFinite(tps)) return '—';
  return tps >= 100 ? tps.toFixed(0) : tps.toFixed(1);
};

const formatSecs = (ms: number | null): string => {
  if (ms === null || !Number.isFinite(ms)) return '—';
  const s = ms / 1000;
  return s >= 10 ? `${s.toFixed(0)}s` : `${s.toFixed(1)}s`;
};

/**
 * The wire curve plus the clock it was measured against. A service older than
 * the timestamps is read as a window ending at now, which is what that service
 * meant, so a mid-update mix still draws something sane.
 */
const sparkFrameFrom = (rate: RateResponse): SparkFrame => {
  const step = rate.curveStep && rate.curveStep > 0 ? rate.curveStep : SPARK_WINDOW_MS / Math.max(1, rate.curve.length);
  const at = rate.curveAt ?? Date.now();
  const startAt = rate.curveStart ?? at - rate.curve.length * step;
  return { values: rate.curve, startAt, stepMs: step, at };
};

const dropSpark = (): void => {
  sparkFrame = null;
  sparkScale = 1;
  clearSparkPaths(sparkParts);
};

/**
 * Redraw between polls against a projected clock, so the curve slides instead
 * of stepping two pixels at a time four times a second. The point values stay
 * exactly what the service measured; only the window edge moves.
 */
const paintSpark = (): void => {
  if (stopped) return;
  const frame = sparkFrame;
  const at = performance.now();
  if (frame && frame.values.length > 0) {
    if (sparkMoving) {
      // ~30 fps is enough for a 2 px/slide and keeps a decorative curve from
      // repainting the whole section sixty times a second.
      if (at - sparkPaintedAt >= 30) {
        sparkPaintedAt = at;
        const elapsed = Math.min(2_000, at - sparkFrameAt);
        sparkScale = nextScale(sparkScale, frame.values);
        drawSpark(sparkParts, frame, frame.at + elapsed, SPARK_W, SPARK_H, sparkScale);
      }
    } else if (sparkNeedsStatic) {
      // Snap to the frame's own edge so the frozen picture does not keep the
      // projection of a slide that has stopped.
      sparkNeedsStatic = false;
      sparkScale = nextScale(sparkScale, frame.values);
      drawSpark(sparkParts, frame, frame.at, SPARK_W, SPARK_H, sparkScale);
    }
  }
  requestAnimationFrame(paintSpark);
};

const fitHeight = (): void => {
  const h = Math.min(320, Math.max(24, Math.ceil(root.scrollHeight) + 2));
  if (h !== lastHeight) {
    lastHeight = h;
    void host.setHeight(h).catch(() => undefined);
  }
};

const setState = (text: string): void => {
  // An empty state must not leave a flex gap behind in the meta row.
  stateEl.textContent = text;
  stateEl.hidden = text.length === 0;
};

const formatPct = (value: number | null | undefined): string => (
  typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)}%` : '—'
);

const barWidth = (value: number | null | undefined): string => (
  `${Math.max(0, Math.min(100, typeof value === 'number' && Number.isFinite(value) ? value : 0))}%`
);

/**
 * The two cache rates: the last settled step (which may belong to a
 * sub-session) and the conversation total. Both are hidden when no step has
 * reported a cache block, rather than drawn as a misleading 0%.
 */
const paintCache = (info: CacheInfo | null | undefined): void => {
  const present = !!info && info.steps > 0 && info.hit + info.miss > 0;
  stepCache.root.hidden = !present;
  totalCache.root.hidden = !present;
  if (!present || !info) {
    stepCache.pct.textContent = '—';
    totalCache.pct.textContent = '—';
    stepCache.delta.textContent = '';
    stepCache.bar.hidden = true;
    totalCache.bar.hidden = true;
    return;
  }
  stepCache.label.textContent = copy.stepHit;
  totalCache.label.textContent = copy.totalHit;
  stepCache.bar.hidden = false;
  totalCache.bar.hidden = false;
  const last = info.last;
  stepCache.fill.style.width = barWidth(last?.hitRate);
  stepCache.pct.textContent = formatPct(last?.hitRate);
  const delta = last?.delta;
  if (typeof delta === 'number' && Number.isFinite(delta) && Math.abs(delta) >= 0.05) {
    stepCache.delta.textContent = `${delta >= 0 ? '↑' : '↓'}${Math.abs(delta).toFixed(1)}`;
    stepCache.delta.className = delta >= 0 ? 'cache-delta up' : 'cache-delta down';
  } else {
    stepCache.delta.textContent = '';
    stepCache.delta.className = 'cache-delta';
  }
  totalCache.fill.style.width = barWidth(info.hitRate);
  totalCache.pct.textContent = formatPct(info.hitRate);
  totalCache.delta.textContent = '';
};

const formatGb = (bytes: number | null | undefined): string => {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—';
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
};

/**
 * Gauge's own two rows.
 *
 * The work row shows whichever heavy job is running: the prompt a local chat is
 * reading, or a ComfyUI render. The memory row shows what the Mac is using.
 * Both rows are always present and the same height; a missing reading is a
 * dash, never a row that appears and disappears.
 */
const paintGauge = (gauge: GaugeWire | null | undefined): void => {
  const prompt = gauge?.prompt ?? null;
  const job = gauge?.render ?? null;
  const mac = gauge?.mac ?? null;

  workRow.label.textContent = copy.work;
  if (prompt && prompt.total > 0) {
    const percent = (prompt.processed / prompt.total) * 100;
    // Time left from the rate Splash itself reported: processed tokens over the
    // prefill time so far. No rate, no estimate.
    const perMs = prompt.timeMs > 0 ? prompt.processed / prompt.timeMs : 0;
    const leftMs = perMs > 0 ? (prompt.total - prompt.processed) / perMs : null;
    workRow.value.textContent = leftMs !== null
      ? `${copy.prompt} ${percent.toFixed(0)}% · ${formatSecs(leftMs)} ${copy.left}`
      : `${copy.prompt} ${percent.toFixed(0)}%`;
    workRow.fill.style.width = barWidth(percent);
    workRow.root.className = 'row gauge active';
  } else if (job) {
    const step = job.step;
    const parts = [copy.render];
    if (step) parts.push(`${step.value} / ${step.max}`);
    if (job.state === 'queued') parts.push(`${job.queued} ${copy.queued}`);
    else if (job.startedAt) parts.push(formatSecs(Date.now() - job.startedAt));
    // Jobs waiting behind the running one: how much is still to come.
    if (job.state !== 'queued' && job.queued > 0) parts.push(`${job.queued} ${copy.queued}`);
    workRow.value.textContent = parts.join(' · ');
    workRow.fill.style.width = barWidth(step && step.max > 0 ? (step.value / step.max) * 100 : null);
    workRow.root.className = 'row gauge active';
  } else {
    workRow.value.textContent = '—';
    workRow.fill.style.width = '0%';
    workRow.root.className = 'row gauge';
  }

  macRow.label.textContent = copy.memory;
  if (mac && mac.usedBytes !== null && mac.totalBytes) {
    const percent = (mac.usedBytes / mac.totalBytes) * 100;
    const swap = mac.swapUsedBytes && mac.swapUsedBytes > 0 ? ` · ${copy.swap} ${formatGb(mac.swapUsedBytes)}` : '';
    macRow.value.textContent = `${formatGb(mac.usedBytes)} / ${formatGb(mac.totalBytes)}${swap}`;
    macRow.fill.style.width = barWidth(percent);
    macRow.root.className = `row gauge ${mac.pressure ?? 'normal'}`;
  } else {
    macRow.value.textContent = '—';
    macRow.fill.style.width = '0%';
    macRow.root.className = 'row gauge';
  }
};

const render = (rate: RateResponse | null, notice: string | null = null): void => {
  if (!rate) {
    dot.className = 'dot';
    valueEl.textContent = '—';
    setState(notice ?? copy.connecting);
    lastEl.textContent = '';
    paintCache(null);
    paintGauge(null);
    dropSpark();
    fitHeight();
    return;
  }
  if (rate.connection === 'error') {
    dot.className = 'dot wait';
    // A network failure is a wrong address, not a bad response: name the
    // condition rather than leak the runtime's `fetch failed`.
    setState(
      rate.errorKind === 'network' ? copy.unreachable : (rate.error ?? copy.reconnecting),
    );
  } else if (rate.connection !== 'live') {
    dot.className = 'dot';
    setState(copy.connecting);
  } else if (rate.waiting === 'permission') {
    dot.className = 'dot wait';
    setState(copy.waitingPermission);
  } else if (rate.waiting === 'question') {
    dot.className = 'dot wait';
    setState(copy.waitingQuestion);
  } else if (rate.toolActive) {
    dot.className = 'dot live';
    setState(copy.toolRunning);
  } else {
    // "generating" and "idle" say nothing the dot and the headline do not
    // already say — they only stretched the meta line.
    dot.className = rate.busy ? 'dot live' : 'dot';
    setState('');
  }

  const live = rate.live.tps;
  const streaming = rate.busy && rate.waiting === null && live > 0.05;
  const turnActive = rate.busy || rate.toolActive;
  // Headline is the running turn average: stable across network jitter and
  // identical to the finalized average when the turn ends.
  const shown = rate.running ? rate.running.tps : (rate.lastTurn?.tokensPerSecond ?? NaN);
  const hasValue = Number.isFinite(shown) && shown > 0;
  valueEl.textContent = hasValue ? formatTps(shown) : '—';
  // Grey whenever tokens are not arriving, so the number does not read as a
  // live rate next to a curve that has already decayed towards zero.
  valueEl.className = hasValue && !streaming ? 'value stale' : 'value';

  // The curve is owned by the service: it survives iframe remounts and
  // session switches, and is a rolling rate window rather than turn history.
  // An empty curve means the answer belongs to no session, so nothing is drawn
  // rather than the previous session's shape being left on screen.
  const nextFrame = sparkFrameFrom(rate);
  const moving = nextFrame.values.some((value) => value > 0.05);
  if (nextFrame.values.length === 0) {
    dropSpark();
    sparkMoving = false;
  } else {
    sparkFrame = nextFrame;
    sparkFrameAt = performance.now();
    // A nonzero curve keeps panning at any time; all zeros flatten once and
    // then hold, so a quiet session shows no motion at all.
    sparkNeedsStatic = sparkMoving && !moving;
    sparkMoving = moving;
  }

  // Second row: last-turn average + TTFT. Prefer the finished turn; while a
  // turn runs, show its TTFT so far.
  const lt = rate.lastTurn;
  const parts: string[] = [];
  if (lt) {
    parts.push(`${copy.lastTurn} ${formatTps(lt.tokensPerSecond)} (${lt.source === 'tokens' ? copy.measured : copy.estimated})`);
  }
  const ttft = rate.turn.active ? rate.turn.ttftMs : lt?.ttftMs ?? null;
  if (ttft !== null || lt) {
    parts.push(`${copy.ttft} ${formatSecs(ttft)}`);
  }
  if (lt && !lt.hasReasoning && lt.tokens > 0) {
    parts.push(copy.noReasoning);
  }
  lastEl.textContent = parts.length > 0 ? parts.join(' · ') : (turnActive ? copy.inProgress : copy.noData);

  paintCache(rate.cache);
  paintGauge(rate.gauge);

  if (notice) setState(notice);
  fitHeight();
};

const describeError = (error: unknown): string => {
  if (error instanceof HostRequestError) {
    if (error.code === 'NO_SERVICE' || error.code === 'SERVICE_FAILED') return copy.noService;
    if (error.code === 'DISABLED') return copy.noService;
    if (error.code === 'HOST_TIMEOUT') return copy.reconnecting;
    return `${error.code}`;
  }
  return error instanceof Error ? error.message : String(error);
};

/**
 * The same answer with everything session-scoped blanked; connection fields
 * stay. A page with no session must not read another session's live numbers,
 * and `sessionId` in the answer names the record the service actually read.
 */
const withoutSession = (rate: RateResponse): RateResponse => ({
  ...rate,
  busy: false,
  waiting: null,
  toolActive: false,
  live: { tps: 0, spanMs: 0, chars: 0, textChars: 0, reasoningChars: 0, toolChars: 0 },
  running: null,
  curve: [],
  turn: { active: false, ttftMs: null },
  lastTurn: null,
  cache: null,
});

const poll = async (): Promise<void> => {
  if (stopped || polling) return;
  // No origin is not a dead end: a relay client runs this page as a `srcDoc`,
  // where `window.location` is `about:srcdoc`. The service finds the server on
  // the machine that hosts it, so the page still asks and shows what it gets.
  polling = true;
  try {
    // Name the session so a page and a service holding different sessions
    // each read their own record instead of whichever one watched last.
    const result = await host.serviceRequest({
      method: 'GET',
      path: session?.id ? `/rate?sessionId=${encodeURIComponent(session.id)}` : '/rate',
    });
    if (result.status < 400) {
      const rate = JSON.parse(result.body) as RateResponse;
      // A page with no session must never show another session's numbers:
      // until this page's watch(null) lands, the service may still answer for
      // a session some other page watched.
      render(session === null && rate.sessionId !== null ? withoutSession(rate) : rate);
      // A service that restarted (crash, redeploy, spawned anew) remembers
      // nothing and answers with no session, so the panel would sit on stale
      // state until the frame remounted. Re-assert the watch instead: the
      // throttle holds a dead service to one call a second, and `configuring`
      // stops this from racing the opening /watch.
      if ((rate.sessionId ?? null) !== (session?.id ?? null)) {
        const now = Date.now();
        if (now - lastReassertAt >= REASSERT_MIN_MS) {
          lastReassertAt = now;
          configuredKey = '';
          await configure(session?.id ?? null);
        }
      }
    } else {
      render(null, `HTTP ${result.status}`);
    }
  } catch (error) {
    render(null, describeError(error));
  } finally {
    polling = false;
  }
};

const configure = async (sessionId: string | null): Promise<void> => {
  const key = `${origin ?? ''}|${sessionId ?? ''}`;
  if (key === configuredKey || configuring) return;
  configuring = true;
  try {
    await host.serviceRequest({
      method: 'POST',
      path: '/watch',
      body: JSON.stringify(origin ? { origin, sessionId } : { sessionId }),
    });
    configuredKey = key;
  } catch (error) {
    configuredKey = '';
    render(null, describeError(error));
  } finally {
    configuring = false;
  }
};

const mount = (): void => {
  root.append(row1, sparkEl, row2, workRow.root, macRow.root, stepCache.root, totalCache.root);
  unitEl.textContent = copy.unit;
  if (!heightReported) {
    heightReported = true;
    // Real height follows content via fitHeight() on every render.
    fitHeight();
  }
  stopped = false;
  void configure(session?.id ?? null);
  void poll();
  requestAnimationFrame(paintSpark);
  const loop = () => {
    if (stopped) return;
    window.setTimeout(async () => {
      await poll();
      loop();
    }, document.hidden ? 1000 : 250);
  };
  loop();
};

host.onReady((next) => {
  copy = next.locale.toLowerCase().startsWith('zh') ? COPY.zh : COPY.en;
  applyHostReady(next, document.documentElement);
  session = next.session ? { id: next.session.id, title: next.session.title, busy: next.session.busy } : null;
  origin = resolveOrigin();
  unitEl.textContent = copy.unit;
  if (!mounted) {
    mounted = true;
    mount();
    return;
  }
  void configure(session?.id ?? null);
});

host.onSession((next) => {
  session = next ? { id: next.id, title: next.title, busy: next.busy } : null;
  void configure(session?.id ?? null);
});
