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
import { GateSideEffects, gateDecisionFromResolution } from './gateSideEffects';
import { listApproveIdeasBatchRows, listRunDecomposedIdeaIds } from './runEntityOwnership';
import { IdeaComponentRouter } from './ideaComponents/ideaComponentRouter';
import type { IdeaComponentKey } from '../../../shared/types/ideaComponents';
import {
  isIdeaVerdict,
  serializeIdeaVerdictMap,
  serializeDesignVerdictMap,
  parseIdeaVerdictMap,
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
/** The multi-idea BATCH design gate resolved by a per-idea design verdict map. */
const APPROVE_DESIGNS_STEP_ID = 'approve-designs';

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

/**
 * True when a review item is an approve-designs BATCH gate — the design-approval
 * sibling of {@link isApproveIdeasGate}, recognized by EITHER mint path (the
 * programmatic runner's 'gate:human-step:approve-designs' source, OR the default
 * ORCHESTRATED planner's 'agent:<label>' source whose gate lives only in the
 * payload `{ kind:'decision', gate:'approve-designs' }`) so both fold an identical
 * per-idea design verdict map.
 */
export function isApproveDesignsGate(
  kind: string | undefined,
  source: string | null | undefined,
  payloadJson: string | null | undefined,
): boolean {
  if (kind !== 'decision') return false;
  if (humanGateStepId(kind, source) === APPROVE_DESIGNS_STEP_ID) return true;
  return parseDecisionGate(payloadJson) === APPROVE_DESIGNS_STEP_ID;
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

/**
 * The PROGRAMMATIC plane's read-side of the decisions contract: the per-idea
 * verdict lines (`- IDEA-014: approve`) of this run's RESOLVED
 * `gate:human-step:approve-ideas` item, or undefined when the run has none (gate
 * still pending, a non-launch run, or an unparseable resolution). The
 * orchestrated plane DELIVERS {@link renderApproveIdeasDecisions} as the parked
 * conversation's next turn — but each programmatic step is a FRESH agent turn
 * that no delivery can reach, so the host re-reads the stored fold per step and
 * `composeStepPrompt` renders the same `# Approve-ideas decisions` block into
 * the step prompt instead. Without this, a post-gate step (expand-spec, epics,
 * tasks) cannot tell which ideas were DENIED and gives every idea the full
 * treatment. Fail-soft: a missing review_items table or any thrown query yields
 * undefined (the section is simply omitted).
 */
export function readApproveIdeasDecisionLines(db: DatabaseLike, runId: string): string | undefined {
  try {
    const row = db
      .prepare(
        `SELECT resolution FROM review_items
          WHERE run_id = ? AND kind = 'decision' AND status = 'resolved'
            AND source = 'gate:human-step:approve-ideas'
          ORDER BY rowid DESC LIMIT 1`,
      )
      .get(runId) as { resolution?: string | null } | undefined;
    const verdicts = parseIdeaVerdictMap(row?.resolution);
    if (verdicts === null) return undefined;
    return Object.entries(verdicts)
      .map(([ref, verdict]) => `- ${ref}: ${verdict}`)
      .join('\n');
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Approve-designs batch gate — per-idea design verdict fold
//
// The design-approval sibling of the approve-ideas fold above. The verdict VALUE
// type is the same approve/deny map keyed by idea display ref; only the batch-ref
// key on the payload (`designRefs`), the serialized resolution prefix (via
// serializeDesignVerdictMap), and the human-facing strings differ.
// ---------------------------------------------------------------------------

/**
 * Parse the batch idea refs off an approve-designs gate's `payload_json` (the
 * DecisionPayload.designRefs the planner stashes when it mints the gate). Returns
 * an empty array when the payload is absent/unparseable or carries no ref list —
 * the fold then refuses the resolve. Mirrors {@link parseApproveIdeasRefs}.
 */
export function parseApproveDesignsRefs(payloadJson: string | null | undefined): string[] {
  if (typeof payloadJson !== 'string' || payloadJson.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const refs = (parsed as { designRefs?: unknown }).designRefs;
  if (!Array.isArray(refs)) return [];
  return refs.filter((r): r is string => typeof r === 'string' && r.length > 0);
}

/**
 * Fold an approve-designs gate's per-idea design verdict map into the stored
 * `resolution` the resumed planner reads. Same all-or-nothing validation as
 * {@link foldIdeaVerdicts} (non-empty batch, non-empty map, valid values, no
 * stray refs, full coverage), throwing ReviewItemError('invalid_payload') on any
 * violation BEFORE the atomic resolve, but serialized under the design-verdict
 * prefix so a resumed planner reads design decisions separately from idea ones.
 */
export function foldDesignVerdicts(designRefs: string[], verdicts: Record<string, string>): string {
  if (designRefs.length === 0) {
    throw new ReviewItemError(
      'invalid_payload',
      'approve-designs gate carries no batch design refs to validate the verdict map against',
    );
  }
  const submittedRefs = Object.keys(verdicts);
  if (submittedRefs.length === 0) {
    throw new ReviewItemError('invalid_payload', 'approve-designs verdict map is empty');
  }
  const batch = new Set(designRefs);
  const validated: IdeaVerdictMap = {};
  for (const [ref, verdict] of Object.entries(verdicts)) {
    if (!batch.has(ref)) {
      throw new ReviewItemError(
        'invalid_payload',
        `approve-designs verdict references idea '${ref}' which is not in this batch gate`,
      );
    }
    if (!isIdeaVerdict(verdict)) {
      throw new ReviewItemError(
        'invalid_payload',
        `approve-designs verdict for '${ref}' must be 'approve' or 'deny' (got '${verdict}')`,
      );
    }
    validated[ref] = verdict;
  }
  for (const ref of designRefs) {
    if (!(ref in validated)) {
      throw new ReviewItemError(
        'invalid_payload',
        `approve-designs verdict map is missing a decision for batch idea '${ref}'`,
      );
    }
  }
  return serializeDesignVerdictMap(validated);
}

/**
 * The heading the delivered design-decisions block MUST lead with — a CONTRACT
 * with planner.md (the resumed agent acts on a '# Approve-designs decisions'
 * block). Keep byte-identical on both sides.
 */
export const APPROVE_DESIGNS_DECISIONS_HEADING = '# Approve-designs decisions';

/**
 * Render the human's per-idea design verdicts into the turn text delivered to the
 * parked ORCHESTRATED planner (its SDK conversation cannot read review items). One
 * line per batch ref in BATCH ORDER under the heading contract, then the
 * proceed-instruction. Mirrors {@link renderApproveIdeasDecisions}.
 */
export function renderApproveDesignsDecisions(
  designRefs: string[],
  verdicts: Record<string, string>,
): string {
  const lines = designRefs.map((ref) => `- ${ref}: ${verdicts[ref]}`);
  return [
    APPROVE_DESIGNS_DECISIONS_HEADING,
    ...lines,
    '',
    'Proceed with the APPROVED designs only; a denied design goes back to its design step for revision.',
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
  /**
   * Idea-component ledger write (P20 — approve-plan REJECT unwinds `epics` /
   * `stories` back to `incomplete`). Optional: unset defaults to the initialized
   * `IdeaComponentRouter` singleton, which is a no-op when the router has not
   * been booted, so neither composition root needs re-wiring and every hand-built
   * test dep bag keeps compiling. Tests inject a spy.
   */
  setIdeaComponentState?: SetIdeaComponentState;
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
   * Per-idea verdict map for an approve-ideas OR approve-designs BATCH gate (the
   * "Submit decisions" payload). ONLY consumed when the item is one of those batch
   * decision gates — it is validated against the gate's batch payload (`ideaRefs`
   * or `designRefs`) and folded into the stored resolution (overriding
   * `outcome`/`resolution`). Ignored for every other gate/item, so scalar
   * resolutions stay byte-for-byte unaffected.
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

/**
 * The gate discriminants whose ORCHESTRATED-plane resolution earns durable side
 * effects. `approve-design` (singular) is the inline single-idea design gate; the
 * plural pair are the batch gates.
 */
const SIDE_EFFECT_GATES = new Set(['approve-ideas', 'approve-designs', 'approve-design']);

/**
 * Fire {@link GateSideEffects} for an orchestrated-plane decision gate, or do
 * nothing. See the call site for why the programmatic plane is excluded here.
 *
 * Fail-soft on every axis: an un-booted singleton, an unrecognized gate, a missing
 * run binding, and a throwing side effect all end as a silent no-op — a resolve
 * that already committed must never be turned into a refusal by an enrichment.
 */
async function maybeApplyOrchestratedGateSideEffects(
  before: { runId?: string | null; kind?: string; source?: string | null; payloadJson?: string | null } | undefined,
  gateStepId: string | null,
  resolution: string | null,
): Promise<void> {
  // A programmatic gate (source `gate:human-step:*`) is the opener's business.
  if (gateStepId !== null) return;
  if (!before?.runId || before.kind !== 'decision') return;
  const gate = parseDecisionGate(before.payloadJson);
  if (gate === null || !SIDE_EFFECT_GATES.has(gate)) return;
  const sideEffects = GateSideEffects.tryGetInstance();
  if (!sideEffects) return;
  try {
    await sideEffects.apply({
      runId: before.runId,
      stepId: gate,
      decision: gateDecisionFromResolution(resolution),
      resolution,
    });
  } catch {
    // GateSideEffects.apply is itself fail-soft; this catch is the belt to its
    // braces, because the resolve above has already committed.
  }
}

/**
 * The two ledger components an approve-plan REJECT invalidates: the ones whose
 * `complete` was earned by the very draft epics/tasks the reject tears down.
 *
 * `idea-spec`, `architecture` and `prototype` are deliberately NOT here. Those
 * were produced by earlier phases and survive the reject untouched — the human
 * declined the PLAN, not the spec or the design — so unwinding them would throw
 * away work that is still valid and send the next run to redo it.
 */
const PLAN_LEDGER_COMPONENTS: readonly IdeaComponentKey[] = ['epics', 'stories'];

/**
 * P20 — approve-plan REJECT unwinds the run's ideas' `epics` / `stories` ledger
 * components back to `incomplete`.
 *
 * `deleteRunCreatedEntities` already tears the rejected draft epics/tasks down,
 * but the ledger rows the decomposition steps stamped `complete` are a SEPARATE
 * store with no foreign key to them (migration 101), so nothing removed or
 * corrected those. A ledger row WINS over derivation permanently, so a leftover
 * `complete` over an idea that now has no epics and no tasks tells every later
 * Planner run that this idea is already decomposed — and the run skips exactly
 * the work the reject asked for. The draft delete is CODE; this is the other
 * half of it.
 *
 * Fires from the SAME place and with the same ordering guarantee as the delete:
 * inside the approve-plan arm, BEFORE the item resolves, so it wins the race with
 * the WorkflowController advancing off the gate.
 *
 * `ideaIds` MUST be resolved by the caller BEFORE the delete runs — the
 * decomposed-idea projection is derived from the child entities' lineage, which
 * the delete removes.
 *
 * Fail-soft and per-idea: the resolve has real work to do afterwards, and an
 * un-unwound ledger row is a planning-efficiency bug, never a correctness one.
 */
async function unwindPlanLedgerForReject(
  projectId: number,
  runId: string,
  ideaIds: readonly string[],
  setIdeaComponentState: SetIdeaComponentState,
): Promise<void> {
  for (const ideaId of ideaIds) {
    for (const component of PLAN_LEDGER_COMPONENTS) {
      try {
        await setIdeaComponentState(projectId, {
          op: 'set-component-state',
          ideaId,
          component,
          state: 'incomplete',
          source: 'flow',
          sourceRunId: runId,
        });
      } catch {
        // Per (idea, component) — one failure never blocks the rest or the resolve.
      }
    }
  }
}

/**
 * The ledger write seam used by {@link unwindPlanLedgerForReject}. Optional on
 * the dep bag with a singleton-backed default (mirroring
 * `GateSideEffects.tryGetInstance()` above) so neither composition root has to be
 * re-wired and every hand-built test dep bag keeps compiling; tests inject a spy.
 */
type SetIdeaComponentState = (
  projectId: number,
  change: {
    op: 'set-component-state';
    ideaId: string;
    component: IdeaComponentKey;
    state: 'incomplete';
    source: 'flow';
    sourceRunId: string;
  },
) => Promise<unknown>;

/** The default seam: the initialized IdeaComponentRouter, or a no-op when un-booted. */
function defaultSetIdeaComponentState(): SetIdeaComponentState {
  return async (projectId, change) => {
    let router: IdeaComponentRouter;
    try {
      router = IdeaComponentRouter.getInstance();
    } catch {
      // Un-booted (unit tests / standalone) — nothing to write.
      return;
    }
    await router.applyChange(projectId, change);
  };
}

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
  const setIdeaComponentState = deps.setIdeaComponentState ?? defaultSetIdeaComponentState();

  // Read the item's run binding + blocking flag + gate provenance BEFORE resolving
  // (the resolve changes none of them) so we know whether to apply aggregate-unblock
  // and whether an explicit outcome drives gate side effects. `status` feeds only
  // the approve-ideas scalar guard below (pending-only, so an already-terminal item
  // still surfaces the chokepoint's own 'invalid_status' refusal).
  const before = db
    .prepare(
      'SELECT run_id AS runId, blocking, status, kind, source, payload_json AS payloadJson FROM review_items WHERE id = ? AND project_id = ?',
    )
    .get(input.reviewItemId, input.projectId) as
    | {
        runId?: string | null;
        blocking?: number;
        status?: string;
        kind?: string;
        source?: string | null;
        payloadJson?: string | null;
      }
    | undefined;

  const gateStepId = humanGateStepId(before?.kind, before?.source);
  // The stored resolution the WorkflowController parses into its verdict. An explicit
  // outcome wins over free text (deterministic verdict); otherwise the caller's
  // free-text resolution passes through unchanged. An approve-ideas verdict map
  // overrides both below (inside the try, so a malformed map surfaces as a refusal).
  let resolution = input.outcome !== undefined ? input.outcome : input.resolution;

  try {
    // Approve-ideas BATCH gate, scalar-resolve REFUSAL: without a verdict map
    // there is nothing to fold OR deliver — a bare approve/reject (the generic
    // queue card's buttons, or a monitor resolveReviewItem action) would clear
    // the gate while recording no per-idea decision, stranding the parked
    // planner with no way to learn which ideas were approved. Refuse
    // (invalid_payload → BAD_REQUEST) and leave the gate pending; the only
    // honest surface is the run's Approve-ideas artifact tab, which submits
    // `verdicts`. Pending-only so an already-terminal item still surfaces the
    // chokepoint's own 'invalid_status' below.
    const isIdeasBatchGate = isApproveIdeasGate(before?.kind, before?.source, before?.payloadJson);
    const isDesignsBatchGate = isApproveDesignsGate(before?.kind, before?.source, before?.payloadJson);
    if (
      input.verdicts === undefined &&
      before?.status === 'pending' &&
      (isIdeasBatchGate || isDesignsBatchGate)
    ) {
      throw new ReviewItemError(
        'invalid_payload',
        isIdeasBatchGate
          ? "an approve-ideas batch gate needs per-idea verdicts — submit decisions from the run's Approve ideas tab"
          : "an approve-designs batch gate needs per-design verdicts — submit decisions from the run's Approve designs tab",
      );
    }

    // Approve-ideas / approve-designs BATCH gate: a submitted per-idea verdict map
    // is validated against the gate's batch payload and folded into the stored
    // resolution the resumed planner reads. Recognized via isApprove*Gate (source
    // OR payload) so BOTH mint paths fold identically — the programmatic runner's
    // 'gate:human-step:approve-*' source AND the default ORCHESTRATED planner's
    // 'agent:<label>' source (whose gate lives only in the payload). All-or-nothing —
    // foldIdeaVerdicts / foldDesignVerdicts throws ReviewItemError('invalid_payload')
    // on a malformed map (empty / unknown ref / bad value / incomplete coverage),
    // which the catch below maps to a refusal BEFORE the single atomic resolve runs,
    // so the gate stays pending and nothing is recorded. Only the "Submit decisions"
    // surface passes `verdicts`; a scalar resolve on THESE gates was already refused
    // above, and every OTHER gate leaves `verdicts` undefined and is byte-for-byte
    // unaffected.
    if (input.verdicts !== undefined) {
      if (isIdeasBatchGate) {
        // Batch refs come from the gate's mint-time payload. FALLBACK for a
        // programmatic `gate:human-step:approve-ideas` row minted WITHOUT them
        // (pre-payload-stamp builds): derive the refs at resolve time from the
        // run's owned ideas via the SAME helper the mint and the artifact tab
        // use, so the legacy gate stays resolvable instead of hard-refusing
        // every verdict map. Payload wins when present; the fold still
        // validates the map against whichever ref list resolves.
        let ideaRefs = parseApproveIdeasRefs(before?.payloadJson);
        if (ideaRefs.length === 0 && gateStepId === APPROVE_IDEAS_STEP_ID && before?.runId) {
          ideaRefs = listApproveIdeasBatchRows(db, before.runId).map((row) => row.ref);
        }
        resolution = foldIdeaVerdicts(ideaRefs, input.verdicts);
      } else if (isDesignsBatchGate) {
        resolution = foldDesignVerdicts(parseApproveDesignsRefs(before?.payloadJson), input.verdicts);
      }
    }

    // Approve-plan side effects run BEFORE the resolve so they beat the controller
    // (the chokepoint's post-commit 'resolved' emit is what makes it advance). Both
    // are fail-soft + idempotent, so awaiting them here can never strand the resolve.
    if (gateStepId === APPROVE_PLAN_STEP_ID && before?.runId) {
      if (input.outcome === 'approve') {
        await promotePendingDraftsForRun(before.runId);
      } else if (input.outcome === 'reject') {
        // P20: resolve the decomposed-idea set BEFORE the delete. The projection
        // is derived from the lineage of the very child entities the delete
        // removes, so reading it afterwards would always return an empty set and
        // the ledger would silently stay `complete`.
        const decomposedIdeaIds = listRunDecomposedIdeaIds(db, before.runId);
        await deleteRunCreatedEntities(input.projectId, before.runId).catch(() => {
          /* self-gated + best-effort — never block the reject resolve */
        });
        // The other half of the teardown: the drafts are gone, so the ledger rows
        // claiming they exist must go back to `incomplete` or the next run skips
        // the decomposition this reject asked for.
        await unwindPlanLedgerForReject(
          input.projectId,
          before.runId,
          decomposedIdeaIds,
          setIdeaComponentState,
        );
      }
    }

    const { reviewItemId } = await applyReviewItemResolve(input.projectId, {
      reviewItemId: input.reviewItemId,
      actor: 'user',
      ...(resolution !== undefined ? { resolution } : {}),
    });

    // ORCHESTRATED-PLANE design/brief gate side effects (durably bind the approved
    // prototype, stamp the project's solution thoroughness, log the adversarial
    // reviewer's remaining entries as accepted risks).
    //
    // This arm covers ONLY the gates the flow minted itself via
    // cyboflow_report_finding kind:'decision' — recognized by the payload `gate`
    // discriminant and the ABSENCE of a `gate:human-step:` source. A programmatic
    // gate carries that source and is handled by HumanGateOpener.onGateResolved,
    // which the controller actually waits on; firing here too would double-run
    // every side effect on that plane.
    //
    // Ordering is BEST-EFFORT and not claimed otherwise: there is no controller
    // walk on the orchestrated plane to order against, and the resumed SDK
    // conversation is woken by the router's own synchronous emit inside the
    // resolve above. Awaited anyway so the writes are in flight before this call
    // returns. GateSideEffects.apply is idempotent and never throws; tryGetInstance
    // keeps every hand-built dep bag in the unit suite working un-booted.
    await maybeApplyOrchestratedGateSideEffects(before, gateStepId, resolution ?? null);

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
