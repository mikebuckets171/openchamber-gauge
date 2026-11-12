// The receipt of a finished reply: where its time went.
//
// One speed number says how fast the words came, not why the reply took as
// long as it did. The receipt cuts the turn into slices that add up to the
// whole: the prompt being read (a local engine reports that), the model being
// waited on, the words being written, and the tools that ran.

export type TurnSplit = {
  /** The turn from its start to its end, without the time spent waiting on the user. */
  totalMs: number;
  /** A local engine reading the prompt; 0 when nothing reported it. */
  readMs: number;
  /** Everything else: the model before its first word and between steps. */
  waitMs: number;
  /** Words arriving: the same span the speed is measured over. */
  writeMs: number;
  /** Tools running. */
  toolMs: number;
};

export type SliceName = 'read' | 'wait' | 'write' | 'tool';

const whole = (value: number | null | undefined): number => (
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
);

/**
 * Cut a turn into slices that always add up to its total.
 *
 * The parts are measured by different clocks, so they can overlap by a few
 * milliseconds. Writing is the measured one and is kept; tools and reading are
 * fitted into what is left, and the wait is the remainder.
 */
export const splitTurn = (input: {
  totalMs: number;
  writeMs: number;
  toolMs: number;
  readMs?: number | null;
}): TurnSplit => {
  const writeMs = whole(input.writeMs);
  // A total the clocks lost is at least the time the words took.
  const totalMs = Math.max(whole(input.totalMs), writeMs);
  const toolMs = Math.min(whole(input.toolMs), totalMs - writeMs);
  const readMs = Math.min(whole(input.readMs), totalMs - writeMs - toolMs);
  return { totalMs, readMs, waitMs: totalMs - writeMs - toolMs - readMs, writeMs, toolMs };
};

/** The slices in the order they are drawn. */
export const SLICES: ReadonlyArray<SliceName> = ['read', 'wait', 'write', 'tool'];

export const sliceMs = (split: TurnSplit, name: SliceName): number => (
  name === 'read' ? split.readMs : name === 'wait' ? split.waitMs : name === 'write' ? split.writeMs : split.toolMs
);

/** The slice that took the longest, or null for an empty turn. */
export const biggestSlice = (split: TurnSplit): SliceName | null => {
  let best: SliceName | null = null;
  for (const name of SLICES) {
    if (sliceMs(split, name) > 0 && (best === null || sliceMs(split, name) > sliceMs(split, best))) best = name;
  }
  return best;
};

/** A persisted or wire value read back: anything that does not add up is dropped. */
export const readSplit = (value: unknown): TurnSplit | null => {
  const raw = value as Partial<TurnSplit> | null;
  if (!raw || typeof raw !== 'object') return null;
  const parts = [raw.totalMs, raw.readMs, raw.waitMs, raw.writeMs, raw.toolMs];
  if (!parts.every((part) => typeof part === 'number' && Number.isFinite(part) && part >= 0)) return null;
  const split = raw as TurnSplit;
  if (split.totalMs <= 0 || Math.abs(split.readMs + split.waitMs + split.writeMs + split.toolMs - split.totalMs) > 1) return null;
  return split;
};
