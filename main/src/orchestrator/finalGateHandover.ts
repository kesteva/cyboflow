/**
 * finalGateHandover — the LAZY, chat-triggered conversion of a programmatic run to
 * a full orchestrated agent when the user chats with it AT ITS FINAL HUMAN GATE.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * The capability gap this closes
 * ───────────────────────────────────────────────────────────────────────────
 * A programmatic run is walked by a host-side controller. When it parks at its
 * final human gate (the terminal 'human-review' / 'decompose' step — a pure
 * `agent: 'human'` gate awaiting the user's sign-off), user chat routes to the
 * on-demand MONITOR: a structured-output brain that can answer questions and
 * actuate a fixed menu of steering actions, but is NOT a general coding agent. So
 * a user who, at the very end of a run, asks for "one more tweak" hits a wall —
 * the monitor cannot edit code, and the workflow has no steps left to carry the
 * request.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * The lazy trigger
 * ───────────────────────────────────────────────────────────────────────────
 * Rather than expose a manual switch, this module makes the FIRST chat message at
 * the final gate DO the conversion: the run is handed over to a fresh orchestrated
 * agent (handoverRunHandler — the one-way programmatic->orchestrated seam) with the
 * user's raw message as its outstanding request. Approve/Reject WITHOUT chatting is
 * untouched — a user who just signs off keeps today's fully-programmatic path. Only
 * a run that is (a) programmatic, (b) awaiting_review, and (c) at its FINAL gate (or
 * fully drained, resting for merge) converts; a mid-run gate or a systemic-pause
 * (failure) gate is left to the monitor's steering — this module returns null there
 * and the router falls through to the monitor exactly as before.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * Why one-way is acceptable HERE
 * ───────────────────────────────────────────────────────────────────────────
 * handoverRunHandler's execution_model flip is irreversible (programmatic ->
 * orchestrated, never back). Elsewhere that costs the remaining programmatic steps.
 * At the FINAL gate there are no remaining agent steps to lose: every step already
 * ran. The orchestrated agent addresses the request and re-opens the same sign-off
 * gate itself (the handover brief instructs it to), so nothing is forfeited.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * Concurrency + ownership invariants
 * ───────────────────────────────────────────────────────────────────────────
 *   - SINGLE-FLIGHT per run (Fix 3): two concurrent sends can never BOTH pass
 *     detection + inject. Attempts for a runId are serialized through a module-level
 *     promise chain, so B only runs after A settles — by which point A's handover may
 *     have already flipped execution_model / stamped handed_over_at, which B then
 *     observes and returns an honest failure for (never a second inject).
 *   - FROZEN-SPEC detection (Fix 2): last-step classification resolves the definition
 *     from the run's FROZEN spec (resolveRunFrozenSpec — the exact graph the walk
 *     executed), NOT the live workflows.spec_json. A variant run or a mid-run edit
 *     makes the live row a DIFFERENT graph, misclassifying a frozen mid-run gate as
 *     final.
 *   - GATE RE-VALIDATION (Fix 1): the detected gate's review_items.id rides in the
 *     handover context; handoverRunHandler re-checks it across the flip so a
 *     concurrent user Approve/Reject wins.
 *   - WE OWN THE MESSAGE AFTER INJECT (Fix 4): once the user's raw turn is injected,
 *     NO code path may throw out of attempt — a throw would hit the router's fail-soft
 *     catch and fall through to the monitor, DOUBLE-injecting the same turn. A handover
 *     that noOps OR THROWS post-inject is caught here and surfaced as a '⚠' marker with
 *     { delivered: true, handedOver: false }. Throws BEFORE any inject may still
 *     propagate (router fall-through to the monitor is correct there).
 *   - POST-HANDOVER STALE SEND (Fix 3): a send to a run that WAS handed over (now
 *     orchestrated, handed_over_at set) returns { delivered: false } rather than
 *     falling through to a still-registered-but-dying monitor.
 *
 * Dep-injected (mirrors handoverRunHandler) — standalone-typecheck invariant: no
 * imports from 'electron', 'better-sqlite3', or main/src/services/*.
 */
