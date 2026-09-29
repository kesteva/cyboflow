/**
 * TerminalDelivery — the verification_requests terminal write and verdict
 * delivery, split out of verificationScheduler.ts (issue #19 step 6). See the
 * class doc below; the §-references are to
 * docs/proposals/visual-verification-design.md.
 *
 * Standalone-typecheck invariant (orchestrator/**): no 'electron', 'fs',
 * 'better-sqlite3', or concrete main/src/services import — the DB is the
 * injected DatabaseLike, the logger LoggerLike.
 */
import { emitSeamError } from '../telemetrySink';
import { classifyErrorPattern, unclassifiedErrorTags } from '../programmatic/systemicError';
import type { DatabaseLike, LoggerLike } from '../types';
import type {
  RequestStatus,
  VerdictV1,
  VerificationRequestInput,
  VerificationType,
} from '../../../../shared/types/visualVerification';
import {
  DELIVERY_RETRY_BASE_MS,
  DELIVERY_RETRY_MAX_MS,
  verificationChannel,
  verificationEvents,
} from './verificationSchedulerContracts';
import type {
  OnVerdict,
  TerminalExtra,
  VerificationTerminalEvent,
} from './verificationSchedulerContracts';
import { parseRequestInput } from './verificationRequestRows';
import type { VerificationRequestRow } from './verificationRequestRows';

export interface TerminalDeliveryDeps {
  db: DatabaseLike;
  logger?: LoggerLike;
  /** The verdict side-effect hook (verdictDelivery.ts) — see {@link OnVerdict}. */
  onVerdict?: OnVerdict;
}

/**
 * The scheduler's terminal-write + verdict-delivery chokepoint (§5.6 delivery
 * outbox). Owns the ONLY writer of a request row's terminal status, the paired
 * delivery through the onVerdict hook + terminal event, the 'pending'/'delivered'
 * outbox stamps, the boot/backoff replay of rows whose delivery did not fully
 * succeed, and the in-process retry timer that drives that replay. Extracted
 * from VerificationScheduler (issue #19 step 6); the method bodies are the
 * scheduler's, unchanged — the scheduler now holds one `delivery` collaborator
 * instead of this state.
 */
export class TerminalDelivery {
  private readonly db: DatabaseLike;
  private readonly logger?: LoggerLike;
  private readonly onVerdict?: OnVerdict;

  /**
   * In-process delivery-retry sweep (§5.6 amended): armed when a delivery leaves a
   * terminal row `pending` (a required consumer failed); fires
   * replayPendingDeliveries after a backoff so recovery does not wait for the next
   * boot. One timer at a time, `unref`ed like QueuedAgeDeadline's timer.
   */
  private deliveryRetryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Current retry backoff — doubles per consecutive failed sweep, reset on a full drain. */
  private deliveryRetryDelayMs = DELIVERY_RETRY_BASE_MS;

  constructor(deps: TerminalDeliveryDeps) {
    this.db = deps.db;
    this.logger = deps.logger;
    this.onVerdict = deps.onVerdict;
  }

