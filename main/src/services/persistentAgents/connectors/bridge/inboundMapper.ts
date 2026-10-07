/**
 * Pure mapping of one relay inbound page to the core's InboundBatch. Inbound text is untrusted: this only
 * normalises it (types, sizes, link shapes); it never interprets it.
 */
import type { InboundPage } from '../../../../../../shared/types/relayProtocol';
import type { VerifiedFlag } from '../../../../../../shared/types/persistentAgents';
import type { InboundBatch, InboundMessage, InboundReceipt } from '../../connectorContract';
import {
  encodeAckToken,
  encodeBridgeCursor,
  type BridgeCursor,
  type BridgeRemoteV1,
} from './bridgeRemote';
import { gapNoteText } from './copy';
import {
  BRIDGE_LINK_RE,
  BRIDGE_MAX_LINK_CHARS,
  BRIDGE_MAX_LINKS,
  INBOUND_TRUNCATION_SUFFIX,
  MAX_INBOUND_BODY_CHARS,
} from './constants';

export interface MapInput {
  page: InboundPage;
  /** What was asked (after any after-override): epoch + `after`. */
  requested: BridgeCursor;
  remote: BridgeRemoteV1;
  nowMs: number;
}

export interface MapOutput {
  batch: InboundBatch;
  /** A relay "paired" note arrived: re-read pairedClient from GET /connections. */
  refreshPairedClient: boolean;
  /** Malformed / unknown items (logged as a count only). */
  skipped: number;
}

interface Stamp { ms: number; iso: string }

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function stampOf(raw: unknown, nowMs: number): Stamp {
  if (typeof raw === 'string') {
    const ms = Date.parse(raw);
    if (!Number.isNaN(ms)) return { ms, iso: raw };
  }
  return { ms: nowMs, iso: new Date(nowMs).toISOString() };
}

function minStamp(xs: Stamp[]): Stamp | null {
  let best: Stamp | null = null;
  for (const x of xs) if (best === null || x.ms < best.ms) best = x;
  return best;
}

function maxStamp(xs: Stamp[]): Stamp | null {
  let best: Stamp | null = null;
  for (const x of xs) if (best === null || x.ms > best.ms) best = x;
  return best;
}

export function sanitizeInboundBody(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  if (raw.length <= MAX_INBOUND_BODY_CHARS) return raw;
  return raw.slice(0, MAX_INBOUND_BODY_CHARS) + INBOUND_TRUNCATION_SUFFIX;
}

export function sanitizeInboundLinks(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const l of raw) {
    if (out.length >= BRIDGE_MAX_LINKS) break;
    if (typeof l === 'string' && l.length <= BRIDGE_MAX_LINK_CHARS && BRIDGE_LINK_RE.test(l)) out.push(l);
  }
  return out;
}

