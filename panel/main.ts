import { connectHost, HostRequestError } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import { clearSpark as clearSparkPaths, drawSpark, makeSparkSvg, nextScale, type SparkFrame } from '../shared/spark';

const SPARK_W = 248;
const SPARK_H = 36;
/** Narrowest believable fallback step for a service that predates the timestamps. */
const SPARK_WINDOW_MS = 30_000;

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

type RateResponse = {
  connection: 'idle' | 'connecting' | 'live' | 'error';
  error: string | null;
  sessionId: string | null;
  busy: boolean;
  waiting: 'permission' | 'question' | null;
  toolActive: boolean;
  live: Live;
  running: { tps: number; source: 'tokens' | 'estimate' } | null;
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
  eventsSeen: number;
};

const COPY = {
  zh: {
    title: '实时 TPS',
    unit: 'tok/s',
    idle: '空闲', generating: '生成中', toolRunning: '工具执行中',
    waitingPermission: '等授权', waitingQuestion: '等回答',
    connecting: '连接中', reconnecting: '重连中',
    noService: '需在 设置 → 扩展 里允许本地服务',
    live: '实时', lastTurn: '上轮均值', ttft: '首字延迟',
    reasoning: '推理占比', connection: '连接', events: '事件',
    measured: '实测', estimated: '估计',
    noReasoning: '本轮无推理数据（模型未上报推理）',
    stepHit: '单步命中',
    totalHit: '累计命中',
    hitMiss: '命中 / 未命中',
    output: '输出',
    steps: '步数',
    subs: '子对话',
    cost: '费用',
    noData: '打开一个对话并让模型生成后显示',
    inProgress: '本轮进行中…',
    estimateNote: '实时值按字符数启发式换算（字符/4，按模型校准）；上轮均值优先用提供商上报的真实 token。',
  },
  en: {
    title: 'Live TPS',
    unit: 'tok/s',
    idle: 'idle', generating: 'generating', toolRunning: 'running tool',
    waitingPermission: 'waiting for permission', waitingQuestion: 'waiting for answer',
    connecting: 'connecting', reconnecting: 'reconnecting',
    noService: 'Allow the local service in Settings → Extensions',
    live: 'live', lastTurn: 'last', ttft: 'TTFT',
    reasoning: 'reasoning share', connection: 'connection', events: 'events',
    measured: 'measured', estimated: 'estimated',
    noReasoning: 'No reasoning reported for this turn',
    stepHit: 'last-step hit',
    totalHit: 'total hit',
    hitMiss: 'hit / miss',
    output: 'output',
    steps: 'steps',
    subs: 'sub-sessions',
    cost: 'cost',
    noData: 'Open a chat and let the model generate',
    inProgress: 'Turn in progress…',
    estimateNote: 'Live values estimate tokens from characters (chars/4), corrected per model; last-turn averages prefer provider-reported tokens.',
  },
} as const;

type Copy = Record<keyof (typeof COPY)['zh'], string>;

const host = connectHost();
const root = document.querySelector('#root');
if (!root) throw new Error('Missing #root');

let copy: Copy = COPY.zh;
let origin: string | null = null;
let sessionId: string | null = null;
let mounted = false;
let polling = false;
let stopped = false;
let configuredKey = '';
/** Latest curve from the service, when this page received it, and its full scale. */
let sparkFrame: SparkFrame | null = null;
let sparkFrameAt = 0;
let sparkScale = 1;
let sparkPaintedAt = 0;
/**
 * Whether the curve still holds a nonzero point. A decaying tail keeps sliding
 * (it is still moving data); only a curve that is zero everywhere stops.
 */
