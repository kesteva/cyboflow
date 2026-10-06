/**
 * Canonical JSON + projection hash for the sync integrity checksum.
 *
 * Both sides hash the same text, so serialization must be byte-deterministic:
 * keys sorted by UTF-16 code unit order at every depth, no whitespace. The
 * projection hash covers only live entities (tombstones are excluded) in
 * entityId order so it is independent of iteration order.
 */

import { createHash } from 'node:crypto';

export function canonicalJson(value: unknown): string {
  const out = canon(value);
  return out === undefined ? 'null' : out;
}

function canon(value: unknown): string | undefined {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (value === null) return 'null';
  if (typeof value === 'object') {
    const withToJson = value as { toJSON?: unknown };
    if (typeof withToJson.toJSON === 'function') {
      return canon((withToJson.toJSON as () => unknown).call(value));
    }
    if (Array.isArray(value)) {
      return `[${value.map((v) => canon(v) ?? 'null').join(',')}]`;
    }
    const obj = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(obj).sort()) {
      const c = canon(obj[key]);
      if (c !== undefined) parts.push(`${JSON.stringify(key)}:${c}`);
    }
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function projectionHash(
  entities: Array<{
    entityId: string;
    entityType: string;
    ref: string | null;
    fields: Record<string, unknown>;
    deleted?: boolean;
  }>,
): string {
  const live = entities
    .filter((e) => e.deleted !== true)
    .sort((a, b) => (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0));
  let text = '';
  for (const e of live) {
    text += `${e.entityId}\t${e.entityType}\t${e.ref ?? ''}\t${canonicalJson(e.fields)}\n`;
  }
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');
}
