/**
 * drainLegacyIdleReviewItems — one-shot cleanup of the retired idle-session
 * review_item mint.
 *
 * The live QuickSessionsTable (quickSessionListing + sessions:list-quick) now
 * owns quick-session state, so IdleSessionDetector no longer mints blocking
 * `human_task` rows with source `idle-session:<id>`. Any such rows left pending
 * from before the switch would otherwise linger forever as stale blocking items
 * (nothing resolves them now the detector is gone). This runs ONCE at
 * orchestrator start and resolves every pending idle-session item through the
 * review-item chokepoint, so the "waiting on you" count and queue self-clean.
 *
 * Pure + injected (db + the applyReviewItem chokepoint) so it needs no service
 * imports and unit-tests against a fake db + spy chokepoint. Fail-soft: a missing
 * review_items table (pre-016 db) or a per-item write error is logged and
 * swallowed — a cleanup pass must never crash boot.
 */
import type { DatabaseLike, LoggerLike } from './types';
import type { ReviewItemTriage } from './reviewItemRouter';
import { IDLE_REVIEW_SOURCE_PREFIX } from '../../../shared/types/reviews';

interface PendingIdleItemRow {
  id: string;
  project_id: number;
}

export interface DrainLegacyIdleReviewItemsDeps {
  db: DatabaseLike;
  applyReviewItem: (
    projectId: number,
    change: ReviewItemTriage,
  ) => Promise<{ reviewItemId: string; event: { id: number; seq: number } }>;
  logger: LoggerLike;
}

/**
 * Resolve every pending `idle-session:%` human_task review item. Returns the
 * count resolved (0 when the table is absent or nothing was pending). Never
 * throws.
 */
export async function drainLegacyIdleReviewItems(
  deps: DrainLegacyIdleReviewItemsDeps,
): Promise<number> {
  const { db, applyReviewItem, logger } = deps;
  let items: PendingIdleItemRow[];
  try {
    items = db
      .prepare(
        `SELECT id, project_id FROM review_items
          WHERE kind = 'human_task' AND status = 'pending'
            AND source LIKE '${IDLE_REVIEW_SOURCE_PREFIX}%'`,
      )
      .all() as PendingIdleItemRow[];
  } catch (err) {
    // Pre-016 db (no review_items table) or a read failure — nothing to drain.
    logger.debug('[drainLegacyIdleReviewItems] skipped (no review_items table?)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }

  let resolved = 0;
  for (const item of items) {
    try {
      await applyReviewItem(item.project_id, {
        op: 'resolve',
        actor: 'orchestrator',
        reviewItemId: item.id,
        resolution: 'idle-session-superseded-by-board',
      });
      resolved += 1;
    } catch (err) {
      logger.warn('[drainLegacyIdleReviewItems] failed to resolve a legacy idle item', {
        reviewItemId: item.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (resolved > 0) {
    logger.info('[drainLegacyIdleReviewItems] drained legacy idle-session review items', { resolved });
  }
  return resolved;
}
