import { describe, expect, test } from 'bun:test';
import { trustedClientOrigin } from './auth';

describe('desktop bearer destination', () => {
  const desktop = 'http://127.0.0.1:18100';
  const parent = [{ host: '127.0.0.1', port: 18100 }];

  test('allows the desktop server, not another loopback service', () => {
    expect(trustedClientOrigin(desktop, desktop, parent)).toBe(true);
    expect(trustedClientOrigin('http://127.0.0.1:18101', desktop, [{ host: '127.0.0.1', port: 18101 }])).toBe(false);
    expect(trustedClientOrigin('https://127.0.0.1:18100', desktop, parent)).toBe(false);
    expect(trustedClientOrigin('http://[::1]:18100', desktop, parent)).toBe(false);
  });

  test('never trusts a nonlocal or hostname-based page address', () => {
    for (const origin of ['https://example.com', 'http://192.168.1.2:18100', 'http://localhost:18100',
      'http://127.0.0.1.example.com:18100', 'http://user@127.0.0.1:18100', 'not-a-url']) {
      expect(trustedClientOrigin(origin, desktop, parent)).toBe(false);
      expect(trustedClientOrigin(origin, null, parent)).toBe(false);
    }
  });

  test('headless mode requires a matching loopback listener owned by the parent', () => {
    expect(trustedClientOrigin(desktop, null, parent)).toBe(true);
    expect(trustedClientOrigin(desktop, null, [])).toBe(false);
    expect(trustedClientOrigin('http://127.0.0.1:18101', null, parent)).toBe(false);
    expect(trustedClientOrigin('http://127.0.0.1:18100', null, [{ host: '0.0.0.0', port: 18100 }])).toBe(true);
    expect(trustedClientOrigin('http://[::1]:18100', null, [{ host: '::', port: 18100 }])).toBe(true);
    // An IPv6-only wildcard does not prove that the IPv4 listener belongs to the parent, or vice versa.
    expect(trustedClientOrigin(desktop, null, [{ host: '::', port: 18100 }])).toBe(false);
    expect(trustedClientOrigin('http://[::1]:18100', null, [{ host: '0.0.0.0', port: 18100 }])).toBe(false);
    expect(trustedClientOrigin(desktop, null, [{ host: '*', port: 18100 }])).toBe(false);
  });
});
