/**
 * ReviewItemCard — kind-polymorphic card for the unified review_items inbox.
 *
 * Renders one of the five review-item kinds (finding | permission | decision |
 * human_task | notification) with kind-specific chrome and triage actions:
 *
 * ## Default CTAs vs. option-carrying CTAs
 *
 * An escalation that carries NO options of its own (a blocking finding, a
 * free-form action item, a `gate:human-step:*` decision minted with
 * `payload: null` — see humanStepManager.composeGatePayload, which composes a
 * payload only for `approve-ideas` and for an `approve-design` opened under a
 * review freshness bound, neither of which carries options) must not have a
 * verdict invented for it by
 * this card. Its default actions are "Open in session →" + "Dismiss": route the
 * human to the run, where the gate's real surface lives (the decomposed-stories
 * tab's approve-plan control, the approve-ideas / approve-designs verdict grids,
 * or simply the transcript), rather than offering a resolve button that settles
 * the gate without anyone having looked at the work.
 *
 * That routing is SURFACE-AWARE (`surface` prop). On the 'queue' surface the
 * default pair applies. In `surface="session"` — RunPendingInputStrip, which
 * renders this same card INSIDE the run — "Open in session" is a no-op, so those
 * branches keep their real actions; the strip is the terminal surface for any
 * gate whose flow has no artifact tab of its own (sprint's `human-review`,
 * compound's `approve-learnings`, ship's gates). Removing them there would leave
 * those gates answerable only by Dismiss, which humanGate.ts maps to a REJECT
 * verdict.
 *
 * NOTE: as of the review-queue redesign the landing home renders its OWN rows
 * (`landing/NeedsInputSection.tsx`) rather than this card, so RunPendingInputStrip
 * is this card's only production host and 'queue' has none today. The surface is
 * kept (and its default-pair semantics tested) because it is the safe default for
 * any future host that is NOT inside the run.
 *
 * Two further carve-outs, both load-bearing:
 *   - A RUN-LESS item (`run_id === null` — a manual / triage-minted row) keeps its
 *     full action set on every surface: "Open in session" has no destination, and
 *     collapsing anyway would leave Dismiss as the only exit.
 *   - The default pair's discard half routes a DECISION through
 *     resolve(outcome: gateDeclineOutcome(item)), not dismiss — see
 *     defaultEscalationActions. gateDeclineOutcome is the centralized gate ->
 *     verdict mapping (TASK-222): 'reject' for a plain gate, but 'revise' for a
 *     gate that declares an intra-phase loopback (today: only `approve-design`),
 *     so a Dismiss click can never silently downgrade a revise-capable gate into
 *     a run-ending reject.
 *   - `approve-design` specifically is checked BEFORE `usesDefaultActions`
 *     collapses to the default pair at all (see the `decision` case below), so it
 *     renders its own Approve/Revise pair on every surface instead of ever
 *     reaching "Open in session" + Dismiss.
 *
 * Branches that DO carry options — permission, the recovery gate's recovered
 * answers, the idea-size guard's two mutations, approve-ideas, the
 * experiment-comparison view, a question-sourced decision, and non-blocking
 * finding triage — are unaffected on both surfaces.
 *
 *   - finding      — a non-blocking observation. Triage: Dismiss / Promote to task.
 *                    When the reporting agent carries an accept-routing hint
 *                    (payload.proposedTarget), the card renders a '→ TARGET' chip
 *                    and makes the primary action CONTEXTUAL: 'backlog' keeps
 *                    Promote-to-task (relabelled 'Accept → task'); 'docs'/'prompt'
 *                    surface an 'Accept' that resolves with 'triaged:accepted-<target>'
 *                    (the human applies the edit). No hint = today's exact actions.
 *                    EXCEPT for an eval-sourced finding (source LIKE
 *                    'agent:eval%' — TASK-277): a post-hoc jury flag on a run
 *                    still parked at its human-review gate is a different kind
 *                    of thing than an agent's inline observation, so it gets
 *                    its own triage set instead — Address review findings
 *                    (rewinds the run to `address-review`, disabled with a
 *                    tooltip when the run already completed or the flow has
 *                    no such step) / Log as findings (resolves
 *                    'triaged:logged', no task minted) / Dismiss. Promote to
 *                    task never appears for these. The ad-hoc quick-session
 *                    verdict summary is a sub-case that drops Address
 *                    entirely (its run has no address-review step at all).
 *   - permission   — a real-time PreToolUse/approval gate (blocking). Reuses the
 *                    APPROVAL resolution path: Approve / Reject route to
 *                    cyboflow.approvals.approve / reject via the folded approvalId.
 *   - decision     — an approve-idea / approve-plan gate (blocking). Resolving it
 *                    via reviewItems.resolve triggers aggregate-unblock → the
 *                    paused run auto-resumes (FLOW ADVANCEMENT). The explicit
 *                    "Approve & resume" / "Reject" verdict pair is a SESSION-surface
 *                    action; the queue routes to the run instead. A
 *                    `gate:'idea-size-guard'`
 *                    decision (IDEA-009: a too-large idea parked mid-batch)
 *                    surfaces its own pair instead: "Launch a separate planner"
 *                    (runs.launchSeparatePlanner) / "Return to backlog"
 *                    (runs.returnIdeaToBacklog) — both resolve the guard
 *                    server-side, never the generic resolve/dismiss. A
 *                    `gate:'systemic-pause'` decision (plan v2: a
 *                    programmatic step's agent hit a subscription/session
 *                    limit) is checked the same way as approve-design — BEFORE
 *                    the default-actions collapse, on both surfaces — and
 *                    offers Retry now / Switch runtime & retry (an inline
 *                    {@link SystemicPauseSwitchForm} in-session, "Switch &
 *                    retry…" routing to the session from the queue) / Stop
 *                    waiting, never a resolve(outcome:'reject'). A pause whose
 *                    payload says `origin: 'triage'` (only the run's Claude-only
 *                    supervisor hit the limit) offers NO switch — nothing a
 *                    step-agent switch does can move it.
 *   - human_task   — a free-form action item (blocking per-item). Carries no
 *                    options, so the queue offers the default pair; in-session it
 *                    keeps Resolve / Dismiss / Promote to task.
 *   - notification — an informational FYI (e.g. a dynamic workflow finished /
 *                    stalled). The work already ran, so its only triage is
 *                    Dismiss — no Resolve, no Promote-to-task.
 *
 * A blocking badge renders on any item with `blocking === true`. The card owns
 * no validation — every action delegates to a chokepoint via the actions hook
 * (review-item triage) or the approvals router (permission gates).
 */
import React from 'react';
import { Button } from '../ui/Button';
import { formatAge } from '../../utils/approvalFormatters';
import { trackEvent } from '../../utils/telemetry';
import { trpc } from '../../trpc/client';
import { isSystemicPauseItem, systemicPauseOrigin } from '../../utils/systemicPause';
import type { ReviewItem, ReviewItemKind, FindingProposedTarget } from '../../../../shared/types/reviews';
import {
  IDLE_REVIEW_SOURCE_PREFIX,
  LOGGED_FINDING_RESOLUTION,
  isEvalSourcedFinding,
  isEvalAdHocSummary,
  parseSupervisorRecommendation,
} from '../../../../shared/types/reviews';
import type { SupervisorRecommendationChoice } from '../../../../shared/types/reviews';
import type { QuestionPayload } from '../../../../shared/types/questions';
import { useReviewItemActions } from '../../hooks/useReviewItemActions';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { SystemicPauseSwitchForm } from './SystemicPauseSwitchForm';

// ---------------------------------------------------------------------------
// Accept-routing target chip — keyed on the discriminant so a new target breaks
// the map at compile time (per docs/CODE-PATTERNS.md "Label maps for shared-type
// discriminants").
// ---------------------------------------------------------------------------

