/**
 * Canonical spec-hash helper for edit-workflow proposals (migration 071 —
 * `agent_proposals.preconditions_json`).
 *
 * This is the CAS material `cyboflow_propose_action` captures at propose time
 * (a hash of the workflow definition the agent drafted its edit against) and
 * `proposalExecutor` re-computes at confirm time, inside the confirm
 * transaction, to detect a stale edit before applying it. It MUST stay
 * deterministic across processes and releases: no locale-dependent
 * formatting, no reliance on JS object-key insertion order, no `Date.now()`
 * or other ambient state folded into the digest.
 *
 * Distinct from `main/src/orchestrator/specHash.ts` (workflow_runs.spec_hash):
 * that helper hashes the exact `spec_json` STRING byte-for-byte (no
 * canonicalization — it content-addresses what actually ran). This helper
 * instead canonicalizes an arbitrary JS VALUE first, so two definitions that
 * are structurally equal but serialized with different key order or
 * whitespace still hash identically — the comparison this CAS check needs.
 */
import { createHash } from 'node:crypto';

/**
 * Recursively sort object keys (arrays keep their element order) so that
 * structurally-equal values always produce the same tree shape, then hand
 * off to `JSON.stringify` for primitive serialization — inheriting its exact
 * quirks (NaN/Infinity → null, function/undefined/symbol values omitted from
 * objects and nulled in arrays, etc.) rather than re-implementing them.
 */
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  const source = value as Record<string, unknown>;
  const sortedKeys = Object.keys(source).sort();
  const result: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    result[key] = canonicalize(source[key]);
  }
  return result;
}

/**
 * Deterministic JSON serialization: object keys sorted recursively at every
 * depth, array order preserved, primitives serialized per `JSON.stringify`
 * (including its `undefined`-object-value-omission behavior).
 */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** Sha256 hex digest of `canonicalJsonStringify(value)`. */
export function computeSpecHash(value: unknown): string {
  return createHash('sha256').update(canonicalJsonStringify(value), 'utf8').digest('hex');
}
