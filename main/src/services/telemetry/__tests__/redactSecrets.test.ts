/**
 * redactSecrets — defence in depth for secrets of KNOWN SHAPES reaching Sentry or the bug-report error
 * buffer. The primary rule is that error messages never embed a secret; this is the sink-side backstop.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Event } from '@sentry/electron/main';

vi.mock('electron', () => ({
  app: { isPackaged: false, getVersion: vi.fn(() => '0.1.35') },
}));

import { redactSecrets, scrubSentryEvent } from '../scrub';
import { recordLocalError, getRecentErrors, __resetRecentErrorsForTests } from '../diagnostics';

const DEVICE_TOKEN = 'cbd_' + 'A'.repeat(43);
const RELAY_TOKEN = 'cbh_' + 'b1-_Z'.repeat(8);

describe('redactSecrets', () => {
  it('redacts cyboflow device tokens', () => {
    expect(redactSecrets(`token ${DEVICE_TOKEN} rejected`)).toBe('token cbd_[redacted] rejected');
  });

  it('redacts relay-http tokens and the reserved cb*_ prefixes', () => {
    expect(redactSecrets(`use ${RELAY_TOKEN}`)).toBe('use cbh_[redacted]');
    expect(redactSecrets('cbf_abc cbr_def cbt_ghi')).toBe('cbf_[redacted] cbr_[redacted] cbt_[redacted]');
  });

  it('redacts cba_c_ client secrets', () => {
    expect(redactSecrets('secret=cba_c_xyz.123/456 end')).toBe('secret=cba_c_[redacted] end');
  });

  it('redacts Bearer credentials case-insensitively', () => {
    expect(redactSecrets('Authorization: Bearer abc.def-123')).toBe('Authorization: Bearer [redacted]');
    expect(redactSecrets('authorization: bearer abc')).toBe('authorization: Bearer [redacted]');
  });

  it('redacts WORD-WORD-NNNN pairing codes in any case', () => {
    expect(redactSecrets('code AMBER-RIVER-4821 expired')).toBe('code [pairing-code] expired');
    expect(redactSecrets('code amber-river-4821')).toBe('code [pairing-code]');
  });

  it('redacts Anthropic API keys', () => {
    expect(redactSecrets('key sk-ant-api03-AbC_dEf-123 bad')).toBe('key sk-ant-[redacted] bad');
  });

  it('returns a string with no secrets unchanged', () => {
    const plain = 'relay request failed: HTTP 503 accounts_unavailable';
    expect(redactSecrets(plain)).toBe(plain);
  });
});

describe('scrubSentryEvent applies redactSecrets', () => {
  it('redacts a cbh_ token in exception.values[0].value, the message and breadcrumbs', () => {
    const event: Event = {
      message: `top ${DEVICE_TOKEN}`,
      exception: { values: [{ type: 'Error', value: `pair failed with ${RELAY_TOKEN}` }] },
      breadcrumbs: [{ category: 'http', message: `Bearer ${DEVICE_TOKEN}` }],
    };
    const out = scrubSentryEvent(event);
    expect(out?.exception?.values?.[0]?.value).toBe('pair failed with cbh_[redacted]');
    expect(out?.message).toBe('top cbd_[redacted]');
    expect(out?.breadcrumbs?.[0]?.message).toBe('Bearer [redacted]');
    expect(JSON.stringify(out)).not.toContain('AAAA');
  });
});

describe('recordLocalError applies redactSecrets', () => {
  beforeEach(() => {
    __resetRecentErrorsForTests();
  });

  it('stores a redacted message', () => {
    recordLocalError('cloud-account', new Error(`register failed for ${DEVICE_TOKEN}`), '2026-10-07T12:00:00.000Z');
    const [entry] = getRecentErrors();
    expect(entry.message).toBe('register failed for cbd_[redacted]');
    expect(entry.message).not.toMatch(/cbd_A/);
  });
});
