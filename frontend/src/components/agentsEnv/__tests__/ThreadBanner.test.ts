import { describe, it, expect } from 'vitest';
import type { ConnectorAvailability } from '../../../../../shared/types/persistentAgents';
import { selectThreadBanner } from '../ThreadBanner';
import { makeAgent, makeConnection } from './fixtures';

const NOW = Date.parse('2026-10-07T12:00:00Z');

function avail(state: ConnectorAvailability['state'], over: Partial<ConnectorAvailability> = {}): ConnectorAvailability {
  return { state, message: `message for ${state}`, retryAt: null, ...over };
}

function pick(
  conn: Parameters<typeof makeConnection>[0] | null,
  opts: { bridgeDisabled?: boolean } = {},
): ReturnType<typeof selectThreadBanner> {
  return selectThreadBanner({
    agent: makeAgent({ connection: conn === null ? null : makeConnection(conn) }),
    bridgeDisabled: opts.bridgeDisabled ?? false,
    now: NOW,
  });
}

describe('selectThreadBanner', () => {
  it('1: not connected', () => {
    expect(pick(null)).toEqual({ kind: 'not_connected', tone: 'neutral', copy: 'Not connected.', action: null });
  });

  it('2: revoked offers Reconnect for a Bridge connection only', () => {
    expect(pick({ state: 'revoked' })).toEqual({
      kind: 'revoked',
      tone: 'error',
      copy: "Token revoked. This agent can't receive messages.",
      action: 'reconnect',
    });
    expect(pick({ state: 'revoked', kind: 'native' })?.action).toBeNull();
  });

  it('3: auth failed', () => {
    expect(pick({ state: 'auth_failed' })).toEqual({
      kind: 'auth_failed',
      tone: 'error',
      copy: 'API key rejected · reconnect.',
      action: null,
    });
  });

  it('4: signed out of cloud (and a revoked device) asks to sign in', () => {
    for (const state of ['signed_out', 'device_revoked'] as const) {
      expect(pick({ availability: avail(state) })).toEqual({
        kind: 'cloud_signed_out',
        tone: 'warning',
        copy: "This computer isn't signed in to cyboflow cloud, so Bridge messages aren't being collected.",
        action: 'sign_in',
      });
    }
  });

  it('5: locked carries the availability message', () => {
    const b = pick({ availability: avail('locked') });
    expect(b?.kind).toBe('cloud_locked');
    expect(b?.tone).toBe('neutral');
    expect(b?.copy).toBe('message for locked');
    expect(b?.action).toBe('sign_in');
  });

  it('6: another account carries the availability message', () => {
    const b = pick({ availability: avail('other_account') });
    expect(b).toMatchObject({ kind: 'other_account', tone: 'warning', copy: 'message for other_account', action: null });
  });

  it('7: a disabled Bridge, from availability or from the feature flag', () => {
    expect(pick({ availability: avail('disabled') })).toMatchObject({
      kind: 'bridge_disabled',
      tone: 'warning',
      copy: 'message for disabled',
    });
    expect(pick({ availability: avail('ok', { message: null }) }, { bridgeDisabled: true })).toMatchObject({
      kind: 'bridge_disabled',
      copy: 'The Bridge is turned off on this computer; messages are not being collected.',
    });
  });

  it('8: a blocked connector carries the availability message', () => {
    for (const state of ['needs_update', 'not_entitled', 'unavailable'] as const) {
      expect(pick({ availability: avail(state) })).toMatchObject({
        kind: 'connector_blocked',
        tone: 'warning',
        copy: `message for ${state}`,
        action: null,
      });
    }
  });

  it('9: pending offers the pairing details for a Bridge connection', () => {
    expect(pick({ state: 'pending' })).toEqual({
      kind: 'pending',
      tone: 'neutral',
      copy: 'Not yet verified · waiting for its first reply. Messages wait on the Bridge until it checks in.',
      action: 'pairing',
    });
  });

  it('10: stale names the vendor app', () => {
    const b = pick({ state: 'stale', lastSeenAt: '2026-10-05T09:30:00.000Z' });
    expect(b?.kind).toBe('stale');
    expect(b?.tone).toBe('warning');
    expect(b?.copy).toContain('Quiet since');
    expect(b?.copy).toContain('Open ChatGPT and ask it to check its cyboflow messages.');
  });

  it('11: rate limited while the limit is in the future', () => {
    expect(pick({ rateLimitedUntil: '2026-10-07T12:05:00.000Z' })).toEqual({
      kind: 'rate_limited',
      tone: 'warning',
      copy: 'Rate limited by the vendor · retrying.',
      action: null,
    });
    expect(pick({ rateLimitedUntil: '2026-10-07T11:55:00.000Z' })).toBeNull();
  });

  it('revoked beats a signed-out availability', () => {
    expect(pick({ state: 'revoked', availability: avail('signed_out') })?.kind).toBe('revoked');
  });

  it('device_revoked beats pending', () => {
    expect(pick({ state: 'pending', availability: avail('device_revoked') })?.kind).toBe('cloud_signed_out');
  });

  it('locked beats stale', () => {
    expect(pick({ state: 'stale', availability: avail('locked') })?.kind).toBe('cloud_locked');
  });

  it('unavailable with retryAt null still yields connector_blocked', () => {
    expect(pick({ availability: avail('unavailable', { retryAt: null }) })?.kind).toBe('connector_blocked');
  });

  it('is null for a verified, recently seen agent', () => {
    expect(pick({})).toBeNull();
  });
});
