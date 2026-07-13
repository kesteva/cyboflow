/**
 * resolveReviewItemHandler — the SHARED, injectable gate-resolution core behind
 * BOTH the `reviewItems.resolve` tRPC mutation AND the monitor's
 * `resolveReviewItem` action, so a human gate / finding / permission always
 * resolves through the IDENTICAL path regardless of which surface triggered it.
 *
 * It owns the two behaviors the resolve mutation just shipped:
 *
 *  - Q1 REVEAL (approve-plan gate) — an explicit `outcome` on a
 *    `gate:human-step:approve-plan` decision item drives the SAME side effects the
 *    orchestrated AskUserQuestion path runs, BEFORE the item resolves (so they win
 *    the race with the WorkflowController advancing to the next step):
 *      · outcome 'approve' → promotePendingDraftsForRun REVEALS the run's PENDING
 *        draft epics/tasks (stamps approved_at) so the very next step (ship's
 *        create-sprint-batch) sees sprint-eligible tasks.
 *      · outcome 'reject'  → deleteRunCreatedEntities tears down the rejected
 *        drafts; the run is NOT auto-resumed (the controller owns terminal 'rejected').
 *    For a non-approve-plan gate (approve-idea / approve-design) the outcome only
 *    threads the verdict — no reveal, no draft delete.
 *
 *  - AGGREGATE-UNBLOCK auto-resume with the DRAINED-REST STRAND GUARD — resolving a
 *    blocking, run-bound item transitions the run awaiting_review -> running ONLY
 *    when no other pending blocking review_item remains AND the run's programmatic
 *    walk has NOT already ended. The `wouldStrandEndedWalk` dep is the injected
 *    verdict of the run-execution probe (reviewItems.ts's resumeWouldStrandEndedWalk,
 *    probe-backed): when the resolved gate was the run's LAST step, the settle wakes
 *    the walk, which finishes and rests the run in awaiting_review BEFORE this
 *    trailing resume runs — a resume then would flip that resting run to 'running'
 *    with no live walk and strand it forever, so it is SKIPPED. Left unset (unit
 *    tests / legacy) => `() => false` preserves the pre-guard behavior (always resume).
 *
 * Standalone-typecheck invariant: NO imports from 'electron', 'better-sqlite3', or
 * main/src/services/* — every collaborator is injected via {@link ResolveReviewItemDeps}
 * (mirrors retryRunHandler / handoverRunHandler). The concrete singletons
 * (ReviewItemRouter / QuestionRouter / TaskChangeRouter / HumanStepManager) are wired
 * at the composition root (the tRPC wrapper in reviewItems.ts, and index.ts for the
 * monitor action).
 *
 * REFUSAL, not throw: a missing / already-terminal item is returned as a
 * discriminated `{ ok: false, reason }` (the chokepoint's ReviewItemError.code) so a
 * monitor action can turn it into a chat message; the tRPC wrapper maps that refusal
 * back to the SAME TRPCError the mutation throws today. Genuinely unexpected errors
 * (not ReviewItemError) propagate unchanged for the caller's own catch.
 *
 * The `actor` is fixed 'user': the monitor RELAYS a human confirmation, so a
 * monitor-driven resolve is still the human's decision — identical to the mutation.
 *
 * NOT owned here (deliberately, to keep byte-identical mutation behavior): the
 * OPEN-QUESTION guard (assertNotOpenQuestionGate) stays in the tRPC wrapper — it is a
 * tRPC-layer precondition that only ever fires for a `source='question'` decision
 * item (a programmatic `gate:human-step:*` item is never question-sourced), so it is
 * irrelevant to the monitor's gate/finding/permission use.
 */
import type { DatabaseLike, LoggerLike } from './types';
import { ReviewItemError, type ReviewItemErrorCode } from './reviewItemRouter';
import {
  isIdeaVerdict,
  serializeIdeaVerdictMap,
  type IdeaVerdictMap,
} from '../../../shared/types/reviews';

// ---------------------------------------------------------------------------
// Programmatic human-gate constants (moved here from reviewItems.ts — this is now
// their single home; mirrors humanStepManager + questionRouter's own LOCAL copies,
// which are kept separate to preserve those files' standalone invariants).
// ---------------------------------------------------------------------------

/** Source prefix stamped on a programmatic human-gate decision review_item. */
const HUMAN_GATE_SOURCE_PREFIX = 'gate:human-step:';
/** The plan-review gate whose Approve REVEALS the run's pending draft entities. */
const APPROVE_PLAN_STEP_ID = 'approve-plan';
/** The multi-idea BATCH gate resolved by a per-idea verdict map (IDEA-009). */
const APPROVE_IDEAS_STEP_ID = 'approve-ideas';