import type { DatabaseLike, LoggerLike } from './types';
import type { StepResultRow } from './stepResultStore';
import type { ClaudeStreamEvent } from '../../../shared/types/claudeStream';
import { resolveWorkflowDefinition } from '../../../shared/types/workflows';
import { resolveRunFrozenSpec } from './runFrozenSpec';
import { buildUserTextEvent, buildAssistantTextEvent } from './programmatic/syntheticEvents';
import type { FinalGateHandoverContext, HandoverRunResult } from './handoverRunHandler';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Gate provenance prefixes (mirrors HumanStepManager's HUMAN_GATE_SOURCE / SYSTEMIC_PAUSE_SOURCE). */
const HUMAN_GATE_PREFIX = 'gate:human-step:';
const SYSTEMIC_PAUSE_PREFIX = 'gate:systemic-pause:';

/** The model tag the monitor stamps on its injected '▶'/'⚠' outcome turns (buildAssistantTextEvent default). */
const MONITOR_MODEL = 'monitor';

/** The assistant marker injected right after the user's message, mirroring the monitor's '▶' style. */
const HANDOVER_MARKER =
  '▶ Handing this run over to a full agent — it will pick your request up in this chat.';

/**
 * Injected when the handover itself THROWS after the user's turn is already in the
 * transcript (Fix 4). We OWN the message post-inject, so surface an honest failure
 * marker rather than letting the throw escape to the router (which would fall through
 * to the monitor and double-inject the same user turn).
 */
const HANDOVER_THREW_MARKER =
  '⚠ The handover failed unexpectedly — your message was not delivered; please try again.';

/**
 * Short human phrasing for a refused handover, reusing the wording of
 * monitorSwitchToOrchestrated's messages map (index.ts) so chat copy stays
 * consistent across the two entry points.
 */
const REFUSAL_MESSAGE: Record<string, string> = {
  not_found: 'Run not found.',
  not_programmatic: 'This run is already running as an interactive agent.',
  not_switchable:
    "The run isn't in a state that can be handed over — it must be running, resting, or failed.",
  race: 'The run changed state mid-handover — try again.',
};

// ---------------------------------------------------------------------------
// Collaborator interfaces
// ---------------------------------------------------------------------------

export interface FinalGateHandoverDeps {
  db: DatabaseLike;
  /** Global kill switch (configManager.getAutoHandoverAtFinalGateEnabled). */
  isEnabled: () => boolean;
  /** step_results reader (StepResultStore-backed) — feeds the drained-rest detection. */
  listStepResults: (runId: string) => StepResultRow[];
  /** The run's persisting monitor inject bridge (RunExecutor.ensureMonitorInjectBridge). */
  getInjectEvent: (runId: string) => (event: ClaudeStreamEvent) => void;
  /** Convert the run programmatic->orchestrated, seeding `text` as the agent's request. */
  handover: (
    runId: string,
    reason: string,
    finalGate: FinalGateHandoverContext,
  ) => Promise<HandoverRunResult>;
  logger?: LoggerLike;
}

// ---------------------------------------------------------------------------
// Internal row types
// ---------------------------------------------------------------------------

interface FinalGateRunRow {
  status: string;
  execution_model: string | null;
  /**
   * migration 081 handover stamp — non-null once the run was handed over. Selected
   * directly off workflow_runs (no workflows JOIN) so the definition can be resolved
   * from the FROZEN spec (Fix 2) rather than the live workflow row.
   */
  handed_over_at: string | null;
}

const RUN_SELECT_SQL = `SELECT status, execution_model, handed_over_at
         FROM workflow_runs
        WHERE id = ?`;

const PENDING_GATE_SQL = `SELECT id, source FROM review_items
         WHERE run_id = ? AND kind = 'decision' AND status = 'pending'
           AND (source LIKE 'gate:human-step:%' OR source LIKE 'gate:systemic-pause:%')`;

/** The delivery result of a single attempt (`null` = not applicable → route to the monitor). */
type AttemptResult = { delivered: boolean; handedOver: boolean } | null;

/**
 * Per-run single-flight chain (Fix 3). Keyed by runId → the tail promise of the
 * serialized attempt chain. Two concurrent sends for the same run can never BOTH
 * pass detection + inject: B chains after A and only runs its detection once A has
 * fully settled (by which point A may have handed the run over, which B observes).
 * Module-level (not closure-level) so it survives even if the factory is rebuilt.
 */
const inflight = new Map<string, Promise<AttemptResult>>();

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the final-gate handover checker. `attempt(runId, text)` returns a delivery
 * result when the message was consumed by an auto-handover, or `null` meaning "not
 * applicable — route to the monitor as today". See the header for the trigger
 * matrix and the concurrency/ownership invariants.
 *
 * `attempt` is a per-run SINGLE-FLIGHT wrapper (Fix 3) around the real `doAttempt`.
 * A PRE-inject throw in doAttempt still propagates out of the returned promise (the
 * router's fail-soft catch owns that — the transcript is untouched); once the user's
 * turn is injected, doAttempt NEVER throws (Fix 4 — it owns the message from there).
 */
export function createFinalGateHandover(deps: FinalGateHandoverDeps): {
  attempt(runId: string, text: string): Promise<AttemptResult>;
} {
  const { db, isEnabled, listStepResults, getInjectEvent, handover, logger } = deps;

  async function doAttempt(runId: string, text: string): Promise<AttemptResult> {
    // 1. Kill switch.
    if (!isEnabled()) return null;

    // 2. Read the run row (NO workflows JOIN — the definition is resolved from the
    // FROZEN spec below, not the live workflow row). handed_over_at distinguishes a
    // genuinely-orchestrated run from one THIS feature already handed over.
    const row = db.prepare(RUN_SELECT_SQL).get(runId) as FinalGateRunRow | undefined;
    if (!row) return null;
    if (row.execution_model !== 'programmatic') {
      // Fix 3 (post-handover stale send): a non-programmatic run carrying a handover
      // stamp WAS converted by this feature — its monitor is dead or dying. A racing /
      // stale-tab send must get an honest failure, NEVER fall through to a still-
      // registered monitor that would double-inject and answer an orchestrated run. A
      // run with NO stamp was genuinely orchestrated from birth (never had a monitor) —
      // return null so the legacy (harmless) monitor path runs unchanged.
      if (row.handed_over_at != null) return { delivered: false, handedOver: false };
      return null;
    }
    if (row.status !== 'awaiting_review') return null;

    // 3. Resolve the definition from the run's FROZEN spec (the exact graph the walk
    // executed) and identify the LAST step. Using the live workflows.spec_json here
    // would misclassify a frozen mid-run gate as final for a variant run or a run
    // edited mid-flight. resolveRunFrozenSpec degrades to the live spec internally for
    // legacy/baseline runs; null (missing run row) refuses.
    const frozen = resolveRunFrozenSpec(db, runId);
    if (!frozen) return null;
    const definition = resolveWorkflowDefinition(frozen.workflowName, frozen.specJson);
    if (!definition) return null;
    const steps = definition.phases.flatMap((phase) => phase.steps);
    const last = steps[steps.length - 1];
    if (!last) return null;

    // 4. Classify against the pending gate rows.
    const gateRows = db.prepare(PENDING_GATE_SQL).all(runId) as Array<{ id: string; source: string }>;

    // A systemic-pause (failure) gate belongs to the monitor's steering, not here.
    if (gateRows.some((r) => r.source.startsWith(SYSTEMIC_PAUSE_PREFIX))) return null;

    const humanGateRows = gateRows.filter((r) => r.source.startsWith(HUMAN_GATE_PREFIX));

    let context: FinalGateHandoverContext | null = null;
    if (humanGateRows.length > 0) {
      // A human gate is open. Only the FINAL step's gate auto-converts — a mid-run
      // gate is never handed over here (the run still has steps to walk).
      if (humanGateRows.some((r) => r.source.slice(HUMAN_GATE_PREFIX.length) !== last.id)) {
        return null;
      }
      // Thread the detected gate's review_items.id through so handoverRunHandler can
      // re-validate the claim across the flip (Fix 1) — a concurrent user Approve/Reject
      // then wins. Every row here targets last.id, so [0] is the final gate.
      context = {
        kind: 'parked-at-final-gate',
        stepId: last.id,
        stepName: last.name,
        reviewItemId: humanGateRows[0]?.id,
      };
    } else {
      // No gate rows — the drained-rest case: the run rests awaiting merge only if
      // the final step is 'done' AND every other defined step completed (done/skipped).
      // A missing result for any defined step, or a 'rejected' final gate, refuses.
      const lastOutcomeByStep = new Map<string, string>();
      for (const r of listStepResults(runId)) lastOutcomeByStep.set(r.stepId, r.outcome);
      if (lastOutcomeByStep.get(last.id) !== 'done') return null;
      for (const step of steps) {
        if (step.id === last.id) continue;
        const outcome = lastOutcomeByStep.get(step.id);
        if (outcome !== 'done' && outcome !== 'skipped') return null;
      }
      // drained-rest carries NO reviewItemId — there is no open gate row to re-validate.
      context = { kind: 'drained-rest', stepId: last.id, stepName: last.name };
    }

    // 5. Inject the user's raw turn + the '▶' handover marker BEFORE converting, so
    // the transcript shows the message the agent will pick up. Mirrors the monitor's
    // outcome-turn style (buildAssistantTextEvent, default 'monitor' model tag). From
    // HERE ON we OWN the message — no code path below may throw out of doAttempt (Fix 4).
    const inject = getInjectEvent(runId);
    inject(buildUserTextEvent(text));
    inject(buildAssistantTextEvent(HANDOVER_MARKER, { model: MONITOR_MODEL }));

    // 6. Convert. The user's raw text is the agent's outstanding request. A handover
    // that THROWS post-inject (Fix 4) is caught here and surfaced as a '⚠' marker,
    // NEVER re-thrown — the router's fail-soft catch would fall through to the monitor
    // and double-inject the same user turn.
    let result: HandoverRunResult;
    try {
      result = await handover(runId, text, context);
    } catch (err) {
      logger?.error('[finalGateHandover] handover threw after inject', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Fail-soft inject (its own guard — a broken bridge must not re-throw and defeat
      // the whole point of owning the message here).
      try {
        inject(buildAssistantTextEvent(HANDOVER_THREW_MARKER, { model: MONITOR_MODEL }));
      } catch {
        /* the inject bridge is gone; nothing more to do — still report delivered. */
      }
      return { delivered: true, handedOver: false };
    }

    if ('delivered' in result) {
      logger?.info('[finalGateHandover] converted run at final gate', { runId, kind: context.kind });
      return { delivered: true, handedOver: true };
    }

    // Refused (race / no-longer-switchable between our SELECT and the guarded flip).
    // The user's turn is already in the transcript, so we OWN it — surface a '⚠'
    // marker and report delivered-but-not-handedOver rather than falling through to
    // the monitor (which would inject the same user turn a second time).
    inject(
      buildAssistantTextEvent(
        `⚠ ${REFUSAL_MESSAGE[result.reason] ?? `Handover refused (${result.reason}).`}`,
        { model: MONITOR_MODEL },
      ),
    );
    logger?.warn('[finalGateHandover] handover refused after inject', {
      runId,
      reason: result.reason,
    });
    return { delivered: true, handedOver: false };
  }

  /**
   * Per-run single-flight wrapper (Fix 3). Chains this attempt after any in-flight one
   * for the run so two concurrent sends can never both pass detection + inject. Only the
   * PREVIOUS link's rejection is swallowed (a failed prior attempt must not poison this
   * one); the returned promise STILL rejects if doAttempt throws pre-inject, so the
   * router's fail-soft catch owns that case.
   */
  function attempt(runId: string, text: string): Promise<AttemptResult> {
    const prev = inflight.get(runId) ?? Promise.resolve<AttemptResult>(null);
    const next = prev.catch(() => null).then(() => doAttempt(runId, text));
    inflight.set(runId, next);
    // Evict the tail once it settles — but only if a newer attempt has not replaced it.
    // A SEPARATE handled branch (.catch → null) does the cleanup so it never raises an
    // unhandled rejection; the returned `next` keeps its own rejection for the router.
    void next
      .catch(() => null)
      .finally(() => {
        if (inflight.get(runId) === next) inflight.delete(runId);
      });
    return next;
  }

  return { attempt };
}
