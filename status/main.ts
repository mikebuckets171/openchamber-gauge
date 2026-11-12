import { connectHost, HostRequestError } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import { sameModelId } from '../shared/models';
import { SLICES, biggestSlice, readSplit, sliceMs, type SliceName, type TurnSplit } from '../shared/receipt';
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
  /** Where the turn's time went; absent from an older service. */
  split?: TurnSplit;
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
  model: {
    name: string;
    quant: string | null;
    id: string;
    at: number;
  } | null;
  /**
   * The model the chat itself is on, as the page knows it.
   *
   * This is the model in play: a cloud chat is on a cloud model while the Mac
   * keeps a local one in memory, so the row names this one and keeps the
   * engine's own reading for the hover.
   */
  chatModel: {
    id: string;
    name: string;
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

type HostSession = { id: string; title: string; busy: boolean; model?: string } | null;

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
    measured: '实测',
    estimated: '估计',
    noReasoning: '无推理数据',
    inProgress: '进行中',
    lastReply: '上轮',
    mostly: '主要是',
    read: '读取提示',
    wait: '等待',
    write: '生成',
    tool: '工具',
    speed: '速度',
    firstWord: '首字',
    reading: '读取提示',
    compacting: '正在整理上下文',
    noReplyYet: '尚无回复',
    render: '渲染',
    queued: '排队',
    left: '剩余',
    model: '模型',
    cost: '本对话费用',
    cacheHit: '缓存命中',
    step: '单步',
    total: '累计',
    engineHolds: '引擎载有',
    thisModel: '当前模型',
    ago: '前',
    memory: '内存',
    swap: '交换',
    pressure: '压力',
    normal: '正常',
    warning: '警告',
    critical: '严重',
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
    measured: 'measured',
    estimated: 'estimated',
    noReasoning: 'no reasoning data',
    inProgress: 'in progress',
    lastReply: 'Last reply',
    mostly: 'mostly',
    read: 'reading',
    wait: 'waiting',
    write: 'writing',
    tool: 'tools',
    speed: 'Speed',
    firstWord: 'First word',
    reading: 'reading prompt',
    compacting: 'compacting',
    noReplyYet: 'no reply yet',
    render: 'render',
    queued: 'queued',
    left: 'left',
    model: 'Model',
    cost: 'Cost this chat',
    cacheHit: 'Cache hit',
    step: 'step',
    total: 'total',
    engineHolds: 'Engine holds',
    thisModel: 'this model',
    ago: 'ago',
    memory: 'Memory',
    swap: 'Swap',
    pressure: 'Pressure',
    normal: 'normal',
    warning: 'warning',
    critical: 'critical',
  },
} as const;

type Copy = Record<keyof (typeof COPY)['en'], string>;

const SPARK_W = 120;
const SPARK_H = 18;
/** Narrowest believable fallback window for a service that predates the timestamps. */
const SPARK_WINDOW_MS = 30_000;
/** Floor between watch re-asserts, so a service that is down costs one call a second, not one per poll. */
const REASSERT_MIN_MS = 1_000;
/** How long the headline number takes to settle on a new value. */
const GLIDE_MS = 140;
/** How long a line takes to open; the frame's height is followed for this long. */
const OPEN_MS = 180;

const host = connectHost();
const root = document.querySelector('#root');
if (!root) throw new Error('Missing #root');

let copy: Copy = COPY.en;
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

