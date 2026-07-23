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
 * Dep-injected (mirrors handoverRunHandler) — standalone-typecheck invariant: no
 * imports from 'electron', 'better-sqlite3', or main/src/services/*.
 */
import type { DatabaseLike, LoggerLike } from './types';
import type { StepResultRow } from './stepResultStore';
import type { ClaudeStreamEvent } from '../../../shared/types/claudeStream';
import { resolveWorkflowDefinition } from '../../../shared/types/workflows';
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
  workflow_name: string;
  spec_json: string | null;
}

const RUN_SELECT_SQL = `SELECT r.status AS status, r.execution_model AS execution_model,
              w.name AS workflow_name, w.spec_json AS spec_json
         FROM workflow_runs r
         JOIN workflows w ON w.id = r.workflow_id
        WHERE r.id = ?`;

const PENDING_GATE_SQL = `SELECT source FROM review_items
         WHERE run_id = ? AND kind = 'decision' AND status = 'pending'
           AND (source LIKE 'gate:human-step:%' OR source LIKE 'gate:systemic-pause:%')`;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the final-gate handover checker. `attempt(runId, text)` returns a delivery
 * result when the message was consumed by an auto-handover, or `null` meaning "not
 * applicable — route to the monitor as today". See the header for the trigger
 * matrix. A throw is intentionally NOT swallowed here (the router wraps attempt in
 * a fail-soft try/catch); only the SELECTs are guarded via the typed cast + null
 * check, mirroring handoverRunHandler.
 */
export function createFinalGateHandover(deps: FinalGateHandoverDeps): {
  attempt(runId: string, text: string): Promise<{ delivered: boolean; handedOver: boolean } | null>;
} {
  const { db, isEnabled, listStepResults, getInjectEvent, handover, logger } = deps;

  async function attempt(
    runId: string,
    text: string,
  ): Promise<{ delivered: boolean; handedOver: boolean } | null> {
    // 1. Kill switch.
    if (!isEnabled()) return null;

    // 2. The run must be a programmatic run resting at a review gate.
    const row = db.prepare(RUN_SELECT_SQL).get(runId) as FinalGateRunRow | undefined;
    if (!row) return null;
    if (row.execution_model !== 'programmatic') return null;
    if (row.status !== 'awaiting_review') return null;

    // 3. Resolve the definition and identify the LAST step (mirrors handoverRunHandler
    // Phase 2 — spec_json wins, else the built-in fallback via the workflow name).
    const definition = resolveWorkflowDefinition(row.workflow_name, row.spec_json);
    if (!definition) return null;
    const steps = definition.phases.flatMap((phase) => phase.steps);
    const last = steps[steps.length - 1];
    if (!last) return null;

    // 4. Classify against the pending gate rows.
    const gateRows = db.prepare(PENDING_GATE_SQL).all(runId) as Array<{ source: string }>;
    const sources = gateRows.map((r) => r.source);

    // A systemic-pause (failure) gate belongs to the monitor's steering, not here.
    if (sources.some((s) => s.startsWith(SYSTEMIC_PAUSE_PREFIX))) return null;

    const humanGateStepIds = sources
      .filter((s) => s.startsWith(HUMAN_GATE_PREFIX))
      .map((s) => s.slice(HUMAN_GATE_PREFIX.length));

    let context: FinalGateHandoverContext | null = null;
    if (humanGateStepIds.length > 0) {
      // A human gate is open. Only the FINAL step's gate auto-converts — a mid-run
      // gate is never handed over here (the run still has steps to walk).
      if (humanGateStepIds.some((id) => id !== last.id)) return null;
      context = { kind: 'parked-at-final-gate', stepId: last.id, stepName: last.name };
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
      context = { kind: 'drained-rest', stepId: last.id, stepName: last.name };
    }

    // 5. Inject the user's raw turn + the '▶' handover marker BEFORE converting, so
    // the transcript shows the message the agent will pick up. Mirrors the monitor's
    // outcome-turn style (buildAssistantTextEvent, default 'monitor' model tag).
    const inject = getInjectEvent(runId);
    inject(buildUserTextEvent(text));
    inject(buildAssistantTextEvent(HANDOVER_MARKER, { model: MONITOR_MODEL }));

    // 6. Convert. The user's raw text is the agent's outstanding request.
    const result = await handover(runId, text, context);
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

  return { attempt };
}
