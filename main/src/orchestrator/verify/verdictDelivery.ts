/**
 * verdictDelivery — wires the VerificationScheduler's `onVerdict` hook to the
 * EXISTING router chokepoints (no new table, no direct UPDATEs). It is the
 * concrete side-effect the P5 scheduler stubbed behind the injected `OnVerdict`
 * callback (see verificationScheduler.ts §"Verdict delivery"). The scheduler
 * itself stays electron/service-free (standalone-typecheck invariant) because
 * this module is INJECTED into it from main/src/index.ts, never imported by it.
 *
 * THREE deliveries (P8b promotes the lane gate from advisory to the visual
 * MERGE-GATE — locked decision #2):
 *
 *  1. ArtifactRouter.apply(projectId, { op:'create', ... atype:'screenshots' })
 *     ENRICHES the SAME run-scoped 'screenshots' artifact (idempotent UPSERT by
 *     (runId, atype) — the producer/auto-mint already wrote `{ fileNames }`) with
 *     a `verdict` block. Done on EVERY judged outcome so the screenshots tab can
 *     render the verdict banner + per-image issues. This is the ONLY of the three
 *     deliveries gated on a PRESENT verdict — a skipped/timeout request and a
 *     verdict-LESS FAIL (capture-fail / judge-throw) enrich nothing, but the
 *     verdict-less FAIL STILL drives the merge-gate (#2) + raises a finding (#3) so
 *     a transient capture failure never silently wedges the lane.
 *
 *  2. MERGE-GATE lane drive (applyMergeGateVerdict — P8b). For a SPRINT run (one
 *     with a batch + lanes), the verdict drives the lane off its `awaiting-verify`
 *     park step: PASS → integrated; FAIL under the 3× cap → back to `implement`
 *     with a bumped attempt (the loopback); FAIL at the cap → `failed`;
 *     low_confidence → advisory pass-through. A non-sprint run (no batch) is a
 *     no-op — the lane drive simply does nothing and only the finding informs.
 *     The action returned decides the finding's `blocking` flag below.
 *
 *  3. ReviewItemRouter.applyReviewItem(projectId, { op:'create', kind:'finding' })
 *     raises ONE finding ONLY on a FAIL or low_confidence terminal verdict (PASS
 *     raises none; skipped/timeout raise none). Severity is mapped from the worst
 *     issue; the finding is soft-linked to the run's task when one exists. In
 *     merge-gate mode a FAIL finding is BLOCKING (it holds this lane's integration
 *     until re-verified / escalated — isMergeGateBlocking); low_confidence stays
 *     NON-blocking (advisory human review, never an auto-loop). This is called once
 *     per terminal verdict (the scheduler delivers a request's verdict exactly
 *     once), so it does not spam a finding per drain.
 *
 * Standalone-typecheck invariant: this file imports ONLY the electron-free
 * orchestrator routers + the merge-gate driver + shared types + the narrow
 * DatabaseLike / LoggerLike — no 'electron' / 'better-sqlite3' / 'fs' / services
 * import.
 */
import { ArtifactRouter } from '../artifactRouter';
import { ReviewItemRouter } from '../reviewItemRouter';
import { applyMergeGateVerdict, isMergeGateBlocking } from './mergeGateLaneAdvance';
import type { DatabaseLike, LoggerLike } from '../types';
import type { OnVerdict } from './verificationScheduler';
import type { VerdictV1 } from '../../../../shared/types/visualVerification';
import type { ScreenshotsArtifactPayload } from '../../../../shared/types/artifacts';
import type {
  FindingPayload,
  ReviewItemSeverity,
} from '../../../../shared/types/reviews';

/** Dependencies the verdict-delivery factory needs. */
export interface VerdictDeliveryDeps {
  /** Read-only DB surface — used to resolve the run's soft task link for the finding. */
  db: DatabaseLike;
  logger?: LoggerLike;
}

/** The terminal request statuses that warrant a finding (FAIL + low confidence). */
const FINDING_STATUSES: ReadonlySet<string> = new Set(['failed', 'low_confidence']);

