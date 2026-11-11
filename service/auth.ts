import fs from 'node:fs/promises';
import path from 'node:path';

/** Hosts that only a process on this machine can dial. */
const isLoopbackHost = (hostname: string): boolean =>
  hostname === '127.0.0.1'
  || hostname === 'localhost'
  || hostname === '::1'
  || hostname === '[::1]';

const readRecord = async (file: string): Promise<Record<string, unknown>> => {
  try {
    const value: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

/**
 * A cookie for the parent host's UI session, read from the instance file the
 * server writes when it was started with a UI password.
 *
 * This is the fallback for a headless install: it has no desktop-local token,
 * so the bearer in `serverHeaders()` is not available. The password is only
 * read for a loopback listener that is either owned by our parent process or
 * has the server's own instance file (`run/openchamber-<port>.json`) in the
 * data directory, and only sent back to that same origin; redirects are refused
 * so neither credential can travel anywhere else. The file is the evidence that
 * matters on Windows, where `netstat` can leave a socket's PID unnamed and the
 * port set comes back empty. `OPENCHAMBER_GAUGE_UI_PASSWORD` supplies the
 * password explicitly when the host's data directory is not visible.
 */
export const passwordAuthHeaders = async (
  origin: string,
  dataDir: string,
  parentPorts: ReadonlySet<number>,
  signal: AbortSignal,
): Promise<Record<string, string>> => {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return {};
  }
  if (!isLoopbackHost(url.hostname)) return {};
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (!Number.isInteger(port) || port <= 0) return {};

  // The instance file is written by the server for its own port, so it is
  // evidence the port is ours even when the scan could not name a PID.
  const instance = await readRecord(path.join(dataDir, 'run', `openchamber-${port}.json`));
  if (!parentPorts.has(port) && Object.keys(instance).length === 0) return {};

  let password = process.env.OPENCHAMBER_GAUGE_UI_PASSWORD?.trim() ?? '';
  if (!password) {
    const value = instance.uiPassword;
    if (typeof value === 'string') password = value;
  }
  if (!password) return {};

  try {
    const response = await fetch(new URL('/auth/session', url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ password }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]),
      redirect: 'manual',
    });
    const cookie = response.headers.get('set-cookie')
      ?.match(/(?:^|,\s*)(oc_ui_session(?:_\d+)?=[^;]+)/)?.[1];
    await response.body?.cancel();
    if (response.ok && cookie) return { Cookie: cookie };
  } catch {
    // No login endpoint, or it did not answer in time: another credential or
    // the next candidate origin may still work.
  }
  return {};
};
