/**
 * Ids for conflicts a CLIENT files (dependency_edge, orphaned, delete_vs_edit).
 *
 * Deterministic, so two machines that compute the same repair file ONE record
 * and an offline client that re-sends never duplicates:
 * sha256 hex of `kind|entityId|<sorted involved ids joined by ','>|winningHlc`.
 */
import { createHash } from 'node:crypto';

export function clientConflictId(kind: string, entityId: string, involvedIds: string[], winningHlc: string): string {
  const involved = [...involvedIds].sort().join(',');
  return createHash('sha256').update(`${kind}|${entityId}|${involved}|${winningHlc}`, 'utf8').digest('hex');
}
