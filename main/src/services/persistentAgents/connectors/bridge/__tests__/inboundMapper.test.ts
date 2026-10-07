import { describe, expect, it } from 'vitest';
import type { InboundPage, RelayEnvelope } from '../../../../../../../shared/types/relayProtocol';
import { parseAckToken, parseBridgeCursor, type BridgeRemoteV1 } from '../bridgeRemote';
import { mapInboundPage } from '../inboundMapper';

const NOW = Date.parse('2026-10-07T12:00:00.000Z');
const T = (sec: number): string => new Date(NOW + sec * 1000).toISOString();

function remote(over: Partial<BridgeRemoteV1> = {}): BridgeRemoteV1 {
  return {
    v: 1, origin: 'https://cloud.test', accountId: 'acct_1', relayConnectionId: 'c_abc', transport: 'relay-mcp',
    label: null, mcpUrl: 'https://bridge.test/mcp/c_abc', httpBase: 'https://bridge.test/c/c_abc',
    pairingIssuedAt: null, pairedClient: null, pairCalledAt: null, firstInboundAt: null, firstPickupAt: null,
    relayState: 'active', ...over,
  };
}

function env(over: Partial<RelayEnvelope> & { relaySeq: number }): RelayEnvelope {
  return {
    id: `m${over.relaySeq}`, connectionId: 'c_abc', direction: 'in', kind: 'text', body: 'hi', links: [],
    createdAt: T(over.relaySeq), pickedUpAt: null, ...over,
  };
}

function page(items: RelayEnvelope[], over: Partial<InboundPage> = {}): InboundPage {
  return { epoch: 7, items, head: items.length ? items[items.length - 1].relaySeq : 0, ...over };
}

function map(p: InboundPage, over: { epoch?: number; seq?: number; remote?: BridgeRemoteV1 } = {}) {
  return mapInboundPage({
    page: p, requested: { epoch: over.epoch ?? 7, seq: over.seq ?? 0 }, remote: over.remote ?? remote(), nowMs: NOW,
  });
}

