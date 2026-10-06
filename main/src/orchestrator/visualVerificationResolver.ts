/**
 * visualVerificationResolver — the SINGLE resolution point for a run's layered
 * visual-verification posture (see docs/proposals/visual-verification-design.md §2).
 * Exact sibling of substrateResolver.ts / executionModelResolver.ts: all three
 * are resolved together in WorkflowRegistry.createRun and stamped IMMUTABLY onto
 * the workflow_runs row (no UPDATE path — a long run can't change posture
 * mid-flight; migration 055's verify_enabled / verify_type / verify_chain).
 *
 * "No UPDATE path" is still true without exception — nothing ever mutates a
 * stamped run row. What is NOT true without qualification: that the run stamp
 * is the only place posture lives. The `__quick__` chat sentinel is minted
 * ONCE on the session's first turn and then reused for the session's whole
 * life, so a session that predates a later change to the global master switch
 * (or its own project config) would read a stale stamp forever if it depended
 * on that stamp at all. Rather than add an UPDATE path, `mcpQueryHandler.ts`'s
 * `handleRequestVerification` BYPASSES the stamp for a quick run: it calls
 * this resolver again at each `cyboflow_request_verification` call (fed the
 * same ladder `createRun` would use, read live) and writes the freshly
 * resolved chain verbatim onto that request's own row instead of the run's.
 * The request row is itself never re-enqueued, so the result is exactly as
 * immutable as the run stamp — just pinned at request granularity instead of
 * run granularity for this one caller. Every other run keeps reading the
 * frozen run stamp exactly as this file always documented.
 *
 * Standalone-typecheck invariant: this file must NOT import from 'electron',
 * 'better-sqlite3', 'fs', or any concrete service in main/src/services/*. It
 * depends only on the renderer-safe shared visual-verification types — the
 * concrete config/backends are passed in by the caller as plain values.
 *
 * The resolver decides three things, ONCE:
 *  (a) enabled?  via the precedence ladder
 *        per-run override > project config > global AppConfig > false.
 *  (b) the TYPE  (only when enabled) via
 *        agent-declared/requested type > project/global defaultType > the floor
 *        'static-render-snapshot'.
 *  (c) the engine chain — `['agent']` (the verification-AGENT engine, the only
 *      one) for an enabled run, `[]` for a disabled one.
 *
 * With the global master switch OFF (the default — getVisualVerifyEnabled floors
 * false), every run resolves { enabled:false, type:null, chain:[] } and stamps
 * verify_enabled=0 / verify_type=NULL / verify_chain=NULL — the
 * zero-behavior-change invariant this seam guarantees, exactly as `substrate`
 * was stamped-but-dormant when migration 013 introduced it. The ONE exception is
 * a `verify-setup` run (`setupFlowBootstrap`), which is the flow that makes the
 * switch worth turning on and so cannot be gated behind it.
 */
import {
  type VerificationType,
  type VerifyChainEntry,
  type VerificationRequestInput,
  VERIFY_AGENT_CHAIN,
  isVerificationType,
} from '../../../shared/types/visualVerification';

/**
 * The hard floor verification type, used when enabled but no requested/default
 * type resolves to a recognized member — the cheapest, broadest type.
 */
export const DEFAULT_VERIFICATION_TYPE: VerificationType = 'static-render-snapshot';

/**
 * Inputs for resolveVisualVerification. Every enablement / type level is
 * optional and untyped at the boundary because the values flow in from agent
 * frontmatter / per-request overrides, project config, and AppConfig — none of
 * which can be trusted to be a valid VerificationType. Each type candidate is
 * validated with isVerificationType() and an unrecognized value is SKIPPED
 * (fail-soft), falling through to the next level — mirroring resolveSubstrate /
 * resolveExecutionModel.
 *
 * Enablement is a strict boolean ladder: a level participates only when it is an
 * explicit `true` or `false` (undefined/null = "unset → fall through"). The
 * highest SET level wins; if none is set, enablement floors to false.
 */
