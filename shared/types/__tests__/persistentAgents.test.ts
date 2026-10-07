import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  CONNECTOR_AVAILABILITY_STATES,
  deriveChips,
  deriveHealth,
  deriveSendLabel,
  formatLastSeen,
  isConnectorCallable,
  isOneOf,
  NOT_CONFIRMED_SUFFIX,
  PERSISTENT_AGENT_MAX_MESSAGE_BYTES,
  PERSISTENT_AGENT_PAIRING_TTL_MS,
  PERSISTENT_AGENT_VENDORS,
  REVOKE_SURFACE_AFTER,
  type BridgeTransport,
  type ConnectionState,
  type ConnectorAvailability,
  type HealthInput,
  type PersistentAgentVendor,
  type ThreadMessageView,
} from '../persistentAgents';
import { MAX_MESSAGE_BYTES, PAIRING_TTL_MS, type RelayTransport } from '../relayProtocol';
import {
  BRIDGE_DESCRIPTOR,
  CMA_DESCRIPTOR,
  GITHUB_ONLY_DESCRIPTOR,
  snapshotOf,
} from './persistentAgentsFixtures';

const NOW = new Date('2026-10-07T12:00:00.000Z');
const MIN = 60_000;
const HOUR = 3_600_000;

function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

function avail(state: ConnectorAvailability['state'], message: string | null = null, retryAt: string | null = null): ConnectorAvailability {
  return { state, message, retryAt };
}

function health(over: Partial<HealthInput>): HealthInput {
  return {
    kind: 'bridge',
    vendor: 'openai-dots',
    state: 'verified',
    lastSeenAt: null,
    verifiedAt: null,
    ...over,
  };
}

type SendFields = Pick<ThreadMessageView, 'sendState' | 'sendAttempts' | 'nextAttemptAt' | 'pickedUpAt' | 'remoteAck'>;
function msg(over: Partial<SendFields>): SendFields {
  return { sendState: 'queued', sendAttempts: 0, nextAttemptAt: null, pickedUpAt: null, remoteAck: null, ...over };
}

// ---------------------------------------------------------------------------------------------

describe('relay protocol alignment', () => {
  it('message and pairing limits equal the relay protocol', () => {
    expect(PERSISTENT_AGENT_MAX_MESSAGE_BYTES).toBe(MAX_MESSAGE_BYTES);
    expect(PERSISTENT_AGENT_PAIRING_TTL_MS).toBe(PAIRING_TTL_MS);
  });

  it('RelayTransport equals BridgeTransport', () => {
    expectTypeOf<RelayTransport>().toEqualTypeOf<BridgeTransport>();
  });

  it('REVOKE_SURFACE_AFTER is 3', () => {
    expect(REVOKE_SURFACE_AFTER).toBe(3);
  });
});

describe('isOneOf', () => {
  it('narrows a matching value and rejects everything else', () => {
    const v: unknown = 'meta-muse';
    if (isOneOf(PERSISTENT_AGENT_VENDORS, v)) {
      expectTypeOf(v).toEqualTypeOf<PersistentAgentVendor>();
      expect(v).toBe('meta-muse');
    } else {
      throw new Error('expected meta-muse to be a vendor');
    }
    expect(isOneOf(PERSISTENT_AGENT_VENDORS, 'acme')).toBe(false);
    expect(isOneOf(PERSISTENT_AGENT_VENDORS, 3)).toBe(false);
    expect(isOneOf(PERSISTENT_AGENT_VENDORS, null)).toBe(false);
  });
});