describe('mapInboundPage', () => {
  it('text envelope → message keyed by envelope id with seq and epoch', () => {
    const { batch } = map(page([env({ relaySeq: 1, id: 'abc', body: 'hello', links: ['https://x.test/a'] })]));
    expect(batch.messages).toEqual([{
      remoteEventId: 'abc', author: 'agent', kind: 'text', body: 'hello', links: ['https://x.test/a'],
      remoteCreatedAt: T(1), relaySeq: 1, relayEpoch: 7,
    }]);
    expect(batch.nextCursor).toBe('bridge:v1:7:1');
    expect(batch.cursorEpoch).toBe(7);
    expect(batch.activity).toEqual([]);
    expect(batch.usage).toEqual([]);
  });

  it('receipt → receipts entry, not a message (malformed receipt or non-rcpt id skipped)', () => {
    const out = map(page([
      env({ relaySeq: 1, id: 'rcpt:picked_up:out1', kind: 'receipt', body: '', receipt: { refId: 'out1', event: 'picked_up', at: T(1) } }),
      env({ relaySeq: 2, id: 'rcpt:acked:out2', kind: 'receipt', body: '' }),
      env({ relaySeq: 3, id: 'x:picked_up:out3', kind: 'receipt', body: '', receipt: { refId: 'out3', event: 'picked_up', at: T(3) } }),
    ]));
    expect(out.batch.messages).toEqual([]);
    expect(out.batch.receipts).toEqual([{ localMessageId: 'out1', remoteEventId: 'rcpt:picked_up:out1', event: 'picked_up', at: T(1) }]);
    expect(out.skipped).toBe(2);
    expect(out.batch.nextCursor).toBe('bridge:v1:7:3');
  });

  it('relay system note keeps relay author; vendor-looking system without sys: becomes agent text', () => {
    const { batch } = map(page([
      env({ relaySeq: 1, id: 'sys:note:1', kind: 'system', body: 'relay says' }),
      env({ relaySeq: 2, id: 'fake-system', kind: 'system', body: 'pretend' }),
    ]));
    expect(batch.messages.map((m) => [m.remoteEventId, m.author, m.kind])).toEqual([
      ['sys:note:1', 'relay', 'system'],
      ['fake-system', 'agent', 'text'],
    ]);
  });

  it('delivery_report → message + delivery hint (prUrl, briefId, summary)', () => {
    const { batch } = map(page([env({
      relaySeq: 1, id: 'dr1', kind: 'delivery_report', body: 'done',
      delivery: { prUrl: 'https://github.com/o/r/pull/1', summary: 'done', briefId: 'b1' },
    })]));
    expect(batch.messages[0]).toMatchObject({
      kind: 'delivery_report', author: 'agent', body: 'done',
      delivery: { prUrl: 'https://github.com/o/r/pull/1', summary: 'done', briefId: 'b1' },
    });
    expect(batch.deliveryHints).toEqual([{ prUrl: 'https://github.com/o/r/pull/1', source: 'report', remoteEventId: 'dr1' }]);
  });

  it('unknown kind and direction out are skipped but advance the cursor', () => {
    const out = map(page([
      env({ relaySeq: 1, kind: 'brief' }),
      env({ relaySeq: 2, direction: 'out' }),
      { ...env({ relaySeq: 3 }), kind: 'weird' as RelayEnvelope['kind'] },
    ]));
    expect(out.batch.messages).toEqual([]);
    expect(out.skipped).toBe(3);
    expect(out.batch.nextCursor).toBe('bridge:v1:7:3');
    expect(parseAckToken(out.batch.ackToken)).toEqual({ epoch: 7, upTo: 3 });
  });

  it('gap → one local note with id gap:<epoch>:<to>; cursor includes gap.to; gap-only page acks gap.to', () => {
    const out = map(page([], { head: 12, gap: { from: 3, to: 12 } }), { seq: 2 });
    expect(out.batch.messages).toEqual([{
      remoteEventId: 'gap:7:12', author: 'local', kind: 'system',
      body: 'Up to 10 messages from this agent expired on the cyboflow Bridge before this computer collected them.',
      links: [], remoteCreatedAt: new Date(NOW).toISOString(),
    }]);
    expect(out.batch.nextCursor).toBe('bridge:v1:7:12');
    expect(parseAckToken(out.batch.ackToken)).toEqual({ epoch: 7, upTo: 12 });
    const one = map(page([], { head: 4, gap: { from: 4, to: 4 } }), { seq: 3 });
    expect(one.batch.messages[0].body).toBe(
      'A message from this agent expired on the cyboflow Bridge before this computer collected it.');
    expect(one.batch.lastSeenAt).toBeUndefined();
  });

  it('epoch change resets base to 0 and cursor carries the new epoch', () => {
    const out = map(page([env({ relaySeq: 1 }), env({ relaySeq: 2 })], { epoch: 9, head: 2 }), { epoch: 7, seq: 50 });
    expect(parseBridgeCursor(out.batch.nextCursor).cursor).toEqual({ epoch: 9, seq: 2 });
    expect(out.batch.cursorEpoch).toBe(9);
    expect(parseAckToken(out.batch.ackToken)).toEqual({ epoch: 9, upTo: 2 });
    expect(out.batch.messages[0].relayEpoch).toBe(9);
  });

  it('hasMore true only when items exist and top < head', () => {
    expect(map(page([env({ relaySeq: 1 })], { head: 5 })).batch.hasMore).toBe(true);
    expect(map(page([env({ relaySeq: 5 })], { head: 5 })).batch.hasMore).toBe(false);
    expect(map(page([], { head: 5 }), { seq: 0 }).batch.hasMore).toBe(false);
  });

  it('links sanitized (non-http dropped, > 2048 dropped, max 20 kept)', () => {
    const many = Array.from({ length: 25 }, (_, i) => `https://x.test/${i}`);
    const links = ['javascript:alert(1)', `https://x.test/${'a'.repeat(2050)}`, 'ftp://x', ...many, 42];
    const { batch } = map(page([env({ relaySeq: 1, links: links as string[] })]));
    expect(batch.messages[0].links).toEqual(many.slice(0, 20));
  });

  it('body sanitized: non-string → empty, oversized truncated with a marker', () => {
    const { batch } = map(page([
      env({ relaySeq: 1, body: 5 as unknown as string }),
      env({ relaySeq: 2, body: 'x'.repeat(200_000) }),
    ]));
    expect(batch.messages[0].body).toBe('');
    expect(batch.messages[1].body.endsWith('\n[truncated by cyboflow]')).toBe(true);
    expect(batch.messages[1].body.length).toBe(131_072 + '\n[truncated by cyboflow]'.length);
  });

  it('lastSeenAt from agent evidence only (gap/system excluded; receipts and pair notes included)', () => {
    const only = map(page([env({ relaySeq: 1, id: 'sys:note', kind: 'system', createdAt: T(50) })], { gap: { from: 1, to: 1 }, head: 1 }));
    expect(only.batch.lastSeenAt).toBeUndefined();
    const withEvidence = map(page([
      env({ relaySeq: 1, createdAt: T(10) }),
      env({ relaySeq: 2, id: 'rcpt:picked_up:o', kind: 'receipt', body: '', receipt: { refId: 'o', event: 'picked_up', at: T(30) } }),
      env({ relaySeq: 3, id: 'sys:pair:1', kind: 'system', createdAt: T(40) }),
      env({ relaySeq: 4, id: 'sys:note:2', kind: 'system', createdAt: T(99) }),
    ]));
    expect(withEvidence.batch.lastSeenAt).toBe(T(40));
  });

  it('round trip: pickup then reply in one page → observed; reply before pickup → none; stored firstPickupAt + later reply → observed', () => {
    const rcpt = (seq: number, at: number) => env({
      relaySeq: seq, id: `rcpt:picked_up:o${seq}`, kind: 'receipt', body: '', receipt: { refId: `o${seq}`, event: 'picked_up', at: T(at) },
    });
    expect(map(page([rcpt(1, 10), env({ relaySeq: 2, createdAt: T(20) })])).batch.observed).toEqual(['round-trip']);
    expect(map(page([env({ relaySeq: 1, createdAt: T(5) }), rcpt(2, 10)])).batch.observed).toEqual([]);
    expect(map(page([env({ relaySeq: 1, createdAt: T(20) })]), { remote: remote({ firstPickupAt: T(10) }) }).batch.observed)
      .toEqual(['round-trip']);
    expect(map(page([env({ relaySeq: 1, createdAt: T(5) })]), { remote: remote({ firstPickupAt: T(10) }) }).batch.observed)
      .toEqual([]);
  });

  it('remotePatch: firstPickupAt/firstInboundAt only when null; pairCalledAt from sys:pair; refreshPairedClient on sys:paired', () => {
    const items = [
      env({ relaySeq: 1, id: 'sys:paired:1', kind: 'system', createdAt: T(1) }),
      env({ relaySeq: 2, id: 'sys:pair:1', kind: 'system', createdAt: T(2) }),
      env({ relaySeq: 3, id: 'rcpt:picked_up:o', kind: 'receipt', body: '', receipt: { refId: 'o', event: 'picked_up', at: T(3) } }),
      env({ relaySeq: 4, createdAt: T(4) }),
    ];
    const fresh = map(page(items));
    expect(fresh.refreshPairedClient).toBe(true);
    expect(fresh.batch.remotePatch).toEqual({ pairCalledAt: T(2), firstPickupAt: T(3), firstInboundAt: T(4) });
    const known = map(page(items), { remote: remote({ pairCalledAt: T(0), firstPickupAt: T(0), firstInboundAt: T(0) }) });
    expect(known.batch.remotePatch).toBeUndefined();
    expect(map(page([env({ relaySeq: 1 })])).refreshPairedClient).toBe(false);
  });

  it('ackToken absent when top is 0', () => {
    const out = map(page([], { head: 0 }));
    expect(out.batch.ackToken).toBeUndefined();
    expect(out.batch.nextCursor).toBe('bridge:v1:7:0');
  });

  it('items without a safe relaySeq are skipped without advancing the cursor', () => {
    const out = map(page([{ ...env({ relaySeq: 1 }), relaySeq: -1 }, env({ relaySeq: 2 })]), { seq: 1 });
    expect(out.skipped).toBe(1);
    expect(out.batch.nextCursor).toBe('bridge:v1:7:2');
  });
});