export interface VisualVerificationResolverInputs {
  /**
   * The run IS the verification bootstrap (`verify-setup`). Sits ABOVE the whole
   * enablement ladder — the one rung that is not a preference.
   *
   * WHY IT OUTRANKS EVERYTHING. Every other rung answers "should this run's work
   * be visually verified?", and the honest default for that is off. A
   * verify-setup run asks a different question: its only verification is the
   * `setup_proof` that PROVES the project's runbook, which is the whole
   * deliverable of the flow and the precondition for every other run's
   * verification ever becoming useful. Resolving it through the ordinary ladder
   * is a bootstrap deadlock in the same shape §3.6 already exempts setup proofs
   * from at the degrade gate: with the master switch off (the shipped default,
   * and `getVisualVerifyConfig` floors it to an EXPLICIT boolean so the ladder
   * always terminates there) the flow can only ever produce an unproven draft,
   * and the switch it is gated on is the switch it exists to make worth turning
   * on. Observed live 2026-07-31: the dogfood run registered its runbook, then
   * its proof no-op-skipped on `verify_enabled = 0`.
   *
   * Narrow by construction: it enables the RUN, not the project. Firing a
   * `setup_proof` request still requires the run's frozen workflow identity to
   * be verify-setup AND a pin resolving to a registered draft (the MCP
   * authorization gate), and setup-proof rows are already budget-exempt and
   * drain behind live lanes. A verify-setup run that fires an ORDINARY request
   * gets an ordinary one — enablement is all this grants.
   */
  setupFlowBootstrap?: boolean;
  /**
   * Explicit per-run enablement override (e.g. from the run-launch UI). HIGHEST
   * precedence among the preference rungs — a deliberate per-launch choice beats
   * any standing default.
   */
  requestedEnabled?: boolean | null;
  /** Per-project config override (project `.cyboflow/verify.json:enabled`). */
  projectConfigEnabled?: boolean | null;
  /** Global AppConfig master switch (ConfigManager.getVisualVerifyEnabled()). */
  globalDefaultEnabled?: boolean | null;

  /**
   * Agent-declared / per-run requested verification type (highest type rung).
   * Only consulted when the run resolves enabled.
   */
  requestedType?: string | null;
  /** Per-project default verification type. */
  projectConfigDefaultType?: string | null;
  /** Global AppConfig default verification type (visualVerify.defaultType). */
  globalDefaultType?: string | null;

  /**
   * The deliverable being verified — feeds the type-ladder's rung C
   * ("infer from deliverable kind"), which sits BELOW the project default and
   * ABOVE the global default. When present + no higher rung resolves a
   * recognized type, inferTypeFromDeliverable(deliverable) decides the type from
   * the deliverable's shape (interactions ⇒ interactive-web-behavior; url/html
   * with no interactions ⇒ static-render-snapshot; otherwise null = fall
   * through). native-desktop / mobile-flow are never inferred — they always
   * require an explicit declaration at a higher rung. Optional; absent => the
   * inference rung is skipped (resolution falls to the global default + floor).
   */
  deliverable?: VerificationRequestInput | null;
}

/**
 * The resolved, immutable verification posture for a run — the exact shape
 * stamped onto workflow_runs (verify_enabled / verify_type / verify_chain).
 * When disabled, `type` is null and `chain` is empty.
 */
export interface ResolvedVisualVerification {
  enabled: boolean;
  type: VerificationType | null;
  /**
   * The stamped chain (redesign §5.8): the single-member `['agent']` engine
   * selector when enabled, `[]` when disabled.
   */
  chain: VerifyChainEntry[];
}

/**
 * The disabled posture — a single frozen value so every disabled run resolves
 * to byte-identical { enabled:false, type:null, chain:[] }.
 */
const DISABLED: ResolvedVisualVerification = { enabled: false, type: null, chain: [] };

/**
 * Resolve enablement via the strict-boolean precedence ladder. Returns the
 * first level that is an explicit boolean (true OR false); a level set to
 * `false` is a deliberate opt-OUT that wins over lower levels, exactly as a
 * `true` opt-in does. Floors to false when no level is set.
 *
 * The bootstrap rung is checked FIRST and is not part of that ladder — see
 * {@link VisualVerificationResolverInputs.setupFlowBootstrap} for why a
 * verify-setup run is not expressing a preference that a preference can outrank.
 */