/**
 * The step id encoded in a `gate:human-step:<stepId>` source, or null when the source
 * is not a programmatic human-gate decision item. Drives whether an explicit
 * approve/reject outcome must run the Q1 reveal (approve-plan approve) or the
 * draft-decline cleanup (approve-plan reject) BEFORE the gate item resolves and the
 * WorkflowController advances.
 */
export function humanGateStepId(kind: string | undefined, source: string | null | undefined): string | null {
  if (kind !== 'decision' || typeof source !== 'string') return null;
  if (!source.startsWith(HUMAN_GATE_SOURCE_PREFIX)) return null;
  return source.slice(HUMAN_GATE_SOURCE_PREFIX.length) || null;
}

/**
 * Fail-soft: the `gate` discriminant stashed on a decision item's `payload_json`
 * (DecisionPayload.gate), or null when the payload is absent/unparseable or
 * carries no gate string. This is the ONLY place the default ORCHESTRATED
 * planner's approve-ideas gate is discoverable — it mints the gate via
 * cyboflow_report_finding, which stamps source 'agent:<label>' (NOT the
 * programmatic 'gate:human-step:*'), so humanGateStepId returns null for it.
 */
function parseDecisionGate(payloadJson: string | null | undefined): string | null {
  if (typeof payloadJson !== 'string' || payloadJson.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const gate = (parsed as { gate?: unknown }).gate;
  return typeof gate === 'string' ? gate : null;
}

/**
 * True when a review item is an approve-ideas BATCH gate, recognized by EITHER
 * mint path so both fold an identical per-idea verdict map:
 *   - the programmatic runner's ReviewQueueHumanGate stamps source
 *     'gate:human-step:approve-ideas' (humanGateStepId === 'approve-ideas'); OR
 *   - the default ORCHESTRATED planner mints it via cyboflow_report_finding, whose
 *     source is 'agent:<label>' — so the discriminant lives ONLY in the payload
 *     ({ kind:'decision', gate:'approve-ideas' }).
 * Keying on the union of source AND payload (not the source string alone) is what
 * lets the fold fire for the default planner.
 */
export function isApproveIdeasGate(
  kind: string | undefined,
  source: string | null | undefined,
  payloadJson: string | null | undefined,
): boolean {
  if (kind !== 'decision') return false;
  if (humanGateStepId(kind, source) === APPROVE_IDEAS_STEP_ID) return true;
  return parseDecisionGate(payloadJson) === APPROVE_IDEAS_STEP_ID;
}

// ---------------------------------------------------------------------------
// Approve-ideas batch gate — per-idea verdict fold (IDEA-009)
// ---------------------------------------------------------------------------

/**
 * Parse the batch idea refs off an approve-ideas gate's `payload_json` (the
 * DecisionPayload.ideaRefs the planner stashes when it mints the gate). Returns
 * an empty array when the payload is absent/unparseable or carries no ref list —
 * the fold then refuses the resolve (a gate with no batch to validate against
 * cannot accept a verdict map).
 */
export function parseApproveIdeasRefs(payloadJson: string | null | undefined): string[] {
  if (typeof payloadJson !== 'string' || payloadJson.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const refs = (parsed as { ideaRefs?: unknown }).ideaRefs;
  if (!Array.isArray(refs)) return [];
  return refs.filter((r): r is string => typeof r === 'string' && r.length > 0);
}

/**
 * Fold an approve-ideas gate's per-idea verdict map into the stored `resolution`
 * string the resumed planner reads. The batch gate is all-or-nothing, so this
 * validates the WHOLE map against the gate's batch refs before serializing:
 *   - the gate must carry a non-empty batch ref list (`ideaRefs`);
 *   - the map must be non-empty;
 *   - every verdict value must be 'approve' | 'deny';
 *   - every ref MUST belong to the batch (no stray/unknown refs);
 *   - every batch ref MUST have a verdict (complete coverage).
 * Any violation throws ReviewItemError('invalid_payload'); the caller runs this
 * BEFORE the single atomic resolve, so a rejected map leaves the gate pending
 * and records nothing. The serialized note spells denials 'deny' (never
 * 'reject') so it resolves the gate as approve-to-proceed while carrying the
 * per-idea decisions (see serializeIdeaVerdictMap).
 */
export function foldIdeaVerdicts(ideaRefs: string[], verdicts: Record<string, string>): string {
  if (ideaRefs.length === 0) {
    throw new ReviewItemError(
      'invalid_payload',
      'approve-ideas gate carries no batch idea refs to validate the verdict map against',
    );
  }
  const submittedRefs = Object.keys(verdicts);
  if (submittedRefs.length === 0) {
    throw new ReviewItemError('invalid_payload', 'approve-ideas verdict map is empty');
  }
  const batch = new Set(ideaRefs);
  const validated: IdeaVerdictMap = {};
  for (const [ref, verdict] of Object.entries(verdicts)) {
    if (!batch.has(ref)) {
      throw new ReviewItemError(
        'invalid_payload',
        `approve-ideas verdict references idea '${ref}' which is not in this batch gate`,
      );
    }
    if (!isIdeaVerdict(verdict)) {
      throw new ReviewItemError(
        'invalid_payload',
        `approve-ideas verdict for '${ref}' must be 'approve' or 'deny' (got '${verdict}')`,
      );
    }
    validated[ref] = verdict;
  }
  for (const ref of ideaRefs) {
    if (!(ref in validated)) {
      throw new ReviewItemError(
        'invalid_payload',
        `approve-ideas verdict map is missing a decision for batch idea '${ref}'`,
      );
    }
  }
  return serializeIdeaVerdictMap(validated);
}

/**
 * The heading the delivered decisions block MUST lead with — a CONTRACT with the
 * planner prompt (planner.md instructs the resumed agent to act on a
 * '# Approve-ideas decisions' block). Keep this byte-identical on both sides.
 */
export const APPROVE_IDEAS_DECISIONS_HEADING = '# Approve-ideas decisions';

/**
 * Render the human's per-idea verdicts into the turn text delivered to the parked
 * ORCHESTRATED planner. Its SDK conversation cannot read review items via MCP, so
 * the resolve DELIVERS the decisions as the run's next turn. One line per batch
 * ref in BATCH ORDER (`- IDEA-014: approve`) under the heading contract, then the
 * proceed-instruction the planner keys on. The caller has already validated the
 * map covers `ideaRefs` exactly (via {@link foldIdeaVerdicts}) before rendering.
 */
export function renderApproveIdeasDecisions(ideaRefs: string[], verdicts: Record<string, string>): string {
  const lines = ideaRefs.map((ref) => `- ${ref}: ${verdicts[ref]}`);
  return [
    APPROVE_IDEAS_DECISIONS_HEADING,
    ...lines,
    '',
    'Proceed with the APPROVED ideas only; denied ideas stay on the backlog untouched.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Collaborator deps (injected — standalone-typecheck invariant)
// ---------------------------------------------------------------------------

export interface ResolveReviewItemDeps {
  /**
   * DB surface for the two READS this handler owns: the pre-resolve `before` snapshot
   * (run_id / blocking / kind / source) and the post-resolve run-status read used only
   * to enrich the skip/refuse diagnostics. The RESOLVE write itself goes through
   * {@link applyReviewItemResolve}, never a direct UPDATE.
   */
  db: DatabaseLike;
  /**
   * Resolve op through the chokepoint (ReviewItemRouter.applyReviewItem, op='resolve').
   * actor is fixed 'user' by the handler. Throws ReviewItemError on a missing /
   * already-terminal item, which the handler maps to a discriminated refusal.
   */
  applyReviewItemResolve: (
    projectId: number,
    args: { reviewItemId: string; actor: 'user'; resolution?: string | null },
  ) => Promise<{ reviewItemId: string }>;
  /** Q1 reveal (approve-plan approve): QuestionRouter.promotePendingDraftsForRun. */
  promotePendingDraftsForRun: (runId: string) => Promise<void>;
  /** Draft-decline cleanup (approve-plan reject): TaskChangeRouter.deleteRunCreatedEntities. */
  deleteRunCreatedEntities: (projectId: number, runId: string) => Promise<void>;
  /** Aggregate-unblock resume (awaiting_review -> running): HumanStepManager.maybeResumeRun. */
  maybeResumeRun: (runId: string) => Promise<boolean>;
  /**
   * Drained-rest strand guard: true when the trailing resume MUST be SKIPPED because
   * the run's programmatic walk has already ended (no live executor holds it).
   * Production: reviewItems.ts's probe-backed resumeWouldStrandEndedWalk. Optional —
   * unset defaults to `() => false` (legacy: always resume).
   */
  wouldStrandEndedWalk?: (runId: string) => boolean;
  /** Reserved for future structured logging; the load-bearing diagnostics stay on console.warn. */
  logger?: LoggerLike;
}

// ---------------------------------------------------------------------------
// Input + result
// ---------------------------------------------------------------------------

export interface ResolveReviewItemInput {
  projectId: number;
  reviewItemId: string;
  /** Free-text resolution. Ignored when `outcome` is set (outcome wins, deterministic verdict). */
  resolution?: string | null;
  /** Explicit gate verdict for a `gate:human-step:*` decision item (drives verdict + approve-plan reveal/decline). */
  outcome?: 'approve' | 'reject';
  /**
   * Per-idea verdict map for an approve-ideas BATCH gate (the "Submit decisions"
   * payload). ONLY consumed when the item is a `gate:human-step:approve-ideas`
   * decision — it is validated against the gate's batch payload and folded into
   * the stored resolution (overriding `outcome`/`resolution`). Ignored for every
   * other gate/item, so scalar resolutions stay byte-for-byte unaffected.
   */
  verdicts?: IdeaVerdictMap;
}

/**
 * Discriminated result. `ok:true` carries the mutation's `{ reviewItemId, resumed,
 * runStatus? }` plus the monitor-facing `gateStepId` / echoed `outcome`. `ok:false`
 * carries the chokepoint's ReviewItemError code + message so the tRPC wrapper can
 * rebuild the identical TRPCError and a monitor action can render a chat message.
 */
export type ResolveReviewItemResult =
  | {
      ok: true;
      reviewItemId: string;
      resumed: boolean;
      /** Present only when the trailing resume was skipped/refused (surfaces the resting status). */
      runStatus?: string;
      /** The programmatic human-gate step id for a `gate:human-step:*` item; null otherwise. */
      gateStepId: string | null;
      /** The explicit verdict when supplied (monitor can echo it back). */
      outcome?: 'approve' | 'reject';
    }
  | { ok: false; reason: ReviewItemErrorCode; message: string };

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Resolve a review item (human gate / finding / permission) through the shared
 * gate-resolution core. See the file header for the Q1 reveal + drained-rest strand
 * guard the two callers must share. Byte-identical to the pre-extraction
 * reviewItems.resolve mutation body (minus the tRPC-layer open-question precondition,
 * which stays in the wrapper).
 */
export async function resolveReviewItem(
  input: ResolveReviewItemInput,
  deps: ResolveReviewItemDeps,
): Promise<ResolveReviewItemResult> {
  const {
    db,
    applyReviewItemResolve,
    promotePendingDraftsForRun,
    deleteRunCreatedEntities,
    maybeResumeRun,
  } = deps;
  const wouldStrandEndedWalk = deps.wouldStrandEndedWalk ?? (() => false);

  // Read the item's run binding + blocking flag + gate provenance BEFORE resolving
  // (the resolve changes none of them) so we know whether to apply aggregate-unblock
  // and whether an explicit outcome drives gate side effects.
  const before = db
    .prepare(
      'SELECT run_id AS runId, blocking, kind, source, payload_json AS payloadJson FROM review_items WHERE id = ? AND project_id = ?',
    )
    .get(input.reviewItemId, input.projectId) as
    | { runId?: string | null; blocking?: number; kind?: string; source?: string | null; payloadJson?: string | null }
    | undefined;

  const gateStepId = humanGateStepId(before?.kind, before?.source);
  // The stored resolution the WorkflowController parses into its verdict. An explicit
  // outcome wins over free text (deterministic verdict); otherwise the caller's
  // free-text resolution passes through unchanged. An approve-ideas verdict map
  // overrides both below (inside the try, so a malformed map surfaces as a refusal).
  let resolution = input.outcome !== undefined ? input.outcome : input.resolution;

  try {
    // Approve-ideas BATCH gate: a submitted per-idea verdict map is validated
    // against the gate's batch payload and folded into the stored resolution the
    // resumed planner reads. Recognized via isApproveIdeasGate (source OR payload)
    // so BOTH mint paths fold identically — the programmatic runner's
    // 'gate:human-step:approve-ideas' source AND the default ORCHESTRATED planner's
    // 'agent:<label>' source (whose gate lives only in the payload). All-or-nothing —
    // foldIdeaVerdicts throws ReviewItemError('invalid_payload') on a malformed map
    // (empty / unknown ref / bad value / incomplete coverage), which the catch below
    // maps to a refusal BEFORE the single atomic resolve runs, so the gate stays
    // pending and nothing is recorded. Only the "Submit decisions" surface passes
    // `verdicts`; every scalar gate leaves it undefined and is byte-for-byte unaffected.
    if (input.verdicts !== undefined && isApproveIdeasGate(before?.kind, before?.source, before?.payloadJson)) {
      resolution = foldIdeaVerdicts(parseApproveIdeasRefs(before?.payloadJson), input.verdicts);
    }

    // Approve-plan side effects run BEFORE the resolve so they beat the controller
    // (the chokepoint's post-commit 'resolved' emit is what makes it advance). Both
    // are fail-soft + idempotent, so awaiting them here can never strand the resolve.
    if (gateStepId === APPROVE_PLAN_STEP_ID && before?.runId) {
      if (input.outcome === 'approve') {
        await promotePendingDraftsForRun(before.runId);
      } else if (input.outcome === 'reject') {
        await deleteRunCreatedEntities(input.projectId, before.runId).catch(() => {
          /* self-gated + best-effort — never block the reject resolve */
        });
      }
    }

    const { reviewItemId } = await applyReviewItemResolve(input.projectId, {
      reviewItemId: input.reviewItemId,
      actor: 'user',
      ...(resolution !== undefined ? { resolution } : {}),
    });

    // Aggregate-unblock auto-resume for a blocking, run-bound item. An explicit REJECT
    // never auto-resumes: the programmatic controller owns the terminal 'rejected'
    // transition, so resuming the run as if approved would be wrong.
    let resumed = false;
    let runStatus: string | undefined;
    if (before?.blocking === 1 && before.runId && input.outcome !== 'reject') {
      if (wouldStrandEndedWalk(before.runId)) {
        // END-OF-WALK case (drained-rest race): the resolved gate was the run's last
        // step, so the settle woke the walk and it finished + rested the run in
        // awaiting_review BEFORE this trailing call ran. No walk holds the run — a
        // resume here would flip its resting awaiting_review -> running with nothing
        // alive to drive it, stranding it 'running' forever. Skip the resume; the
        // resting awaiting_review state survives, where retryStep and the summary-panel
        // CTAs are valid. (Contrast the MID-WALK case below: a walk parked at the gate
        // still holds its execution slot -> the resume proceeds.)
        const runRow = db
          .prepare('SELECT status FROM workflow_runs WHERE id = ?')
          .get(before.runId) as { status?: string } | undefined;
        runStatus = runRow?.status;
        console.warn(
          `[reviewItems.resolve] blocking item ${reviewItemId} resolved for run ${before.runId} but resume was SKIPPED: no active walk (status='${runStatus ?? 'unknown'}'). The walk has already ended and rested the run; resuming would strand it 'running' with no live walk.`,
        );
      } else {
        // MID-WALK case (walk parked at the gate) OR guard unset (tests/legacy):
        // attempt the guarded awaiting_review -> running resume.
        resumed = await maybeResumeRun(before.runId);
        if (!resumed) {
          // maybeResumeRun REFUSED: the resume is a guarded awaiting_review -> running
          // UPDATE, so a run in any OTHER state no-ops. Legitimate when a sibling
          // blocking item is still pending; a ZOMBIE when the run sits 'running' with a
          // dead session. Never let that stay silent — report the actual status.
          // (Distinct from the SKIPPED path above: there we never called maybeResumeRun;
          // here it ran and refused.)
          const runRow = db
            .prepare('SELECT status FROM workflow_runs WHERE id = ?')
            .get(before.runId) as { status?: string } | undefined;
          runStatus = runRow?.status;
          console.warn(
            `[reviewItems.resolve] blocking item ${reviewItemId} resolved for run ${before.runId} but the run did NOT resume — maybeResumeRun refused (status='${runStatus ?? 'unknown'}'; resume only fires from awaiting_review with no other pending blocking items)`,
          );
        }
      }
    }

    return {
      ok: true,
      reviewItemId,
      resumed,
      gateStepId,
      ...(runStatus !== undefined ? { runStatus } : {}),
      ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
    };
  } catch (err) {
    // A missing / already-terminal item surfaces as a discriminated refusal (the
    // chokepoint's ReviewItemError.code) so a monitor action can render it. Anything
    // else is genuinely unexpected — re-throw for the caller's own catch.
    if (err instanceof ReviewItemError) {
      return { ok: false, reason: err.code, message: err.message };
    }
    throw err;
  }
}