let sparkMoving = false;
/** A curve that just emptied still needs one static draw to flatten out. */
let sparkNeedsStatic = false;
const titleEl = document.createElement('h1');
const stateLine = document.createElement('div');
const dot = document.createElement('span');
dot.className = 'dot';
const stateText = document.createElement('span');
stateLine.append(dot, stateText);
const bigEl = document.createElement('div');
bigEl.className = 'big muted';
bigEl.textContent = '—';
const unitLine = document.createElement('div');
unitLine.className = 'unit muted';
const sparkEl = document.createElement('div');
sparkEl.className = 'spark';
const sparkParts = makeSparkSvg(SPARK_W, SPARK_H);
// The drawing keeps its 248-unit coordinate system; the element spans the
// panel and stretches the curve horizontally, so its width never needs
// measuring (or a resize observer) on a page that redraws every frame.
sparkParts.svg.setAttribute('width', '100%');
sparkParts.svg.setAttribute('preserveAspectRatio', 'none');
for (const path of [sparkParts.line, sparkParts.area]) {
  path.setAttribute('vector-effect', 'non-scaling-stroke');
}
sparkEl.append(sparkParts.svg);
const list = document.createElement('dl');
const row = (label: string): HTMLElement => {
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = '—';
  list.append(dt, dd);
  return dd;
};
const lastEl = row('');
const ttftEl = row('');
const reasoningEl = row('');
/** The two hit rates sit under the curve, not inside the value list. */
type CacheLine = {
  root: HTMLElement;
  label: HTMLElement;
  bar: HTMLElement;
  fill: HTMLElement;
  pct: HTMLElement;
  delta: HTMLElement;
};
const makeCacheLine = (): CacheLine => {
  const line = document.createElement('div');
  line.className = 'cacheline';
  const label = document.createElement('span');
  label.className = 'cache-name';
  const bar = document.createElement('span');
  bar.className = 'hitbar';
  const fill = document.createElement('span');
  fill.className = 'fill';
  bar.append(fill);
  const pct = document.createElement('span');
  pct.className = 'pct';
  pct.textContent = '—';
  const delta = document.createElement('span');
  delta.className = 'delta';
  line.append(label, bar, pct, delta);
  return { root: line, label, bar, fill, pct, delta };
};
const cacheBlock = document.createElement('div');
cacheBlock.className = 'cacheblock';
const stepLine = makeCacheLine();
const totalLine = makeCacheLine();
cacheBlock.append(stepLine.root, totalLine.root);
const hitMissEl = row('');
const outputEl = row('');
const stepsEl = row('');
const costEl = row('');
const connEl = row('');
const eventsEl = row('');
const noteEl = document.createElement('div');
noteEl.className = 'note';

const resolveOrigin = (): string | null => {
  try {
    const url = new URL(window.location.href);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin;
  } catch { /* opaque sandbox origin */ }
  return null;
};

const formatTps = (tps: number): string => (!Number.isFinite(tps) ? '—' : tps >= 100 ? tps.toFixed(0) : tps.toFixed(1));
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

/**
 * Redraw between polls against a projected clock.
 *
 * The service answers every 250 ms, which is a fifth of a bucket: at one point
 * per poll the curve would jump two pixels at a time. Sliding the window edge
 * with the wall clock turns those jumps into a continuous pan, while the point
 * values stay exactly what the service measured.
 */
const paintSpark = (): void => {
  if (stopped) return;
  const frame = sparkFrame;
  const at = performance.now();
  // ~30 fps is enough for a 2 px/slide and keeps a decorative curve from
  // repainting the whole panel sixty times a second on an idle session.
  if (frame && frame.values.length > 0) {
    if (sparkMoving) {
      if (at - sparkPaintedAt >= 30) {
        sparkPaintedAt = at;
        const elapsed = Math.min(2_000, at - sparkFrameAt);
        sparkScale = nextScale(sparkScale, frame.values);
        drawSpark(sparkParts, frame, frame.at + elapsed, SPARK_W, SPARK_H, sparkScale);
      }
    } else if (sparkNeedsStatic) {
      // Drop the frozen slide's projection and draw the frame where it ended.
      sparkNeedsStatic = false;
      sparkScale = nextScale(sparkScale, frame.values);
      drawSpark(sparkParts, frame, frame.at, SPARK_W, SPARK_H, sparkScale);
    }
  }
  requestAnimationFrame(paintSpark);
};