/**
 * Map a VlmJudge issue severity ('low'|'medium'|'high') to the review_items
 * severity domain ('info'|'warning'|'error'). A finding with no issues (e.g. a
 * bare low_confidence verdict) defaults to 'warning'.
 */
function toReviewSeverity(issueSeverity: 'low' | 'medium' | 'high' | undefined): ReviewItemSeverity {
  if (issueSeverity === 'high') return 'error';
  if (issueSeverity === 'medium') return 'warning';
  if (issueSeverity === 'low') return 'info';
  return 'warning';
}

/** Severity rank so the WORST issue drives the finding's severity. */
const ISSUE_RANK: Record<'low' | 'medium' | 'high', number> = { low: 0, medium: 1, high: 2 };

/**
 * Pick the worst (highest-rank) issue severity from a verdict, or undefined when
 * none. A verdict-LESS FAIL (capture-fail / judge-throw — `verdict` undefined) has
 * no issues to rank, so the caller falls back to the default 'warning' severity.
 */
function worstIssueSeverity(verdict: VerdictV1 | undefined): 'low' | 'medium' | 'high' | undefined {
  if (!verdict) return undefined;
  let worst: 'low' | 'medium' | 'high' | undefined;
  for (const issue of verdict.issues) {
    if (worst === undefined || ISSUE_RANK[issue.severity] > ISSUE_RANK[worst]) {
      worst = issue.severity;
    }
  }
  return worst;
}

/**
 * Build the human-facing finding title + body from a terminal verdict. low_confidence
 * gets a "needs human visual review" framing (it is never an auto-loop); fail gets a
 * "visual verification failed" framing. The body threads the judge feedback +
 * per-issue lines so the review queue carries the actionable detail.
 *
 * Tolerates an ABSENT verdict (a capture-fail / judge-throw delivers status 'failed'
 * with `verdict` undefined): the title is still the FAIL framing and the body falls
 * back to a generic "no images were captured / judged" line so the review inbox
 * carries an actionable reason instead of an empty finding. (The concrete
 * capture/judge error is persisted on verification_requests.error_message by the
 * scheduler's markTerminal; it is not threaded to this hook, so the body stays
 * generic-but-actionable rather than re-reading that row.)
 */
function buildFindingText(
  status: string,
  verdict: VerdictV1 | undefined,
): { title: string; body: string } {
  const title =
    status === 'low_confidence'
      ? 'Visual verification needs human review (low confidence)'
      : 'Visual verification failed';
  if (!verdict) {
    return {
      title,
      body: 'Visual verification could not produce a verdict (no screenshots were captured or judged). The lane was sent back to re-implement; investigate the capture/judge step (dev server reachable? selectors/URL valid?).',
    };
  }
  const lines: string[] = [];
  if (verdict.feedback) lines.push(verdict.feedback);
  if (verdict.issues.length > 0) {
    lines.push('');
    for (const issue of verdict.issues) {
      const where = issue.fileName ? ` (${issue.fileName})` : '';
      lines.push(`- [${issue.severity}]${where} ${issue.description}`);
    }
  }
  return { title, body: lines.join('\n') };
}

/**
 * Resolve the run's soft task link (workflow_runs.task_id) so the finding can be
 * attached to the originating task. Returns null when the run has no task (e.g. a
 * planner / quick-session run) or the read fails — the finding is then run-scoped
 * only (entity link omitted, both entityType + entityId left null per the router's
 * "both set together or both omitted" rule).
 */
