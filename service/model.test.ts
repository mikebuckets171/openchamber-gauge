// The rules for reading the model a local engine has loaded: which runtime
// record counts, what a status body has to say, and which of several servers
// is the one to report.
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverSplash, parseServeRecord, parseSplashStatus, pickSplash, splitModelName } from './gauge';

describe('the runtime record', () => {
  test('names the port and the process that serves it', () => {
    expect(parseServeRecord('serve-18301.json', { phase: 'ready', pid: 12608 })).toEqual({ port: 18301, pid: 12608 });
  });

  test('a record that is not ready, or is not a record, is ignored', () => {
    expect(parseServeRecord('serve-18301.json', { phase: 'starting', pid: 12608 })).toBeNull();
    expect(parseServeRecord('serve-18301.json', { phase: 'stopped', pid: 12608 })).toBeNull();
    expect(parseServeRecord('serve-18301.json', { pid: 12608 })).toBeNull();
    expect(parseServeRecord('other-18301.json', { phase: 'ready', pid: 12608 })).toBeNull();
    expect(parseServeRecord('serve-18301.json.bak', { phase: 'ready', pid: 12608 })).toBeNull();
  });

  test('a record without a usable process is ignored', () => {
    expect(parseServeRecord('serve-18301.json', { phase: 'ready', pid: 0 })).toBeNull();
    expect(parseServeRecord('serve-18301.json', { phase: 'ready', pid: -1 })).toBeNull();
    expect(parseServeRecord('serve-18301.json', { phase: 'ready', pid: '12608' })).toBeNull();
    expect(parseServeRecord('serve-18301.json', { phase: 'ready', pid: 12.5 })).toBeNull();
    expect(parseServeRecord('serve-99999.json', { phase: 'ready', pid: 12608 })).toBeNull();
  });
});

describe('the status body', () => {
  const ready = {
    ready: true,
    transport: { ready: true, recovering: false, stopped: false, status_stale: false },
    weights: { released: false },
    instance: { pid: 12608, port: 18301, model: 'ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF:IQ3_XXS', started_at: 1794428518.004 },
    active_requests: [],
  };

  test('reports the model the engine has loaded', () => {
    const parsed = parseSplashStatus(ready);
    expect(parsed).not.toBeNull();
    expect(parsed?.model).toBe('ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF:IQ3_XXS');
    expect(parsed?.pid).toBe(12608);
    expect(parsed?.port).toBe(18301);
    expect(parsed?.startedAt).toBe(1794428518004);
    expect(parsed?.serving).toBe(false);
  });

  test('a server that is generating says so', () => {
    const parsed = parseSplashStatus({ ...ready, active_requests: [{ id: 1, phase: 'decode' }] });
    expect(parsed?.serving).toBe(true);
  });

  test('a server with no model loaded reports nothing', () => {
    expect(parseSplashStatus({ ...ready, ready: false })).toBeNull();
    expect(parseSplashStatus({ ...ready, transport: { ...ready.transport, stopped: true } })).toBeNull();
    expect(parseSplashStatus({ ...ready, transport: { ...ready.transport, recovering: true } })).toBeNull();
    expect(parseSplashStatus({ ...ready, transport: { ...ready.transport, status_stale: true } })).toBeNull();
    expect(parseSplashStatus({ ...ready, weights: { released: true } })).toBeNull();
    expect(parseSplashStatus({ ...ready, instance: { ...ready.instance, model: '' } })).toBeNull();
    expect(parseSplashStatus({ ...ready, instance: { ...ready.instance, model: 42 } })).toBeNull();
    expect(parseSplashStatus({ ...ready, instance: { port: 18301, model: 'x' } })).toBeNull();
    expect(parseSplashStatus(null)).toBeNull();
    expect(parseSplashStatus({})).toBeNull();
  });
});

describe('the name to show', () => {
  test('drops the organization and the file format, and keeps the quantization', () => {
    expect(splitModelName('ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF:IQ3_XXS'))
      .toEqual({ name: 'Qwen3.8-Flash-Next-GSQ-RCO', quant: 'IQ3_XXS' });
  });

  test('a name without an organization or a quantization still reads', () => {
    expect(splitModelName('Qwen3-30B-A3B')).toEqual({ name: 'Qwen3-30B-A3B', quant: null });
    expect(splitModelName('unsloth/Qwen3-30B-A3B-GGUF')).toEqual({ name: 'Qwen3-30B-A3B', quant: null });
  });

  test('a quantization that is not a plain name is dropped', () => {
    expect(splitModelName('org/model:not a quant')).toEqual({ name: 'model', quant: null });
  });
});

describe('finding the loaded server', () => {
  const alive = process.pid;
  /** A folder of records, fresh for each case so one case cannot see another's. */
  const folder = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'gauge-model-'));
  const write = (dir: string, name: string, body: unknown): void => {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(body));
  };

  test('a live server with a matching status is found', async () => {
    const dir = folder();
    write(dir, 'serve-19001.json', { phase: 'ready', pid: alive });
    const found = await discoverSplash(dir, async (port) => ({
      pid: alive, port, model: 'org/model:IQ3_XXS', startedAt: 1, serving: false,
    }));
    expect(found).toHaveLength(1);
    expect(found[0].port).toBe(19001);
  });

  test('a record whose process is gone is ignored', async () => {
    const dir = folder();
    write(dir, 'serve-19002.json', { phase: 'ready', pid: 999999 });
    const found = await discoverSplash(dir, async (port) => ({
      pid: 999999, port, model: 'org/model:IQ3_XXS', startedAt: 2, serving: false,
    }));
    expect(found).toEqual([]);
  });

  test('a server that does not answer is ignored', async () => {
    const dir = folder();
    write(dir, 'serve-19003.json', { phase: 'ready', pid: alive });
    const found = await discoverSplash(dir, async (port) => (port === 19003 ? null : ({
      pid: alive, port, model: 'org/model:IQ3_XXS', startedAt: 3, serving: false,
    })));
    expect(found).toEqual([]);
  });

  test('a port another process has taken is ignored', async () => {
    const dir = folder();
    write(dir, 'serve-19004.json', { phase: 'ready', pid: alive });
    const found = await discoverSplash(dir, async (port) => ({
      pid: alive + 1, port, model: 'org/model:IQ3_XXS', startedAt: 4, serving: false,
    }));
    expect(found).toEqual([]);
  });

  test('no runtime folder means no model', async () => {
    expect(await discoverSplash(path.join(folder(), 'missing'), async () => null)).toEqual([]);
  });
});

describe('choosing one model', () => {
  const status = (model: string, startedAt: number, serving = false) => ({
    pid: 1, port: 1, model, startedAt, serving,
  });

  test('the server that is generating wins', () => {
    const picked = pickSplash([
      status('org/a', 10),
      status('org/b', 20, true),
    ]);
    expect(picked?.model).toBe('org/b');
  });

  test('otherwise the one that started last wins', () => {
    const picked = pickSplash([status('org/a', 10), status('org/b', 20)]);
    expect(picked?.model).toBe('org/b');
  });

  test('no server means no model', () => {
    expect(pickSplash([])).toBeNull();
  });
});