const TARGET_CHIP_LABEL: Record<FindingProposedTarget, string> = {
  backlog: '→ Backlog',
  docs: '→ Docs',
  prompt: '→ Prompt',
  fix: '→ Quick fix',
};

// ---------------------------------------------------------------------------
// Supervisor-recommendation chip — the run monitor's NON-BINDING advice, written
// into the item body as a `## Supervisor recommendation` section by the router's
// `annotate` op. The label is the COPY OF THE BUTTON the recommendation points
// at, not the raw choice word, so the human reads "the supervisor would press
// that one" rather than having to map a verb onto a menu. Keyed on the
// discriminant so a new choice breaks the map at compile time (per
// docs/CODE-PATTERNS.md "Label maps for shared-type discriminants").
// ---------------------------------------------------------------------------

const RECOMMENDATION_CHIP_LABEL: Record<SupervisorRecommendationChoice, string> = {
  approve: 'Approve',
  reject: 'Reject',
  continue: 'Continue, log as findings',
  rerun: 'Rerun planning with findings',
  dismiss: 'Continue without logging',
};

// ---------------------------------------------------------------------------
// Kind label map — keyed on the discriminant so a new kind breaks the map at
// compile time (per docs/CODE-PATTERNS.md "Label maps for shared-type discriminants").
// ---------------------------------------------------------------------------

const KIND_LABEL: Record<ReviewItemKind, string> = {
  finding: 'Finding',
  permission: 'Permission',
  decision: 'Decision',
  human_task: 'Action',
  notification: 'Notice',
};

const KIND_ACCENT: Record<ReviewItemKind, string> = {
  finding: 'text-text-secondary',
  permission: 'text-status-error',
  decision: 'text-interactive',
  human_task: 'text-status-warning',
  notification: 'text-text-tertiary',
};

/**
 * Where this card is mounted. 'queue' (the default — any host OUTSIDE the run;
 * none in production today, see the module doc) routes option-less escalations
 * to the run via the default "Open in session →" pair. 'session'
 * (RunPendingInputStrip) is already inside the run, so those branches render
 * their real actions instead.
 */
export type ReviewItemCardSurface = 'queue' | 'session';

interface ReviewItemCardProps {
  item: ReviewItem;
  /** When true, renders a visible focus ring for keyboard-navigation highlighting. */
  isFocused?: boolean;
  /** Called once after a successful triage (resolve / dismiss / promote / approve / reject). */
  onResolved?: () => void;
  /** @see ReviewItemCardSurface — defaults to 'queue'. */
  surface?: ReviewItemCardSurface;
}

/**
 * The folded approvalId for a permission item (or null when not present). Used
 * to route Approve / Reject through the approval resolution path.
 */
function permissionApprovalId(item: ReviewItem): string | null {
  if (item.kind !== 'permission') return null;
  const payload = item.payload;
  if (payload && payload.kind === 'permission' && typeof payload.approvalId === 'string') {
    return payload.approvalId;
  }
  return null;
}

/**
 * True for a durable `ask-user-question-recovery` decision gate — keyed on the
 * payload discriminant, INDEPENDENT of whether any options were recovered. A
 * recovery gate MUST be answered via `runs.answerRecoveryGate` (which delivers the
 * answer as a `--resume` turn); the generic resolve/dismiss route only flips run
 * status and would strand a drained SDK session unanswered. So even an option-less
 * (malformed-payload) recovery gate stays on the recovery answer path, never the
 * generic Approve/Reject — the backend rejects generic triage on these too.
 */
function isRecoveryGate(item: ReviewItem): boolean {
  if (item.kind !== 'decision') return false;
  const payload = item.payload;
  return Boolean(payload && payload.kind === 'decision' && payload.gate === 'ask-user-question-recovery');
}

/**
 * The recovered AskUserQuestion options for a durable `ask-user-question-recovery`
 * decision gate (empty for any other item). Parsed defensively so a malformed
 * payload degrades to no options — the card then offers a FREE-TEXT answer (still
 * routed through answerRecoveryGate), never a plain resolve/dismiss.
 */
function recoveredQuestions(item: ReviewItem): QuestionPayload[] {
  if (!isRecoveryGate(item)) return [];
  const payload = item.payload;
  if (payload && payload.kind === 'decision' && Array.isArray(payload.recoveredQuestions)) {
    return payload.recoveredQuestions;
  }
  return [];
}

/**
 * A human-readable explanation for a REFUSED recovery-gate resume, so the card
 * can stay visible with actionable context instead of silently swallowing the
 * answer. `nudge` is the runs.answerRecoveryGate result's nudge outcome.
 */
function recoveryResumeErrorMessage(nudge: { noOp?: true; reason?: string } | { delivered?: true }): string {
  const reason = 'reason' in nudge ? nudge.reason : undefined;
  switch (reason) {
    case 'no_session':
      return "This run has no saved session to resume — it can't be answered from here.";
    case 'not_idle':
      return 'The run is busy right now — wait for it to settle, then try again.';
    case 'blocked':
      return 'Another blocking item must be cleared before this run can resume.';
    case 'race':
      return 'The run just changed state — please try again.';
    case 'execute_failed':
      return 'The run failed to resume — check the run and try again.';
    case 'terminal':
      return 'This run has already ended.';
    default:
      return 'Could not resume the run — the gate is still open, try again.';
  }
}

/**
 * The accept-routing hint for a finding (or null when absent / malformed).
 * Parsed defensively (unknown + guards) so a payload missing or carrying a
 * non-union proposedTarget behaves EXACTLY like no payload — the card then keeps
 * its legacy Dismiss / Promote-to-task actions with zero behavior change.
 */
function findingProposedTarget(item: ReviewItem): FindingProposedTarget | null {
  if (item.kind !== 'finding') return null;
  const payload: unknown = item.payload;
  if (payload === null || typeof payload !== 'object') return null;
  const target = (payload as { proposedTarget?: unknown }).proposedTarget;
  if (target === 'backlog' || target === 'docs' || target === 'prompt' || target === 'fix') return target;
  return null;
}

/**
 * A/B testing slice C: the experimentId when this decision item is a
 * `gate:'experiment-comparison'` pairwise-verdict notification (minted by
 * PairwiseJudgeWorker), or null for every other decision (approve-idea /
 * approve-plan / a malformed payload) — which keep the legacy resolve/dismiss
 * actions unchanged. Parsed defensively so an absent/foreign payload shape
 * behaves exactly like no payload.
 */
function experimentComparisonId(item: ReviewItem): string | null {
  if (item.kind !== 'decision') return null;
  const payload: unknown = item.payload;
  if (payload === null || typeof payload !== 'object') return null;
  const p = payload as { gate?: unknown; experimentId?: unknown };
  if (p.gate !== 'experiment-comparison' || typeof p.experimentId !== 'string') return null;
  return p.experimentId;
}

/**
 * IDEA-009: true for a `gate:'idea-size-guard'` decision item — the planner's
 * size guard parks a too-large idea mid-batch behind this gate. The
 * discriminant is INDEPENDENT of whether `payload.ideaRef` is present (it is
 * optional in {@link DecisionPayload}) — the guard branch must still activate
 * off the soft entity link alone, see {@link ideaSizeGuardRef}. Parsed
 * defensively so a malformed/foreign payload behaves exactly like no payload
 * (legacy resolve/dismiss actions), mirroring {@link experimentComparisonId}.
 */
function isIdeaSizeGuard(item: ReviewItem): boolean {
  if (item.kind !== 'decision') return false;
  const payload = item.payload;
  return Boolean(payload && payload.kind === 'decision' && payload.gate === 'idea-size-guard');
}