const formatPct = (value: number | null | undefined): string => (
  typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)}%` : '—'
);

const barWidth = (value: number | null | undefined): string => (
  `${Math.max(0, Math.min(100, typeof value === 'number' && Number.isFinite(value) ? value : 0))}%`
);

const formatTokens = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
};

const paintCache = (info: CacheInfo | null | undefined): void => {
  const hasSteps = !!info && info.steps > 0;
  const hasRate = hasSteps && info !== null && info !== undefined && info.hit + info.miss > 0;
  cacheBlock.hidden = !hasRate;
  stepLine.label.textContent = copy.stepHit;
  totalLine.label.textContent = copy.totalHit;
  stepLine.pct.textContent = hasRate && info ? formatPct(info.last?.hitRate) : '—';
  totalLine.pct.textContent = hasRate && info ? formatPct(info.hitRate) : '—';
  stepLine.fill.style.width = hasRate ? barWidth(info?.last?.hitRate) : '0%';
  totalLine.fill.style.width = hasRate ? barWidth(info?.hitRate) : '0%';
  const delta = hasRate ? info?.last?.delta : null;
  if (typeof delta === 'number' && Number.isFinite(delta) && Math.abs(delta) >= 0.05) {
    stepLine.delta.textContent = `${delta >= 0 ? '↑' : '↓'}${Math.abs(delta).toFixed(1)}`;
    stepLine.delta.className = delta >= 0 ? 'delta up' : 'delta down';
  } else {
    stepLine.delta.textContent = '';
    stepLine.delta.className = 'delta';
  }
  if (!hasSteps || !info) {
    hitMissEl.textContent = '—';
    outputEl.textContent = '—';
    stepsEl.textContent = '—';
    costEl.textContent = '—';
    return;
  }
  hitMissEl.textContent = `${formatTokens(info.hit)} / ${formatTokens(info.miss)}`;
  outputEl.textContent = `${formatTokens(info.output)} tok`;
  stepsEl.textContent = info.sessions > 1
    ? `${info.steps} · ${copy.subs} ${info.sessions - 1}`
    : String(info.steps);
  costEl.textContent = info.cost > 0 ? `$${Number(info.cost.toFixed(4))}` : '—';
};

const render = (rate: RateResponse | null, notice: string | null = null): void => {
  if (!rate) {
    dot.className = 'dot';
    stateText.textContent = notice ?? copy.connecting;
    paintCache(null);
    return;
  }
  if (rate.connection === 'error') {
    dot.className = 'dot wait';
    stateText.textContent = rate.error ?? copy.reconnecting;
  } else if (rate.connection !== 'live') {
    dot.className = 'dot';
    stateText.textContent = copy.connecting;
  } else if (rate.waiting === 'permission') {
    dot.className = 'dot wait';
    stateText.textContent = copy.waitingPermission;
  } else if (rate.waiting === 'question') {
    dot.className = 'dot wait';
    stateText.textContent = copy.waitingQuestion;
  } else if (rate.toolActive) {
    dot.className = 'dot live';
    stateText.textContent = copy.toolRunning;
  } else if (rate.busy) {
    dot.className = 'dot live';
    stateText.textContent = copy.generating;
  } else {
    dot.className = 'dot';
    stateText.textContent = copy.idle;
  }

  const live = rate.live.tps;
  // Full strength only while the model is emitting text or reasoning. Tool
  // arguments also land in `live.chars`, but the headline should not look
  // live while the model itself has stopped producing.
  const streaming = rate.busy && rate.waiting === null
    && (rate.live.textChars > 0 || rate.live.reasoningChars > 0);
  // Headline is the running turn average: stable across network jitter and
  // identical to the finalized average when the turn ends.
  const shown = rate.running ? rate.running.tps : (rate.lastTurn?.tokensPerSecond ?? NaN);
  const hasValue = Number.isFinite(shown) && shown > 0;
  bigEl.textContent = hasValue ? formatTps(shown) : '—';
  // Grey whenever tokens are not arriving. The number stays the running or
  // last average, but full strength made it read as a live rate while the
  // curve was already decaying: thinking, a tool run, or a finished turn.
  bigEl.className = hasValue ? (streaming ? 'big' : 'big stale') : 'big muted';

  // The curve is owned by the service: it survives panel reloads and
  // session switches, and is a rolling rate window rather than turn history.
  // An empty curve means the answer belongs to no session, so nothing is drawn
  // rather than the previous session's shape being left on screen.
  const nextFrame = sparkFrameFrom(rate);
  const moving = nextFrame.values.some((value) => value > 0.05);
  if (nextFrame.values.length === 0) {
    sparkFrame = null;
    sparkMoving = false;
    clearSparkPaths(sparkParts);
  } else {
    sparkFrame = nextFrame;
    sparkFrameAt = performance.now();
    // A nonzero curve keeps panning even after the turn ends; a curve that is
    // zero everywhere is drawn once and then held still.
    sparkNeedsStatic = sparkMoving && !moving;
    sparkMoving = moving;
  }

  const lt = rate.lastTurn;
  lastEl.textContent = lt
    ? `${formatTps(lt.tokensPerSecond)} ${copy.unit} (${lt.source === 'tokens' ? copy.measured : copy.estimated})`
    : '—';
  const ttft = rate.turn.active ? rate.turn.ttftMs : lt?.ttftMs ?? null;
  ttftEl.textContent = ttft !== null || lt ? formatSecs(ttft) : '—';
  if (lt && lt.tokens > 0 && !lt.hasReasoning) {
    reasoningEl.textContent = copy.noReasoning;
  } else if (rate.live.chars > 0) {
    const share = rate.live.reasoningChars / Math.max(1, rate.live.chars);
    reasoningEl.textContent = `${(share * 100).toFixed(0)}%`;
  } else {
    reasoningEl.textContent = '—';
  }
  connEl.textContent = rate.connection;
  eventsEl.textContent = String(rate.eventsSeen);
  paintCache(rate.cache);
  if (notice) stateText.textContent = notice;
  if (!lt && !rate.busy) noteEl.textContent = copy.noData;
  else if (!lt) noteEl.textContent = copy.inProgress;
  else noteEl.textContent = copy.estimateNote;
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
    const result = await host.serviceRequest({ method: 'GET', path: '/rate' });
    if (result.status < 400) {
      const rate = JSON.parse(result.body) as RateResponse;
      // A page with no session must never show another session's numbers:
      // until this page's watch(null) lands, the service may still answer for
      // a session some other page watched.
      render(sessionId === null && rate.sessionId !== null ? withoutSession(rate) : rate);
    } else render(null, `HTTP ${result.status}`);
  } catch (error) {
    render(null, describeError(error));
  } finally {
    polling = false;
  }
};

const configure = async (id: string | null): Promise<void> => {
  const key = `${origin ?? ''}|${id ?? ''}`;
  if (key === configuredKey) return;
  try {
    await host.serviceRequest({
      method: 'POST',
      path: '/watch',
      body: JSON.stringify(origin ? { origin, sessionId: id } : { sessionId: id }),
    });
    configuredKey = key;
  } catch (error) {
    configuredKey = '';
    render(null, describeError(error));
  }
};

const relabel = (): void => {
  const labels = [
    copy.lastTurn, copy.ttft, copy.reasoning,
    copy.hitMiss, copy.output, copy.steps, copy.cost,
    copy.connection, copy.events,
  ];
  list.querySelectorAll('dt').forEach((dt, i) => {
    if (i < labels.length) dt.textContent = labels[i];
  });
  titleEl.textContent = copy.title;
  unitLine.textContent = copy.unit;
};

const mount = (): void => {
  relabel();
  root.append(titleEl, stateLine, bigEl, unitLine, sparkEl, cacheBlock, list, noteEl);
  stopped = false;
  void configure(sessionId);
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
  sessionId = next.session?.id ?? null;
  origin = resolveOrigin();
  relabel();
  if (!mounted) {
    mounted = true;
    mount();
    return;
  }
  void configure(sessionId);
});

host.onSession((next) => {
  sessionId = next?.id ?? null;
  void configure(sessionId);
});
