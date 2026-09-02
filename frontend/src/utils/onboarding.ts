/**
 * First-run onboarding — renderer-side shared constants.
 *
 * Neutral module (importable by stores, components, and integration touch
 * points alike) so the onboarding overlay, the Sidebar resume button, the
 * guided set-up surface, and App's shell gate never drift on key/event names or
 * step arithmetic.
 */

import type { OnboardingStepName } from '../../../shared/types/telemetry';
import type { OnboardingStatus } from '../stores/onboardingStore';

/**
 * Single user_preferences key holding the persisted tour snapshot as JSON
 * (see PersistedOnboarding in stores/onboardingStore.ts). Read/write via the
 * raw `preferences:get` / `preferences:set` IPC channels — the established
 * pattern for one-shot UI flags (docs/CODE-PATTERNS.md "IPC preference-backed
 * component visibility"). The key name is FROZEN at `_v1`; the schema version
 * lives inside the JSON payload and is migrated by
 * `migratePersistedOnboarding`.
 */
export const ONBOARDING_PREF_KEY = 'cyboflow_onboarding_state_v1';

/**
 * Window CustomEvents the onboarding paths participate in. `projectCreated` is
 * the app's PRE-EXISTING event (dispatched by CreateProjectDialog and by the
 * guided set-up's create handler); `landingStore` is the consumer that matters
 * — it resyncs the project list when one lands.
 */
export const ONBOARDING_EVENTS = {
  projectCreated: 'project-created',
} as const;

/** Total tour steps: 7 modal cards (0-6) + 2 guided full-window screens (7-8). */
export const ONBOARDING_STEP_COUNT = 9;

/** Steps rendered as the centered modal card over a bare paper shell. */
export const ONBOARDING_MODAL_STEPS: ReadonlyArray<number> = [0, 1, 2, 3, 4, 5, 6];
/**
 * Steps rendered as the full-window guided set-up surface (inside the shell row,
 * NOT the body portal, so the TitleBar drag region keeps working).
 */
export const ONBOARDING_GUIDED_STEPS: ReadonlyArray<number> = [7, 8];

/**
 * The one CONDITIONAL step: "which agent should be your default?" only has a
 * question to ask when the Connect step left more than one of {claude, codex}
 * activated. The store decides (onboardingStore.isStepSkipped) — this constant
 * just names the index so the numbering helpers below and the store agree on
 * which one it is.
 */
export const ONBOARDING_DEFAULT_RUNTIME_STEP = 2;
/** Model + reasoning-effort picker; follows the effective default agent. */
export const ONBOARDING_MODEL_STEP = 3;
/** "You're set up" — continue into the guided set-up, or finish here. */
export const ONBOARDING_HANDOFF_STEP = 6;
/** Guided: existing project / new project / not sure yet. */
export const ONBOARDING_ADD_PROJECT_STEP = 7;
/** Guided: the folder picker or the create form, per the step-7 choice. */
export const ONBOARDING_PROJECT_DETAIL_STEP = 8;

/** True when `step` is one of the full-window guided set-up screens. */
export function isGuidedStep(step: number): boolean {
  return ONBOARDING_GUIDED_STEPS.includes(step);
}

/**
 * Progress numbering for the MODAL cards ("STEP n / N" + the dot rail). It
 * counts modal steps only — the guided screens carry their own "STEP n OF 2"
 * eyebrow — and EXCLUDES the steps this run skips, so a single-provider install
 * reads "STEP 3 / 6" rather than "STEP 4 / 7" with a dot nobody can reach. Both
 * helpers take the live skipped set (the gate derives it from the store) rather
 * than importing the store, keeping this module neutral.
 */
export function visibleStepTotal(skipped: ReadonlySet<number>): number {
  return ONBOARDING_MODAL_STEPS.filter((i) => !skipped.has(i)).length;
}

/**
 * 1-based position of `step` among the modal steps this run actually shows. A
 * guided step reports the last modal position (it is past the card rail).
 */
export function visibleStepNumber(step: number, skipped: ReadonlySet<number>): number {
  let n = 0;
  for (const i of ONBOARDING_MODAL_STEPS) {
    if (i > step) break;
    if (!skipped.has(i)) n++;
  }
  // A skipped step is never rendered, but Back/goTo race a toggle change; report
  // the position it would occupy rather than 0.
  return Math.max(n, 1);
}

/**
 * Stable analytics slug per step index (see telemetry `OnboardingStepName`),
 * index-aligned with the tour's step order and ONBOARDING_STEP_COUNT. Used only
 * for the `onboarding_*` usage events — never for control flow.
 *
 * The order is load-bearing for the persisted-snapshot migrations: every past
 * insertion shifted every step at or after its index forward by one (see
 * migrateV1StepIndex / migrateV2StepIndex / migrateV3StepIndex in
 * stores/onboardingStore.ts). Do NOT append a new entry at the end without
 * checking whether it belongs earlier in the tour's actual order — and add the
 * matching remap when it does.
 */
export const ONBOARDING_STEP_NAMES: readonly OnboardingStepName[] = [
  'welcome',
  'connect',
  'default_runtime',
  'model',
  'permission',
  'telemetry',
  'handoff',
  'add_project',
  'project_detail',
];

/** Step index → analytics slug; out-of-range indices fall back to 'welcome'. */
export function onboardingStepName(step: number): OnboardingStepName {
  return ONBOARDING_STEP_NAMES[step] ?? 'welcome';
}

/**
 * Whether the app shell (Sidebar, center surface, AgentRail, StatusBar) must
 * stay unmounted. Two reasons, both no-flash rules:
 * - `!hydrated`: the persisted snapshot read has not resolved, so we do not yet
 *   know whether this boot owes the user a tour (docs/CODE-PATTERNS.md "IPC
 *   preference-backed component visibility").
 * - `status === 'active'`: the tour owns the whole window — modal steps render a
 *   card over bare paper, guided steps render the set-up surface in the shell
 *   row.
 *
 * 'skipped' and 'completed' both mount the shell (a skipped tour is resumable
 * from the Sidebar card, which only exists once the shell is there).
 */
export function isOnboardingShellHidden(state: {
  hydrated: boolean;
  status: OnboardingStatus;
}): boolean {
  return !state.hydrated || state.status === 'active';
}
