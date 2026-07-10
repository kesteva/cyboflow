/**
 * IdleSessionDetector — periodic service that surfaces idle PTY quick sessions
 * into the human review queue.
 *
 * An interactive (PTY) quick session rests to sessions.status='completed' on each
 * assistant turn-end (see the turn-end rester in main/src/index.ts). A session
 * that finished a turn and has sat UNVIEWED longer than the configured threshold
 * is one the user needs to look at — but nothing surfaces it unless the agent
 * happened to file a finding via the cyboflow MCP hook. This detector closes that
 * gap: every scan it mints a blocking `human_task` review item for each such
 * session (idempotent per session via source='idle-session:<id>'), and it
 * auto-resolves the item once the session leaves scope (reopened/viewed, a new
 * turn starts, or the session is archived) so the queue self-cleans without
 * wiring view/resume events.
 *
 * Modeled on StuckDetector (same 60s tick, injected-deps, no imports from
 * 'electron' / 'better-sqlite3' / any concrete service in main/src/services/*).
 * All collaborators arrive via IdleSessionDetectorDeps so the scan is unit
 * testable against a fake db + fake review-item chokepoint.
 */
import type { DatabaseLike, LoggerLike, PreparedStatement } from './types';
import type { ReviewItemCreate, ReviewItemTriage } from './reviewItemRouter';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How often the detector scans for idle sessions. Matches StuckDetector. */
const SCAN_INTERVAL_MS = 60_000; // 60 seconds

/** Source-tag prefix — one pending review item per session, keyed by this. */
const SOURCE_PREFIX = 'idle-session:';

// ---------------------------------------------------------------------------
// Dependency bag
// ---------------------------------------------------------------------------

/** Live idle-review settings, re-read each scan so a Settings edit applies next tick. */
export interface IdleSessionReviewSettings {
  enabled: boolean;
  thresholdMinutes: number;
}

export interface IdleSessionDetectorDeps {
  db: DatabaseLike;
  /**
   * The review-item write chokepoint (ReviewItemRouter.applyReviewItem), injected
   * so the detector never imports the concrete router and tests can substitute a
   * spy. Narrowed to the two ops this service issues (create + resolve).
   */
  applyReviewItem: (
    projectId: number,
    change: ReviewItemCreate | ReviewItemTriage,
  ) => Promise<{ reviewItemId: string; event: { id: number; seq: number } }>;
  /** Reads the resolved idle-session-review config (ConfigManager.getIdleSessionReviewConfig). */
  getConfig: () => IdleSessionReviewSettings;
  logger: LoggerLike;
  /** Injectable clock for deterministic tests; defaults to Date.now. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Internal row shapes
// ---------------------------------------------------------------------------

/** A candidate idle session row. `updated_at_iso` is normalized to UTC ISO. */
interface IdleSessionRow {
  id: string;
  project_id: number;
  name: string;
  chat_run_id: string | null;
  updated_at_iso: string;
}

/** A pending idle-session review item row (for the auto-resolve pass). */
interface PendingIdleItemRow {
  id: string;
  project_id: number;
  source: string;
}

// ---------------------------------------------------------------------------
// SQL predicates
// ---------------------------------------------------------------------------

/**
 * The "in scope" predicate shared by minting and auto-resolve: an interactive,
 * list-visible quick session (not the hidden main-repo singleton, not archived)
 * that rested to 'completed' and has NOT been viewed since (last_viewed_at is
 * NULL or older than the resting updated_at → renders as completed_unviewed).
 * Columns are qualified `s.` so this composes with the workflow_runs LEFT JOIN
 * in the candidate query (workflow_runs also has substrate/status/updated_at,
 * which would otherwise be ambiguous).
 *
 * NOTE: the `last_viewed_at < updated_at` unviewed rule is the SQL twin of
 * sessionManager.mapDbStatusToSessionStatus's completed_unviewed logic — keep
 * the two definitions in sync (they intentionally mirror the same badge).
 *
 * Timestamps are wrapped in SQLite datetime() so the comparison is correct
 * regardless of the stored string format: sessions.updated_at / last_viewed_at
 * are written via CURRENT_TIMESTAMP / datetime() ('YYYY-MM-DD HH:MM:SS'), which
 * is NOT lexicographically comparable to an ISO 'YYYY-MM-DDTHH:MM:SSZ' cutoff
 * (' ' < 'T' at index 10). datetime() normalizes both sides to one canonical form.
 */
const IN_SCOPE_PREDICATE = `
  s.substrate = 'interactive'
  AND s.is_quick = 1
  AND (s.is_main_repo IS NULL OR s.is_main_repo = 0)
  AND (s.archived IS NULL OR s.archived = 0)
  AND s.status = 'completed'
  AND (s.last_viewed_at IS NULL OR datetime(s.last_viewed_at) < datetime(s.updated_at))
  AND s.project_id IS NOT NULL
`;

// ---------------------------------------------------------------------------
// IdleSessionDetector
// ---------------------------------------------------------------------------

export class IdleSessionDetector {
  private readonly db: DatabaseLike;
  private readonly applyReviewItem: IdleSessionDetectorDeps['applyReviewItem'];
  private readonly getConfig: () => IdleSessionReviewSettings;
  private readonly logger: LoggerLike;
  private readonly now: () => number;

  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  /** Re-entrancy guard: setInterval does not await scan(); a scan slower than
   *  SCAN_INTERVAL_MS must not overlap the next tick (that would let two scans
   *  both pass the per-episode mint guard before either INSERT commits). */
  private scanning = false;