/**
 * IDEA-009: the flagged idea's display ref for a `gate:'idea-size-guard'`
 * decision item, or null for every other decision. Prefers `payload.ideaRef`;
 * falls back to the item's soft entity link (`entity_type === 'idea'` →
 * `entity_id`) when the payload omits it; falls back to a generic label so the
 * guard branch still renders (never a plain string 'null') when neither is
 * present.
 */
function ideaSizeGuardRef(item: ReviewItem): string | null {
  if (!isIdeaSizeGuard(item)) return null;
  const payload = item.payload;
  if (payload && payload.kind === 'decision' && typeof payload.ideaRef === 'string') {
    return payload.ideaRef;
  }
  if (item.entity_type === 'idea' && item.entity_id !== null) {
    return item.entity_id;
  }
  return 'this idea';
}

/**
 * Which of the idea-size guard's two realized choices a RESOLVED item's
 * `resolution` note recorded — keyed on the stable prefix each server mutation
 * writes (runs.ts `launchSeparatePlanner` → `separate-planner:<runId>`,
 * `returnIdeaToBacklog` → `return-to-backlog:<ideaId>`). Null for a still-pending
 * item or an unrecognized resolution, so the card falls back to a generic
 * "Resolved" label rather than guessing.
 */
function guardResolutionPath(resolution: string | null): 'separate-planner' | 'return-to-backlog' | null {
  if (resolution === null) return null;
  if (resolution.startsWith('separate-planner:')) return 'separate-planner';
  if (resolution.startsWith('return-to-backlog:')) return 'return-to-backlog';
  return null;
}

/**
 * IDEA-009: true for an approve-ideas BATCH-gate decision item — minted by
 * EITHER the programmatic runner (source 'gate:human-step:approve-ideas') OR
 * the default ORCHESTRATED planner (source 'agent:<label>', where the gate is
 * discoverable ONLY via the payload — keying on source alone would silently
 * never fire for it, the TASK-035B landmine). Mirrors the backend's
 * isApproveIdeasGate discriminant; parsed defensively like the sibling
 * {@link isIdeaSizeGuard}.
 */
function isApproveIdeasGateItem(item: ReviewItem): boolean {
  if (item.kind !== 'decision') return false;
  if (item.source === 'gate:human-step:approve-ideas') return true;
  const payload = item.payload;
  return Boolean(payload && payload.kind === 'decision' && payload.gate === 'approve-ideas');
}

/**
 * Tier 2, item 12b: true for the two-way approve-design gate — Approve logs
 * every remaining adversarial-review entry as a non-blocking accepted-risk
 * finding and continues; Revise reruns the design steps with those findings
 * as feedback (a loopback, not a rejection). The generic "Approve & resume" /
 * "Reject" labels below read as a plain accept/deny, which is wrong for a
 * revision loop — this keys the button copy on the gate the same way
 * {@link isApproveIdeasGateItem} does.
 */
function isApproveDesignGateItem(item: ReviewItem): boolean {
  if (item.kind !== 'decision') return false;
  if (item.source === 'gate:human-step:approve-design') return true;
  const payload = item.payload;
  return Boolean(payload && payload.kind === 'decision' && payload.gate === 'approve-design');
}

/**
 * TASK-222 — centralized gate -> verdict mapping. A gate that declares an
 * intra-phase `loopback` (today, the ONLY one among human gates: `approve-design`
 * — shared/types/workflows.ts) must never have its non-approve action recorded as
 * a plain terminal 'reject': that ENDS the run instead of looping back to
 * `expand-spec`/`ui-prototype` with the human's note + the adversarial review
 * threaded in (the 2026-09-17 swift-bison incident — `defaultEscalationActions`'s
 * discard button used to hardcode 'reject' for every decision kind, silently
 * downgrading this gate's Dismiss into a run-ending reject on the queue surface).
 *
 * ONE function, used by BOTH the explicit verdict pair below AND
 * `defaultEscalationActions`'s discard, so a future surface/collapse cannot
 * regress back to a bare 'reject' literal for this gate. Extend the underlying
 * discriminant (currently just {@link isApproveDesignGateItem}) — never add a new
 * per-surface conditional — when a future gate adds a loopback.
 */
function gateDeclineOutcome(item: ReviewItem): 'reject' | 'revise' {
  return isApproveDesignGateItem(item) ? 'revise' : 'reject';
}

// ---------------------------------------------------------------------------
// Plan v2 — switch runtime/model on a systemic pause (subscription/session
// limit) and retry. `gate:systemic-pause:<stepId>` decision items.
// ---------------------------------------------------------------------------

/**
 * The human-readable disposition for a RESOLVED/DISMISSED systemic-pause
 * item, keyed on the resolution's stable prefix. Dismissed (by status OR a
 * 'stop waiting' resolution) is checked first — it is the definitive "gave
 * up" signal; 'retry: switched…' (the switch handler's own resolution, see
 * plan v2 D3 step 6) names the switch-and-retry path specifically; anything
 * else that reached a terminal status through a plain resolve() (a bare
 * retry, or the auto-resume timer's 'auto-retry…') reads as a plain retry.
 */
function systemicPauseResolvedLabel(item: ReviewItem): string {
  const resolution = item.resolution ?? '';
  if (item.status === 'dismissed' || resolution.startsWith('stop waiting')) return 'Stopped waiting';
  if (resolution.startsWith('retry: switched')) return 'Switched & retried';
  return 'Retried';
}

// ---------------------------------------------------------------------------
// TASK-277 — eval-sourced finding triage (Address review findings / Log as
// findings / Dismiss), replacing the legacy Dismiss / Promote-to-task pair.
// ---------------------------------------------------------------------------

/** Human copy for `runs.canAddressReviewFindings`'s ineligibility reasons. */
const ADDRESS_REVIEW_DISABLED_TOOLTIP: Record<'completed' | 'no_step' | 'in_progress', string> = {
  completed: 'Run already completed — log or dismiss',
  no_step: 'This flow has no address-review step',
  in_progress: 'Address review is already running for this run',
};

/** Human copy for a `runs.addressReviewFindings` `noOp` result (the rare race case). */
const ADDRESS_REVIEW_NOOP_MESSAGE: Record<string, string> = {
  not_found: 'Run not found.',
  not_programmatic: 'Only programmatic runs support Address review findings.',
  not_rewindable: 'This run is not in a state that can be rewound right now.',
  in_progress: 'Address review is already running for this run — its findings are being worked through.',
  unknown_step: 'This flow has no address-review step.',
  target_not_prior: 'The address-review step is ahead of the run — nothing to rewind.',
  fanout_settled: 'Every sprint task in this run is already integrated.',
  race: 'The run changed state — try again.',
};

/** The eligibility shape `runs.canAddressReviewFindings` returns; null while loading. */
type AddressReviewEligibility = { eligible: boolean; reason?: 'completed' | 'no_step' | 'in_progress' } | null;

/**
 * The narrower half of {@link isApproveDesignGateItem}: ONLY the programmatic
 * runner's singular `gate:human-step:approve-design` item.
 *
 * This is the discriminant `resolveReviewItemHandler` itself uses to admit the
 * `no-findings` verdict modifier — it refuses `approve[no-findings]` on anything
 * whose source is not exactly that string. So the two behaviours that SEND the
 * modifier (the third in-session button and the queue surface's re-pointed
 * discard) must key on this, not on the payload-discriminated sibling from the
 * ORCHESTRATED plane, which would get a refused resolve and no verdict at all.
 * Copy and layout stay on the wider predicate: they are correct for both.
 */
function isProgrammaticApproveDesignGate(item: ReviewItem): boolean {
  return item.kind === 'decision' && item.source === 'gate:human-step:approve-design';
}

/**
 * The in-session gate buttons, as emphasis targets. Not the same set as the
 * verdict words: an approve-design gate offers TWO distinct approves (log the
 * surviving entries, or don't), and the plain gates offer no revise button of
 * their own.
 */