describe('isConnectorCallable', () => {
  it('ok and degraded unavailable are callable; blocked and every other state are not', () => {
    expect(isConnectorCallable(avail('ok'))).toBe(true);
    expect(isConnectorCallable(avail('unavailable', null, null))).toBe(true);
    expect(isConnectorCallable(avail('unavailable', null, '2026-10-07T12:05:00.000Z'))).toBe(false);
    for (const state of CONNECTOR_AVAILABILITY_STATES) {
      if (state === 'ok' || state === 'unavailable') continue;
      expect(isConnectorCallable(avail(state))).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe('deriveChips', () => {
  const labels = (chips: ReturnType<typeof deriveChips>): string[] => chips.map((c) => c.label);

  it('CMA descriptor, nothing observed: the literal design column', () => {
    expect(labels(deriveChips(snapshotOf(CMA_DESCRIPTOR)))).toEqual([
      'Two-way messages (not confirmed)', 'Links (not confirmed)', 'Opens PRs via GitHub (not confirmed)',
      'Live activity (not confirmed)', 'Cost & tokens (not confirmed)', 'Stop (not confirmed)', 'No attachments',
      'Structured briefs',
    ]);
  });

  it('Bridge relay-mcp + openai-dots: the literal design column', () => {
    expect(labels(deriveChips(snapshotOf(BRIDGE_DESCRIPTOR), { transport: 'relay-mcp', vendor: 'openai-dots' }))).toEqual([
      'Messages when the agent checks in (not confirmed)', 'Links (not confirmed)', 'Reports PRs (not confirmed)',
      'No live activity', 'No cost data', 'No remote stop · use ChatGPT', 'No attachments', 'Briefs as messages',
    ]);
  });

  it('Bridge relay-http + meta-muse: the literal design column', () => {
    expect(labels(deriveChips(snapshotOf(BRIDGE_DESCRIPTOR), { transport: 'relay-http', vendor: 'meta-muse' }))).toEqual([
      'Messages, best effort (not confirmed)', 'Links (not confirmed)', 'Reports PRs (not confirmed)',
      'No live activity', 'No cost data', 'No remote stop · use Muse', 'No attachments', 'Briefs as messages',
    ]);
  });

  it('Bridge without context keeps the generic messages and remote-stop labels', () => {
    const l = labels(deriveChips(snapshotOf(BRIDGE_DESCRIPTOR)));
    expect(l).toContain('Messages when the agent checks in (not confirmed)');
    expect(l).toContain('No remote stop');
  });

  it('CMA nothing observed: declared rows are neutral + unconfirmed, limitations are not', () => {
    const chips = deriveChips(snapshotOf(CMA_DESCRIPTOR));
    expect(chips.map((c) => c.key)).toEqual([
      'messages', 'links', 'deliveries', 'activity', 'usage', 'control-interrupt', 'attachments', 'briefs',
    ]);
    for (const c of chips.slice(0, 6)) {
      expect(c).toMatchObject({ tone: 'neutral', unconfirmed: true });
    }
    expect(chips[6]).toEqual({ key: 'attachments', label: 'No attachments', tone: 'neutral', unconfirmed: false });
    expect(chips[7]).toEqual({ key: 'briefs', label: 'Structured briefs', tone: 'neutral', unconfirmed: false });
  });

  it('chip labels end with " (not confirmed)" exactly when unconfirmed', () => {
    const fixtures = [
      deriveChips(snapshotOf(CMA_DESCRIPTOR)),
      deriveChips(snapshotOf(CMA_DESCRIPTOR, ['round-trip', 'activity'])),
      deriveChips(snapshotOf(BRIDGE_DESCRIPTOR), { transport: 'relay-http', vendor: 'meta-muse' }),
      deriveChips(snapshotOf(GITHUB_ONLY_DESCRIPTOR)),
    ];
    for (const chips of fixtures) {
      for (const c of chips) {
        expect(c.label.endsWith(NOT_CONFIRMED_SUFFIX)).toBe(c.unconfirmed);
      }
    }
  });

  it('CMA with round-trip + activity + usage observed: those chips are success with no suffix', () => {
    const chips = deriveChips(snapshotOf(CMA_DESCRIPTOR, ['round-trip', 'activity', 'usage']));
    const byKey = new Map(chips.map((c) => [c.key, c]));
    expect(byKey.get('messages')).toEqual({ key: 'messages', label: 'Two-way messages', tone: 'success', unconfirmed: false });
    expect(byKey.get('links')).toEqual({ key: 'links', label: 'Links', tone: 'success', unconfirmed: false });
    expect(byKey.get('activity')).toEqual({ key: 'activity', label: 'Live activity', tone: 'success', unconfirmed: false });
    expect(byKey.get('usage')).toEqual({ key: 'usage', label: 'Cost & tokens', tone: 'success', unconfirmed: false });
    expect(byKey.get('deliveries')?.unconfirmed).toBe(true);
  });

  it('Bridge descriptor rows (dots / Muse columns)', () => {
    const chips = deriveChips(snapshotOf(BRIDGE_DESCRIPTOR));
    const byKey = new Map(chips.map((c) => [c.key, c]));
    expect(byKey.get('deliveries')?.label).toBe('Reports PRs (not confirmed)');
    expect(byKey.get('activity')).toMatchObject({ label: 'No live activity', unconfirmed: false });
    expect(byKey.get('usage')).toMatchObject({ label: 'No cost data', unconfirmed: false });
    expect(byKey.get('control-none')).toMatchObject({ label: 'No remote stop', unconfirmed: false });
    expect(byKey.get('briefs')?.label).toBe('Briefs as messages');
  });

  it('GitHub-only synthetic: inbound-only limitations', () => {
    const chips = deriveChips(snapshotOf(GITHUB_ONLY_DESCRIPTOR));
    expect(chips[0]).toEqual({ key: 'messages', label: 'Agent → cyboflow only', tone: 'neutral', unconfirmed: false });
    expect(chips[1]).toEqual({ key: 'links', label: 'Links from the agent only', tone: 'neutral', unconfirmed: false });
  });

  it('the control flag confirms every verb chip', () => {
    const descriptor = { ...CMA_DESCRIPTOR, control: ['end', 'interrupt'] as const };
    const chips = deriveChips(snapshotOf(descriptor, ['control']));
    const control = chips.filter((c) => c.key.startsWith('control-'));
    expect(control).toEqual([
      { key: 'control-interrupt', label: 'Stop', tone: 'success', unconfirmed: false },
      { key: 'control-end', label: 'End session', tone: 'success', unconfirmed: false },
    ]);
  });

  it('never drops rows and never emits error', () => {
    const descriptors = [
      CMA_DESCRIPTOR,
      BRIDGE_DESCRIPTOR,
      GITHUB_ONLY_DESCRIPTOR,
      { ...CMA_DESCRIPTOR, control: ['interrupt', 'end', 'pause', 'resume'] as const },
    ];
    for (const d of descriptors) {
      const chips = deriveChips(snapshotOf(d));
      expect(chips).toHaveLength(7 + Math.max(1, d.control.length));
      expect(chips.some((c) => c.tone === 'error')).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe('formatLastSeen', () => {
  const at = new Date('2026-10-01T12:00:00.000Z');
  const before = (ms: number): string => new Date(at.getTime() - ms).toISOString();

  it('formats each band', () => {
    expect(formatLastSeen(before(30_000), at)).toBe('just now');
    expect(formatLastSeen(before(4 * MIN), at)).toBe('4m ago');
    expect(formatLastSeen(before(3 * HOUR), at)).toBe('3h ago');
    expect(formatLastSeen('2026-09-28T12:00:00.000Z', at)).toBe('Sep 28');
  });

  it('clamps negative ages and returns empty for invalid input', () => {
    expect(formatLastSeen('2026-10-01T13:00:00.000Z', at)).toBe('just now');
    expect(formatLastSeen('not a date', at)).toBe('');
  });
});

describe('deriveHealth table', () => {
  it('row 1: revoked is red (bridge / native copy)', () => {
    expect(deriveHealth(health({ state: 'revoked' }), NOW)).toEqual({ dot: 'red', copy: 'Token revoked', banner: null });
    expect(deriveHealth(health({ kind: 'native', vendor: 'anthropic-cma', state: 'revoked' }), NOW))
      .toEqual({ dot: 'red', copy: 'Connection revoked · reconnect', banner: null });
  });

  it('row 2: an undecryptable credential is amber, not red', () => {
    expect(deriveHealth(health({ kind: 'native', vendor: 'anthropic-cma', credentialState: 'undecryptable' }), NOW))
      .toEqual({ dot: 'amber', copy: "Stored API key can't be read on this computer · re-enter it", banner: null });
  });

  it('row 3: auth_failed is red (native / bridge copy)', () => {
    expect(deriveHealth(health({ kind: 'native', vendor: 'anthropic-cma', state: 'auth_failed' }), NOW))
      .toEqual({ dot: 'red', copy: 'API key rejected · reconnect', banner: null });
    expect(deriveHealth(health({ state: 'auth_failed' }), NOW))
      .toEqual({ dot: 'red', copy: 'Rejected by the Bridge · repair', banner: null });
  });

  it('row 4: device_revoked is red and prefers the availability message', () => {
    expect(deriveHealth(health({ availability: avail('device_revoked') }), NOW))
      .toEqual({ dot: 'red', copy: 'Signed out of cyboflow cloud · sign in again', banner: null });
    expect(deriveHealth(health({ availability: avail('device_revoked', 'Custom') }), NOW).copy).toBe('Custom');
  });

  it('row 5: neutral gates (signed_out, locked, not_entitled, other_account, disabled)', () => {
    const cases: Array<[ConnectorAvailability['state'], string]> = [
      ['signed_out', 'Sign in to cyboflow cloud'],
      ['locked', 'Waiting for the cyboflow cloud sign-in'],
      ['not_entitled', "Bridge isn't enabled for your account"],
      ['other_account', 'Created under a different cyboflow cloud account'],
      ['disabled', 'Disabled on this computer'],
    ];
    for (const [state, copy] of cases) {
      expect(deriveHealth(health({ availability: avail(state) }), NOW)).toEqual({ dot: 'neutral', copy, banner: null });
    }
  });

  it('deriveHealth locked → neutral, other_account → neutral, both use availability.message when present', () => {
    expect(deriveHealth(health({ availability: avail('locked', 'Unlocking…') }), NOW))
      .toEqual({ dot: 'neutral', copy: 'Unlocking…', banner: null });
    expect(deriveHealth(health({ availability: avail('other_account', 'Other account') }), NOW))
      .toEqual({ dot: 'neutral', copy: 'Other account', banner: null });
  });

  it('row 6: amber gates (needs_update, unavailable incl. degraded)', () => {
    expect(deriveHealth(health({ availability: avail('needs_update') }), NOW))
      .toEqual({ dot: 'amber', copy: 'Update cyboflow to keep agent messages flowing', banner: null });
    expect(deriveHealth(health({ availability: avail('unavailable') }), NOW))
      .toEqual({ dot: 'amber', copy: "Can't reach the service · retrying", banner: null });
    expect(deriveHealth(health({ availability: avail('unavailable', 'Bridge offline · retrying') }), NOW).copy)
      .toBe('Bridge offline · retrying');
  });

  it('row 7: rate limited (Bridge / Anthropic)', () => {
    const until = new Date(NOW.getTime() + MIN).toISOString();
    expect(deriveHealth(health({ rateLimitedUntil: until, lastSeenAt: ago(MIN) }), NOW))
      .toEqual({ dot: 'amber', copy: 'Rate-limited by the Bridge · retrying', banner: null });
    expect(deriveHealth(health({ kind: 'native', vendor: 'anthropic-cma', rateLimitedUntil: until }), NOW).copy)
      .toBe('Rate-limited by Anthropic · retrying');
    expect(deriveHealth(health({ kind: 'native', vendor: 'other', rateLimitedUntil: until }), NOW).copy)
      .toBe('Rate-limited by the vendor · retrying');
    // An expired limit no longer applies.
    expect(deriveHealth(health({ rateLimitedUntil: ago(1), lastSeenAt: ago(MIN) }), NOW).dot).toBe('green');
  });

  it('row 8: pending is hollow', () => {
    expect(deriveHealth(health({ state: 'pending' }), NOW))
      .toEqual({ dot: 'hollow', copy: 'Not yet verified · waiting for its first reply', banner: null });
  });

  it('row 9: stale is neutral with the vendor banner', () => {
    expect(deriveHealth(health({ state: 'stale', lastSeenAt: '2026-10-01T12:00:00.000Z' }), NOW)).toEqual({
      dot: 'neutral',
      copy: 'Quiet since Oct 1 · messages wait on the bridge',
      banner: { kind: 'stale', copy: 'Open ChatGPT and ask it to check its cyboflow messages' },
    });
    expect(deriveHealth(health({ state: 'stale', vendor: 'other' }), NOW)).toEqual({
      dot: 'neutral',
      copy: 'Quiet · messages wait on the bridge',
      banner: { kind: 'stale', copy: "Open the agent's app and ask it to check its cyboflow messages" },
    });
  });

  it('row 10: verified native with presence', () => {
    const native = (remoteStatus: HealthInput['remoteStatus']): HealthInput =>
      health({ kind: 'native', vendor: 'anthropic-cma', remoteStatus, lastSeenAt: ago(MIN) });
    expect(deriveHealth(native('working'), NOW)).toEqual({ dot: 'green', copy: 'Connected via API · working', banner: null });
    expect(deriveHealth(native('idle'), NOW))
      .toEqual({ dot: 'green', copy: 'Connected via API · idle · awaiting input', banner: null });
    expect(deriveHealth(native('errored'), NOW)).toEqual({ dot: 'amber', copy: 'Connected via API · errored', banner: null });
    expect(deriveHealth(native('budget_paused'), NOW)).toEqual({ dot: 'amber', copy: 'Paused at budget', banner: null });
  });

  it('row 11: verified with no timestamp at all', () => {
    expect(deriveHealth(health({}), NOW)).toEqual({ dot: 'amber', copy: 'Connected · last seen unknown', banner: null });
  });

  it('row 12: verified and recent is green (falls back to verifiedAt)', () => {
    expect(deriveHealth(health({ lastSeenAt: ago(4 * MIN) }), NOW))
      .toEqual({ dot: 'green', copy: 'Connected via cyboflow Bridge · last seen 4m ago', banner: null });
    expect(deriveHealth(health({ kind: 'native', vendor: 'anthropic-cma', verifiedAt: ago(4 * MIN) }), NOW))
      .toEqual({ dot: 'green', copy: 'Connected via API · last seen 4m ago', banner: null });
  });

  it('row 13: verified within a day is amber', () => {
    expect(deriveHealth(health({ lastSeenAt: ago(3 * HOUR) }), NOW))
      .toEqual({ dot: 'amber', copy: 'Connected via cyboflow Bridge · last seen 3h ago', banner: null });
  });

  it('row 14: an older verified Bridge connection reads as stale', () => {
    expect(deriveHealth(health({ lastSeenAt: '2026-10-05T12:00:00.000Z' }), NOW)).toEqual({
      dot: 'neutral',
      copy: 'Quiet since Oct 5 · messages wait on the bridge',
      banner: { kind: 'stale', copy: 'Open ChatGPT and ask it to check its cyboflow messages' },
    });
  });

  it('row 15: an older verified native connection stays amber', () => {
    expect(deriveHealth(health({ kind: 'native', vendor: 'anthropic-cma', lastSeenAt: '2026-10-05T12:00:00.000Z' }), NOW))
      .toEqual({ dot: 'amber', copy: 'Connected via API · last seen Oct 5', banner: null });
  });

  it('availability ok falls through to the connection rows', () => {
    expect(deriveHealth(health({ availability: avail('ok'), lastSeenAt: ago(MIN) }), NOW).dot).toBe('green');
  });
});

describe('deriveHealth boundaries', () => {
  it('green / amber / stale at the age thresholds', () => {
    expect(deriveHealth(health({ lastSeenAt: ago(15 * MIN - 1) }), NOW).dot).toBe('green');
    expect(deriveHealth(health({ lastSeenAt: ago(15 * MIN) }), NOW).dot).toBe('amber');
    expect(deriveHealth(health({ lastSeenAt: ago(24 * HOUR) }), NOW).dot).toBe('amber');
    const bridgeOld = deriveHealth(health({ lastSeenAt: ago(24 * HOUR + 1) }), NOW);
    expect(bridgeOld.dot).toBe('neutral');
    expect(bridgeOld.copy).toMatch(/^Quiet since [A-Z][a-z]{2} \d{1,2} · messages wait on the bridge$/);
    expect(bridgeOld.banner?.kind).toBe('stale');
    const nativeOld = deriveHealth(health({ kind: 'native', vendor: 'anthropic-cma', lastSeenAt: ago(24 * HOUR + 1) }), NOW);
    expect(nativeOld.dot).toBe('amber');
    expect(nativeOld.banner).toBeNull();
  });

  it('precedence: revoked beats rate-limited; undecryptable beats auth_failed; device_revoked beats pending', () => {
    const until = new Date(NOW.getTime() + MIN).toISOString();
    expect(deriveHealth(health({ state: 'revoked', rateLimitedUntil: until }), NOW).copy).toBe('Token revoked');
    expect(deriveHealth(health({ kind: 'native', vendor: 'anthropic-cma', state: 'auth_failed', credentialState: 'undecryptable' }), NOW))
      .toMatchObject({ dot: 'amber' });
    expect(deriveHealth(health({ state: 'pending', availability: avail('device_revoked') }), NOW).dot).toBe('red');
  });

  it('a negative age clamps to just now', () => {
    expect(deriveHealth(health({ lastSeenAt: new Date(NOW.getTime() + HOUR).toISOString() }), NOW))
      .toEqual({ dot: 'green', copy: 'Connected via cyboflow Bridge · last seen just now', banner: null });
  });
});

// ---------------------------------------------------------------------------------------------

describe('deriveSendLabel', () => {
  const future = new Date(NOW.getTime() + MIN).toISOString();
  const cases: Array<[string, SendFields, ConnectionState | null, { label: string; at: string | null; tone: string }]> = [
    ['no send state', msg({ sendState: null }), 'verified', { label: '', at: null, tone: 'neutral' }],
    ['declined', msg({ sendState: 'on_bridge', remoteAck: 'declined' }), 'verified', { label: 'Declined', at: null, tone: 'warning' }],
    ['acked', msg({ sendState: 'on_bridge', remoteAck: 'acked' }), 'verified', { label: 'Accepted', at: null, tone: 'success' }],
    ['picked up', msg({ sendState: 'on_bridge', pickedUpAt: '2026-10-07T11:59:00.000Z' }), 'verified',
      { label: 'Picked up', at: '2026-10-07T11:59:00.000Z', tone: 'success' }],
    ['withdrawn', msg({ sendState: 'withdrawn' }), 'verified', { label: 'Withdrawn', at: null, tone: 'neutral' }],
    ['failed', msg({ sendState: 'failed' }), 'verified', { label: 'Not sent', at: null, tone: 'error' }],
    ['on the bridge', msg({ sendState: 'on_bridge' }), 'verified', { label: 'On the bridge', at: null, tone: 'success' }],
    ['sent', msg({ sendState: 'sent' }), 'verified', { label: 'Sent', at: null, tone: 'success' }],
    ['ambiguous', msg({ sendState: 'ambiguous' }), 'verified', { label: 'Checking delivery…', at: null, tone: 'warning' }],
    ['queued on a revoked connection', msg({}), 'revoked', { label: 'Waiting · agent disconnected', at: null, tone: 'warning' }],
    ['queued on an auth_failed connection', msg({}), 'auth_failed', { label: 'Waiting · reconnect to send', at: null, tone: 'warning' }],
    ['queued and retrying', msg({ sendAttempts: 2, nextAttemptAt: future }), 'verified', { label: 'Retrying…', at: future, tone: 'warning' }],
    ['queued', msg({}), 'verified', { label: 'Queued', at: null, tone: 'neutral' }],
    ['creating / in flight', msg({ sendState: 'in_flight' }), null, { label: 'Sending…', at: null, tone: 'neutral' }],
  ];

  for (const [name, m, connectionState, expected] of cases) {
    it(name, () => {
      expect(deriveSendLabel(m, connectionState, NOW)).toEqual(expected);
    });
  }

  it('creating is also Sending…', () => {
    expect(deriveSendLabel(msg({ sendState: 'creating' }), 'verified', NOW).label).toBe('Sending…');
  });

  it('a past nextAttemptAt is Queued, not Retrying', () => {
    expect(deriveSendLabel(msg({ sendAttempts: 1, nextAttemptAt: ago(1) }), 'verified', NOW).label).toBe('Queued');
  });

  it('acked → Accepted beats pickedUpAt', () => {
    expect(deriveSendLabel(msg({ sendState: 'on_bridge', remoteAck: 'acked', pickedUpAt: ago(MIN) }), 'verified', NOW))
      .toEqual({ label: 'Accepted', at: null, tone: 'success' });
  });

  it('never claims a read / seen state', () => {
    for (const [, m, connectionState] of cases) {
      expect(deriveSendLabel(m, connectionState, NOW).label).not.toMatch(/\bread\b|\bseen\b/i);
    }
  });
});