  /**
   * Write a terminal status (passed/failed/low_confidence/skipped/timeout) +
   * verdict_json / error_message / ended_at. attempt is bumped so a re-judged
   * request reflects its fall-forward count.
   *
   * CANCEL-SAFE (R1 #3b): the write is guarded to a NON-TERMINAL current status
   * (`status IN ('queued','leased','running')`). If a cancelForRun / timeout sweep
   * already made the row terminal (e.g. 'timeout') it WON the race — the guard
   * changes 0 rows so we do NOT clobber the canceled status. Returns the .changes so
   * markTerminalAndDeliver can suppress delivery when the write lost the race.
   * (The non-terminal set — a superset of the leased/running the running path sees —
   * is required because this same writer performs the queued→skipped transition for
   * the processRow skip paths, which must still succeed on a live 'queued' row.)
   */
  markTerminal(
    id: string,
    status: RequestStatus,
    extra: TerminalExtra = {},
  ): number {
    // The migration-095 classification columns are written in the SAME guarded
    // write as the status, so a health-panel audit can never observe a terminal
    // row whose verdict and its evidence disagree. FAIL-SOFT (mirrors
    // agentColumnsForRow): a pre-095 DB — every minimal test fixture, and any
    // binary rolled back below the migration — throws on `prepare`, BEFORE any
    // row is touched, so falling through to the legacy write below is safe and
    // byte-identical to the pre-phase-0 behavior.
    const hasClassification =
      extra.failureClass !== undefined ||
      extra.failureEvidence !== undefined ||
      extra.preflight !== undefined;
    if (hasClassification) {
      try {
        return this.markTerminalWithClassification(id, status, extra);
      } catch (err) {
        this.logger?.debug('[VerificationScheduler] classification columns unavailable; writing legacy terminal', {
          requestId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return this.db
      .prepare(
        `UPDATE verification_requests
            SET status = ?,
                current_backend = COALESCE(?, current_backend),
                verdict_json = ?,
                report_json = COALESCE(?, report_json),
                error_message = ?,
                delivery_state = 'pending',
                attempt = attempt + 1,
                ended_at = ?
          WHERE id = ? AND status IN ('queued', 'leased', 'running')`,
      )
      .run(
        status,
        extra.backend ?? null,
        extra.verdict ? JSON.stringify(extra.verdict) : null,
        // report_json (redesign §5.6): committed atomically with the terminal
        // status. COALESCE(NULL, report_json) leaves the legacy path's report_json
        // untouched (always NULL there); an agent row writes its normalized report.
        extra.report ? JSON.stringify(extra.report) : null,
        extra.error ?? null,
        new Date().toISOString(),
        id,
      ).changes;
  }

  /**
   * The migration-095 widening of {@link markTerminal}: the identical guarded
   * UPDATE plus `failure_class` / `failure_evidence_json` / `preflight_json`
   * (docs/proposals/verification-setup-flow.md §3.1 — "The classifier's inputs
   * and verdict are persisted on the request row so the health panel can show the
   * env/deliverable/ambiguous histogram and misclassification can be audited").
   * Throws on a pre-095 DB; {@link markTerminal} owns that fallback.
   */
  private markTerminalWithClassification(id: string, status: RequestStatus, extra: TerminalExtra): number {
    return this.db
      .prepare(
        `UPDATE verification_requests
            SET status = ?,
                current_backend = COALESCE(?, current_backend),
                verdict_json = ?,
                report_json = COALESCE(?, report_json),
                error_message = ?,
                failure_class = ?,
                failure_evidence_json = ?,
                preflight_json = ?,
                delivery_state = 'pending',
                attempt = attempt + 1,
                ended_at = ?
          WHERE id = ? AND status IN ('queued', 'leased', 'running')`,
      )
      .run(
        status,
        extra.backend ?? null,
        extra.verdict ? JSON.stringify(extra.verdict) : null,
        extra.report ? JSON.stringify(extra.report) : null,
        extra.error ?? null,
        extra.failureClass ?? null,
        extra.failureEvidence ? JSON.stringify(extra.failureEvidence) : null,
        extra.preflight ? JSON.stringify(extra.preflight) : null,
        new Date().toISOString(),
        id,
      ).changes;
  }

  /**
   * Delivery-outbox stamp (§5.6): flip `delivery_state` to 'delivered' AFTER all
   * three verdict-delivery consumers (artifact / lane / finding) have SUCCEEDED —
   * written only by markTerminalAndDeliver + the replay sweeps, and only when
   * deliver() reported success. markTerminal stamps 'pending' atomically with the
   * terminal status, so both a crash in the window between the two AND a failed
   * consumer leave 'pending' for replay to pick up. A legacy/pre-078 row
   * (delivery_state NULL) never reaches here. Best-effort — a failed flip merely
   * re-delivers once more (idempotently) at the next sweep/boot.
   */
  private markDelivered(id: string): void {
    try {
      this.db.prepare(`UPDATE verification_requests SET delivery_state = 'delivered' WHERE id = ?`).run(id);
    } catch (err) {
      this.logger?.debug('[VerificationScheduler] delivery_state=delivered stamp failed (fail-soft)', {
        requestId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Write a terminal status AND fire verdict delivery — but ONLY when the
   * status-guarded markTerminal actually transitioned the row (changes === 1). A
   * 0-change write means a cancel/timeout sweep already made the row terminal and
   * WON the race: we must NOT overwrite it and must NOT deliver — no artifact
   * enrich, no ReviewItemRouter finding, no SprintLaneStore merge-gate write, no
   * terminal event — for a canceled run (R1 #3b). This is the SINGLE chokepoint
   * pairing the guarded write with delivery so every runChosen / skip exit is
   * cancel-safe by construction.
   */
  async markTerminalAndDeliver(
    row: VerificationRequestRow,
    status: RequestStatus,
    extra: TerminalExtra,
    verdict: VerdictV1 | undefined,
    fileNames: string[],
    input?: VerificationRequestInput,
  ): Promise<void> {
    const changes = this.markTerminal(row.id, status, extra);
    if (changes === 0) {
      this.logger?.debug('[VerificationScheduler] terminal write lost race to cancel/timeout; skipping delivery', {
        requestId: row.id,
        attemptedStatus: status,
      });
      return;
    }
    // Report a verification that genuinely FAILED or TIMED OUT. Deliberately NOT
    // 'skipped': a skip is this scheduler's by-design non-failure for a missing
    // precondition (no usable/healthy backend, missing TCC grant, uninstalled
    // chromium, static-only chain, unparseable input) — and on a host without a
    // provisioned visual-verify backend (the documented common case) EVERY request
    // skips, which would flood Sentry with non-errors under a seam named
    // 'verify-request-failed' and bury real signal. Passed / low_confidence are
    // valid verdicts, also not errors. Only after the guarded write won
    // (changes === 1) so a cancel-race never double-reports.
    if (status === 'failed' || status === 'timeout') {
      // extra.error (a capture/judge error) may include a URL or path, so it is
      // NOT put in the exception message — only the bounded errorClass, derived
      // from it, plus the bounded requestStatus/verifyType/backend tags.
      const verifyErrorClass = classifyErrorPattern(extra.error);
      emitSeamError('verify-request-failed', new Error(`verify ${status} (${verifyErrorClass})`), {
        requestStatus: status,
        verifyType: row.verify_type,
        ...(extra.backend ? { backend: extra.backend } : {}),
        errorClass: verifyErrorClass,
        // An UNCLASSIFIED verify failure is otherwise blind: the message is
        // withheld above and `other`/`unknown` says nothing about which failure
        // it was. The shape+digest split it without shipping the text — the last
        // `other`-emitting seam to be wired for this (cf. stepResultStore,
        // monitorQuery, claudeCodeManager).
        ...unclassifiedErrorTags(verifyErrorClass, extra.error),
      });
    }
    const deliveredOk = await this.deliver(row, status, verdict, fileNames, input, extra);
    // §5.6 delivery-outbox (amended, adversarial-review fix 2026-07-23): flip the
    // 'pending' stamp markTerminal wrote to 'delivered' ONLY when every required
    // consumer succeeded. A crash before this line leaves the row
    // terminal-but-'pending' for the boot replay — and now a swallowed consumer
    // error does too: the row stays 'pending' and an in-process retry sweep
    // re-delivers it (idempotently) without waiting for a reboot.
    if (deliveredOk) {
      this.markDelivered(row.id);
    } else {
      this.logger?.warn('[VerificationScheduler] delivery incomplete; leaving row pending for retry', {
        requestId: row.id,
        status,
      });
      this.armDeliveryRetryTimer();
    }
  }

  /**
   * §5.6 delivery-outbox replay: re-deliver every TERMINAL row still marked
   * `delivery_state='pending'` (a crash struck after markTerminal committed the
   * status but before/within the three verdict deliveries, OR a required consumer
   * failed on a prior attempt), stamping 'delivered' only for rows whose delivery
   * fully succeeds; the rest stay pending and re-arm the in-process retry sweep.
   * Runs at boot from runRecovery AND from armDeliveryRetryTimer's backoff sweep.
   * Reconstructs the deliver() args from the
   * persisted columns; the load-bearing consumers (artifact merge keyed by
   * (taskRef, requestId), the requestAttempt-guarded lane advance, the
   * requestId-correlated finding) are all idempotent, so a double replay is a
   * no-op. Legacy/pre-078 rows have NULL delivery_state and are self-excluded.
   * fileNames / captureOrigin are best-effort (the agent path's captureOrigin is
   * always 'agent'; diagnostics are not persisted and are omitted on replay).
   */
  async replayPendingDeliveries(): Promise<number> {
    let rows: Array<{
      id: string;
      run_id: string;
      project_id: number;
      status: string;
      verify_type: string;
      deliverable_json: string;
      verdict_json: string | null;
      report_json: string | null;
    }>;
    try {
      rows = this.db
        .prepare(
          `SELECT id, run_id, project_id, status, verify_type, deliverable_json, verdict_json, report_json
             FROM verification_requests
            WHERE delivery_state = 'pending'
              AND status IN ('passed', 'failed', 'low_confidence', 'skipped', 'timeout')
            ORDER BY enqueued_at ASC, id ASC`,
        )
        .all() as typeof rows;
    } catch (err) {
      // A minimal DB lacking delivery_state (pre-078) has nothing to replay.
      this.logger?.debug('[VerificationScheduler] delivery-outbox replay query failed (fail-soft)', {
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }

    let replayed = 0;
    let stillFailing = 0;
    for (const row of rows) {
      const input = parseRequestInput(row.deliverable_json) ?? undefined;
      const verdict = this.parseVerdict(row.verdict_json);
      const fileNames = this.deriveReplayFileNames(row.report_json, verdict);
      // A persisted report_json means the agent engine produced this terminal —
      // its capture origin is always 'agent' (§5.9); the legacy path leaves it
      // undefined on replay (diagnostics are not persisted either).
      const extra: TerminalExtra = row.report_json ? { captureOrigin: 'agent' } : {};
      const deliverRow: VerificationRequestRow = {
        id: row.id,
        run_id: row.run_id,
        project_id: row.project_id,
        status: row.status,
        verify_type: row.verify_type,
        deliverable_json: row.deliverable_json,
        chain_json: null,
        current_backend: null,
        attempt: 0,
        enqueued_at: '',
      };
      const ok = await this.deliver(deliverRow, row.status as RequestStatus, verdict, fileNames, input, extra);
      if (ok) {
        this.markDelivered(row.id);
        replayed += 1;
      } else {
        stillFailing += 1;
      }
    }
    if (replayed > 0) {
      this.logger?.info('[VerificationScheduler] replayed pending verdict deliveries', { replayed });
    }
    if (stillFailing > 0) {
      // A consumer failed again — keep the rows pending and re-arm the sweep with
      // the doubled backoff. A permanently failing row retries at the capped
      // cadence (cheap idempotent DB writes) and is still picked up at next boot.
      this.logger?.warn('[VerificationScheduler] deliveries still failing; retry sweep re-armed', {
        stillFailing,
        nextDelayMs: this.deliveryRetryDelayMs,
      });
      this.armDeliveryRetryTimer();
    } else {
      this.deliveryRetryDelayMs = DELIVERY_RETRY_BASE_MS;
    }
    return replayed;
  }

  /**
   * Arm the in-process delivery-retry sweep (§5.6 amended). One timer at a time;
   * each arming consumes the current backoff and doubles it (capped) so a
   * persistently failing consumer cannot hot-loop. `unref`ed so it never keeps the
   * process alive; the sweep itself is replayPendingDeliveries, whose consumers
   * are idempotent by requestId.
   */
  private armDeliveryRetryTimer(): void {
    if (this.deliveryRetryTimer !== null) return;
    const delay = this.deliveryRetryDelayMs;
    this.deliveryRetryDelayMs = Math.min(this.deliveryRetryDelayMs * 2, DELIVERY_RETRY_MAX_MS);
    const timer = setTimeout(() => {
      this.deliveryRetryTimer = null;
      void this.replayPendingDeliveries().catch((err: unknown) => {
        this.logger?.warn('[VerificationScheduler] delivery-retry sweep failed (fail-soft)', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, delay);
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as { unref: () => void }).unref();
    }
    this.deliveryRetryTimer = timer;
  }

  /** Parse a persisted verdict_json into a VerdictV1; undefined on NULL/malformed. */
  private parseVerdict(verdictJson: string | null): VerdictV1 | undefined {
    if (typeof verdictJson !== 'string' || verdictJson.length === 0) return undefined;
    try {
      const parsed: unknown = JSON.parse(verdictJson);
      return parsed !== null && typeof parsed === 'object' ? (parsed as VerdictV1) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Best-effort fileNames for a replayed delivery: the agent report's screenshot
   * basenames when a report_json is present, else the verdict's judgedFileNames,
   * else empty. Only feeds the artifact merge's fileNames union + the label — the
   * load-bearing report entry is composed by verdictDelivery from report_json.
   */
  private deriveReplayFileNames(reportJson: string | null, verdict: VerdictV1 | undefined): string[] {
    if (typeof reportJson === 'string' && reportJson.length > 0) {
      try {
        const parsed: unknown = JSON.parse(reportJson);
        if (parsed !== null && typeof parsed === 'object') {
          const shots = (parsed as { screenshots?: unknown }).screenshots;
          if (Array.isArray(shots)) {
            const names = shots
              .map((s) => (s !== null && typeof s === 'object' ? (s as { fileName?: unknown }).fileName : undefined))
              .filter((n): n is string => typeof n === 'string' && n.length > 0);
            if (names.length > 0) return names;
          }
        }
      } catch {
        // fall through to verdict-derived names
      }
    }
    return verdict?.judgedFileNames ?? [];
  }

  // --------------------------------------------------------------------------
  // Verdict delivery (stubbed hook — P8 wires the real routers)
  // --------------------------------------------------------------------------

  /**
   * Fire the injected onVerdict hook (if any). The real side-effects
   * (ArtifactRouter enrich + ReviewItemRouter finding + SprintLaneStore
   * advance/loopback) live behind this callback (verdictDelivery.ts). Fail-soft:
   * a throwing hook is logged, never propagated (it must not wedge the drain loop
   * or leave the lease unreleased — release already ran in runChosen's finally
   * before deliver here is reached for the judged path, and the skip/parse paths
   * hold no lease).
   *
   * Returns TRUE when the hook fully delivered (or none is wired), FALSE when it
   * threw or explicitly returned `false` (a required consumer failed) — the
   * caller then leaves the outbox row 'pending' for replay (§5.6 amended). The
   * terminal event fires REGARDLESS of the hook outcome and never affects the
   * return value: it is a wake signal for in-process listeners, not a durable
   * consumer, and a parked lane must always be woken.
   */
  private async deliver(
    row: VerificationRequestRow,
    status: RequestStatus,
    verdict: VerdictV1 | undefined,
    fileNames: string[],
    input?: VerificationRequestInput,
    extra?: TerminalExtra,
  ): Promise<boolean> {
    let deliveredOk = true;
    if (this.onVerdict) {
      try {
        const hookResult = await this.onVerdict({
          requestId: row.id,
          runId: row.run_id,
          projectId: row.project_id,
          type: row.verify_type as VerificationType,
          status,
          verdict,
          fileNames,
          input,
          // S9 human-facing provenance: forwarded (not persisted by markTerminal)
          // so verdictDelivery can render origin + capped page diagnostics on the
          // review-item finding body + screenshots payload.
          ...(extra?.captureOrigin ? { captureOrigin: extra.captureOrigin } : {}),
          ...(extra?.diagnostics && extra.diagnostics.length > 0
            ? { diagnostics: extra.diagnostics }
            : {}),
        });
        if (hookResult === false) deliveredOk = false;
      } catch (err) {
        deliveredOk = false;
        this.logger?.error('[VerificationScheduler] onVerdict hook threw', {
          requestId: row.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Fire the terminal event LAST — after onVerdict (so any merge-gate lane write
    // is already visible) and REGARDLESS of whether a hook is wired. This is the
    // wake signal the programmatic visual merge-gate awaits to un-park a lane. It
    // fires for EVERY terminal status (incl. skipped/timeout — which the merge-gate
    // now ADVANCES per R4) so a parked programmatic lane can never hang. Fail-soft:
    // a throwing listener must never wedge the drain loop.
    try {
      const event: VerificationTerminalEvent = {
        runId: row.run_id,
        requestId: row.id,
        projectId: row.project_id,
        status,
        type: row.verify_type as VerificationType,
        ...(input?.taskRef ? { taskRef: input.taskRef } : {}),
      };
      verificationEvents.emit(verificationChannel(row.run_id), event);
    } catch (err) {
      this.logger?.error('[VerificationScheduler] terminal event emit threw', {
        requestId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return deliveredOk;
  }
}