  // Hoisted prepared statements — SQL is static.
  private readonly stmtIdleCandidates: PreparedStatement;
  private readonly stmtPendingIdleItems: PreparedStatement;
  private readonly stmtStillInScope: PreparedStatement;

  constructor(deps: IdleSessionDetectorDeps) {
    this.db = deps.db;
    this.applyReviewItem = deps.applyReviewItem;
    this.getConfig = deps.getConfig;
    this.logger = deps.logger;
    this.now = deps.now ?? Date.now;

    // Candidate = an in-scope, idle session for which THIS idle episode has not
    // already been surfaced. "Episode" is keyed by the resting updated_at: the
    // NOT EXISTS matches ANY prior idle item (pending OR already-triaged) minted
    // at/after the current updated_at, so a manually resolved/dismissed item is
    // NOT re-minted for the same episode (finding: dismissed items respawning).
    // A genuinely new turn bumps updated_at past the old item's created_at, so
    // the new episode surfaces afresh. The LEFT JOIN nulls out a dangling
    // chat_run_id (sessions.chat_run_id has no FK; review_items.run_id does, so
    // passing a pruned run id would throw and silently drop the session).
    this.stmtIdleCandidates = this.db.prepare(
      `SELECT s.id, s.project_id, s.name,
              CASE WHEN wr.id IS NOT NULL THEN s.chat_run_id ELSE NULL END AS chat_run_id,
              strftime('%Y-%m-%dT%H:%M:%SZ', s.updated_at) AS updated_at_iso
         FROM sessions s
         LEFT JOIN workflow_runs wr ON wr.id = s.chat_run_id
        WHERE ${IN_SCOPE_PREDICATE}
          AND datetime(s.updated_at) < datetime(?)
          AND NOT EXISTS (
                SELECT 1 FROM review_items ri
                 WHERE ri.source = '${SOURCE_PREFIX}' || s.id
                   AND datetime(ri.created_at) >= datetime(s.updated_at)
              )`,
    );
    this.stmtPendingIdleItems = this.db.prepare(
      `SELECT id, project_id, source FROM review_items
        WHERE kind = 'human_task' AND status = 'pending'
          AND source LIKE '${SOURCE_PREFIX}%'`,
    );
    this.stmtStillInScope = this.db.prepare(
      `SELECT 1 FROM sessions s
        WHERE s.id = ? AND ${IN_SCOPE_PREDICATE}
        LIMIT 1`,
    );

    this.scan = this.scan.bind(this);
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  /** Start the recurring scan interval. A second start() is a no-op. */
  start(): void {
    if (this.intervalHandle !== null) return;
    this.intervalHandle = setInterval(this.scan, SCAN_INTERVAL_MS);
  }

  /** Stop the recurring scan interval. Safe to call when never started. */
  stop(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  // --------------------------------------------------------------------------
  // Scan
  // --------------------------------------------------------------------------

  /**
   * One scan pass.
   *
   * Disabled → drain EVERY pending idle item (turning the feature off clears its
   * nags, still-idle or not) and return. Enabled → resolve items whose session
   * left scope (viewed / new turn / archived), then mint for idle episodes not
   * yet surfaced. The whole body is wrapped so a single bad scan never stops the
   * interval; each per-item write is further guarded so one project's failure
   * does not abort the rest. Re-entrancy-guarded so overlapping ticks can't
   * double-mint (the mint guard is a SELECT before an async commit).
   */
  async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const { enabled, thresholdMinutes } = this.getConfig();
      if (!enabled) {
        await this.resolvePendingIdleItems(true /* drainAll */);
        return;
      }
      await this.resolvePendingIdleItems(false /* only sessions that left scope */);

      const cutoffIso = new Date(this.now() - thresholdMinutes * 60_000).toISOString();
      const rows = this.stmtIdleCandidates.all(cutoffIso) as IdleSessionRow[];

      for (const s of rows) {
        const source = `${SOURCE_PREFIX}${s.id}`;
        const idleMin = Math.max(
          thresholdMinutes,
          Math.round((this.now() - new Date(s.updated_at_iso).getTime()) / 60_000),
        );
        try {
          await this.applyReviewItem(s.project_id, {
            op: 'create',
            actor: 'orchestrator',
            kind: 'human_task',
            title: `Idle session needs your attention: ${s.name}`,
            body:
              `This quick session finished its turn and has been sitting unviewed ` +
              `for about ${idleMin} min. Open it to continue the work or wrap it up. ` +
              `(Surfaced automatically because it went idle — no finding was filed.)`,
            blocking: true,
            source,
            ...(s.chat_run_id ? { runId: s.chat_run_id } : {}),
            payload: { kind: 'human_task' },
          });
          this.logger.info('[IdleSessionDetector] surfaced idle session for review', {
            sessionId: s.id,
            projectId: s.project_id,
            idleMinutes: idleMin,
          });
        } catch (err) {
          this.logger.warn('[IdleSessionDetector] failed to mint idle review item', {
            sessionId: s.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      this.logger.warn('[IdleSessionDetector] scan failed', {
        error: err instanceof Error ? (err.stack ?? err.message) : String(err),
      });
    } finally {
      this.scanning = false;
    }
  }

  /**
   * Resolve pending idle-session review items. When `drainAll` is false (feature
   * enabled) only items whose session LEFT scope are resolved (reopened/viewed,
   * new turn running, or archived/deleted) — the queue's self-cleaning pass, no
   * view/resume event wiring needed. When `drainAll` is true (feature disabled)
   * every pending idle item is resolved, so turning the toggle off clears its
   * nags rather than stranding still-idle blocking rows.
   */
  private async resolvePendingIdleItems(drainAll: boolean): Promise<void> {
    const items = this.stmtPendingIdleItems.all() as PendingIdleItemRow[];
    for (const item of items) {
      const sessionId = item.source.slice(SOURCE_PREFIX.length);
      if (!drainAll && this.stmtStillInScope.get(sessionId)) continue; // still idle+unviewed → keep
      try {
        await this.applyReviewItem(item.project_id, {
          op: 'resolve',
          actor: 'orchestrator',
          reviewItemId: item.id,
          resolution: 'idle-session-attended',
        });
      } catch (err) {
        this.logger.warn('[IdleSessionDetector] failed to auto-resolve idle review item', {
          reviewItemId: item.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
