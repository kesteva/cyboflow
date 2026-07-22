/**
 * enqueueTaskVerification — the main-process seam that turns a task-verify-composed
 * `VerificationTaskV1` into a queued verification request for ONE sprint lane,
 * WITHOUT the MCP hop (verification-agent redesign §5.3/§5.4). The programmatic
 * `WorkflowController` calls this (via an injected `ControllerHost` capability) from
 * the agentless visual-verify inner step; orchestrated mode keeps using the MCP
 * `cyboflow_request_verification` handler instead.
 *
 * This mirrors `mcpQueryHandler.handleRequestVerification` (the dual-format enqueue)
 * for a request that ALWAYS carries a task, minus the socket plumbing:
 *   - read the run's IMMUTABLE verify stamps (verify_enabled / verify_type /
 *     verify_chain) + project id defensively; disabled/missing ⇒ a fail-open SKIP;
 *   - resolve the chain = FALLBACK_CHAINS[type] ∩ the stamped chain (an empty
 *     intersection still enqueues — the scheduler treats an empty chain as a SKIP,
 *     never a fabricated fail — exactly like the MCP handler);
 *   - capture the snapshot sha at enqueue time (§5.5); a capture failure falls back
 *     to a null sha and STILL enqueues (the provisioner's dirty-worktree bucket);
 *   - FORCE the lane identity: the controller's `laneTaskRef` is authoritative for
 *     gate attribution, so it overrides `task.taskRef` AND drives the derived legacy
 *     input, so `task_json` and `deliverable_json` carry the SAME ref regardless of
 *     what the composing agent wrote;
 *   - dedupe on `${runId}:${laneTaskRef}:${attempt}` so a crash re-walk never
 *     double-enqueues while a genuinely fresh attempt (bumped by the merge-gate
 *     loopback) re-fires (§5.3).
 *
 * Electron-free: it takes a narrow `DatabaseLike` + reads the VerificationScheduler
 * singleton (initialized in main/src/index.ts). It is injected into the controller
 * host so the controller itself stays DB/electron-free and unit-testable with a fake.
 */
import { VerificationScheduler } from './verificationScheduler';
import { captureSnapshotSha } from './snapshotProvisioner';
import {
  deriveLegacyInputFromTask,
  FALLBACK_CHAINS,
  isVerificationType,
} from '../../../../shared/types/visualVerification';
import type {
  VerificationTaskV1,
  VerificationType,
  VisualBackendId,
} from '../../../../shared/types/visualVerification';
import type { DatabaseLike, LoggerLike } from '../types';
import type { TaskEnqueueResult } from '../programmatic/types';

export type { TaskEnqueueResult };

/** Parse the stamped `verify_chain` JSON into a `VisualBackendId[]` (mirrors mcpQueryHandler). Fail-soft → []. */
function parseStampedChain(v: unknown): VisualBackendId[] {
  if (typeof v !== 'string' || v.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(v);
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is VisualBackendId => typeof x === 'string');
    }
    return [];
  } catch {
    return [];
  }
}

export interface EnqueueTaskVerificationOptions {
  db: DatabaseLike;
  runId: string;
  task: VerificationTaskV1;
  /** The lane's authoritative ref/id — overrides `task.taskRef` for gate attribution. */
  laneTaskRef: string;
  /** 1-based lane attempt; part of the idempotency key so a fresh attempt re-fires. */
  attempt: number;
  /** The run worktree the snapshot sha is captured from (§5.5). */
  worktreePath: string;
  logger?: LoggerLike;
}

/**
 * Enqueue a composed visual-verification task for one lane. Returns
 * `{ outcome: 'enqueued', requestId }` on success, or `{ outcome: 'skipped', reason }`
 * when verification is disabled/missing for the run or the scheduler is unavailable
 * (both fail-open — the caller advances the lane without parking). NEVER throws.
 */
