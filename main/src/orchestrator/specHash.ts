/**
 * specHash — the single source of the `spec_hash` content address used by
 * `workflow_runs.spec_hash` (frozen at run creation) and the
 * `workflow_revisions` snapshot key (migration 026).
 *
 * A run is stamped with the sha256 of the EXACT `spec_json` string the workflow
 * carried at createRun. The hash lets Insights bucket runs by the precise
 * workflow revision they executed even after the live `spec_json` is later
 * edited, and keys the `workflow_revisions` snapshot so a frozen hash always
 * resolves back to the spec text that produced it.
 *
 * Standalone-typecheck invariant (mirrors workflowRegistry.ts): no import from
 * 'electron' or any concrete service in main/src/services/* — only node:crypto.
 */
import { createHash } from 'node:crypto';

/**
 * Compute the sha256 hex digest of a workflow's `spec_json`.
 *
 * Normalization is INTENTIONALLY minimal: null/undefined collapse to the empty
 * spec `'{}'` FIRST, then the digest is taken over the EXACT remaining string.
 * We deliberately do NOT JSON.parse + re-serialize to canonicalize — the stored
 * `spec_json` is itself the canonical string (always produced by
 * `JSON.stringify(definition)` on the write path), so two runs share a hash iff
 * they ran byte-identical spec text. The `'{}'` floor means an unset/reset
 * workflow (column default `'{}'`) and an explicit null both hash identically,
 * which is the desired equivalence: they describe the same (empty) spec.
 *
 * @param specJson - The raw `workflows.spec_json` value (the column is NOT NULL
 *                   with a `'{}'` default, but null/undefined are accepted and
 *                   normalized so callers never have to guard).
 * @returns Lowercase 64-char sha256 hex digest.
 */
export function computeSpecHash(specJson: string | null | undefined): string {
  const normalized = specJson ?? '{}';
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}
