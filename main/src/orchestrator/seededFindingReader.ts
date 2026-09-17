/**
 * seededFindingReader — the RunExecutor `FindingReaderLike` backed by
 * reviewItemListing.selectFindingForSeed (migration 034).
 *
 * Resolves a compound run's `seed_finding_ids` to each finding's content so
 * getPrompt can prepend a `# Selected findings` block and the terminal-seam
 * close-out can read seeded-finding status. selectFindingForSeed already
 * SELECTs only kind='finding' rows and lifts proposedTarget / suggestedFix /
 * locations from payload_json; this is the narrowing to the reader contract.
 * Returns null when the row is missing or not a finding.
 */
import type { DatabaseLike } from './types';
import type { FindingReaderLike } from './runExecutor';
import { selectFindingForSeed } from './reviewItemListing';

export function createSeededFindingReader(db: DatabaseLike): FindingReaderLike {
  return {
    read: (id) => {
      const finding = selectFindingForSeed(db, id);
      return finding
        ? {
            id: finding.id,
            title: finding.title,
            body: finding.body,
            severity: finding.severity,
            priority: finding.priority,
            proposedTarget: finding.proposedTarget,
            source: finding.source,
            suggestedFix: finding.suggestedFix,
            locations: finding.locations,
          }
        : null;
    },
  };
}