export async function enqueueTaskVerification(
  opts: EnqueueTaskVerificationOptions,
): Promise<TaskEnqueueResult> {
  const { db, runId, laneTaskRef, attempt, worktreePath, logger } = opts;

  // (1) Immutable verify stamps + project id (resolveReviewItemRunContext's minimal
  // query, reduced to the columns this seam needs). Read defensively — a pre-078 /
  // pre-055 DB lacking the columns degrades to a disabled posture (skipped).
  let enabled = false;
  let stampedType: VerificationType | null = null;
  let stampedChain: VisualBackendId[] = [];
  let projectId = Number.NaN;
  try {
    const row = db
      .prepare(
        `SELECT project_id AS projectId, verify_enabled AS verifyEnabled,
                verify_type AS verifyType, verify_chain AS verifyChain
           FROM workflow_runs WHERE id = ?`,
      )
      .get(runId) as
      | { projectId?: unknown; verifyEnabled?: unknown; verifyType?: unknown; verifyChain?: unknown }
      | undefined;
    if (!row) return { outcome: 'skipped', reason: 'verification-disabled' };
    enabled = row.verifyEnabled === 1 || row.verifyEnabled === true;
    stampedType = isVerificationType(row.verifyType) ? row.verifyType : null;
    stampedChain = parseStampedChain(row.verifyChain);
    projectId = typeof row.projectId === 'number' ? row.projectId : Number(row.projectId);
  } catch (err) {
    logger?.warn('[enqueueTaskVerification] verify-stamp read failed (fail-open skip)', {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { outcome: 'skipped', reason: 'verification-disabled' };
  }

  if (!enabled || stampedType === null || !Number.isFinite(projectId)) {
    return { outcome: 'skipped', reason: 'verification-disabled' };
  }

  const type: VerificationType = stampedType;
  // Effective chain = FALLBACK_CHAINS[type] ∩ the stamped (host-available) chain,
  // in FALLBACK_CHAINS order. An empty intersection still enqueues (scheduler SKIP).
  const chain = FALLBACK_CHAINS[type].filter((backend) => stampedChain.includes(backend));

  // (2) Snapshot sha (§5.5) — captured at enqueue time. A capture failure falls back
  // to null and STILL enqueues (the provisioner's dirty-worktree fallback bucket).
  let snapshotSha: string | null = null;
  try {
    snapshotSha = await captureSnapshotSha(worktreePath);
  } catch (err) {
    logger?.warn('[enqueueTaskVerification] snapshot sha capture failed; enqueuing without a snapshot', {
      runId,
      worktreePath,
      error: err instanceof Error ? err.message : String(err),
    });
    snapshotSha = null;
  }

  // (3) FORCE lane identity: laneTaskRef is authoritative for gate attribution, so
  // it overrides task.taskRef AND drives the derived legacy input — both persisted
  // columns then carry the SAME ref regardless of what the composing agent wrote.
  const task: VerificationTaskV1 = { ...opts.task, taskRef: laneTaskRef };
  const input = deriveLegacyInputFromTask(task, laneTaskRef);
  const enqueueKey = `${runId}:${laneTaskRef}:${attempt}`;

  // (4) Enqueue on the singleton. Guard getInstance (+ the enqueue itself) so an
  // uninitialized scheduler or a transient enqueue error is a fail-open SKIP, never
  // a thrown lane crash.
  try {
    const requestId = VerificationScheduler.getInstance().enqueue({
      runId,
      projectId,
      type,
      input,
      chain,
      task,
      snapshotSha,
      enqueueKey,
    });
    logger?.debug('[enqueueTaskVerification] enqueued lane verification', {
      runId,
      requestId,
      laneTaskRef,
      attempt,
      enqueueKey,
      hasSnapshot: snapshotSha !== null,
    });
    return { outcome: 'enqueued', requestId };
  } catch (err) {
    logger?.warn('[enqueueTaskVerification] scheduler unavailable; skipping visual verification', {
      runId,
      laneTaskRef,
      error: err instanceof Error ? err.message : String(err),
    });
    return { outcome: 'skipped', reason: 'scheduler-unavailable' };
  }
}