/** Motion is decoration here: a reader who asked for less gets none of it. */
const reducedMotion = (): boolean => {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

const el = (tag: string, className: string, text?: string): HTMLElement => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

// The headline: the speed, its unit, and the state on the far right. The state
// also carries the heavy job running now, so no line appears for it.
const hero = el('div', 'hero');
const dot = el('span', 'dot');
const valueEl = el('span', 'value', '—');
const unitEl = el('span', 'unit');
const captionEl = el('span', 'cap');
captionEl.hidden = true;
const stateEl = el('span', 'state');
hero.append(dot, valueEl, unitEl, captionEl, stateEl);

const sparkEl = el('div', 'sparkrow');
const sparkParts = makeSparkSvg(SPARK_W, SPARK_H);
// The drawing keeps its coordinate system and the element spans the section,
// so the curve reaches both edges.
sparkParts.svg.setAttribute('width', '100%');
sparkParts.svg.setAttribute('preserveAspectRatio', 'none');
for (const path of [sparkParts.line, sparkParts.area]) {
  path.setAttribute('vector-effect', 'non-scaling-stroke');
}
sparkEl.append(sparkParts.svg);

// What a notice too long for the headline says, in the curve's spot: the whole
// sentence, wrapped, instead of an ellipsis next to the number.
const noticeEl = el('div', 'notice');
noticeEl.hidden = true;

// The divider under the curve doubles as the progress bar of the job in the
// headline: it fills while a prompt is read or a render runs.
const rule = el('div', 'rule');
const ruleFill = el('i', 'fill');
rule.append(ruleFill);

/**
 * One line: a label and the one value worth a glance. A tap opens what is
 * behind it; one line is open at a time, so the section stays short.
 */
type Line = {
  key: string;
  root: HTMLElement;
  button: HTMLElement;
  label: HTMLElement;
  value: HTMLElement;
  detail: HTMLElement;
};

/** A detail entry: a label and its value, side by side. */
type Item = { root: HTMLElement; label: HTMLElement; value: HTMLElement };

const makeItem = (): Item => {
  const itemRoot = el('div', 'item');
  const label = el('span', 'k');
  const value = el('span', 'v', '—');
  itemRoot.append(label, value);
  return { root: itemRoot, label, value };
};

type Meter = { root: HTMLElement; fill: HTMLElement };

const makeMeters = (count: number): { root: HTMLElement; meters: Meter[] } => {
  const track = el('div', 'meters');
  const meters: Meter[] = [];
  for (let i = 0; i < count; i += 1) {
    const bar = el('span', 'meter');
    const fill = el('i', 'fill');
    bar.append(fill);
    track.append(bar);
    meters.push({ root: bar, fill });
  }
  return { root: track, meters };
};

let openKey: string | null = null;
const lines: Line[] = [];
/** Until when the frame's height follows a line that is still sliding. */
let fitUntil = 0;

const applyOpen = (): void => {
  for (const line of lines) {
    const open = line.key === openKey;
    line.root.className = `${line.root.className.split(/\s+/).filter((name) => name && name !== 'open').join(' ')}${open ? ' open' : ''}`;
    line.button.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
};

const makeLine = (key: string): Line => {
  const lineRoot = el('div', 'row');
  const button = el('button', 'line');
  button.setAttribute('type', 'button');
  button.setAttribute('aria-expanded', 'false');
  const label = el('span', 'k');
  const value = el('span', 'v', '—');
  const chevron = el('span', 'chev', '›');
  chevron.setAttribute('aria-hidden', 'true');
  button.append(label, value, chevron);
  const shell = el('div', 'det');
  const detail = el('div', 'in');
  shell.append(detail);
  lineRoot.append(button, shell);
  const line: Line = { key, root: lineRoot, button, label, value, detail };
  button.addEventListener('click', () => {
    openKey = openKey === key ? null : key;
    applyOpen();
    fitUntil = performance.now() + OPEN_MS + 120;
    fitHeight();
  });
  lines.push(line);
  return line;
};

/** Keep the line's own state class (`warning`, `critical`) beside `row` and `open`. */
const setLineTone = (line: Line, tone: string): void => {
  line.root.className = `row${tone ? ` ${tone}` : ''}${line.key === openKey ? ' open' : ''}`;
};

const rows = el('div', 'rows');

// Last reply: how long it took and what most of that was. Behind it, the
// receipt: the turn cut into slices, its speed and its first word.
const lineReply = makeLine('reply');
const segs = el('div', 'segs');
const segFills = new Map<SliceName, HTMLElement>();
for (const name of SLICES) {
  const fill = el('i', `seg ${name}`);
  segFills.set(name, fill);
  segs.append(fill);
}
const receiptCaption = el('div', 'sub', '—');
const itemSpeed = makeItem();
const itemFirst = makeItem();
lineReply.detail.append(segs, receiptCaption, itemSpeed.root, itemFirst.root);

// Model: the model in play and what the chat has cost. Behind it, the cost on
// its own, the cache hit rates, the local engine's reading and the full name.
const lineModel = makeLine('model');
// The model value is built from parts so an over-long name is what gives way:
// the quantization and the cost at its end stay readable.
const modelParts = [el('span', 'part'), el('span', 'part keep'), el('span', 'part keep')];
const modelJoiners = [el('span', 'join', ' · '), el('span', 'join', ' · ')];
// The parts are the whole value: the dash makeLine put there is cleared so a
// stale one cannot sit in front of them.
lineModel.value.textContent = '';
lineModel.value.className = 'v pieces';
lineModel.value.append(modelParts[0], modelJoiners[0], modelParts[1], modelJoiners[1], modelParts[2]);
const itemCost = makeItem();
const itemCache = makeItem();
const cacheMeters = makeMeters(2);
const itemEngine = makeItem();
itemEngine.root.className = 'item wrap';
const modelId = el('div', 'sub id');
lineModel.detail.append(itemCost.root, itemCache.root, cacheMeters.root, itemEngine.root, modelId);

// Memory: what the Mac is using. Behind it, the meter, the swap and the
// kernel's own pressure level.
const lineMemory = makeLine('memory');
const memoryMeters = makeMeters(1);
const itemSwap = makeItem();
const itemPressure = makeItem();
lineMemory.detail.append(memoryMeters.root, itemSwap.root, itemPressure.root);

rows.append(lineReply.root, lineModel.root, lineMemory.root);

let lastHeight = 0;

const formatTps = (tps: number): string => {
  if (!Number.isFinite(tps)) return '—';
  return tps >= 100 ? tps.toFixed(0) : tps.toFixed(1);
};

/** A turn of several minutes reads as minutes, not as two or three hundred seconds. */
const formatSecs = (ms: number | null): string => {
  if (ms === null || !Number.isFinite(ms)) return '—';
  const s = ms / 1000;
  if (s < 60) return s >= 10 ? `${s.toFixed(0)}s` : `${s.toFixed(1)}s`;
  const whole = Math.round(s);
  const mins = Math.floor(whole / 60);
  const secs = whole % 60;
  return secs === 0 ? `${mins}m` : `${mins}m ${secs}s`;
};

const formatGb = (bytes: number | null | undefined): string => {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—';
  return `${(bytes / 1024 ** 3).toFixed(1)}`;
};

const barWidth = (value: number | null | undefined): string => (
  `${Math.max(0, Math.min(100, typeof value === 'number' && Number.isFinite(value) ? value : 0))}%`
);

const formatPct = (value: number | null | undefined): string => (
  typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)}%` : '—'
);

/** What the provider charged, or a dash when it reported nothing. */
const formatCost = (cost: number | null | undefined): string => {
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost <= 0) return '—';
  return cost < 0.01 ? '<$0.01' : `$${cost.toFixed(2)}`;
};

/**
 * The origin the page was served from, or null when it has none: a relay
 * client mounts a guest as a `srcDoc`, whose location is `about:srcdoc` with
 * no http(s) origin to report. The service then finds the server on this
 * machine instead of dialing the client's address.
 */
const resolveOrigin = (): string | null => {
  try {
    const url = new URL(window.location.href);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin;
  } catch {
    // about:srcdoc, an opaque sandbox origin, or no window: nothing usable.
  }
  return null;
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
 * The headline number glides to a new value instead of snapping to it. The
 * first value, and every value for a reader who asked for less motion, is
 * written at once.
 */
let heroShown: number | null = null;
let heroTarget: number | null = null;
let heroAt = 0;

const setHero = (target: number | null): void => {
  if (target === null) {
    heroShown = null;
    heroTarget = null;
    valueEl.textContent = '—';
    // A dash is not a rate, so it does not wear the unit.
    unitEl.hidden = true;
    return;
  }
  unitEl.hidden = false;
  heroTarget = target;
  if (heroShown === null || reducedMotion()) {
    heroShown = target;
    valueEl.textContent = formatTps(target);
  }
};

const glideHero = (at: number): void => {
  const dt = Math.min(250, at - heroAt);
  heroAt = at;
  if (heroShown === null || heroTarget === null || heroShown === heroTarget) return;
  heroShown += (heroTarget - heroShown) * (1 - Math.exp(-dt / GLIDE_MS));
  if (Math.abs(heroTarget - heroShown) < 0.05) heroShown = heroTarget;
  valueEl.textContent = formatTps(heroShown);
};

/**
 * One frame: the curve slides between polls against a projected clock, so it
 * pans instead of stepping four times a second; the headline number glides;
 * and the frame's height follows a line that is sliding open.
 */
const paintSpark = (): void => {
  if (stopped) return;
  const frame = sparkFrame;
  const at = performance.now();
  glideHero(at);
  if (at < fitUntil) fitHeight();
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
  const h = Math.min(480, Math.max(24, Math.ceil(root.scrollHeight) + 2));
  if (h !== lastHeight) {
    lastHeight = h;
    void host.setHeight(h).catch(() => undefined);
  }
};

const setState = (text: string): void => {
  // An empty state must not leave a gap behind in the headline.
  stateEl.textContent = text;
  stateEl.hidden = text.length === 0;
};

/** `Last reply` beside a grey headline number, so a kept value never reads as live. */
const setCaption = (text: string): void => {
  captionEl.textContent = text;
  captionEl.hidden = text.length === 0;
};

/**
 * A notice too long for the headline is read in full in the curve's spot,
 * which has nothing to draw while the notice stands.
 */
const showNotice = (text: string): void => {
  noticeEl.textContent = text;
  noticeEl.hidden = text.length === 0;
  sparkEl.className = text.length > 0 ? 'sparkrow tight' : 'sparkrow';
};

/** A notice this long or shorter is a label; a longer one is a sentence. */
const NOTICE_MAX = 28;

/**
 * Whether the headline's state slot can hold this text whole.
 *
 * The slot is narrow and the room it has depends on the number and the
 * caption beside it, so the fit is measured rather than counted: a wording
 * that does not fit is read in full in the curve's spot instead of being cut
 * off with an ellipsis.
 */
const fitsState = (text: string): boolean => {
  // Put the text in the slot and ask the browser how much room it wants.
  setState(text);
  const slot = stateEl.clientWidth;
  // A DOM with no layout (a test harness) has no widths to compare, so there
  // the caller decides.
  if (!Number.isFinite(slot) || slot <= 0) return true;
  return stateEl.scrollWidth <= slot + 1;
};

/**
 * Where a state belongs: beside the number when the slot holds it whole, in
 * the curve's spot when it does not.
 */
const placeState = (text: string): void => {
  if (fitsState(text)) {
    showNotice('');
  } else {
    setState('');
    showNotice(text);
  }
};

/**
 * Where a notice belongs. A short one is a label and fits beside the number;
 * a longer one is a sentence, and is read in full in the curve's spot, which
 * is also what clears the state the headline no longer carries.
 */
const placeNotice = (text: string): void => {
  if (text.length <= NOTICE_MAX && fitsState(text)) {
    showNotice('');
  } else {
    setState('');
    showNotice(text);
  }
};

/**
 * The heavy job running now, as the headline says it and as the divider fills:
 * the prompt a local chat is reading, or a ComfyUI render.
 */
type Job = { kind: 'prompt' | 'render'; text: string; percent: number | null };

const jobFrom = (gauge: GaugeWire | null | undefined): Job | null => {
  const prompt = gauge?.prompt ?? null;
  if (prompt && prompt.total > 0) {
    const percent = (prompt.processed / prompt.total) * 100;
    // Time left from the rate Splash itself reported: processed tokens over the
    // prefill time so far. No rate, no estimate.
    const perMs = prompt.timeMs > 0 ? prompt.processed / prompt.timeMs : 0;
    const leftMs = perMs > 0 ? (prompt.total - prompt.processed) / perMs : null;
    // Compaction is the one reading the user can name: the chat is rewriting
    // its own history, not merely starting to answer.
    const label = prompt.kind === 'compaction' ? copy.compacting : copy.reading;
    const parts = [`${label} ${percent.toFixed(0)}%`];
    if (leftMs !== null) parts.push(`${formatSecs(leftMs)} ${copy.left}`);
    return { kind: 'prompt', text: parts.join(' · '), percent };
  }
  const job = gauge?.render ?? null;
  if (job) {
    const step = job.step;
    const parts: string[] = [step ? `${copy.render} ${step.value} / ${step.max}` : copy.render];
    if (job.state === 'queued') parts.push(`${job.queued} ${copy.queued}`);
    else if (job.startedAt) parts.push(formatSecs(Date.now() - job.startedAt));
    // Jobs waiting behind the running one: how much is still to come.
    if (job.state !== 'queued' && job.queued > 0) parts.push(`${job.queued} ${copy.queued}`);
    return { kind: 'render', text: parts.join(' · '), percent: step && step.max > 0 ? (step.value / step.max) * 100 : null };
  }
  return null;
};

/** Whether the previous answer was for a running turn of this session: a reply that ends then fills its bar in once. */
let replyWasActive = false;
let replySession: string | null = null;
let replyEndedAt: number | null = null;

/** The reply line: the finished turn, its receipt, its speed and its first word. */
const paintReply = (rate: RateResponse | null): void => {
  lineReply.label.textContent = copy.lastReply;
  itemSpeed.label.textContent = copy.speed;
  itemFirst.label.textContent = copy.firstWord;
  const lt = rate?.lastTurn ?? null;
  const turnActive = !!rate && (rate.busy || rate.toolActive);
  const split = readSplit(lt?.split);

  if (lt && split) {
    const top = biggestSlice(split);
    lineReply.value.textContent = top
      ? `${formatSecs(split.totalMs)} · ${copy.mostly} ${copy[top]}`
      : formatSecs(split.totalMs);
    receiptCaption.textContent = SLICES
      .filter((name) => sliceMs(split, name) >= 50)
      .map((name) => `${formatSecs(sliceMs(split, name))} ${copy[name]}`)
      .join(' · ') || '—';
  } else if (lt) {
    // A turn an older service recorded: its speed is all there is.
    lineReply.value.textContent = `${formatTps(lt.tokensPerSecond)} ${copy.unit}`;
    receiptCaption.textContent = '—';
  } else {
    lineReply.value.textContent = turnActive ? copy.inProgress : '—';
    receiptCaption.textContent = '—';
  }

  const widths = SLICES.map((name) => barWidth(split ? (sliceMs(split, name) / split.totalMs) * 100 : 0));
  const sessionId = rate?.sessionId ?? null;
  const ended = lt?.endedAt ?? null;
  // A reply that just ended, watched as it ran, fills its bar in once. Anything
  // else — the first answer, another session, a reload — is drawn as it is.
  const fresh = split !== null && ended !== null && ended !== replyEndedAt
    && replyWasActive && sessionId === replySession && !reducedMotion();
  if (fresh) {
    SLICES.forEach((name) => { segFills.get(name)!.style.width = '0%'; });
    requestAnimationFrame(() => requestAnimationFrame(() => {
      SLICES.forEach((name, i) => { segFills.get(name)!.style.width = widths[i]; });
    }));
  } else if (ended !== replyEndedAt || sessionId !== replySession || !split) {
    SLICES.forEach((name, i) => { segFills.get(name)!.style.width = widths[i]; });
  }
  replyEndedAt = ended;
  replySession = sessionId;
  replyWasActive = turnActive;

  itemSpeed.value.textContent = lt
    ? `${formatTps(lt.tokensPerSecond)} ${copy.unit} · ${lt.source === 'tokens' ? copy.measured : copy.estimated}`
      + (!lt.hasReasoning && lt.tokens > 0 ? ` · ${copy.noReasoning}` : '')
    : '—';
  const ttft = rate?.turn.active ? rate.turn.ttftMs : lt?.ttftMs ?? null;
  itemFirst.value.textContent = ttft !== null ? formatSecs(ttft) : '—';
};

/**
 * The model line: the model in play and what the chat has cost.
 *
 * The line never names a model the chat is not using. When the local engine
 * holds the very model the chat is on, its quantization is part of the name;
 * when it holds another one, that reading waits behind the line.
 */
const paintModel = (gauge: GaugeWire | null | undefined, info: CacheInfo | null | undefined): void => {
  const chat = gauge?.chatModel ?? null;
  const loaded = gauge?.model ?? null;
  lineModel.label.textContent = copy.model;
  itemCost.label.textContent = copy.cost;
  itemCache.label.textContent = copy.cacheHit;
  itemEngine.label.textContent = copy.engineHolds;

  const cost = formatCost(info?.cost);
  itemCost.value.textContent = cost;

  // The cache: the last settled step's hit rate and the conversation's.
  const cached = !!info && info.steps > 0 && info.hit + info.miss > 0;
  if (cached && info) {
    const last = info.last;
    const delta = last?.delta;
    const moved = typeof delta === 'number' && Number.isFinite(delta) && Math.abs(delta) >= 0.05;
    const arrow = moved ? `${delta >= 0 ? '↑' : '↓'}${Math.abs(delta).toFixed(1)}` : '';
    itemCache.value.textContent = `${formatPct(last?.hitRate)}${arrow} ${copy.step} · ${formatPct(info.hitRate)} ${copy.total}`;
    cacheMeters.meters[0].fill.style.width = barWidth(last?.hitRate);
    cacheMeters.meters[1].fill.style.width = barWidth(info.hitRate);
  } else {
    itemCache.value.textContent = '—';
    cacheMeters.meters[0].fill.style.width = '0%';
    cacheMeters.meters[1].fill.style.width = '0%';
  }

  // How old the engine's reading is; said only once it has grown old.
  const age = loaded ? Date.now() - loaded.at : 0;
  const ageText = age > 10_000 ? `${Math.round(age / 1000)}s ${copy.ago}` : '';
  const engineValue = loaded
    ? [loaded.name, loaded.quant, ageText].filter(Boolean).join(' · ')
    : '—';
  // The engine holds the chat's model when the two identifiers name one model;
  // then the name is already on the line and is not said twice.
  const same = !!(chat && loaded && sameModelId(chat.id, loaded.id));
  itemEngine.value.textContent = same
    ? [copy.thisModel, loaded!.quant, ageText].filter(Boolean).join(' · ')
    : engineValue;

  const writeParts = (parts: string[]): void => {
    // A joiner is said only between two parts it has: one whose following
    // part is not drawn takes its ` · ` with it.
    modelJoiners.forEach((joiner, i) => {
      joiner.textContent = parts[i + 1] === undefined ? '' : ' · ';
    });
    modelParts.forEach((node, i) => {
      node.textContent = parts[i] ?? '';
      node.hidden = parts[i] === undefined;
    });
  };

  if (!chat && !loaded) {
    writeParts([cost]);
    modelId.textContent = '';
    modelId.hidden = true;
    lineModel.root.removeAttribute('title');
    return;
  }
  // The name first: on a narrow panel the ellipsis lands on the name, and the
  // quantization or the cost that follows stays whole.
  const parts: string[] = [chat ? chat.name : loaded!.name];
  if ((same || !chat) && loaded!.quant) parts.push(loaded!.quant);
  if (cost !== '—') parts.push(cost);
  writeParts(parts);
  // The full identifier is behind the line for a tap, and on the hover for a mouse.
  const id = chat ? chat.id : loaded!.id;
  modelId.textContent = id;
  modelId.hidden = false;
  const title = chat
    ? [chat.id, loaded ? `${copy.engineHolds} ${engineValue}` : ''].filter(Boolean).join(' · ')
    : loaded!.id;
  lineModel.root.setAttribute('title', title);
};

/** The memory line: what the Mac is using, and the kernel's own pressure level. */
const paintMemory = (gauge: GaugeWire | null | undefined): void => {
  const mac = gauge?.mac ?? null;
  lineMemory.label.textContent = copy.memory;
  itemSwap.label.textContent = copy.swap;
  itemPressure.label.textContent = copy.pressure;
  if (mac && mac.usedBytes !== null && mac.totalBytes) {
    lineMemory.value.textContent = `${formatGb(mac.usedBytes)} / ${formatGb(mac.totalBytes)} GB`;
    memoryMeters.meters[0].fill.style.width = barWidth((mac.usedBytes / mac.totalBytes) * 100);
    itemSwap.value.textContent = mac.swapUsedBytes !== null ? `${formatGb(mac.swapUsedBytes)} GB` : '—';
    itemPressure.value.textContent = mac.pressure ? copy[mac.pressure] : '—';
    // Amber and red are the kernel's words, so they show on the closed line too.
    setLineTone(lineMemory, mac.pressure && mac.pressure !== 'normal' ? mac.pressure : '');
    return;
  }
  lineMemory.value.textContent = '—';
  memoryMeters.meters[0].fill.style.width = '0%';
  itemSwap.value.textContent = '—';
  itemPressure.value.textContent = '—';
  setLineTone(lineMemory, '');
};

const render = (rate: RateResponse | null, notice: string | null = null): void => {
  if (!rate) {
    dot.className = 'dot idle';
    setHero(null);
    setCaption('');
    valueEl.className = 'value';
    // A refused or failing service is the common long notice: it goes where a
    // whole sentence fits, not beside the number.
    if (notice) {
      placeNotice(notice);
    } else {
      placeNotice(copy.connecting);
    }
    ruleFill.style.width = '0%';
    paintReply(null);
    paintModel(null, null);
    paintMemory(null);
    dropSpark();
    sparkMoving = false;
    sparkNeedsStatic = false;
    // Nothing is being measured, so the band has nothing to hold open.
    sparkEl.className = 'sparkrow tight';
    fitHeight();
    return;
  }
  const job = jobFrom(rate.gauge);

  // The headline's number, its unit and its caption come first: they decide
  // how much room the state has beside them, and the state is placed after
  // them so that fit is judged on the room there really is.
  const live = rate.live.tps;
  const streaming = rate.busy && rate.waiting === null && live > 0.05;
  // Headline is the running turn average: stable across network jitter and
  // identical to the finalized average when the turn ends.
  const shown = rate.running ? rate.running.tps : (rate.lastTurn?.tokensPerSecond ?? NaN);
  const hasValue = Number.isFinite(shown) && shown > 0;
  setHero(hasValue ? shown : null);
  // Grey whenever tokens are not arriving, so the number does not read as a
  // live rate next to a curve that has already decayed towards zero — and
  // named, so a kept value is plainly the last reply's.
  valueEl.className = hasValue && !streaming ? 'value stale' : 'value';
  // The caption names a kept number: the last reply's own rate. A turn that is
  // still running shows its own average, which is not the last reply's, so it
  // is not named as one.
  const kept = hasValue && !streaming && !rate.running && !!rate.lastTurn;
  setCaption(kept ? copy.lastReply : '');

  if (rate.connection === 'error') {
    dot.className = 'dot wait';
    // A network failure is a wrong address, not a bad response: name the
    // condition rather than leak the runtime's `fetch failed`.
    if (rate.errorKind === 'network') {
      placeNotice(copy.unreachable);
    } else if ((rate.error ?? '').length > NOTICE_MAX) {
      // The runtime's own words are rarely short: keep the headline quiet and
      // read the detail where there is room for it.
      setState(copy.reconnecting);
      showNotice(rate.error ?? '');
    } else {
      placeNotice(rate.error ?? copy.reconnecting);
    }
  } else if (rate.connection !== 'live') {
    dot.className = 'dot idle';
    placeState(copy.connecting);
  } else if (rate.waiting === 'permission') {
    dot.className = 'dot wait';
    placeState(copy.waitingPermission);
  } else if (rate.waiting === 'question') {
    dot.className = 'dot wait';
    placeState(copy.waitingQuestion);
  } else if (job?.kind === 'prompt') {
    // The chat is waiting on this, so it outranks everything but a question.
    dot.className = 'dot live';
    placeState(job.text);
  } else if (rate.toolActive) {
    dot.className = 'dot live';
    placeState(copy.toolRunning);
  } else {
    // "generating" and "idle" say nothing the dot and the headline do not
    // already say. A render is the Mac's job, not the chat's, so it is said
    // only when the chat has nothing of its own to say. A watched chat with
    // nothing to report says so once, instead of a row of dashes.
    dot.className = rate.busy ? 'dot live' : 'dot idle';
    const empty = !rate.busy && !rate.toolActive && !job && !rate.lastTurn && rate.sessionId !== null;
    placeState(job ? job.text : (empty ? copy.noReplyYet : ''));
  }
  // A caller-supplied notice is the loudest thing on screen: it replaces the
  // state it displaced, in the headline when it fits and in the curve's spot
  // when it does not.
  if (notice) placeNotice(notice);
  ruleFill.style.width = barWidth(job?.percent);

  // The curve is owned by the service: it survives iframe remounts and
  // session switches, and is a rolling rate window rather than turn history.
  // Its length is fixed at 24 buckets, quiet ones included, so "nothing to
  // draw" is a window with no point above the floor, not an empty list: an
  // empty list is what a page with no session of its own gets. A band with
  // nothing in it closes up, so an idle section is shorter; a decaying tail
  // keeps it open until its last live bucket leaves the window.
  const nextFrame = sparkFrameFrom(rate);
  const moving = nextFrame.values.some((value) => value > 0.05);
  if (nextFrame.values.length === 0) {
    dropSpark();
    sparkMoving = false;
    sparkNeedsStatic = false;
  } else {
    sparkFrame = nextFrame;
    sparkFrameAt = performance.now();
    // A nonzero curve keeps panning at any time; all zeros flatten once and
    // then hold, so a quiet session shows no motion at all.
    sparkNeedsStatic = sparkMoving && !moving;
    sparkMoving = moving;
  }
  // A notice read in the curve's spot and the band cannot both have the space.
  sparkEl.className = moving && noticeEl.hidden ? 'sparkrow' : 'sparkrow tight';

  paintReply(rate);
  paintModel(rate.gauge, rate.cache);
  paintMemory(rate.gauge);
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
 * stay. A page with no session must not show another session's live numbers,
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
  gauge: undefined,
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
  // The model the chat is on rides with the watch: the service needs it to
  // say which model is in play, which is not the model the local engine holds.
  const model = session?.model ?? null;
  const key = `${origin ?? ''}|${sessionId ?? ''}|${model ?? ''}`;
  if (key === configuredKey || configuring) return;
  configuring = true;
  try {
    await host.serviceRequest({
      method: 'POST',
      path: '/watch',
      body: JSON.stringify({ ...(origin ? { origin } : {}), sessionId, model }),
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
  root.append(hero, sparkEl, noticeEl, rule, rows);
  unitEl.textContent = copy.unit;
  // Nothing has been polled yet, so the band starts closed and opens with the
  // first curve, instead of a blank gap filling the section's first frame.
  sparkEl.className = 'sparkrow tight';
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
  // The markup says English; the host knows what the reader actually reads.
  document.documentElement.lang = copy === COPY.zh ? 'zh' : 'en';
  session = next.session ? { id: next.session.id, title: next.session.title, busy: next.session.busy, model: next.session.model } : null;
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
  session = next ? { id: next.id, title: next.title, busy: next.busy, model: next.model } : null;
  void configure(session?.id ?? null);
});
