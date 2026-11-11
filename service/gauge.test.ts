// The parsers Gauge's own readings rely on. They read machine output and
// another program's files, so they are checked against the shapes those
// actually produce rather than against the service around them.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseVmStat, parseSysctl, readProgressEntries, parseJobs, sessionKey } from './gauge';

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    18002.
Pages active:                                 231987.
Pages inactive:                                226059.
Pages wired down:                             2310602.
Pages purgeable:                                 1696.
Anonymous pages:                               305854.
Pages stored in compressor:                     620654.
Pages occupied by compressor:                  297270.
`;

describe('vm_stat', () => {
  test('memory used is app memory plus wired plus compressed', () => {
    const used = parseVmStat(VM_STAT);
    expect(used).not.toBeNull();
    // (305854 - 1696 + 2310602 + 297270) pages of 16384 bytes
    expect(used).toBe((305854 - 1696 + 2310602 + 297270) * 16384);
  });

  test('a missing page size or a missing count reads as no reading', () => {
    expect(parseVmStat('Pages free: 1.')).toBeNull();
    expect(parseVmStat('Mach Virtual Memory Statistics: (page size of 16384 bytes)\n')).toBeNull();
    expect(parseVmStat('')).toBeNull();
  });

  test('a 4 KiB page size is read, not assumed away', () => {
    const text = 'Mach Virtual Memory Statistics: (page size of 4096 bytes)\n'
      + 'Pages wired down: 100.\nAnonymous pages: 50.\nPages occupied by compressor: 25.\n';
    expect(parseVmStat(text)).toBe((50 + 100 + 25) * 4096);
  });
});

describe('sysctl', () => {
  test('pressure, memory size and swap are read', () => {
    const parsed = parseSysctl([
      'vm.swapusage: total = 6144.00M  used = 5063.88M  free = 1080.12M  (encrypted)',
      'kern.memorystatus_vm_pressure_level: 2',
      'hw.memsize: 51539607552',
    ].join('\n'));
    expect(parsed.pressure).toBe('warning');
    expect(parsed.totalBytes).toBe(51539607552);
    expect(parsed.swapUsedBytes).toBe(Math.round(5063.88 * 1024 ** 2));
  });

  test('levels 1 and 4 are normal and critical, anything else is unknown', () => {
    expect(parseSysctl('kern.memorystatus_vm_pressure_level: 1').pressure).toBe('normal');
    expect(parseSysctl('kern.memorystatus_vm_pressure_level: 4').pressure).toBe('critical');
    expect(parseSysctl('kern.memorystatus_vm_pressure_level: 3').pressure).toBeNull();
    expect(parseSysctl('').pressure).toBeNull();
  });
});

describe('prompt progress files', () => {
  const write = (dir: string, name: string, body: unknown): void => {
    writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  };

  test('a valid entry is read; the counters must agree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gauge-progress-'));
    try {
      const now = Date.now();
      write(dir, 'w.json', {
        schemaVersion: 1,
        writerID: 'w',
        updatedAtMs: now,
        expiresAtMs: now + 10_000,
        entries: [{
          requestID: 'r', sessionKey: 'abc', providerID: 'splash', endpointKey: 'e', modelKey: 'm',
          kind: 'primary', total: 100, cache: 20, processed: 40, timeMs: 500, observedAtMs: now, expiresAtMs: now + 10_000,
        }],
      });
      const entries = readProgressEntries(dir, now);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ sessionKey: 'abc', total: 100, cache: 20, processed: 40, timeMs: 500 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('an expired, malformed or impossible entry is skipped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gauge-progress-'));
    try {
      const now = Date.now();
      const entry = (over: Record<string, unknown> = {}) => ({
        requestID: 'r', sessionKey: 'abc', kind: 'primary', total: 100, cache: 20, processed: 40,
        timeMs: 500, observedAtMs: now, expiresAtMs: now + 10_000, ...over,
      });
      write(dir, 'expired.json', { schemaVersion: 1, expiresAtMs: now - 1, entries: [entry()] });
      write(dir, 'impossible.json', { schemaVersion: 1, expiresAtMs: now + 10_000, entries: [entry({ cache: 90, processed: 40 })] });
      write(dir, 'beyond.json', { schemaVersion: 1, expiresAtMs: now + 10_000, entries: [entry({ processed: 101 })] });
      write(dir, 'zero.json', { schemaVersion: 1, expiresAtMs: now + 10_000, entries: [entry({ total: 0 })] });
      write(dir, 'wrongversion.json', { schemaVersion: 2, expiresAtMs: now + 10_000, entries: [entry()] });
      write(dir, 'broken.json', '{not json');
      write(dir, '.hidden.json', { schemaVersion: 1, expiresAtMs: now + 10_000, entries: [entry()] });
      expect(readProgressEntries(dir, now)).toHaveLength(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a missing directory reads as no progress, not an error', () => {
    expect(readProgressEntries(join(tmpdir(), 'gauge-progress-missing'), Date.now())).toEqual([]);
  });
});

describe('the session key', () => {
  test('it is the helper\'s key for the same session', () => {
    // The helper hashes `gauge-session-v1\0<session id>`; the service must ask
    // for the same key or a prompt is never found.
    expect(sessionKey('ses_123')).toBe(sessionKey('ses_123'));
    expect(sessionKey('ses_123')).not.toBe(sessionKey('ses_124'));
    expect(sessionKey('ses_123')).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('ComfyUI jobs', () => {
  test('running and queued jobs are read; others are ignored', () => {
    const jobs = parseJobs({
      jobs: [
        { id: 'a', status: 'in_progress', create_time: 1_700_000_000_000 },
        { id: 'b', status: 'pending' },
        { id: 'c', status: 'completed' },
        { status: 'pending' },
      ],
    });
    expect(jobs).toHaveLength(3);
    expect(jobs?.[0].create_time).toBe(1_700_000_000_000);
    expect(jobs?.[1].create_time).toBeUndefined();
  });

  test('a body that is not a job list reads as no jobs', () => {
    expect(parseJobs(null)).toBeNull();
    expect(parseJobs({})).toBeNull();
    expect(parseJobs({ jobs: 'no' })).toBeNull();
  });
});