function resolveEnabled(inputs: VisualVerificationResolverInputs): boolean {
  if (inputs.setupFlowBootstrap === true) return true;
  const candidates: Array<boolean | null | undefined> = [
    inputs.requestedEnabled,
    inputs.projectConfigEnabled,
    inputs.globalDefaultEnabled,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'boolean') {
      return candidate;
    }
  }
  return false;
}

/**
 * Type-ladder rung C — infer the verification TYPE from the deliverable's shape.
 * Only the two web types are ever inferred (a deterministic floor inference):
 *
 *   - a non-empty `interactions` list ⇒ 'interactive-web-behavior' (it clicks/types);
 *   - else a `url` OR `htmlPath` (a renderable artifact, no interactions)
 *       ⇒ 'static-render-snapshot';
 *   - else null (nothing to infer from → fall through to the next rung).
 *
 * native-desktop / mobile-flow are NEVER inferred: a screenshot of the running
 * app or a mobile build is too consequential to guess at, so those types must be
 * declared explicitly at a higher rung (returns null here). responsive-multi-
 * viewport is also not inferred (viewports alone don't disambiguate it from a
 * static render); it too must be declared. Returns null for an absent deliverable.
 */
export function inferTypeFromDeliverable(
  deliverable: VerificationRequestInput | null | undefined,
): VerificationType | null {
  if (!deliverable) {
    return null;
  }
  if (deliverable.interactions && deliverable.interactions.length > 0) {
    return 'interactive-web-behavior';
  }
  if (deliverable.url || deliverable.htmlPath) {
    return 'static-render-snapshot';
  }
  return null;
}

/**
 * Resolve the verification TYPE via the override ladder. Each candidate is
 * validated with isVerificationType(); an unrecognized value is skipped and
 * resolution falls through to the next level, flooring to
 * DEFAULT_VERIFICATION_TYPE.
 *
 * Rung order (highest wins): requestedType (agent-declared) > projectConfigDefaultType
 * (`.cyboflow/verify.json`) > inferred-from-deliverable-kind (rung C, between the
 * project and global defaults) > globalDefaultType (AppConfig) > the floor
 * 'static-render-snapshot'.
 */
function resolveType(inputs: VisualVerificationResolverInputs): VerificationType {
  const candidates: Array<string | null | undefined> = [
    inputs.requestedType,
    inputs.projectConfigDefaultType,
    // Rung C — inferred from the deliverable's shape, BELOW the project default
    // and ABOVE the global default. inferTypeFromDeliverable returns a valid
    // VerificationType or null; null falls through to the global rung.
    inferTypeFromDeliverable(inputs.deliverable),
    inputs.globalDefaultType,
  ];
  for (const candidate of candidates) {
    if (isVerificationType(candidate)) {
      return candidate;
    }
  }
  return DEFAULT_VERIFICATION_TYPE;
}

/**
 * Resolve a run's visual-verification posture.
 *
 * Enablement precedence (highest wins; first explicit boolean level):
 *   0. setupFlowBootstrap — the verify-setup flow's own run, which is not
 *      expressing a preference; see the field's doc for the deadlock it breaks.
 *   1. requestedEnabled (explicit per-run override)
 *   2. projectConfigEnabled (project config)
 *   3. globalDefaultEnabled (global AppConfig master switch)
 *   4. false — the hard floor.
 *
 * When disabled → { enabled:false, type:null, chain:[] } (no chain resolution).
 *
 * When enabled, the TYPE is resolved (requestedType > project default >
 * inferred-from-deliverable-kind > global default > 'static-render-snapshot'
 * floor) and the chain is the verification-AGENT selector `['agent']`.
 */
export function resolveVisualVerification(
  inputs: VisualVerificationResolverInputs,
): ResolvedVisualVerification {
  if (!resolveEnabled(inputs)) {
    return DISABLED;
  }

  const type = resolveType(inputs);

  // The verification AGENT (redesign §5.8). Stamp the single-member `['agent']`
  // selector — the scheduler dispatches a run whose stamp equals it to the
  // VerificationAgentRunner (which builds/serves/drives/judges the composed
  // VerificationTaskV1 itself). The TYPE is still resolved (it rides the request +
  // drives the agent's viewport handling).
  return { enabled: true, type, chain: [...VERIFY_AGENT_CHAIN] };
}
