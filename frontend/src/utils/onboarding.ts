/**
 * First-run onboarding — renderer-side shared constants.
 *
 * Neutral module (importable by stores, components, and integration touch
 * points alike) so the onboarding overlay, the Sidebar resume button, and the
 * real-action dispatch sites never drift on key/event/anchor names.
 */

import type { OnboardingStepName } from '../../../shared/types/telemetry';

/**
 * Single user_preferences key holding the persisted tour snapshot as JSON
 * (see PersistedOnboarding in stores/onboardingStore.ts). Read/write via the
 * raw `preferences:get` / `preferences:set` IPC channels — the established
 * pattern for one-shot UI flags (docs/CODE-PATTERNS.md "IPC preference-backed
 * component visibility").
 */
export const ONBOARDING_PREF_KEY = 'cyboflow_onboarding_state_v1';

/**
 * Window CustomEvents that advance the tour's coach steps. `projectCreated`
 * is the app's PRE-EXISTING event (dispatched by CreateProjectDialog and any
 * onboarding-embedded create path); the other two are dispatched at the
 * real-action success sites (quick-session creation, runs.start success).
 */
export const ONBOARDING_EVENTS = {
  projectCreated: 'project-created',
  quickSessionCreated: 'cyboflow:quick-session-created',
  workflowRunStarted: 'cyboflow:workflow-run-started',
} as const;

/**
 * Coachmark anchor ids, rendered as `data-onboarding="<id>"` on the real
 * target elements. The Coachmark component resolves targets exclusively via
 * this attribute — never by class name or test id.
 */
export const ONBOARDING_ANCHOR_ATTR = 'data-onboarding';
export const ONBOARDING_ANCHORS = {
  /** SessionStartWizard step-② Quick Session card (tour step 4). */
  quickSessionCard: 'quick-session-card',
  /** Wizard Configure — Session permission selector (tour step 5). */
  sessionPermission: 'session-permission',
  /** Wizard Configure — Model picker (tour step 6). */
  modelSelect: 'model-select',
  /** Wizard Configure — CLI substrate selector (tour step 7). */
  substrateSelect: 'substrate-select',
  /** QuickSessionCanvas "/ship" workflow chip (tour step 8). */
  shipChip: 'ship-chip',
  /** Sidebar "Human review" rail item (tour step 9). */
  humanReview: 'human-review',
} as const;

export const ONBOARDING_STEP_COUNT = 11;

/** Steps rendered as the centered modal card. */
export const ONBOARDING_MODAL_STEPS: ReadonlyArray<number> = [0, 1, 2, 3, 10];
/** Steps rendered as an anchored coachmark over the live UI. */
export const ONBOARDING_COACH_STEPS: ReadonlyArray<number> = [4, 5, 6, 7, 8, 9];
/**
 * The coach steps that are informational POINTERS (the wizard-Configure trio:
 * permission / model / substrate). Unlike the advance-by-doing steps (4, 8, 9)
 * they carry a Next button on the popover and advance via store.next();
 * interacting with the anchored control never advances them.
 */
export const ONBOARDING_POINTER_STEPS: ReadonlyArray<number> = [5, 6, 7];

/**
 * Stable analytics slug per step index (see telemetry `OnboardingStepName`),
 * index-aligned with the tour's step order and ONBOARDING_STEP_COUNT. Used only
 * for the `onboarding_*` usage events — never for control flow.
 */
export const ONBOARDING_STEP_NAMES: readonly OnboardingStepName[] = [
  'welcome',
  'connect',
  'permission',
  'add_project',
  'quick_session',
  'session_permission',
  'model',
  'substrate',
  'ship',
  'human_review',
  'rail_map',
];

/** Step index → analytics slug; out-of-range indices fall back to 'welcome'. */
export function onboardingStepName(step: number): OnboardingStepName {
  return ONBOARDING_STEP_NAMES[step] ?? 'welcome';
}

/**
 * Real-action dispatch helpers — call these at the SUCCESS point of the
 * corresponding launch path (never on error paths). OnboardingGate is the
 * sole listener; these just fire the window CustomEvents it forwards into
 * `useOnboardingStore.realEvent`, so integration call sites never need to
 * import the store directly.
 */
export function notifyQuickSessionCreated(detail?: unknown): void {
  window.dispatchEvent(new CustomEvent(ONBOARDING_EVENTS.quickSessionCreated, { detail }));
}

export function notifyWorkflowRunStarted(detail?: unknown): void {
  window.dispatchEvent(new CustomEvent(ONBOARDING_EVENTS.workflowRunStarted, { detail }));
}