type GateButton = 'approve' | 'revise' | 'no-findings' | 'reject';

/**
 * Which button, if any, the supervisor's recommendation points at.
 *
 * The mapping is per-gate because the recommendation names a CHOICE while the
 * card renders BUTTONS, and the two menus differ: at an approve-design gate
 * `continue`/`rerun`/`dismiss` are the three controls, while every other gate
 * renders only Approve and Reject — so a plain gate maps `approve`→Approve and
 * `reject`→Reject, and nothing else. In particular there is no "send it back"
 * arm here: a plain gate's Reject ENDS THE RUN, so routing a third choice onto
 * it would emphasize the destructive button on advice nobody gave. A
 * recommendation naming a choice this gate does not offer emphasizes nothing,
 * and the card keeps today's emphasis.
 */
function recommendedGateButton(
  choice: SupervisorRecommendationChoice | undefined,
  approveDesign: boolean,
): GateButton | null {
  if (choice === undefined) return null;
  if (approveDesign) {
    if (choice === 'continue') return 'approve';
    if (choice === 'rerun') return 'revise';
    if (choice === 'dismiss') return 'no-findings';
    return null;
  }
  if (choice === 'approve') return 'approve';
  if (choice === 'reject') return 'reject';
  return null;
}

export function ReviewItemCard({
  item,
  isFocused = false,
  onResolved,
  surface = 'queue',
}: ReviewItemCardProps): React.ReactElement {
  const {
    pendingItemId,
    error,
    resolve,
    acceptFinding,
    dismiss,
    promoteToTask,
    launchSeparatePlanner,
    returnIdeaToBacklog,
  } = useReviewItemActions();
  const [approvalBusy, setApprovalBusy] = React.useState(false);
  // Set when a recovery-gate resume was REFUSED — the gate stays open and this
  // explains why, so the answer is never silently lost.
  const [recoveryError, setRecoveryError] = React.useState<string | null>(null);
  // Free-text answer for an OPTION-LESS recovery gate (malformed AskUserQuestion
  // payload → no recovered options). Still delivered via answerRecoveryGate.
  const [recoveryText, setRecoveryText] = React.useState('');
  // The human's own words on an approve-design REVISE ("only AR-2 matters, drop
  // AR-11"). Sent as the resolve's `resolution` next to outcome 'revise', which
  // the server composes into 'revise: <note>' — the re-run reads it back through
  // readGateResolutionNote and it outranks the review itself. Empty => no note,
  // so the stored resolution stays the bare verdict word it is today.
  const [reviseNote, setReviseNote] = React.useState('');
  // TASK-277: in-flight state for the "Address review findings" rewind (a
  // separate busy flag — this mutation never resolves the item, so it must
  // not disable Log/Dismiss the way the shared `pendingItemId` would).
  const [addressBusy, setAddressBusy] = React.useState(false);
  const [addressError, setAddressError] = React.useState<string | null>(null);
  const [addressEligibility, setAddressEligibility] = React.useState<AddressReviewEligibility>(null);
  // Plan v2: whether the inline "Switch runtime & retry" form is open for a
  // systemic-pause item (session surface only — the queue-side row lives in
  // the landing's NeedsInputSection, whose "Switch & retry…" opens the session).
  const [showSwitchForm, setShowSwitchForm] = React.useState(false);

  const busy = pendingItemId === item.id || approvalBusy;
  // Accept-routing hint (findings only); null = legacy actions, zero change.
  const proposedTarget = findingProposedTarget(item);
  // The supervisor's recommendation, parsed out of the body's annotated section;
  // null = no chip. Rendered on BOTH surfaces (the header block below is shared),
  // because the advice is just as useful in the queue as it is in the session.
  const recommendation = parseSupervisorRecommendation(item.body);
  // TASK-277: eval-sourced findings (source LIKE 'agent:eval%') get a
  // dedicated triage set (Address review findings / Log as findings /
  // Dismiss) instead of the legacy Dismiss / Promote-to-task pair — see the
  // 'finding' case below. The ad-hoc quick-session summary is a sub-case that
  // never offers Address (its run has no address-review step to reopen).
  const isEvalFinding = item.kind === 'finding' && isEvalSourcedFinding(item.source);
  const isAdHocEvalSummary = isEvalFinding && isEvalAdHocSummary(item);
  // A/B testing slice C: an experiment-comparison decision routes to the
  // comparison view instead of the legacy resolve/dismiss actions.
  const comparisonExperimentId = experimentComparisonId(item);
  const focusClass = isFocused
    ? ' ring-2 ring-interactive'
    : ' focus-within:ring-2 focus-within:ring-interactive';

  // -- Action handlers ------------------------------------------------------

  const handleResolve = (): void => {
    void resolve(item.project_id, item.id).then((r) => {
      if (r !== null) {
        trackEvent('review_item_resolved', { kind: item.kind, action: 'resolve', blocking: item.blocking });
        onResolved?.();
      }
    });
  };

  // Explicit programmatic human-gate verdict (approve-plan / approve-idea /
  // approve-design). 'approve' resolves + reveals the run's drafts and resumes;
  // 'reject' tears down rejected drafts and lets the controller end the run
  // 'rejected'. Both route through reviewItems.resolve via the `outcome` field so
  // the WorkflowController's parseGateVerdict is deterministic, not a free-text sniff.
  // 'revise' is the approve-design gate's SECOND choice ("Rerun planning with
  // findings"): the controller loops back to the design steps with the
  // adversarial review threaded in. It is never 'reject' — that verdict ends the
  // run, which the 2026-09-15 launch smoke hit from this very button.
  // A REVISE on the approve-design gate may carry the human's note (the textarea
  // rendered above the buttons). Every other decision sends the bare outcome, so
  // its stored resolution is byte-identical to today's; an empty textarea is the
  // same, since `undefined` is dropped before the mutation.
  // The MODIFIER qualifies an approve: `no-findings` is the approve-design
  // gate's third choice ("Continue without logging"), which approves the design
  // while telling gateSideEffects NOT to log the surviving adversarial-review
  // entries as accepted-risk findings. It rides the stored resolution as
  // `approve[no-findings]`; the server refuses it on any other outcome or gate.
  const handleGateDecision = (
    outcome: 'approve' | 'reject' | 'revise',
    modifier?: 'no-findings',
  ): void => {
    const note =
      outcome === 'revise' && isApproveDesignGateItem(item) ? reviseNote.trim() || undefined : undefined;
    void resolve(item.project_id, item.id, {
      outcome,
      surface,
      ...(modifier !== undefined ? { modifier } : {}),
      ...(note !== undefined ? { resolution: note } : {}),
    }).then((r) => {
      if (r !== null) {
        trackEvent('review_item_resolved', {
          kind: item.kind,
          // `approve[no-findings]` is counted apart from a plain approve: the
          // interesting number is how often a critique is dropped, not approved.
          action: modifier === 'no-findings' ? 'approve[no-findings]' : outcome,
          blocking: item.blocking,
        });
        onResolved?.();
      }
    });
  };

  const handleDismiss = (): void => {
    void dismiss(item.project_id, item.id).then((ok) => {
      if (ok) {
        trackEvent('review_item_resolved', { kind: item.kind, action: 'dismiss', blocking: item.blocking });
        onResolved?.();
      }
    });
  };

  const handlePromote = (): void => {
    void promoteToTask(item.project_id, item.id).then((r) => {
      if (r !== null) {
        trackEvent('review_item_resolved', { kind: item.kind, action: 'promote_to_task', blocking: item.blocking });
        onResolved?.();
      }
    });
  };

  // TASK-277: fetch the "Address review findings" eligibility for an
  // eligible eval finding's run — the button renders disabled (with an
  // explanatory tooltip) until this resolves, rather than letting the human
  // click it and hit a `noOp` reason. Skipped entirely for the ad-hoc summary
  // (never offers Address) and any run-less item (defensive — evalWorker
  // always binds a run).
  React.useEffect(() => {
    if (!isEvalFinding || isAdHocEvalSummary || item.run_id === null) {
      setAddressEligibility(null);
      return;
    }
    let cancelled = false;
    setAddressEligibility(null);
    void trpc.cyboflow.runs.canAddressReviewFindings
      .query({ runId: item.run_id })
      .then((result) => {
        if (!cancelled) setAddressEligibility(result);
      })
      .catch(() => {
        if (!cancelled) setAddressEligibility({ eligible: false, reason: 'completed' });
      });
    return () => {
      cancelled = true;
    };
  }, [isEvalFinding, isAdHocEvalSummary, item.run_id]);

  // TASK-277: "Log as findings" — resolve with 'triaged:logged' (no task
  // minted, the row stays queryable). Clears a blocking cap item's gate the
  // same way any other resolve does (aggregate-unblock).
  const handleLogFinding = (): void => {
    void resolve(item.project_id, item.id, { resolution: LOGGED_FINDING_RESOLUTION }).then((r) => {
      if (r !== null) {
        trackEvent('review_item_resolved', { kind: item.kind, action: 'log_as_finding', blocking: item.blocking });
        onResolved?.();
      }
    });
  };

  // TASK-277: "Address review findings" — reopen the run's `address-review`
  // step so it discovers + acts on EVERY still-pending eval finding for this
  // run (cyboflow_list_run_findings, called from the step itself). The
  // findings stay pending — address-review resolves each one it fixes/triages
  // — so this action never removes the card the way a resolve/dismiss would.
  const handleAddressReviewFindings = (): void => {
    if (item.run_id === null) return;
    setAddressBusy(true);
    setAddressError(null);
    void trpc.cyboflow.runs.addressReviewFindings
      .mutate({ runId: item.run_id })
      .then((result) => {
        if ('delivered' in result) {
          trackEvent('review_item_resolved', {
            kind: item.kind,
            action: 'address_review_findings',
            blocking: item.blocking,
          });
        } else {
          setAddressError(ADDRESS_REVIEW_NOOP_MESSAGE[result.reason] ?? 'Could not rewind the run.');
        }
      })
      .catch(() => { setAddressError('Could not rewind the run — please try again.'); })
      .finally(() => { setAddressBusy(false); });
  };

  // Accept a docs/prompt finding: resolve with 'triaged:accepted-<target>' (the
  // human applies the edit). 'backlog' never reaches here — it uses handlePromote;
  // 'fix' never reaches here either — a quick-fix finding is COMPOUNDED, not
  // human-applied-as-docs, so the param is pinned to the manual-accept literals
  // (matching acceptedResolution in shared/types/reviews.ts) — a tripwire that
  // forces a compile error if a 'fix' caller is ever added.
  const handleAccept = (target: 'docs' | 'prompt'): void => {
    void acceptFinding(item.project_id, item.id, target).then((r) => {
      if (r !== null) onResolved?.();
    });
  };

  // A/B testing slice C: jump straight to the pairwise comparison view.
  const handleViewComparison = (): void => {
    if (comparisonExperimentId === null) return;
    useNavigationStore.getState().openExperimentComparison(comparisonExperimentId);
  };

  // IDEA-009 idea-size guard: launch a dedicated single-idea planner for the
  // flagged idea. The server resolves the guard as part of the same mutation
  // (create-then-resolve) — no separate resolve() call here.
  const handleGuardLaunchSeparatePlanner = (): void => {
    void launchSeparatePlanner(item.project_id, item.id).then((r) => {
      if (r !== null) {
        trackEvent('review_item_resolved', { kind: item.kind, action: 'launch_separate_planner', blocking: item.blocking });
        onResolved?.();
      }
    });
  };

  // IDEA-009 idea-size guard: send the flagged idea back to the backlog
  // (stamped scope='large'). The server resolves the guard as part of the same
  // mutation (stamp-then-resolve) — no separate resolve() call here.
  const handleGuardReturnToBacklog = (): void => {
    void returnIdeaToBacklog(item.project_id, item.id).then((r) => {
      if (r !== null) {
        trackEvent('review_item_resolved', { kind: item.kind, action: 'return_idea_to_backlog', blocking: item.blocking });
        onResolved?.();
      }
    });
  };

  // Open the originating run as the session workspace (mirrors TypeGroupedQueue's
  // openRunSession). This is the ONLY honest action for every escalation the queue
  // cannot settle on its own: a question-sourced decision (answered in the chat),
  // the approve-ideas gate (verdicts submitted from its artifact tab), and — on
  // `surface === 'queue'` — every option-less default branch.
  const openInSession = (): void => {
    if (item.run_id === null) return;
    useCyboflowStore.getState().setActiveRun(item.run_id);
    useNavigationStore.getState().setActiveProjectId(item.project_id);
    useNavigationStore.getState().goToSession();
  };

  // Answer a durable ask-user-question-recovery gate: the chosen option label is
  // delivered to the run as a resumed turn AND the gate is resolved — but ONLY if
  // the resume actually lands (the backend leaves the gate PENDING on a refused
  // resume so the answer is never lost). So the card is removed only on a
  // confirmed `resolved`; otherwise it stays visible with the failure reason.
  const handleRecoveryAnswer = (answerText: string): void => {
    setApprovalBusy(true);
    setRecoveryError(null);
    void trpc.cyboflow.runs.answerRecoveryGate
      .mutate({ projectId: item.project_id, reviewItemId: item.id, answerText })
      .then((result) => {
        if (result.resolved) {
          trackEvent('review_item_resolved', { kind: item.kind, action: 'resolve', blocking: item.blocking });
          onResolved?.();
        } else {
          setRecoveryError(recoveryResumeErrorMessage(result.nudge));
        }
      })
      .catch(() => { setRecoveryError('Could not answer the gate — please try again.'); })
      .finally(() => { setApprovalBusy(false); });
  };

  // Permission items reuse the real-time approval resolution path.
  const handleApprovalDecision = (decision: 'approve' | 'reject'): void => {
    const approvalId = permissionApprovalId(item);
    if (approvalId === null) {
      // No folded approval (e.g. a synthetic permission item) — fall back to the
      // review-item triage path so the item still leaves the inbox.
      if (decision === 'approve') handleResolve();
      else handleDismiss();
      return;
    }
    setApprovalBusy(true);
    const mutation =
      decision === 'approve'
        ? trpc.cyboflow.approvals.approve.mutate({ approvalId })
        : trpc.cyboflow.approvals.reject.mutate({ approvalId });
    void mutation
      .then(() => { onResolved?.(); })
      .catch(() => { /* leave card visible on error */ })
      .finally(() => { setApprovalBusy(false); });
  };

  // -- Kind-specific action row ---------------------------------------------

  /**
   * Whether an option-less branch should collapse into {@link defaultEscalationActions}.
   *
   * Requires BOTH the queue surface and a run to open. `run_id` is genuinely
   * nullable (a manual / triage-minted item — see ReviewItem.run_id), and for one
   * of those "Open in session" has no destination: applying the default pair
   * anyway would strip Resolve and Promote-to-task and leave Dismiss as the only
   * exit, so legitimate manual work could be discarded but never completed or
   * converted to backlog. A run-less item therefore keeps its full action set.
   */
  const usesDefaultActions = surface === 'queue' && item.run_id !== null;

  /**
   * The emphasis for one in-session gate button.
   *
   * With a supervisor recommendation, the button it points at is `primary` and
   * every other one `secondary` — the chip in the header says whose advice it
   * is, and the emphasis is what makes it actionable at a glance. Without one,
   * this collapses to today's fixed emphasis (approve primary, the rest
   * secondary), so an un-annotated card is byte-identical to before this seam.
   */
  const recommendedButton = recommendedGateButton(recommendation?.choice, isApproveDesignGateItem(item));
  const gateVariant = (button: GateButton): 'primary' | 'secondary' =>
    recommendedButton === null
      ? button === 'approve'
        ? 'primary'
        : 'secondary'
      : button === recommendedButton
        ? 'primary'
        : 'secondary';

  /**
   * The DEFAULT actions for an escalation that provided no options of its own:
   * route to the run, or drop the item. Never a resolve — settling a gate nobody
   * opened is exactly what these branches used to get wrong.
   *
   * The discard half is kind-sensitive. For a DECISION it must route through
   * resolve(outcome:'reject'), NOT dismiss: a dismissed gate is already read as a
   * rejection (humanGate.ts onChange), but ONLY the resolve path runs the
   * gate-specific teardown — resolveReviewItemHandler fires
   * deleteRunCreatedEntities for an approve-plan reject, and reviewItems.dismiss
   * does not. Routing a gate through dismiss would reject the plan while leaving
   * its pending draft epics/tasks orphaned on the board. A finding / human_task is
   * not a gate, so it keeps the plain dismiss (aggregate-unblock resume).
   */
  function defaultEscalationActions(): React.ReactElement {
    // APPROVE-DESIGN is carved out of the decision arm. "Dismiss" there used to
    // resolve `reject`, which ENDS THE RUN — a human tidying a card they had
    // already dealt with in the session would kill the walk. The design gate has
    // a real "drop the entries and carry on" verdict (`approve[no-findings]`),
    // so the queue's discard points at THAT instead, and the label says what it
    // does. Keyed on the PROGRAMMATIC gate only: the server admits the modifier
    // for no other source. Defence in depth: the explicit approve-design pair
    // above is checked BEFORE `usesDefaultActions`, so this branch is not reached
    // for that gate today — but if that ordering ever changes, the queue's
    // discard must still never send a run-ending reject.
    // TASK-222: every OTHER decision's discard routes through the centralized
    // gate-decline mapping, never a bare 'reject' literal — see
    // gateDeclineOutcome. Findings keep the plain dismiss.
    const approveDesign = isProgrammaticApproveDesignGate(item);
    const discard = approveDesign
      ? () => handleGateDecision('approve', 'no-findings')
      : item.kind === 'decision'
        ? () => handleGateDecision(gateDeclineOutcome(item))
        : handleDismiss;
    return (
      <>
        <Button variant="primary" size="sm" onClick={openInSession} data-testid="open-in-session">
          Open in session →
        </Button>
        <Button variant="secondary" size="sm" disabled={busy} onClick={discard} data-testid="default-dismiss">
          {approveDesign ? 'Continue without logging' : 'Dismiss'}
        </Button>
      </>
    );
  }

  function actions(): React.ReactElement {
    switch (item.kind) {
      case 'permission':
        return (
          <>
            <Button variant="primary" size="sm" disabled={busy} onClick={() => handleApprovalDecision('approve')}>
              Approve
            </Button>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => handleApprovalDecision('reject')}>
              Reject
            </Button>
          </>
        );
      case 'decision': {
        // A durable ask-user-question-recovery gate: the in-session gate dropped
        // or its SDK session expired, so re-offer the ORIGINAL options here. Every
        // exit routes through answerRecoveryGate (resolve-first/resume-on-delivered)
        // — NEVER the generic resolve/dismiss, which only flips status and would
        // strand a drained SDK session unanswered (the false-complete this gate
        // exists to prevent; the backend rejects generic triage on these too).
        if (isRecoveryGate(item)) {
          const recovered = recoveredQuestions(item);
          if (recovered.length > 0) {
            // Options survived: re-offer each label; a click answers + resumes.
            const options = recovered.flatMap((q) => q.options.map((o) => o.label));
            const unique = Array.from(new Set(options));
            return (
              <>
                {unique.map((label) => (
                  <Button
                    key={label}
                    variant="primary"
                    size="sm"
                    disabled={busy}
                    onClick={() => handleRecoveryAnswer(label)}
                    data-testid="recovery-gate-answer"
                  >
                    {label}
                  </Button>
                ))}
              </>
            );
          }
          // Option-less (malformed payload): still keep the human on the answer
          // path with a free-text reply delivered via answerRecoveryGate. Falling
          // back to generic resolve/dismiss here is exactly the data-loss hole.
          const submit = (): void => {
            const text = recoveryText.trim();
            if (text !== '') handleRecoveryAnswer(text);
          };
          return (
            <div className="flex flex-1 flex-wrap items-center gap-2">
              <input
                type="text"
                value={recoveryText}
                onChange={(e) => setRecoveryText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submit();
                }}
                placeholder="Type your answer…"
                disabled={busy}
                data-testid="recovery-gate-input"
                className="min-w-[12rem] flex-1 rounded border border-border-primary bg-bg-secondary px-2 py-1 text-xs text-text-primary"
              />
              <Button
                variant="primary"
                size="sm"
                disabled={busy || recoveryText.trim() === ''}
                onClick={submit}
                data-testid="recovery-gate-free-answer"
              >
                Answer &amp; resume
              </Button>
            </div>
          );
        }
        // A/B testing slice C: an experiment-comparison verdict-ready item routes
        // straight to the comparison view (promote/discard/rerun/switch-to-
        // rotation all live there) — resolve/dismiss would just drop the card
        // without recording any decision.
        if (comparisonExperimentId !== null) {
          return (
            <Button
              variant="primary"
              size="sm"
              onClick={handleViewComparison}
              data-testid="decision-view-comparison"
            >
              View comparison →
            </Button>
          );
        }
        // IDEA-009 idea-size guard: a too-large idea parked mid-batch. Resolved
        // (status !== 'pending') shows which of the two realized choices was
        // taken, keyed on the resolution's stable prefix — never re-offer the
        // buttons, since both server mutations hard-error on an already-resolved
        // guard rather than silently no-op.
        if (isIdeaSizeGuard(item)) {
          const guardIdeaRef = ideaSizeGuardRef(item);
          if (item.status !== 'pending') {
            const taken = guardResolutionPath(item.resolution);
            return (
              <span className="text-xs text-text-tertiary" data-testid="guard-resolved">
                {taken === 'separate-planner'
                  ? 'Launched a separate planner'
                  : taken === 'return-to-backlog'
                    ? 'Returned to the backlog'
                    : 'Resolved'}
              </span>
            );
          }
          return (
            <>
              <span className="text-xs text-text-secondary" data-testid="guard-idea-ref">
                {guardIdeaRef}
              </span>
              <Button
                variant="primary"
                size="sm"
                disabled={busy}
                onClick={handleGuardLaunchSeparatePlanner}
                data-testid="guard-launch-separate"
              >
                Launch a separate planner
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={handleGuardReturnToBacklog}
                data-testid="guard-return-backlog"
              >
                Return to backlog
              </Button>
            </>
          );
        }
        // IDEA-009 approve-ideas BATCH gate: per-idea verdicts are collected and
        // submitted from the run's Approve-ideas artifact tab (which validates the
        // map and DELIVERS the decisions into the parked planner). A generic scalar
        // Approve/Reject here would clear the gate while recording no per-idea
        // decision — the backend refuses exactly that (invalid_payload) — so the
        // only honest action is routing to the run session.
        if (isApproveIdeasGateItem(item)) {
          if (item.status !== 'pending') {
            return (
              <span className="text-xs text-text-tertiary" data-testid="approve-ideas-resolved">
                Decisions submitted
              </span>
            );
          }
          return (
            <Button
              variant="primary"
              size="sm"
              disabled={item.run_id === null}
              onClick={openInSession}
              data-testid="decision-review-ideas"
            >
              Review ideas →
            </Button>
          );
        }
        // A question-sourced decision is an OPEN AskUserQuestion: the run is
        // awaiting_input on a specific answer, so plain resolve/dismiss would
        // strand the waiting agent (the backend rejects it too). The only
        // honest action is answering the question card in the session chat.
        if (item.source === 'question') {
          return (
            <Button
              variant="primary"
              size="sm"
              disabled={item.run_id === null}
              onClick={openInSession}
              data-testid="decision-answer-in-session"
            >
              Answer in session →
            </Button>
          );
        }
        // TASK-222 — the two-way approve-design gate (Tier 2, item 12b) is a
        // REVISION loop, not a plain accept/deny: its decline outcome (via
        // gateDeclineOutcome) is ALWAYS 'revise', which reruns the refine phase
        // with the adversarial-review findings as feedback, never a terminal
        // 'reject'. Checked BEFORE `usesDefaultActions` — UNLIKE every other
        // `gate:human-step:*` gate below — so it renders this exact Approve/Revise
        // pair on EVERY surface (queue included) instead of collapsing into
        // defaultEscalationActions' "Open in session" + Dismiss, which is how the
        // 2026-09-17 swift-bison incident silently sent 'reject' from the queue.
        // There is deliberately no third "End run" button here: the controller's
        // own MAX_STEP_LOOPBACKS budget already ends the run automatically once
        // revise is exhausted, and the app-wide "Cancel run" control (RunActionBar
        // / RunCancelDialog) is the explicitly-labelled end-run affordance for
        // anyone who wants to stop sooner.
        if (isApproveDesignGateItem(item)) {
          return (
            <>
              {/* The revise note. Rendered wherever this pair is (the pair is
                  checked before usesDefaultActions, so that includes the queue).
                  `w-full` makes the flex-wrap row break, which puts the buttons
                  underneath. */}
              <textarea
                value={reviseNote}
                onChange={(e) => setReviseNote(e.target.value)}
                placeholder="Optional: what to change — e.g. only AR-2 matters, drop AR-11"
                rows={2}
                disabled={busy}
                data-testid="design-gate-note"
                className="w-full rounded border border-border-primary bg-bg-secondary px-2 py-1 text-xs text-text-primary"
              />
              <Button variant={gateVariant('approve')} size="sm" disabled={busy} onClick={() => handleGateDecision('approve')} data-testid="decision-resolve">
                Continue, log as findings
              </Button>
              <Button
                variant={gateVariant('revise')}
                size="sm"
                disabled={busy}
                onClick={() => handleGateDecision(gateDeclineOutcome(item))}
                data-testid="decision-reject"
              >
                Rerun planning with findings
              </Button>
              {/* The gate's THIRD choice: approve the design and drop the surviving
                  review entries instead of logging them. Only for the PROGRAMMATIC
                  gate, the one source the server accepts the `no-findings`
                  modifier on. */}
              {isProgrammaticApproveDesignGate(item) && (
                <Button
                  variant={gateVariant('no-findings')}
                  size="sm"
                  disabled={busy}
                  onClick={() => handleGateDecision('approve', 'no-findings')}
                  data-testid="decision-continue-no-findings"
                >
                  Continue without logging
                </Button>
              )}
            </>
          );
        }
        // Plan v2 (switch runtime/model on a systemic pause, then retry): the
        // programmatic run host's `gate:systemic-pause:<stepId>` gate, opened
        // when a step's agent hits a subscription/session limit. Checked
        // BEFORE `usesDefaultActions` — like approve-design above — so the
        // card never collapses this gate into the option-less "Open in
        // session" + Dismiss pair. The switch form is session-only (the
        // landing's NeedsInputSection row is the queue-side surface and
        // routes its "Switch & retry…" here). Never sends outcome 'reject':
        // Retry now / Switch & retry both resolve WITHOUT an outcome (a plain
        // retry — the pause gate reads any resolve as 'retry'), and Stop
        // waiting dismisses (giveup) instead.
        if (isSystemicPauseItem(item)) {
          if (item.status !== 'pending') {
            return (
              <span className="text-xs text-text-tertiary" data-testid="pause-resolved">
                {systemicPauseResolvedLabel(item)}
              </span>
            );
          }
          const origin = systemicPauseOrigin(item);
          // A triage-origin pause: only the run's Claude-only supervisor hit the
          // limit. No step-agent switch moves it (the backend refuses one with
          // `origin_triage`), so the card offers Retry now / Stop waiting and the
          // note below — never a switch that would replay every lane for nothing.
          const switchable = origin !== 'triage';
          const retryNow = (): void => {
            void resolve(item.project_id, item.id, { surface }).then((r) => {
              if (r !== null) {
                trackEvent('review_item_resolved', { kind: item.kind, action: 'retry', blocking: item.blocking });
                onResolved?.();
              }
            });
          };
          const stopWaiting = (): void => {
            void dismiss(item.project_id, item.id).then((ok) => {
              if (ok) {
                trackEvent('review_item_resolved', { kind: item.kind, action: 'stop_waiting', blocking: item.blocking });
                onResolved?.();
              }
            });
          };
          return (
            <>
              <Button variant="primary" size="sm" disabled={busy} onClick={retryNow} data-testid="pause-retry">
                Retry now
              </Button>
              {switchable && surface === 'session' && (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => setShowSwitchForm((v) => !v)}
                  data-testid="pause-switch-toggle"
                >
                  Switch runtime &amp; retry
                </Button>
              )}
              <Button variant="secondary" size="sm" disabled={busy} onClick={stopWaiting} data-testid="pause-stop">
                Stop waiting
              </Button>
              {origin === 'triage' && (
                <p className="w-full text-xs text-text-tertiary" data-testid="pause-triage-note">
                  The run&apos;s supervisor (always Claude) hit the limit; switching step agents won&apos;t move it.
                </p>
              )}
              {switchable && surface === 'session' && showSwitchForm && (
                <div className="w-full">
                  <SystemicPauseSwitchForm
                    item={item}
                    onDone={() => {
                      setShowSwitchForm(false);
                      onResolved?.();
                    }}
                  />
                </div>
              )}
            </>
          );
        }
        // A `gate:human-step:*` gate carries NO options (humanStepManager mints a
        // payload only for approve-ideas and for a bound-carrying approve-design,
        // and neither payload holds options), so the queue routes to
        // the run rather than inventing a verdict — the real control is the flow's
        // own artifact tab (decomposed-stories' approve-plan, approve-designs' grid)
        // or the transcript. In-session the explicit pair below stays: it is the
        // terminal surface for the flows that have no artifact tab of their own.
        if (usesDefaultActions) return defaultEscalationActions();
        // Explicit gate verdict via reviewItems.resolve `outcome`. Approve reveals
        // the run's drafts (approve-plan) + auto-resumes; Reject tears down rejected
        // drafts and ends the run 'rejected' (no resume).
        return (
          <>
            <Button variant={gateVariant('approve')} size="sm" disabled={busy} onClick={() => handleGateDecision('approve')} data-testid="decision-resolve">
              Approve &amp; resume
            </Button>
            <Button
              variant={gateVariant('reject')}
              size="sm"
              disabled={busy}
              onClick={() => handleGateDecision(gateDeclineOutcome(item))}
              data-testid="decision-reject"
            >
              Reject
            </Button>
          </>
        );
      }
      case 'notification':
        // An informational FYI — the work already ran, so there is no follow-up
        // to track. Acknowledging (Dismiss) is the only triage.
        return (
          <Button variant="secondary" size="sm" disabled={busy} onClick={handleDismiss}>
            Dismiss
          </Button>
        );
      case 'human_task':
        // A free-form action item states what to do but offers no options — the
        // queue routes to the run so the human can act, then resolve from there.
        if (usesDefaultActions) return defaultEscalationActions();
        return (
          <>
            <Button variant="primary" size="sm" disabled={busy} onClick={handleResolve}>
              Resolve
            </Button>
            <Button variant="secondary" size="sm" disabled={busy} onClick={handleDismiss}>
              Dismiss
            </Button>
            <Button variant="secondary" size="sm" disabled={busy} onClick={handlePromote} data-testid="promote-to-task">
              Promote to task
            </Button>
          </>
        );
      case 'finding':
      default:
        // TASK-277: an eval-sourced finding (source LIKE 'agent:eval%' — every
        // confirmed jury finding, the synthesized catastrophic-cap item, and
        // the ad-hoc summary) is a POST-HOC jury flag on a run parked at its
        // human-review gate, not a plain agent observation — Promote to task
        // is wrong vocabulary for it (a human who wants a task can Log it and
        // let Compound propose one instead). Takes priority over the
        // blocking/surface branches below: this triage set applies on every
        // surface, blocking or not.
        if (isEvalFinding) {
          if (isAdHocEvalSummary) {
            // The quick-session ad-hoc rollup: its run has no address-review
            // step to reopen, so Address never renders here at all (not just
            // disabled) — only Log / Dismiss.
            return (
              <>
                <Button variant="secondary" size="sm" disabled={busy} onClick={handleLogFinding} data-testid="log-as-findings">
                  Log as findings
                </Button>
                <Button variant="secondary" size="sm" disabled={busy} onClick={handleDismiss}>
                  Dismiss
                </Button>
              </>
            );
          }
          const ineligibleReason = addressEligibility && !addressEligibility.eligible ? addressEligibility.reason : undefined;
          return (
            <>
              <Button
                variant="primary"
                size="sm"
                disabled={busy || addressBusy || addressEligibility === null || !addressEligibility.eligible}
                title={ineligibleReason ? ADDRESS_REVIEW_DISABLED_TOOLTIP[ineligibleReason] : undefined}
                onClick={handleAddressReviewFindings}
                data-testid="address-review-findings"
              >
                Address review findings
              </Button>
              <Button variant="secondary" size="sm" disabled={busy} onClick={handleLogFinding} data-testid="log-as-findings">
                Log as findings
              </Button>
              <Button variant="secondary" size="sm" disabled={busy} onClick={handleDismiss}>
                Dismiss
              </Button>
            </>
          );
        }
        // A BLOCKING finding parked a programmatic run (Fix: blocking findings must
        // block) — a DEFECT, not a decision. Resolving or promoting it from the queue
        // clears the park without the defect being looked at, so the queue routes to
        // the run (where the agent can be told to fix it) and keeps Dismiss, which
        // still aggregate-unblocks. In-session the resolve affordance stays: Resolve
        // (resolve → aggregate-unblock resume) + Dismiss + Promote to task.
        // Non-blocking findings keep the accept-routing actions below on both surfaces.
        if (item.blocking) {
          if (usesDefaultActions) return defaultEscalationActions();
          return (
            <>
              <Button variant="primary" size="sm" disabled={busy} onClick={handleResolve} data-testid="finding-resolve">
                Resolve &amp; resume
              </Button>
              <Button variant="secondary" size="sm" disabled={busy} onClick={handleDismiss}>
                Dismiss
              </Button>
              <Button variant="secondary" size="sm" disabled={busy} onClick={handlePromote} data-testid="promote-to-task">
                Promote to task
              </Button>
            </>
          );
        }
        // Contextual primary action driven by the accept-routing hint:
        //   - no hint            → legacy Dismiss / Promote to task (unchanged).
        //   - 'backlog'          → Promote-to-task, relabelled 'Accept → task'.
        //   - 'docs' | 'prompt'  → 'Accept' resolves with 'triaged:accepted-<target>'.
        return (
          <>
            <Button variant="secondary" size="sm" disabled={busy} onClick={handleDismiss}>
              Dismiss
            </Button>
            {proposedTarget === 'docs' || proposedTarget === 'prompt' ? (
              <Button
                variant="primary"
                size="sm"
                disabled={busy}
                onClick={() => handleAccept(proposedTarget)}
                data-testid="accept-finding"
              >
                Accept
              </Button>
            ) : (
              <Button variant={proposedTarget === 'backlog' ? 'primary' : 'secondary'} size="sm" disabled={busy} onClick={handlePromote} data-testid="promote-to-task">
                {proposedTarget === 'backlog' ? 'Accept → task' : 'Promote to task'}
              </Button>
            )}
          </>
        );
    }
  }

  return (
    <div
      data-review-item-id={item.id}
      data-kind={item.kind}
      role="listitem"
      className={`px-4 py-3 border-b border-border-primary hover:bg-surface-hover cursor-default${focusClass}`}
    >
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className={`text-xs font-semibold uppercase tracking-wide ${KIND_ACCENT[item.kind]}`} data-testid="review-item-kind">
          {KIND_LABEL[item.kind]}
        </span>
        <span className="text-sm font-semibold text-text-primary">{item.title}</span>
        {item.kind === 'finding' && item.severity && (
          <span className="text-[10px] font-medium uppercase text-text-tertiary">{item.severity}</span>
        )}
        {proposedTarget && (
          <span
            className="rounded-full border border-border-primary bg-bg-secondary px-1.5 py-px text-[10px] font-medium text-text-secondary"
            data-testid="proposed-target-chip"
            data-target={proposedTarget}
          >
            {TARGET_CHIP_LABEL[proposedTarget]}
          </span>
        )}
        {item.blocking && (
          <span
            className="ml-1 rounded-full border border-status-error/40 bg-status-error/10 px-1.5 py-px text-[10px] font-bold text-status-error"
            data-testid="blocking-badge"
          >
            Blocking
          </span>
        )}
        {recommendation && (
          <span
            className="rounded-full border border-interactive/40 bg-interactive/10 px-1.5 py-px text-[10px] font-medium text-interactive"
            data-testid="supervisor-recommendation"
            data-choice={recommendation.choice}
            title={recommendation.sentence}
          >
            Supervisor recommends: {RECOMMENDATION_CHIP_LABEL[recommendation.choice]}
          </span>
        )}
        <span className="ml-auto text-xs text-text-muted">{formatAge(item.created_at)}</span>
      </div>

      {item.body != null && item.body !== '' && (
        <p className="my-2 text-xs text-text-secondary whitespace-pre-wrap">{item.body}</p>
      )}

      {item.source && (
        <p className="text-[10px] text-text-tertiary">{item.source}</p>
      )}

      {/* Idle-session items are informational — the only affordance is the
          queue row's "Open session →". Opening the session marks it viewed, which
          auto-resolves the item on the next detector scan, so no triage CTAs. */}
      {!item.source?.startsWith(IDLE_REVIEW_SOURCE_PREFIX) && (
        <div className="flex gap-2 mt-3 flex-wrap">{actions()}</div>
      )}

      {/* `useReviewItemActions` is instantiated once PER CARD, so `error` is
          already scoped to this item — the mutation's `finally` resets
          `pendingItemId` to null in the same tick `error` is set, so gating on
          `pendingItemId === item.id` here was dead code (never true). */}
      {error && (
        <p className="mt-2 text-xs text-status-error" role="alert">
          {error}
        </p>
      )}

      {recoveryError && (
        <p className="mt-2 text-xs text-status-error" role="alert" data-testid="recovery-gate-error">
          {recoveryError}
        </p>
      )}

      {addressError && (
        <p className="mt-2 text-xs text-status-error" role="alert" data-testid="address-review-error">
          {addressError}
        </p>
      )}
    </div>
  );
}
