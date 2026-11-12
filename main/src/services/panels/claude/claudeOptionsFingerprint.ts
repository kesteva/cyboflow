/**
 * The warm-session options fingerprint (extracted from claudeCodeManager.ts): a per-field SHA-1 of the
 * spawn-baked mutable SDK inputs plus a combined digest. Pure — the manager builds the material.
 */
import { createHash } from 'crypto';

/**
 * A per-field hash of the spawn-baked MUTABLE SDK inputs (model, betas, settings
 * overlay, composed mcpServers, deny guards, systemPrompt, env, permissionMode,
 * merged permission allowRules) plus a `combined` digest. Warm reuse requires a
 * `combined` match; a mismatch is diffed field-by-field to name the changed input
 * for the cold-respawn reason. Everything a warm turn cannot mutate live (the v1
 * choice is respawn, not SDK mutators) lives here.
 */
export interface OptionsFingerprint {
  combined: string;
  fields: Readonly<Record<string, string>>;
}

/** SHA-1 hex of a string — a bounded, stable fingerprint digest (not for crypto). */
function sha1(input: string): string {
  return createHash('sha1').update(input).digest('hex');
}

/**
 * Recursively sort object keys and drop functions so structurally-equal values
 * serialize identically regardless of key insertion order (composeMcpServers etc.
 * build records in a non-deterministic order). Used for the options fingerprint.
 */
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'function' ? null : value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    if (typeof record[key] === 'function') continue;
    out[key] = canonicalize(record[key]);
  }
  return out;
}

/** Stable JSON of a value with sorted keys — the fingerprint's per-field input. */
function stableSerialize(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? 'null';
}

/** Name the first fingerprint field whose hash differs (for the cold-respawn reason). */
export function firstChangedFingerprintField(prev: OptionsFingerprint, next: OptionsFingerprint): string {
  for (const key of Object.keys(next.fields).sort()) {
    if (prev.fields[key] !== next.fields[key]) return key;
  }
  return 'combined';
}

/** Hash each material field (stable JSON) and fold the sorted field hashes into `combined`. */
export function foldOptionsFingerprint(material: Readonly<Record<string, unknown>>): OptionsFingerprint {
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(material)) {
    fields[key] = sha1(stableSerialize(value));
  }
  const combined = sha1(
    Object.keys(fields)
      .sort()
      .map((k) => `${k}=${fields[k]}`)
      .join('&'),
  );
  return { combined, fields };
}
