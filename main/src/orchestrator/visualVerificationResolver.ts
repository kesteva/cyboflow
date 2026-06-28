/**
 * visualVerificationResolver — the SINGLE resolution point for a run's layered
 * visual-verification posture (see docs/visual-verification-design.md §2).
 * Exact sibling of substrateResolver.ts / executionModelResolver.ts: all three
 * are resolved together in WorkflowRegistry.createRun and stamped IMMUTABLY onto
 * the workflow_runs row (no UPDATE path — a long run can't change posture
 * mid-flight; migration 036's verify_enabled / verify_type / verify_chain).
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
 *  (c) the live chain = FALLBACK_CHAINS[type] ∩ the host-available backends.
 *      In the MVP only 'capturePage' is available (playwright / peekaboo /
 *      maestro are filtered out until their host-deps land), so a render-type
 *      chain collapses to ['capturePage'] and an interactive/native/mobile type
 *      collapses to [] (the scheduler SKIPs an empty chain — never a fabricated
 *      fail).
 *
 * With the global master switch OFF (the default — getVisualVerifyEnabled floors
 * false), EVERY run resolves { enabled:false, type:null, chain:[] } and stamps
 * verify_enabled=0 / verify_type=NULL / verify_chain=NULL — the
 * zero-behavior-change invariant this seam guarantees, exactly as `substrate`
 * was stamped-but-dormant when migration 013 introduced it.
 */
import {
  type VerificationType,
  type VisualBackendId,
  type VerificationRequestInput,
  FALLBACK_CHAINS,
  isVerificationType,
} from '../../../shared/types/visualVerification';

/**
 * The hard floor verification type, used when enabled but no requested/default
 * type resolves to a recognized member. The cheapest, broadest type — its chain
 * is the only one that always contains the MVP's sole available backend.
 */
export const DEFAULT_VERIFICATION_TYPE: VerificationType = 'static-render-snapshot';

/**
 * The backends whose host-deps are available in the v1 MVP. Only the in-process
 * rung-0 capturePage backend ships first; playwright / peekaboo / maestro are
 * filtered out of every resolved chain until their host-deps + leases land.
 * Callers may pass a wider set as the resolver's `availableBackends` input.
 */
export const MVP_AVAILABLE_BACKENDS: readonly VisualBackendId[] = ['capturePage'] as const;

/**
 * The backends actually registered into the scheduler's VerificationBackendRegistry
 * at boot (index.ts). createRun passes this as the resolver's `availableBackends`
 * so the stamped `verify_chain` can list every SHIPPED rung (not just the rung-0
 * floor); the per-backend runtime `healthCheck()` at drain is the SECOND gate (a
 * shipped-but-unhealthy backend — e.g. chromium not installed, or 'playwright'
 * pruned from a packaged build as a devDependency — is skipped then, never a
 * fabricated pass). Keep this in sync with the index.ts registry; it grows as each
 * backend slice lands (S3 'playwright', S4 'peekaboo', …). The resolver's own
 * default stays MVP_AVAILABLE_BACKENDS so the standalone resolver never assumes a
 * richer host than it can prove.
 */
export const SHIPPED_VERIFY_BACKENDS: readonly VisualBackendId[] = [
  'capturePage',
  'playwright',
  'peekaboo',
] as const;

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
   * Explicit per-run enablement override (e.g. from the run-launch UI). HIGHEST
   * precedence — a deliberate per-launch choice beats any standing default.
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

  /**
   * The backends whose host-deps are available on this host. The resolved chain
   * is intersected with this set. Defaults to MVP_AVAILABLE_BACKENDS (only
   * 'capturePage') so the standalone resolver never assumes a richer host.
   */
  availableBackends?: readonly VisualBackendId[];
}

/**
 * The resolved, immutable verification posture for a run — the exact shape
 * stamped onto workflow_runs (verify_enabled / verify_type / verify_chain).
 * When disabled, `type` is null and `chain` is empty.
 */
export interface ResolvedVisualVerification {
  enabled: boolean;
  type: VerificationType | null;
  chain: VisualBackendId[];
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
 */
function resolveEnabled(inputs: VisualVerificationResolverInputs): boolean {
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
 *   1. requestedEnabled (explicit per-run override)
 *   2. projectConfigEnabled (project config)
 *   3. globalDefaultEnabled (global AppConfig master switch)
 *   4. false — the hard floor.
 *
 * When disabled → { enabled:false, type:null, chain:[] } (no chain resolution).
 *
 * When enabled, the TYPE is resolved (requestedType > project default >
 * inferred-from-deliverable-kind > global default > 'static-render-snapshot'
 * floor) and the chain is
 * FALLBACK_CHAINS[type] intersected with the host-available backends (default:
 * only 'capturePage'). Order follows FALLBACK_CHAINS (easy→hard), preserved
 * through the intersection. An empty intersection is returned as-is — the
 * scheduler treats an empty chain as a SKIP (missing precondition), never a fail.
 */
export function resolveVisualVerification(
  inputs: VisualVerificationResolverInputs,
): ResolvedVisualVerification {
  if (!resolveEnabled(inputs)) {
    return DISABLED;
  }

  const type = resolveType(inputs);
  const available = inputs.availableBackends ?? MVP_AVAILABLE_BACKENDS;
  // Preserve the easy→hard FALLBACK_CHAINS order through the intersection.
  const chain = FALLBACK_CHAINS[type].filter((backend) => available.includes(backend));

  return { enabled: true, type, chain };
}
