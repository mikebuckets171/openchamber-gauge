// The receipt's arithmetic: slices measured by different clocks must still add
// up to the turn, whatever the clocks disagree about.
import { describe, expect, test } from 'bun:test';
import { biggestSlice, readSplit, splitTurn } from '../shared/receipt';
import { noteRead, takeReadMs, sessionKey } from './gauge';

const sum = (s: ReturnType<typeof splitTurn>): number => s.readMs + s.waitMs + s.writeMs + s.toolMs;

describe('splitTurn', () => {
  test('a cloud reply has no reading slice and the wait is the remainder', () => {
    const split = splitTurn({ totalMs: 48_000, writeMs: 33_000, toolMs: 9_000 });
    expect(split).toEqual({ totalMs: 48_000, readMs: 0, waitMs: 6_000, writeMs: 33_000, toolMs: 9_000 });
    expect(biggestSlice(split)).toBe('write');
  });

  test('a local reply carves the reading out of the wait', () => {
    const split = splitTurn({ totalMs: 48_000, writeMs: 24_000, toolMs: 9_000, readMs: 9_000 });
    expect(split.readMs).toBe(9_000);
    expect(split.waitMs).toBe(6_000);
    expect(sum(split)).toBe(split.totalMs);
  });

  test('overlapping clocks never make the slices exceed the turn', () => {
    const split = splitTurn({ totalMs: 10_000, writeMs: 8_000, toolMs: 5_000, readMs: 4_000 });
    expect(split).toEqual({ totalMs: 10_000, readMs: 0, waitMs: 0, writeMs: 8_000, toolMs: 2_000 });
  });

  test('a lost total is at least the time the words took', () => {
    const split = splitTurn({ totalMs: 0, writeMs: 3_000, toolMs: 0 });
    expect(split.totalMs).toBe(3_000);
    expect(sum(split)).toBe(3_000);
  });

  test('junk in is zero out', () => {
    const split = splitTurn({ totalMs: Number.NaN, writeMs: -5, toolMs: Number.POSITIVE_INFINITY, readMs: null });
    expect(split).toEqual({ totalMs: 0, readMs: 0, waitMs: 0, writeMs: 0, toolMs: 0 });
    expect(biggestSlice(split)).toBeNull();
  });
});

describe('readSplit', () => {
  test('a split that adds up is kept, anything else is dropped', () => {
    const good = splitTurn({ totalMs: 5_000, writeMs: 2_000, toolMs: 1_000 });
    expect(readSplit(good)).toEqual(good);
    expect(readSplit({ ...good, waitMs: 9_000 })).toBeNull();
    expect(readSplit({ totalMs: 5_000 })).toBeNull();
    expect(readSplit(null)).toBeNull();
    expect(readSplit(undefined)).toBeNull();
  });
});

describe('prompt reading time per turn', () => {
  const key = sessionKey('ses_receipt');
  const at = Date.now();
  const entry = (processed: number, timeMs: number, observedAt: number, total = 1000) => ({
    sessionKey: key, kind: 'primary' as const, total, cache: 0, processed, timeMs, observedAt,
  });

  test('one prompt counts its latest time once, and a taken reading is not counted again', () => {
    takeReadMs(['ses_receipt']);
    noteRead(entry(200, 1_000, at));
    noteRead(entry(600, 3_000, at + 400));
    noteRead(entry(600, 3_000, at + 400));
    expect(takeReadMs(['ses_receipt'])).toBe(3_000);
    // The same file entry is still on disk after the turn ended.
    noteRead(entry(600, 3_000, at + 400));
    expect(takeReadMs(['ses_receipt'])).toBe(0);
  });

  test('two prompts in one turn add up', () => {
    takeReadMs(['ses_receipt']);
    // Fewer tokens processed than the last reading: a new prompt.
    noteRead(entry(300, 4_000, at + 1_000));
    noteRead(entry(100, 500, at + 2_000, 2000));
    noteRead(entry(2000, 2_500, at + 3_000, 2000));
    expect(takeReadMs(['ses_receipt'])).toBe(6_500);
  });

  test('another session\'s reading is left alone', () => {
    noteRead(entry(500, 2_000, at + 4_000));
    expect(takeReadMs(['ses_other'])).toBe(0);
    expect(takeReadMs(['ses_receipt'])).toBeGreaterThan(0);
  });
});
