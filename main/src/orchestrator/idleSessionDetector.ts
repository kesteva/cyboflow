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
 *
 * Timestamps are wrapped in SQLite datetime() so the comparison is correct
 * regardless of the stored string format: sessions.updated_at / last_viewed_at
 * are written via CURRENT_TIMESTAMP / datetime() ('YYYY-MM-DD HH:MM:SS'), which
 * is NOT lexicographically comparable to an ISO 'YYYY-MM-DDTHH:MM:SSZ' cutoff
 * (' ' < 'T' at index 10). datetime() normalizes both sides to one canonical form.
 */
const IN_SCOPE_PREDICATE = `
  substrate = 'interactive'
  AND is_quick = 1
  AND (is_main_repo IS NULL OR is_main_repo = 0)
  AND (archived IS NULL OR archived = 0)
  AND status = 'completed'
  AND (last_viewed_at IS NULL OR datetime(last_viewed_at) < datetime(updated_at))
  AND project_id IS NOT NULL
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

  // Hoisted prepared statements — SQL is static.
  private readonly stmtIdleCandidates: PreparedStatement;
  private readonly stmtHasPendingForSource: PreparedStatement;
  private readonly stmtPendingIdleItems: PreparedStatement;
  private readonly stmtStillInScope: PreparedStatement;

  constructor(deps: IdleSessionDetectorDeps) {
    this.db = deps.db;
    this.applyReviewItem = deps.applyReviewItem;
    this.getConfig = deps.getConfig;
    this.logger = deps.logger;
    this.now = deps.now ?? Date.now;

    this.stmtIdleCandidates = this.db.prepare(
      `SELECT id, project_id, name, chat_run_id,
              strftime('%Y-%m-%dT%H:%M:%SZ', updated_at) AS updated_at_iso
         FROM sessions
        WHERE ${IN_SCOPE_PREDICATE}
          AND datetime(updated_at) < datetime(?)`,
    );
    this.stmtHasPendingForSource = this.db.prepare(
      `SELECT 1 FROM review_items
        WHERE source = ? AND status = 'pending'
        LIMIT 1`,
    );
    this.stmtPendingIdleItems = this.db.prepare(
      `SELECT id, project_id, source FROM review_items
        WHERE kind = 'human_task' AND status = 'pending'
          AND source LIKE '${SOURCE_PREFIX}%'`,
    );
    this.stmtStillInScope = this.db.prepare(
      `SELECT 1 FROM sessions
        WHERE id = ? AND ${IN_SCOPE_PREDICATE}
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
   * One scan pass. Auto-resolve stale items FIRST (a session attended to since
   * the last tick), then mint for newly-idle sessions. The whole body is wrapped
   * so a single bad scan never stops the interval; each per-item write is further
   * guarded so one project's failure does not abort the rest.
   */
  async scan(): Promise<void> {
    try {
      const { enabled, thresholdMinutes } = this.getConfig();
      // Even when disabled we still auto-resolve outstanding items so flipping the
      // toggle off drains the queue instead of stranding blocking rows.
      await this.resolveAttendedItems();
      if (!enabled) return;

      const cutoffIso = new Date(this.now() - thresholdMinutes * 60_000).toISOString();
      const rows = this.stmtIdleCandidates.all(cutoffIso) as IdleSessionRow[];

      for (const s of rows) {
        const source = `${SOURCE_PREFIX}${s.id}`;
        if (this.stmtHasPendingForSource.get(source)) continue; // idempotent

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
    }
  }

  /**
   * Resolve every pending idle-session review item whose session has left scope
   * (reopened/viewed, a new turn is running, or the session was archived/deleted).
   * This is the queue's self-cleaning pass — no view/resume event wiring needed.
   */
  private async resolveAttendedItems(): Promise<void> {
    const items = this.stmtPendingIdleItems.all() as PendingIdleItemRow[];
    for (const item of items) {
      const sessionId = item.source.slice(SOURCE_PREFIX.length);
      if (this.stmtStillInScope.get(sessionId)) continue; // still idle+unviewed → keep
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