function isSafeSeq(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

const RECEIPT_EVENTS: ReadonlySet<string> = new Set(['picked_up', 'acked', 'declined']);

export function mapInboundPage(input: MapInput): MapOutput {
  const { page, requested, remote, nowMs } = input;
  const epochChanged = page.epoch !== requested.epoch;
  const base = epochChanged ? 0 : requested.seq;
  let top = base;
  let skipped = 0;
  let refreshPairedClient = false;
  const messages: InboundMessage[] = [];
  const receipts: InboundReceipt[] = [];
  const deliveryHints: InboundBatch['deliveryHints'] = [];
  const remotePatch: Record<string, unknown> = {};
  const evidence: Stamp[] = [];
  const agentMessages: Stamp[] = [];
  const pickups: Stamp[] = [];

  for (const raw of page.items as unknown[]) {
    if (!isObj(raw) || !isSafeSeq(raw.relaySeq)) {
      skipped += 1;
      continue;
    }
    const seq = raw.relaySeq;
    top = Math.max(top, seq);
    if (raw.direction !== 'in' || typeof raw.id !== 'string' || raw.id === '') {
      skipped += 1;
      continue;
    }
    const id = raw.id;
    const kind = raw.kind;

    if (kind === 'receipt') {
      const r = raw.receipt;
      if (id.startsWith('rcpt:') && isObj(r) && typeof r.refId === 'string' && typeof r.event === 'string'
        && RECEIPT_EVENTS.has(r.event) && typeof r.at === 'string') {
        const at = stampOf(r.at, nowMs);
        receipts.push({
          localMessageId: r.refId,
          remoteEventId: id,
          event: r.event as InboundReceipt['event'],
          at: at.iso,
        });
        evidence.push(at);
        if (r.event === 'picked_up') pickups.push(at);
      } else {
        skipped += 1;
      }
      continue;
    }

    const created = stampOf(raw.createdAt, nowMs);
    const body = sanitizeInboundBody(raw.body);
    const links = sanitizeInboundLinks(raw.links);
    const common = { remoteEventId: id, body, links, remoteCreatedAt: created.iso, relaySeq: seq, relayEpoch: page.epoch };

    if (kind === 'system' && id.startsWith('sys:')) {
      messages.push({ ...common, author: 'relay', kind: 'system' });
      if (id.startsWith('sys:paired:')) {
        refreshPairedClient = true;
        evidence.push(created);
      } else if (id.startsWith('sys:pair:')) {
        evidence.push(created);
        if (remote.pairCalledAt === null && remotePatch.pairCalledAt === undefined) remotePatch.pairCalledAt = created.iso;
      }
      continue;
    }

    if (kind === 'text' || kind === 'system') {
      // Only the relay may author system notes; a system envelope without a relay id is agent text.
      messages.push({ ...common, author: 'agent', kind: 'text' });
      agentMessages.push(created);
      evidence.push(created);
      continue;
    }

    if (kind === 'delivery_report') {
      const d = raw.delivery;
      const msg: InboundMessage = { ...common, author: 'agent', kind: 'delivery_report' };
      if (isObj(d) && typeof d.prUrl === 'string' && d.prUrl.length <= BRIDGE_MAX_LINK_CHARS && BRIDGE_LINK_RE.test(d.prUrl)) {
        msg.delivery = {
          prUrl: d.prUrl,
          ...(typeof d.summary === 'string' ? { summary: sanitizeInboundBody(d.summary) } : {}),
          ...(typeof d.briefId === 'string' ? { briefId: d.briefId.slice(0, 128) } : {}),
        };
        deliveryHints.push({ prUrl: d.prUrl, source: 'report', remoteEventId: id });
      }
      messages.push(msg);
      agentMessages.push(created);
      evidence.push(created);
      continue;
    }

    skipped += 1;
  }

  const gap = page.gap;
  if (gap && isSafeSeq(gap.from) && isSafeSeq(gap.to) && gap.from <= gap.to) {
    const n = gap.to - gap.from + 1;
    messages.push({
      remoteEventId: `gap:${page.epoch}:${gap.to}`,
      author: 'local',
      kind: 'system',
      body: gapNoteText(n),
      links: [],
      remoteCreatedAt: new Date(nowMs).toISOString(),
    });
    top = Math.max(top, gap.to);
  }

  // Round trip: an agent reply at/after the first pickup.
  const observed: VerifiedFlag[] = [];
  const batchPickup = minStamp(pickups);
  const storedPickupMs = remote.firstPickupAt !== null ? Date.parse(remote.firstPickupAt) : Number.NaN;
  const pickupMs = !Number.isNaN(storedPickupMs) ? storedPickupMs : (batchPickup ? batchPickup.ms : null);
  if (pickupMs !== null && agentMessages.some((m) => m.ms >= pickupMs)) observed.push('round-trip');
  if (remote.firstPickupAt === null && batchPickup) remotePatch.firstPickupAt = batchPickup.iso;

  const firstAgent = minStamp(agentMessages);
  if (remote.firstInboundAt === null && firstAgent) remotePatch.firstInboundAt = firstAgent.iso;

  const lastSeen = maxStamp(evidence);

  const batch: InboundBatch = {
    messages,
    activity: [],
    usage: [],
    deliveryHints,
    receipts,
    nextCursor: encodeBridgeCursor({ epoch: page.epoch, seq: top }),
    cursorEpoch: page.epoch,
    observed,
    hasMore: page.items.length > 0 && top < page.head,
  };
  if (top > 0) batch.ackToken = encodeAckToken({ epoch: page.epoch, upTo: top });
  if (Object.keys(remotePatch).length > 0) batch.remotePatch = remotePatch;
  if (lastSeen) batch.lastSeenAt = new Date(lastSeen.ms).toISOString();
  return { batch, refreshPairedClient, skipped };
}
