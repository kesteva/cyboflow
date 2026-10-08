import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeBackoffMs } from '../../../../cloud/backoff';
import {
  encodeAckToken,
  encodeBridgeCursor,
  isValidRedirectHost,
  parseAckToken,
  parseBridgeCursor,
  parseBridgeRemote,
  sanitizeClientName,
  sanitizeLabel,
  sanitizePairedClient,
  type BridgeRemoteV1,
} from '../bridgeRemote';
import { clampRetryAfterMs, DOORBELL_BACKOFF, BACKOFF_TRANSIENT } from '../constants';
import { BRIDGE_COPY } from '../copy';
import { BRIDGE_DEFINITION } from '../descriptor';
import { buildHttpInstructionBrief } from '../instructionBrief';
import { RelayHttpError, toConnectorError } from '../relayErrors';
import { BudgetAbortError, BudgetWaitTimeoutError, RequestBudget } from '../requestBudget';

const ch = (code: number): string => String.fromCharCode(code);

function validRemote(over: Partial<BridgeRemoteV1> = {}): BridgeRemoteV1 {
  return {
    v: 1, origin: 'https://cloud.test', accountId: 'acct_1', relayConnectionId: 'c_abc', transport: 'relay-mcp',
    label: 'Scout', mcpUrl: 'https://bridge.test/mcp/c_abc', httpBase: 'https://bridge.test/c/c_abc',
    pairingIssuedAt: null, pairedClient: null, pairCalledAt: null, firstInboundAt: null, firstPickupAt: null,
    relayState: 'active', ...over,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('backoff and retry-after', () => {
  it('computeBackoffMs stays within the equal-jitter bounds and the cap', () => {
    const p = DOORBELL_BACKOFF;
    expect(computeBackoffMs({ attempt: 0, baseMs: p.baseMs, capMs: p.capMs, random: () => 0 })).toBe(500);
    expect(computeBackoffMs({ attempt: 0, baseMs: p.baseMs, capMs: p.capMs, random: () => 1 })).toBe(1000);
    expect(computeBackoffMs({ attempt: 3, baseMs: p.baseMs, capMs: p.capMs, random: () => 1 })).toBe(8000);
    expect(computeBackoffMs({ attempt: 30, baseMs: p.baseMs, capMs: p.capMs, random: () => 1 })).toBe(60_000);
    expect(computeBackoffMs({ attempt: 30, baseMs: p.baseMs, capMs: p.capMs, random: () => 0 })).toBe(30_000);
    expect(computeBackoffMs({ attempt: 10, baseMs: BACKOFF_TRANSIENT.baseMs, capMs: BACKOFF_TRANSIENT.capMs, random: () => 1 }))
      .toBe(120_000);
  });

  it('clampRetryAfterMs clamps to [1 s, 15 min]', () => {
    expect(clampRetryAfterMs(0)).toBe(1000);
    expect(clampRetryAfterMs(5000)).toBe(5000);
    expect(clampRetryAfterMs(60 * 60_000)).toBe(15 * 60_000);
    expect(clampRetryAfterMs(Number.NaN)).toBe(1000);
  });
});

describe('RequestBudget', () => {
  it('grants the burst immediately and then waits for refill', async () => {
    vi.useFakeTimers();
    const b = new RequestBudget(2, 60);
    await b.acquire('normal', 10_000);
    await b.acquire('normal', 10_000);
    let third = false;
    void b.acquire('normal', 10_000).then(() => { third = true; });
    await vi.advanceTimersByTimeAsync(999);
    expect(third).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(third).toBe(true);
    b.dispose();
  });

  it('serves high-priority waiters before normal ones', async () => {
    vi.useFakeTimers();
    const b = new RequestBudget(1, 60);
    await b.acquire('normal', 10_000);
    const order: string[] = [];
    void b.acquire('normal', 10_000).then(() => order.push('normal'));
    void b.acquire('high', 10_000).then(() => order.push('high'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(order).toEqual(['high']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(order).toEqual(['high', 'normal']);
    b.dispose();
  });

  it('rejects after maxWaitMs', async () => {
    vi.useFakeTimers();
    const b = new RequestBudget(1, 1);
    await b.acquire('normal', 1000);
    const p = b.acquire('normal', 1000);
    const assertion = expect(p).rejects.toBeInstanceOf(BudgetWaitTimeoutError);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    b.dispose();
  });

  it('rejects at once when the signal aborts and removes the waiter', async () => {
    vi.useFakeTimers();
    const b = new RequestBudget(1, 1);
    await b.acquire('normal', 60_000);
    const c = new AbortController();
    const p = b.acquire('normal', 60_000, c.signal);
    c.abort();
    await expect(p).rejects.toBeInstanceOf(BudgetAbortError);
    expect(vi.getTimerCount()).toBe(0);
    b.dispose();
  });

  it('a global block grants nothing before it ends; extends, never shortens', async () => {
    vi.useFakeTimers();
    const b = new RequestBudget(5, 100);
    b.blockUntil(Date.now() + 5000);
    b.blockUntil(Date.now() + 1000);
    expect(b.blockedUntil()).toBe(Date.now() + 5000);
    let got = false;
    void b.acquire('normal', 10_000).then(() => { got = true; });
    await vi.advanceTimersByTimeAsync(4999);
    expect(got).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(got).toBe(true);
    b.dispose();
  });

  it('dispose rejects waiters and clears its timer', async () => {
    vi.useFakeTimers();
    const b = new RequestBudget(1, 1);
    await b.acquire('normal', 60_000);
    const p = b.acquire('high', 60_000);
    b.dispose();
    await expect(p).rejects.toBeInstanceOf(BudgetAbortError);
    expect(vi.getTimerCount()).toBe(0);
    await expect(b.acquire('normal', 10)).rejects.toBeInstanceOf(BudgetAbortError);
  });
});

describe('buildHttpInstructionBrief', () => {
  it('produces the exact relay-http instructions', () => {
    const brief = buildHttpInstructionBrief({ httpBase: 'https://bridge.test/c/c_1', token: 'cbh_TOKEN', handle: 'scout' });
    expect(brief).toBe([
      'You can reach me through cyboflow. Call these HTTPS endpoints with the header',
      '"Authorization: Bearer cbh_TOKEN":',
      '',
      '- Send me a message: POST https://bridge.test/c/c_1/inbox with JSON {"id": "<a unique id you choose>", "text": "<message>", "links": ["https://..."]}',
      '- Read my messages and briefs: GET https://bridge.test/c/c_1/outbox?since_cursor=<the cursor from your previous call>',
      '- Accept or decline a brief: POST https://bridge.test/c/c_1/outbox/<brief id>/ack with JSON {"accepted": true, "note": "<optional>"}',
      '- Report a pull request: POST https://bridge.test/c/c_1/inbox with JSON {"kind": "delivery_report", "pr_url": "<url>", "summary": "<optional>"}',
      '',
      'Name your branches cf/scout/<task or topic> and put <!-- cyboflow:scout --> in pull request descriptions.',
      'Check for my messages whenever you start working. Keep this token private: it only works for this connection.',
    ].join('\n'));
  });
});

describe('bridgeRemote', () => {
  it('parseBridgeRemote accepts a valid record', () => {
    expect(parseBridgeRemote({ ...validRemote(), extra: 1 })).toEqual(validRemote());
  });

  it('parseBridgeRemote rejects wrong v, missing ids, bad transport', () => {
    expect(parseBridgeRemote({ ...validRemote(), v: 2 })).toBeNull();
    expect(parseBridgeRemote({ ...validRemote(), accountId: undefined })).toBeNull();
    expect(parseBridgeRemote({ ...validRemote(), origin: '' })).toBeNull();
    expect(parseBridgeRemote({ ...validRemote(), relayConnectionId: undefined })).toBeNull();
    expect(parseBridgeRemote({ ...validRemote(), relayConnectionId: 'c/../x' })).toBeNull();
    expect(parseBridgeRemote({ ...validRemote(), transport: 'poll' })).toBeNull();
    expect(parseBridgeRemote(null)).toBeNull();
    expect(parseBridgeRemote({})).toBeNull();
  });

  it('cursor parse: null → 0:0; bridge:v1:17:42 → 17/42; garbage → 0:0 malformed', () => {
    expect(parseBridgeCursor(null)).toEqual({ cursor: { epoch: 0, seq: 0 }, malformed: false });
    expect(parseBridgeCursor('bridge:v1:17:42')).toEqual({ cursor: { epoch: 17, seq: 42 }, malformed: false });
    expect(parseBridgeCursor('42')).toEqual({ cursor: { epoch: 0, seq: 0 }, malformed: true });
    expect(parseBridgeCursor('bridge:v1:x:1')).toEqual({ cursor: { epoch: 0, seq: 0 }, malformed: true });
    expect(encodeBridgeCursor({ epoch: 3, seq: 9 })).toBe('bridge:v1:3:9');
  });

  it('ack token round-trips and rejects malformed values', () => {
    expect(parseAckToken(encodeAckToken({ epoch: 5, upTo: 7 }))).toEqual({ epoch: 5, upTo: 7 });
    expect(parseAckToken('bridge-ack:v1:5:0')).toBeNull();
    expect(parseAckToken('nonsense')).toBeNull();
    expect(parseAckToken(42)).toBeNull();
  });

  it('sanitizeClientName strips bidi overrides, zero-width and C0/C1 controls', () => {
    const raw = `${ch(0x202e)}Evil${ch(0x200b)}App${ch(0x85)}${ch(0x07)}${ch(0x2066)}${ch(0xfeff)}`;
    expect(sanitizeClientName(raw)).toBe('EvilApp');
    expect(sanitizeClientName('  x'.repeat(80))?.length).toBeLessThanOrEqual(100);
    expect(sanitizeClientName(ch(0x200b))).toBeNull();
    expect(sanitizeClientName(42)).toBeNull();
  });

  it('isValidRedirectHost accepts hostnames and loopback literals only', () => {
    expect(isValidRedirectHost('chatgpt.com')).toBe(true);
    expect(isValidRedirectHost('localhost')).toBe(true);
    expect(isValidRedirectHost('[::1]')).toBe(true);
    expect(isValidRedirectHost('evil.com/path')).toBe(false);
    expect(isValidRedirectHost(`a${ch(0x202e)}.com`)).toBe(false);
    expect(isValidRedirectHost('a'.repeat(254))).toBe(false);
    expect(isValidRedirectHost(5)).toBe(false);
  });

  it('sanitizePairedClient drops an invalid host and cleans the name', () => {
    expect(sanitizePairedClient(undefined)).toEqual({ ok: true, value: null });
    expect(sanitizePairedClient({ name: 'x', redirectHost: 'bad host', pairedAt: 1 })).toEqual({ ok: false });
    expect(sanitizePairedClient({ name: `${ch(0x202e)}Chat`, redirectHost: 'chatgpt.com', pairedAt: 5 }))
      .toEqual({ ok: true, value: { name: 'Chat', redirectHost: 'chatgpt.com', pairedAt: 5 } });
  });

  it('sanitizeLabel strips control characters and caps at 100', () => {
    expect(sanitizeLabel(`Sc${ch(0x07)}out${ch(0x0a)}`)).toBe('Scout');
    expect(sanitizeLabel('x'.repeat(150))).toHaveLength(100);
    expect(sanitizeLabel('   ')).toBeNull();
  });
});

describe('descriptor', () => {
  it('declares the core fields', () => {
    expect(BRIDGE_DEFINITION).toMatchObject({
      id: 'bridge', kind: 'bridge', version: 1, credentialVendor: null,
      transports: ['relay-mcp', 'relay-http'], limits: { maxMessageBytes: 65536, maxLinks: 20 },
    });
  });
});

describe('toConnectorError gate refusals', () => {
  const gate = (code: string): RelayHttpError => new RelayHttpError({ status: 0, code, kind: 'paused', sent: false });

  it('a stopped runtime reads as turned off, with the availability copy', () => {
    const e = toConnectorError(gate('stopped'), 'pull');
    expect([e.kind, e.code, e.message]).toEqual(['paused', 'disabled', BRIDGE_COPY.disabled]);
  });

  it('each gate code carries its availability copy', () => {
    for (const code of ['disabled', 'signed_out', 'locked', 'needs_sign_in', 'needs_update', 'not_entitled'] as const) {
      const e = toConnectorError(gate(code), 'send');
      expect([e.kind, e.code, e.message, e.maybeDelivered]).toEqual(['paused', code, BRIDGE_COPY[code], false]);
    }
  });

  it('an unknown gate code keeps the generic message', () => {
    const e = toConnectorError(gate('mystery'), 'pull');
    expect([e.kind, e.code, e.message]).toEqual(['paused', 'mystery', 'Bridge pull failed (mystery)']);
  });
});