function resolveRunTaskId(db: DatabaseLike, runId: string, logger?: LoggerLike): string | null {
  try {
    const row = db
      .prepare('SELECT task_id FROM workflow_runs WHERE id = ?')
      .get(runId) as { task_id: string | null } | undefined;
    return row?.task_id ?? null;
  } catch (err) {
    logger?.warn('[verdictDelivery] could not resolve run task link (fail-soft)', {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Build the concrete `OnVerdict` callback the scheduler fires after a terminal
 * outcome. Fail-soft end to end: a router error is logged and swallowed (the
 * scheduler's own deliver() wrapper also catches, but we never want a delivery
 * problem to wedge the drain loop or leave a half-applied state visible).
 */
export function createVerdictDelivery(deps: VerdictDeliveryDeps): OnVerdict {
  const { db, logger } = deps;

  return async ({ runId, projectId, status, verdict, fileNames, input }) => {
    // ---- 1. Enrich the SAME 'screenshots' artifact (idempotent UPSERT) ----
    // Gated on a PRESENT verdict only: a judged outcome (passed/failed/low_confidence
    // WITH a verdict) carries the verdict block to enrich. A verdict-LESS FAIL
    // (capture-fail / judge-throw) and skipped/timeout have nothing to enrich — but
    // a verdict-less FAIL STILL drives the merge-gate + raises a finding below (it
    // must not wedge the lane), so the enrich is the ONLY part gated on `verdict`.
    //
    // op:'create' UPSERTs by (runId, atype); the producer/auto-mint already wrote
    // `{ fileNames }`, so this re-derive refreshes the payload WITH the verdict
    // block. isNew:false so an already-surfaced screenshots tab does not re-pulse
    // its "new" dot just because a verdict arrived.
    if (verdict) {
      try {
        const payload: ScreenshotsArtifactPayload = { fileNames, verdict };
        await ArtifactRouter.getInstance().apply(projectId, {
          op: 'create',
          runId,
          atype: 'screenshots',
          label: `${fileNames.length} screenshot${fileNames.length === 1 ? '' : 's'}`,
          payloadJson: JSON.stringify(payload),
          stepOrigin: 'visual-verify',
          isNew: false,
          actor: 'orchestrator',
        });
      } catch (err) {
        logger?.error('[verdictDelivery] artifact enrich failed (fail-soft)', {
          runId,
          projectId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // ---- 2. MERGE-GATE: drive the sprint lane off `awaiting-verify` ----
    // For a sprint run (batch + lanes) the verdict advances/loops-back/fails the
    // lane through the SprintLaneStore chokepoint; the returned action also decides
    // whether the finding below is blocking. A non-sprint run resolves to a noop.
    // Fully fail-soft inside the driver — a lane problem never blocks the finding.
    const gateAction = applyMergeGateVerdict({
      db,
      runId,
      status,
      verdict,
      taskRef: input?.taskRef,
      logger,
    });

    // ---- 3. Raise ONE finding ONLY on FAIL / low_confidence (PASS: none) ----
    if (!FINDING_STATUSES.has(status)) return;

    try {
      const taskId = resolveRunTaskId(db, runId, logger);
      const severity = toReviewSeverity(worstIssueSeverity(verdict));
      const { title, body } = buildFindingText(status, verdict);
      const findingPayload: FindingPayload = {
        kind: 'finding',
        category: 'visual-regression',
      };
      await ReviewItemRouter.getInstance().applyReviewItem(projectId, {
        op: 'create',
        actor: 'orchestrator',
        kind: 'finding',
        title,
        body,
        // Merge-gate (locked decision #2): a FAIL finding BLOCKS — it holds this
        // lane's integration (loopback re-implement, or terminal failure at the
        // 3× cap) until re-verified / escalated. low_confidence stays NON-blocking
        // (advisory human review; never an auto-loop). A non-sprint run (noop
        // gateAction) also stays non-blocking — there is no lane to gate.
        blocking: isMergeGateBlocking(gateAction),
        severity,
        source: 'visual-verify',
        // Soft-link to the run's task when one exists, else leave the link absent
        // (both fields null) — the finding is still run-scoped via runId.
        entityType: taskId ? 'task' : null,
        entityId: taskId ?? null,
        runId,
        payload: findingPayload,
      });
    } catch (err) {
      logger?.error('[verdictDelivery] finding creation failed (fail-soft)', {
        runId,
        projectId,
        status,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}
